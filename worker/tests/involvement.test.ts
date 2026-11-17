import { describe, expect, it } from 'vitest';
import {
  InvolvementResponse,
  LIMITS,
  PROTOCOL_VERSION,
  type InvolvementMode,
  type InvolvementRecord,
} from '@daintreehq/decisions-protocol';
import { buildSignedInvolvement, newId, signObject } from '@daintreehq/decisions-crypto';
import {
  claimRelay,
  events,
  inRoom,
  pairDevice,
  settle,
  type Actor,
  type World,
} from './helpers.js';
import { enrollHost, eventsWith, openSocket } from './snapshots.helpers.js';

/*
 * The involvement preference (docs/protocol.md section 20): phones and tablets replace one signed record, every
 * device reads it, and declaring clients get a hint that replaces the last one.
 */

const INVOLVEMENT = ['involvement-v1'] as const;

interface Opts {
  revision?: number;
  normal?: InvolvementMode;
  consult?: number;
  override?: { mode: InvolvementMode; until: string } | null;
  installationId?: string;
  signerId?: string;
}

async function sign(w: World, a: Actor, o: Opts = {}): Promise<InvolvementRecord> {
  return buildSignedInvolvement({
    installationId: o.installationId ?? w.installationId,
    signerDeviceId: o.signerId ?? a.id,
    signingKey: a.keys.signing.privateKey,
    revision: o.revision ?? 1,
    normalMode: o.normal ?? 'recommend',
    consultCount: o.consult ?? 3,
    override: o.override ?? null,
  });
}

async function put(a: Actor, preference: unknown, idempotencyKey = newId()) {
  return a.call('PUT', '/api/v1/involvement', {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: idempotencyKey,
    preference,
  });
}

async function get(a: Actor) {
  const r = await a.call('GET', '/api/v1/involvement');
  expect(r.status).toBe(200);
  return InvolvementResponse.parse(r.json);
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe('setting the involvement preference', () => {
  it('starts empty, then a phone sets revision 1 and every device reads the signed record', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    expect(await get(w.owner)).toEqual({ preference: null, received_at: null });

    const record = await sign(w, phone, {
      override: { mode: 'involve-early', until: inAnHour() },
    });
    const res = await put(phone, record);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ revision: 1, event_seq: expect.any(Number) });

    for (const reader of [w.owner, phone, await enrollHost(w)]) {
      const got = await get(reader);
      expect(got.preference).toEqual(record);
      expect(Date.parse(got.received_at!)).toBeLessThanOrEqual(Date.now());
    }
  });

  it('a tablet may set it too', async () => {
    const w = await claimRelay();
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    expect((await put(tablet, await sign(w, tablet))).status).toBe(200);
  });

  it('the owner desktop sets it and overrides it, and every device reads its record', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const host = await enrollHost(w);

    const first = await sign(w, w.owner, { normal: 'recommend', consult: 2 });
    const set = await put(w.owner, first);
    expect(set.status).toBe(200);
    expect(set.json).toEqual({ revision: 1, event_seq: expect.any(Number) });

    const override = await sign(w, w.owner, {
      revision: 2,
      normal: 'recommend',
      consult: 2,
      override: { mode: 'involve-early', until: inAnHour() },
    });
    const res = await put(w.owner, override);
    expect(res.status).toBe(200);
    expect(res.json.revision).toBe(2);
    for (const reader of [w.owner, phone, host]) {
      const got = await get(reader);
      expect(got.preference).toEqual(override);
      expect(got.preference!.signer_device_id).toBe(w.owner.id);
    }
  });

  it('a Daintree Host never may, whatever it signs', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const host = await enrollHost(w);
    expect((await put(host, await sign(w, host))).status).toBe(403);
    // Nor by carrying the owner's own record.
    expect((await put(host, await sign(w, w.owner))).status).toBe(403);
    expect((await get(phone)).preference).toBeNull();
  });

  it("the owner desktop can only send its own record, not a phone's", async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    expect((await put(w.owner, await sign(w, phone))).status).toBe(400);
    expect((await put(phone, await sign(w, w.owner))).status).toBe(400);
    // Signed with the owner's own key, so it verifies, but naming the phone as its signer.
    expect((await put(w.owner, await sign(w, w.owner, { signerId: phone.id }))).status).toBe(400);
    const elsewhere = await sign(w, w.owner, { installationId: newId() });
    expect((await put(w.owner, elsewhere)).status).toBe(400);
    const forged = { ...(await sign(w, w.owner)), consult_count: 5 };
    expect((await put(w.owner, forged)).status).toBe(400);
    expect((await get(phone)).preference).toBeNull();
  });

  it('refuses a record signed by another key, for another device or for another installation', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const other = await pairDevice(w, 'phone', 'Other iPhone');

    const forged = { ...(await sign(w, phone)), consult_count: 5 };
    expect((await put(phone, forged)).status).toBe(400);
    // Signed by `other` but naming `phone` as the signer.
    const borrowed = await sign(w, other, { signerId: phone.id });
    expect((await put(phone, borrowed)).status).toBe(400);
    // Another phone's genuine record, replayed by this one.
    expect((await put(phone, await sign(w, other))).status).toBe(400);
    const elsewhere = await sign(w, phone, { installationId: newId() });
    expect((await put(phone, elsewhere)).status).toBe(400);
    // A record with an unsigned field added after signing.
    const { signature: _s, ...unsigned } = await sign(w, phone);
    const resigned = await signObject(other.keys.signing.privateKey, unsigned);
    expect((await put(phone, resigned)).status).toBe(400);
    expect((await get(phone)).preference).toBeNull();
  });

  it('refuses a temporary mode that has ended or ends too far ahead', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const ended = await sign(w, phone, {
      override: { mode: 'involve-early', until: new Date(Date.now() - 1000).toISOString() },
    });
    const ended_ = await put(phone, ended);
    expect(ended_.status).toBe(400);
    expect(ended_.json.message).toMatch(/already ended/);
    const far = await sign(w, phone, {
      override: {
        mode: 'involve-early',
        until: new Date(
          Date.now() + LIMITS.involvementOverrideMaxMs + LIMITS.requestSkewMs + 60_000,
        ).toISOString(),
      },
    });
    expect((await put(phone, far)).status).toBe(400);
    expect((await get(phone)).preference).toBeNull();
  });

  it("holds the owner desktop's temporary mode to the same limit", async () => {
    const w = await claimRelay();
    const ended = await sign(w, w.owner, {
      override: { mode: 'involve-early', until: new Date(Date.now() - 1000).toISOString() },
    });
    expect((await put(w.owner, ended)).status).toBe(400);
    const far = await sign(w, w.owner, {
      override: {
        mode: 'involve-early',
        until: new Date(
          Date.now() + LIMITS.involvementOverrideMaxMs + LIMITS.requestSkewMs + 60_000,
        ).toISOString(),
      },
    });
    const res = await put(w.owner, far);
    expect(res.status).toBe(400);
    expect(res.json.message).toMatch(/too far ahead/);
    expect((await get(w.owner)).preference).toBeNull();
  });
});

describe('compare-and-swap on the revision', () => {
  it('each write is one more than the last; a stale or skipped revision is a conflict', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');

    expect((await put(phone, await sign(w, phone, { revision: 2 }))).status).toBe(409);
    expect((await put(phone, await sign(w, phone, { revision: 1 }))).status).toBe(200);
    const r2 = await sign(w, tablet, { revision: 2, normal: 'involve-early' });
    expect((await put(tablet, r2)).status).toBe(200);

    // The phone still holds revision 1 and signs revision 2: refused, with what is current.
    const stale = await put(phone, await sign(w, phone, { revision: 2 }));
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('revision_conflict');
    expect(stale.json.details).toEqual({ latest_revision: 2 });
    expect((await get(phone)).preference).toEqual(r2);
  });

  it('two phones racing for the same revision: exactly one wins', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    const [a, b] = await Promise.all([
      put(phone, await sign(w, phone, { normal: 'recommend' })),
      put(tablet, await sign(w, tablet, { normal: 'involve-early' })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? phone : tablet;
    expect((await get(phone)).preference!.signer_device_id).toBe(winner.id);
  });

  it('the owner desktop and a phone conflict as two phones do', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);

    // The owner desktop cannot skip a revision either.
    const skipped = await put(w.owner, await sign(w, w.owner, { revision: 2 }));
    expect(skipped.status).toBe(409);
    expect(skipped.json.details).toEqual({ latest_revision: 0 });
    expect((await put(phone, await sign(w, phone, { revision: 1 }))).status).toBe(200);
    const ahead = await put(w.owner, await sign(w, w.owner, { revision: 3 }));
    expect(ahead.status).toBe(409);
    expect(ahead.json.details).toEqual({ latest_revision: 1 });
    // The owner desktop still holds nothing and signs revision 1: refused, with what is current.
    const stale = await put(w.owner, await sign(w, w.owner, { revision: 1 }));
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('revision_conflict');
    expect(stale.json.details).toEqual({ latest_revision: 1 });

    const r2 = await sign(w, w.owner, { revision: 2, normal: 'involve-early' });
    expect((await put(w.owner, r2)).status).toBe(200);
    // Now the phone is the one behind.
    const behind = await put(phone, await sign(w, phone, { revision: 2 }));
    expect(behind.status).toBe(409);
    expect(behind.json.details).toEqual({ latest_revision: 2 });
    expect((await get(phone)).preference).toEqual(r2);
    // And a phone record replaces the owner's like any other.
    const r3 = await sign(w, phone, { revision: 3 });
    expect((await put(phone, r3)).status).toBe(200);
    expect((await get(w.owner)).preference).toEqual(r3);
  });

  it('the owner desktop and a phone racing for the same revision: exactly one wins', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    // Both signed first, so the two writes are in flight together.
    const fromOwner = await sign(w, w.owner, { normal: 'recommend' });
    const fromPhone = await sign(w, phone, { normal: 'involve-early' });
    const [a, b] = await Promise.all([put(w.owner, fromOwner), put(phone, fromPhone)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? w.owner : phone;
    expect((await get(phone)).preference!.signer_device_id).toBe(winner.id);
  });

  it("the owner desktop's retry returns its original receipt and changes nothing", async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const key = newId();
    const record = await sign(w, w.owner);
    const first = await put(w.owner, record, key);
    expect(first.status).toBe(200);
    expect((await put(phone, await sign(w, phone, { revision: 2 }))).status).toBe(200);
    const again = await put(w.owner, record, key);
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    expect((await get(w.owner)).preference!.signer_device_id).toBe(phone.id);
    expect((await put(w.owner, await sign(w, w.owner, { revision: 3 }), key)).status).toBe(409);
  });

  it('a retry returns the original receipt, even after the temporary mode ended or a later write', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const key = newId();
    const record = await sign(w, phone, {
      override: { mode: 'involve-early', until: new Date(Date.now() + 1500).toISOString() },
    });
    const first = await put(phone, record, key);
    expect(first.status).toBe(200);
    expect((await put(phone, await sign(w, phone, { revision: 2 }))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1600));
    const again = await put(phone, record, key);
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    // The retry did not roll anything back.
    expect((await get(phone)).preference!.revision).toBe(2);
    // The same key with another body is a collision.
    expect((await put(phone, await sign(w, phone, { revision: 3 }), key)).status).toBe(409);
  });

  it('a revoked phone can no longer set it', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    await inRoom((room) =>
      room.run(`UPDATE devices SET revoked_at = ? WHERE device_id = ?`, Date.now(), phone.id),
    );
    expect((await put(phone, await sign(w, phone))).status).toBe(401);
  });
});

describe('the involvement hint', () => {
  it('replaces the last one, carries only the revision, and reaches only declaring clients', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const declaring = await openSocket(w.owner, [...INVOLVEMENT]);
    const baseline = await openSocket(phone);

    await put(phone, await sign(w, phone, { revision: 1 }));
    const r2 = await put(phone, await sign(w, phone, { revision: 2 }));
    const frame = await declaring.waitFor(
      (f) =>
        f.t === 'event' &&
        f.event.event_type === 'involvement.updated' &&
        f.event.data.revision === 2,
    );
    expect(frame.event).toMatchObject({
      seq: r2.json.event_seq,
      question_id: null,
      question_revision: null,
      origin_device_id: phone.id,
      data: { revision: 2 },
    });
    expect(Object.keys(frame.event.data)).toEqual(['revision']);
    await settle(300);
    expect(
      baseline.frames.some((f) => f.t === 'event' && f.event.event_type === 'involvement.updated'),
    ).toBe(false);
    declaring.close();
    baseline.close();

    // Only the latest hint is kept, and a client that did not declare the feature is never sent it.
    const hints = (await eventsWith(w.owner, [...INVOLVEMENT])).filter(
      (e) => e.event_type === 'involvement.updated',
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].data).toEqual({ revision: 2 });
    expect((await events(w.owner)).some((e) => e.event_type === 'involvement.updated')).toBe(false);
  });

  it('reading it emits nothing, schedules nothing and notifies no one', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    await put(phone, await sign(w, phone));
    const before = await inRoom((room) => ({
      events: room.q(`SELECT seq FROM events`).length,
      jobs: room.q(`SELECT job_id FROM scheduled_jobs`).length,
    }));
    for (let i = 0; i < 3; i++) await get(w.owner);
    await get(phone);
    const after = await inRoom((room) => ({
      events: room.q(`SELECT seq FROM events`).length,
      jobs: room.q(`SELECT job_id FROM scheduled_jobs`).length,
    }));
    expect(after).toEqual(before);
  });

  it('setting it schedules no notification', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const jobs = () =>
      inRoom((room) => room.q(`SELECT kind FROM scheduled_jobs WHERE kind != 'purge'`));
    const before = await jobs();
    await put(phone, await sign(w, phone));
    expect(await jobs()).toEqual(before);
  });
});

describe('data deletion', () => {
  it('a questions wipe keeps the preference; a full reset removes it', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const record = await sign(w, phone);
    await put(phone, record);
    const wipe = (scope: string) =>
      w.owner.call('POST', '/api/v1/admin/delete-data', {
        protocol_version: PROTOCOL_VERSION,
        confirm: 'DELETE',
        scope,
      });
    expect((await wipe('questions')).status).toBe(200);
    expect((await get(phone)).preference).toEqual(record);
    expect((await wipe('everything')).status).toBe(200);
    expect(await inRoom((room) => room.getMeta('involvement'))).toBeUndefined();
  });
});
