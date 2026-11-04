import { describe, expect, it } from 'vitest';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { LIMITS, PROTOCOL_VERSION, PaneSnapshotResponse } from '@daintreehq/decisions-protocol';
import { decryptEnvelope, newId, signObject } from '@daintreehq/decisions-crypto';
import {
  act,
  ask,
  claimRelay,
  events,
  inRoom,
  pairDevice,
  stub,
  type Actor,
  type World,
} from './helpers.js';
import {
  SNAPSHOTS,
  buildSnapshot,
  declare,
  enrollHost,
  eventsWith,
  getSnapshot,
  openSocket,
  publish,
  putSnapshot,
  refresh,
} from './snapshots.helpers.js';

const asHost = (w: World, host: Actor): World => ({ ...w, owner: host });

/** A question published by `publisher`, which has declared pane snapshots. */
async function setup(o: { host?: boolean } = {}) {
  const w = await claimRelay();
  const phone = await pairDevice(w);
  const publisher = o.host ? await enrollHost(w) : w.owner;
  await declare(publisher, SNAPSHOTS);
  const { questionId } = await ask(asHost(w, publisher));
  return { w, phone, publisher, questionId };
}

const snapshotRows = () =>
  inRoom((room) => room.q<Record<string, unknown>>(`SELECT * FROM question_snapshots`));

describe('writing pane snapshots (docs/protocol.md section 18)', () => {
  it('lets the publishing desktop write, replaces the last one, and keeps no history', async () => {
    const { w, phone, publisher, questionId } = await setup();
    const first = await publish(w, publisher, questionId, { at: -2000 });
    expect(first.res.status).toBe(200);
    expect(first.res.json).toMatchObject({ question_id: questionId, revision: 0, status: 'open' });
    const second = await publish(w, publisher, questionId, { at: -1000 });
    expect(second.res.status).toBe(200);

    const read = await getSnapshot(phone, questionId);
    expect(read.status).toBe(200);
    expect(PaneSnapshotResponse.safeParse(read.json).success).toBe(true);
    expect(read.json.snapshot.record.snapshot_id).toBe(second.snap.record.snapshot_id);
    expect(read.json.refresh).toBeNull();
    expect(Date.parse(read.json.received_at)).toBeLessThanOrEqual(Date.now());
    // The phone decrypts what the desktop encrypted; the relay only ever held ciphertext.
    const content = await decryptEnvelope<{ pane_title: string }>(
      read.json.snapshot.envelope,
      phone.epochs,
      { questionId, recordType: 'pane.snapshot', purpose: 'snapshot-content' },
    );
    expect(content.pane_title).toBeTruthy();

    // One row, holding only the latest ciphertext; the replaced one is nowhere in storage.
    const rows = await snapshotRows();
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(
      await inRoom((room) => [
        room.q(`SELECT * FROM question_snapshots`),
        room.q(`SELECT * FROM events`),
        room.q(`SELECT * FROM command_receipts`),
      ]),
    );
    expect(dump).not.toContain(first.snap.envelope!.ciphertext);
    expect(dump).toContain(second.snap.envelope!.ciphertext);
    expect(dump).not.toContain(content.pane_title);
  });

  it('lets an enrolled host write its own questions, and refuses every other device', async () => {
    const { w, phone, publisher: host, questionId } = await setup({ host: true });
    expect((await publish(w, host, questionId, { at: -3000 })).res.status).toBe(200);

    // Not even the owner speaks for another desktop's pane.
    const byOwner = await buildSnapshot(w, w.owner, questionId);
    expect((await putSnapshot(w.owner, questionId, byOwner)).json.code).toBe('forbidden');
    const other = await enrollHost(w, 'Other Host');
    const byOther = await buildSnapshot(w, other, questionId);
    expect((await putSnapshot(other, questionId, byOther)).status).toBe(403);
    // Human devices may not write at all.
    const tablet = await pairDevice(w, 'tablet', 'Tablet');
    for (const human of [phone, tablet]) {
      const snap = await buildSnapshot(w, human, questionId);
      expect((await putSnapshot(human, questionId, snap)).status).toBe(403);
    }
    // A host's snapshot signed with someone else's key, or for another question, is refused.
    const forged = await buildSnapshot(w, host, questionId);
    const { signature: _sig, ...unsigned } = forged.record;
    const resigned = await signObject(other.keys.signing.privateKey, unsigned);
    expect((await putSnapshot(host, questionId, { ...forged, record: resigned })).json.code).toBe(
      'validation_error',
    );
    const { questionId: ownerQuestion } = await ask(w);
    const elsewhere = await buildSnapshot(w, host, ownerQuestion);
    expect((await putSnapshot(host, questionId, elsewhere)).status).toBe(400);
    expect((await putSnapshot(host, ownerQuestion, elsewhere)).status).toBe(403);
  });

  it('validates the signed record and its envelope', async () => {
    const { w, publisher, questionId } = await setup();
    const snap = await buildSnapshot(w, publisher, questionId);
    const swapped = await buildSnapshot(w, publisher, questionId);
    // the envelope must be the one the record signed
    expect(
      (await putSnapshot(publisher, questionId, { ...snap, envelope: swapped.envelope })).json.code,
    ).toBe('validation_error');
    // record_id must bind the envelope to this snapshot
    expect(
      (
        await putSnapshot(publisher, questionId, {
          ...snap,
          envelope: { ...snap.envelope!, record_id: newId() },
        })
      ).status,
    ).toBe(400);
    // a tampered record fails its signature
    expect(
      (
        await putSnapshot(publisher, questionId, {
          ...snap,
          record: { ...snap.record, question_revision: 1 },
        })
      ).status,
    ).toBe(400);
    // an envelope without the record saying so, and sharing off with an envelope
    expect((await putSnapshot(publisher, questionId, { ...snap, envelope: null })).status).toBe(
      400,
    );
    // nothing was stored
    expect(await snapshotRows()).toHaveLength(0);
  });

  it('caps the size of what it stores', async () => {
    const { w, publisher, questionId } = await setup();
    const snap = await buildSnapshot(w, publisher, questionId);
    const big = {
      ...snap,
      envelope: { ...snap.envelope!, ciphertext: 'A'.repeat(LIMITS.snapshotCiphertextChars + 1) },
    };
    const res = await putSnapshot(publisher, questionId, big);
    expect(res.status).toBe(413);
    expect(res.json.code).toBe('payload_too_large');
    expect(await snapshotRows()).toHaveLength(0);
  });

  it('accepts only the current revision and a strictly later observed_at, within the clock allowance', async () => {
    const { w, phone, publisher, questionId } = await setup();
    const stale = await publish(w, publisher, questionId, { revision: 1 });
    expect(stale.res.status).toBe(409);
    expect(stale.res.json.code).toBe('revision_conflict');
    expect(stale.res.json.details.latest_revision).toBe(0);

    const t = Date.now() - 10_000;
    expect(
      (await publish(w, publisher, questionId, { observedAt: new Date(t).toISOString() })).res
        .status,
    ).toBe(200);
    for (const at of [t, t - 1]) {
      const old = await publish(w, publisher, questionId, {
        observedAt: new Date(at).toISOString(),
      });
      expect(old.res.status).toBe(409);
      expect(old.res.json.code).toBe('revision_conflict');
    }
    const ahead = await publish(w, publisher, questionId, { at: LIMITS.requestSkewMs + 60_000 });
    expect(ahead.res.status).toBe(400);
    // A refused write never moves the watermark.
    expect(
      (await publish(w, publisher, questionId, { observedAt: new Date(t + 1).toISOString() })).res
        .status,
    ).toBe(200);

    // After an answer the desktop publishes against the new revision.
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(201);
    expect((await publish(w, publisher, questionId, { revision: 0, at: -100 })).res.status).toBe(
      409,
    );
    expect((await publish(w, publisher, questionId, { revision: 1, at: -50 })).res.status).toBe(
      200,
    );
    // An answer keeps the snapshot: the thread is still live.
    expect((await getSnapshot(phone, questionId)).json.snapshot).not.toBeNull();
  });

  it('rate-limits writes per question', async () => {
    const { w, publisher, questionId } = await setup();
    const base = Date.now() - 60_000;
    for (let i = 0; i < LIMITS.snapshotWritesPerQuestionMinute; i++) {
      const r = await publish(w, publisher, questionId, {
        observedAt: new Date(base + i).toISOString(),
      });
      expect(r.res.status, `write ${i}`).toBe(200);
    }
    const over = await publish(w, publisher, questionId, { at: -1 });
    expect(over.res.status).toBe(429);
    expect(over.res.json.retry_after_ms).toBeGreaterThan(0);
    // Another question has its own budget.
    const { questionId: other } = await ask(w);
    expect((await publish(w, publisher, other)).res.status).toBe(200);
  });

  it('returns the original receipt for a retry and refuses a reused key with another body', async () => {
    const { w, publisher, questionId } = await setup();
    const key = newId();
    const snap = await buildSnapshot(w, publisher, questionId, {
      observedAt: new Date(Date.now() - 5000).toISOString(),
    });
    const first = await putSnapshot(publisher, questionId, snap, key);
    expect(first.status).toBe(200);
    const newer = await publish(w, publisher, questionId, { at: -1000 });
    expect(newer.res.status).toBe(200);
    // The retry answers with the first receipt and never brings the older snapshot back.
    const retry = await putSnapshot(publisher, questionId, snap, key);
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual(first.json);
    expect((await getSnapshot(publisher, questionId)).json.snapshot.record.snapshot_id).toBe(
      newer.snap.record.snapshot_id,
    );
    const other = await buildSnapshot(w, publisher, questionId);
    expect((await putSnapshot(publisher, questionId, other, key)).json.code).toBe(
      'idempotency_collision',
    );
  });
});

describe('reading and change notifications', () => {
  it('serves every paired device and reports no snapshot, sharing off and a missing question', async () => {
    const { w, phone, publisher, questionId } = await setup();
    const empty = await getSnapshot(phone, questionId);
    expect(empty.json).toEqual({
      question_id: questionId,
      snapshot: null,
      received_at: null,
      refresh: null,
    });
    expect((await getSnapshot(phone, newId())).status).toBe(404);
    expect((await publish(w, publisher, questionId, { sharing: 'off' })).res.status).toBe(200);
    const off = (await getSnapshot(w.owner, questionId)).json;
    expect(off.snapshot.record.sharing).toBe('off');
    expect(off.snapshot.envelope).toBeNull();
    expect(off.received_at).not.toBeNull();
  });

  it('tells devices that declared the feature, over the event feed and the socket, with hints only', async () => {
    const { w, phone, publisher, questionId } = await setup();
    const live = await openSocket(phone, SNAPSHOTS);
    const baseline = await openSocket(w.owner);
    const a = await publish(w, publisher, questionId, { at: -2000 });
    const b = await publish(w, publisher, questionId, { at: -1000 });
    const frame = await live.waitFor(
      (f) => f.t === 'event' && f.event.data.snapshot_id === b.snap.record.snapshot_id,
    );
    expect(frame.event.event_type).toBe('decision.snapshot.updated');
    expect(frame.event.question_id).toBe(questionId);
    expect(frame.event.question_revision).toBeNull();
    // A hint names the snapshot and nothing that is in it.
    expect(Object.keys(frame.event.data).sort()).toEqual([
      'observed_at',
      'sharing',
      'snapshot_id',
      'target_host_id',
    ]);
    // The feed keeps only the latest hint per question; a 0.3.0-shaped request sees none.
    const hints = (await eventsWith(phone, SNAPSHOTS)).filter(
      (e) => e.event_type === 'decision.snapshot.updated',
    );
    expect(hints.map((e) => e.data.snapshot_id)).toEqual([b.snap.record.snapshot_id]);
    expect(a.snap.record.snapshot_id).not.toBe(b.snap.record.snapshot_id);
    expect((await events(phone)).some((e) => e.event_type.startsWith('decision.snapshot.'))).toBe(
      false,
    );
    // A later baseline event still reaches the baseline socket; no snapshot frame ever did.
    await ask(w);
    await baseline.waitFor((f) => f.t === 'event' && f.event.event_type === 'decision.created');
    expect(
      baseline.frames.some(
        (f) => f.t === 'event' && f.event.event_type.startsWith('decision.snapshot.'),
      ),
    ).toBe(false);
    live.close();
    baseline.close();
  });
});

describe('refresh requests', () => {
  it('reach the publishing desktop, coalesce, and are fulfilled by the next snapshot', async () => {
    const { w, phone, publisher, questionId } = await setup({ host: true });
    const tablet = await pairDevice(w, 'tablet', 'Tablet');
    const hostSocket = await openSocket(publisher, SNAPSHOTS);
    const asked = await refresh(phone, questionId);
    expect(asked.status).toBe(200);
    expect(asked.json.requested_by_device_id).toBe(phone.id);
    expect(Date.parse(asked.json.deadline_at) - Date.parse(asked.json.requested_at)).toBe(
      LIMITS.snapshotRefreshTimeoutMs,
    );
    const frame = await hostSocket.waitFor(
      (f) => f.t === 'event' && f.event.event_type === 'decision.snapshot.refresh_requested',
    );
    expect(frame.event.data).toMatchObject({ ...asked.json, target_host_id: 'host_aaaaaaaa' });
    // The host can also find it on its feed and on the snapshot route.
    expect(
      (await eventsWith(publisher, SNAPSHOTS)).filter(
        (e) => e.event_type === 'decision.snapshot.refresh_requested',
      ),
    ).toHaveLength(1);
    expect((await getSnapshot(publisher, questionId)).json.refresh).toEqual(asked.json);

    // Repeats, from this phone or another, get the same outstanding request and no new event.
    expect((await refresh(phone, questionId)).json).toEqual(asked.json);
    expect((await refresh(tablet, questionId)).json).toEqual(asked.json);
    expect(
      hostSocket.frames.filter(
        (f) => f.t === 'event' && f.event.event_type === 'decision.snapshot.refresh_requested',
      ),
    ).toHaveLength(1);

    // The next accepted snapshot fulfils it and retires its hint.
    expect((await publish(w, publisher, questionId)).res.status).toBe(200);
    expect((await getSnapshot(phone, questionId)).json.refresh).toBeNull();
    expect(
      (await eventsWith(phone, SNAPSHOTS)).some(
        (e) => e.event_type === 'decision.snapshot.refresh_requested',
      ),
    ).toBe(false);
    hostSocket.close();
  });

  it('starts a new request once the deadline passes, and limits each device per minute', async () => {
    const { phone, questionId } = await setup();
    const first = (await refresh(phone, questionId)).json;
    await inRoom((room) =>
      room.run(
        `UPDATE question_snapshots SET refresh_json = ? WHERE question_id = ?`,
        JSON.stringify({ ...first, deadline_at: new Date(Date.now() - 1).toISOString() }),
        questionId,
      ),
    );
    // A timed-out request is still visible, so the phone can call the snapshot stale.
    expect((await getSnapshot(phone, questionId)).json.refresh.refresh_id).toBe(first.refresh_id);
    const second = (await refresh(phone, questionId)).json;
    expect(second.refresh_id).not.toBe(first.refresh_id);
    for (let i = 2; i < LIMITS.snapshotRefreshesPerDeviceMinute; i++) {
      expect((await refresh(phone, questionId)).status).toBe(200);
    }
    const over = await refresh(phone, questionId);
    expect(over.status).toBe(429);
  });

  it('is refused when the desktop does not publish snapshots, has sharing off, or the question closed', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    // a 0.3.0 desktop never declared the feature
    const { questionId: legacy } = await ask(w);
    expect((await refresh(phone, legacy)).json.code).toBe('invalid_state');
    // nor does a desktop whose latest ticket dropped it
    await declare(w.owner, SNAPSHOTS);
    expect((await refresh(phone, legacy)).status).toBe(200);
    await declare(w.owner, []);
    const { questionId: dropped } = await ask(w);
    expect((await refresh(phone, dropped)).json.code).toBe('invalid_state');

    await declare(w.owner, SNAPSHOTS);
    const { questionId: off } = await ask(w);
    expect((await publish(w, w.owner, off, { sharing: 'off', at: -1000 })).res.status).toBe(200);
    expect((await refresh(phone, off)).json.code).toBe('invalid_state');
    // a shared snapshot turns it back on
    expect((await publish(w, w.owner, off)).res.status).toBe(200);
    expect((await refresh(phone, off)).status).toBe(200);

    const { questionId: cancelled } = await ask(w);
    expect((await act(w, w.owner, 'cancel', cancelled, 0)).res.status).toBe(201);
    expect((await refresh(phone, cancelled)).json.code).toBe('invalid_state');
    expect((await refresh(w.owner, off)).status).toBe(403);
    expect((await refresh(phone, newId())).status).toBe(404);
  });
});

describe('clearing', () => {
  it('a sharing-off record replaces and clears the snapshot, and fulfils a refresh', async () => {
    const { w, phone, publisher, questionId } = await setup();
    const shared = await publish(w, publisher, questionId, { at: -2000 });
    expect((await refresh(phone, questionId)).status).toBe(200);
    const off = await publish(w, publisher, questionId, { sharing: 'off', at: -1000 });
    expect(off.res.status).toBe(200);
    const read = (await getSnapshot(phone, questionId)).json;
    expect(read.snapshot.record.snapshot_id).toBe(off.snap.record.snapshot_id);
    expect(read.snapshot.envelope).toBeNull();
    expect(read.refresh).toBeNull();
    const rows = await snapshotRows();
    expect(JSON.stringify(rows)).not.toContain(shared.snap.envelope!.ciphertext);
    expect(rows[0]!.retain_until).toBeNull();
    const hints = (await eventsWith(phone, SNAPSHOTS)).filter(
      (e) => e.event_type === 'decision.snapshot.updated',
    );
    expect(hints.map((e) => e.data.sharing)).toEqual(['off']);
  });

  it('clears on cancel and expiry, starts a reopened question empty, and keeps the order watermark', async () => {
    const { w, phone, publisher, questionId } = await setup();
    const latest = Date.now() - 1000;
    expect(
      (await publish(w, publisher, questionId, { observedAt: new Date(latest).toISOString() })).res
        .status,
    ).toBe(200);
    expect((await refresh(phone, questionId)).status).toBe(200);
    expect((await act(w, w.owner, 'cancel', questionId, 0)).res.status).toBe(201);
    expect((await getSnapshot(phone, questionId)).json).toMatchObject({
      snapshot: null,
      refresh: null,
    });
    expect((await publish(w, publisher, questionId)).res.json.code).toBe('invalid_state');
    const rows = await snapshotRows();
    expect(rows[0]).toMatchObject({ record_json: null, envelope_json: null, refresh_json: null });
    expect(
      (await eventsWith(phone, SNAPSHOTS)).some((e) =>
        e.event_type.startsWith('decision.snapshot.'),
      ),
    ).toBe(false);

    expect((await act(w, w.owner, 'reopen', questionId, 0, { content: null })).res.status).toBe(
      201,
    );
    expect((await getSnapshot(phone, questionId)).json).toMatchObject({
      snapshot: null,
      refresh: null,
    });
    // A delayed snapshot from before the clear never comes back.
    const delayed = await publish(w, publisher, questionId, {
      revision: 1,
      observedAt: new Date(latest - 1).toISOString(),
    });
    expect(delayed.res.status).toBe(409);
    expect((await publish(w, publisher, questionId, { revision: 1 })).res.status).toBe(200);

    // Expiry: lazily on the next write, and by the alarm.
    await inRoom((room) =>
      room.run(
        `UPDATE questions SET expires_at = ? WHERE question_id = ?`,
        Date.now() - 1,
        questionId,
      ),
    );
    const late = await publish(w, publisher, questionId, { revision: 1, at: 1 });
    expect(late.res.status).toBe(410);
    expect((await phone.call('GET', `/api/v1/questions/${questionId}`)).json.status).toBe(
      'expired',
    );
    expect((await getSnapshot(phone, questionId)).json.snapshot).toBeNull();
    expect((await snapshotRows())[0]).toMatchObject({ record_json: null });

    const { questionId: second } = await ask(w);
    expect((await publish(w, publisher, second)).res.status).toBe(200);
    await inRoom((room) => {
      room.run(`UPDATE questions SET expires_at = ? WHERE question_id = ?`, Date.now() - 1, second);
      room.run(
        `UPDATE scheduled_jobs SET run_at = ? WHERE question_id = ? AND kind = 'expire'`,
        Date.now() - 1,
        second,
      );
    });
    await runDurableObjectAlarm(stub());
    const row = await inRoom((room) =>
      room.q1<Record<string, unknown>>(
        `SELECT * FROM question_snapshots WHERE question_id = ?`,
        second,
      ),
    );
    expect(row).toMatchObject({ record_json: null, envelope_json: null });
  });

  it('removes the ciphertext 24 hours after the relay received it, by the alarm', async () => {
    const { w, phone, publisher, questionId } = await setup();
    await publish(w, publisher, questionId, { at: -1000 });
    // With no job pending, the alarm is the retention deadline of the latest snapshot.
    await inRoom((room) => room.run(`UPDATE scheduled_jobs SET status = 'done'`));
    const snap = await publish(w, publisher, questionId);
    const row = (await snapshotRows())[0]!;
    expect((row.retain_until as number) - (row.received_at as number)).toBe(
      LIMITS.snapshotRetentionMs,
    );
    expect(await inRoom((_room, state) => state.storage.getAlarm())).toBe(row.retain_until);

    await inRoom((room) =>
      room.run(
        `UPDATE question_snapshots SET retain_until = ? WHERE question_id = ?`,
        Date.now() - 1,
        questionId,
      ),
    );
    await runDurableObjectAlarm(stub());
    const after = (await snapshotRows())[0]!;
    expect(after).toMatchObject({ record_json: null, envelope_json: null, retain_until: null });
    expect(JSON.stringify(after)).not.toContain(snap.snap.envelope!.ciphertext);
    expect((await getSnapshot(phone, questionId)).json.snapshot).toBeNull();
    // Readers are told, so they stop showing it.
    const hints = (await eventsWith(phone, SNAPSHOTS)).filter(
      (e) => e.event_type === 'decision.snapshot.updated',
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].origin_device_id).toBeNull();
  });

  it('enforces retention on read even before the alarm runs', async () => {
    const { w, phone, publisher, questionId } = await setup();
    await publish(w, publisher, questionId);
    await inRoom((room) =>
      room.run(
        `UPDATE question_snapshots SET retain_until = ? WHERE question_id = ?`,
        Date.now() - 1,
        questionId,
      ),
    );
    expect((await getSnapshot(phone, questionId)).json.snapshot).toBeNull();
  });
});

describe('delete, export and push', () => {
  it('deleting a question removes its snapshot, refresh and hints', async () => {
    const { w, phone, publisher, questionId } = await setup();
    await publish(w, publisher, questionId);
    expect((await refresh(phone, questionId)).status).toBe(200);
    expect((await w.owner.call('DELETE', `/api/v1/questions/${questionId}`)).status).toBe(200);
    expect(await snapshotRows()).toHaveLength(0);
    const left = await inRoom((room) =>
      room.q(`SELECT * FROM events WHERE event_type LIKE 'decision.snapshot.%'`),
    );
    expect(left).toHaveLength(0);
    expect((await getSnapshot(phone, questionId)).status).toBe(404);
  });

  for (const scope of ['questions', 'everything'] as const) {
    it(`delete-data (${scope}) removes every snapshot`, async () => {
      const { w, publisher, questionId } = await setup();
      await publish(w, publisher, questionId);
      const res = await w.owner.call('POST', '/api/v1/admin/delete-data', {
        protocol_version: PROTOCOL_VERSION,
        confirm: 'DELETE',
        scope,
      });
      expect(res.status).toBe(200);
      expect(await snapshotRows()).toHaveLength(0);
    });
  }

  it('keeps snapshots out of question details and never schedules a push for them', async () => {
    const { w, phone, publisher, questionId } = await setup();
    const jobsBefore = await inRoom((room) => room.q(`SELECT job_id FROM scheduled_jobs`));
    const snap = await publish(w, publisher, questionId);
    await refresh(phone, questionId);
    await publish(w, publisher, questionId, { sharing: 'off', at: 1 });
    const jobsAfter = await inRoom((room) => room.q(`SELECT job_id FROM scheduled_jobs`));
    expect(jobsAfter).toEqual(jobsBefore);
    const detail = await phone.call('GET', `/api/v1/questions/${questionId}`);
    expect(detail.text).not.toContain(snap.snap.record.snapshot_id);
    expect(detail.text).not.toContain(snap.snap.envelope!.ciphertext);
  });
});
