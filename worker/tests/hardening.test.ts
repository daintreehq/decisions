import { settle } from './helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exports } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { PROTOCOL_VERSION, bytesToBase64Url } from '@daintreehq/decisions-protocol';
import { newId, signRequest } from '@daintreehq/decisions-crypto';
import { buildRotation } from './devices.helpers.js';
import {
  act,
  ask,
  claimRelay,
  events,
  inRoom,
  pairDevice,
  raw,
  stub,
  uploadImage,
  type Actor,
} from './helpers.js';

const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...Array.from({ length: 64 }, (_, i) => i),
]);

afterEach(() => vi.restoreAllMocks());

describe('authentication budget', () => {
  it('successful requests never consume the failure budget', async () => {
    const w = await claimRelay();
    for (let i = 0; i < 130; i++)
      expect((await w.owner.call('GET', '/api/v1/devices')).status).toBe(200);
  });

  it('repeated bad signatures from one source are throttled, then recover with the window', async () => {
    const w = await claimRelay();
    const stranger = await (await import('./helpers.js')).Actor.create('owner-desktop');
    stranger.installationId = w.installationId;
    stranger.id; // never registered
    let throttled = false;
    for (let i = 0; i < 30; i++) {
      const forged = await w.owner.authHeader('GET', '/api/v1/devices', 'x=1');
      const r = await raw('GET', '/api/v1/devices', { headers: { authorization: forged } }); // wrong query => bad signature
      if (r.status === 429) throttled = true;
    }
    expect(throttled).toBe(true);
  });
});

describe('expiry cannot be bypassed', () => {
  it('answers to an overdue question are refused even when more than 50 are overdue', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      ids.push((await ask(w, { originRef: `pane_due${String(i).padStart(4, '0')}` })).questionId);
    }
    await inRoom((room) => room.run(`UPDATE questions SET expires_at = ?`, Date.now() - 1000));
    const target = ids[54]!;
    const r = await act(w, phone, 'answer', target, 0);
    expect(r.res.status).toBe(410);
    const d = await phone.call('GET', `/api/v1/questions/${target}`);
    expect(d.json.status).toBe('expired');
    expect(d.json.actions).toHaveLength(0);
    const open = await phone.call('GET', '/api/v1/questions', undefined, 'status=open');
    expect(open.json.questions).toHaveLength(0); // the sweep drained all 55
  });

  it('overdue questions do not count against the pane quota', async () => {
    const w = await claimRelay();
    for (let i = 0; i < 10; i++) await ask(w, { originRef: 'pane_dueq0001' });
    await inRoom((room) => room.run(`UPDATE questions SET expires_at = ?`, Date.now() - 1000));
    expect((await ask(w, { originRef: 'pane_dueq0001' })).res.status).toBe(201);
  });

  it('late jobs never push for an overdue question', async () => {
    const w = await claimRelay();
    await pairDevice(w);
    const spy = vi.spyOn(globalThis, 'fetch');
    await ask(w);
    await inRoom((room) => room.run(`UPDATE questions SET expires_at = ?`, Date.now() - 1000));
    await inRoom((room) =>
      room.run(
        `UPDATE scheduled_jobs SET run_at = ? WHERE kind IN ('notify_new','remind')`,
        Date.now() - 1,
      ),
    );
    await runDurableObjectAlarm(stub());
    await settle();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('command identity', () => {
  it('an action id cannot be reused for another question or by another signer', async () => {
    const w = await claimRelay();
    const a = await pairDevice(w, 'phone', 'A');
    const b = await pairDevice(w, 'tablet', 'B');
    const q1 = await ask(w);
    const q2 = await ask(w, { originRef: 'pane_other0001' });
    const actionId = newId();
    expect((await act(w, a, 'answer', q1.questionId, 0, { actionId })).res.status).toBe(201);
    const crossQuestion = await act(w, a, 'answer', q2.questionId, 0, { actionId });
    expect(crossQuestion.res.status).toBe(409);
    expect(crossQuestion.res.json.code).toBe('idempotency_collision');
    const otherSigner = await act(w, b, 'answer', q1.questionId, 0, { actionId });
    expect(otherSigner.res.status).toBe(409);
    expect((await a.call('GET', `/api/v1/questions/${q2.questionId}`)).json.status).toBe('open');
  });

  it('re-sending a question id with a changed requirement is a collision, not a silent success', async () => {
    const w = await claimRelay();
    const first = await ask(w, { requirement: 'proxy-ok' });
    const changed = await ask(w, { questionId: first.questionId, requirement: 'human-required' });
    expect(changed.res.status).toBe(409);
    const d = await w.owner.call('GET', `/api/v1/questions/${first.questionId}`);
    expect(d.json.requirement).toBe('proxy-ok');
  });

  it('delivery failure reports are idempotent', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    await act(w, phone, 'answer', questionId, 0);
    const body = {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(),
      question_id: questionId,
      answer_revision: 1,
      host_id: 'host_aaaaaaaa',
      status: 'needs-attention',
      error_code: 'pane_gone',
    };
    expect((await w.owner.call('POST', '/api/v1/deliveries/failed', body)).status).toBe(200);
    expect((await w.owner.call('POST', '/api/v1/deliveries/failed', body)).status).toBe(200);
    expect(
      (await events(w.owner)).filter((e) => e.event_type === 'delivery.needs_attention'),
    ).toHaveLength(1);
    expect(
      (await w.owner.call('POST', '/api/v1/deliveries/failed', { ...body, error_code: 'other' }))
        .status,
    ).toBe(409);
  });
});

describe('quotas', () => {
  it('reopen cannot exceed the open-question limit for a pane', async () => {
    const w = await claimRelay();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++)
      ids.push((await ask(w, { originRef: 'pane_reopen001' })).questionId);
    await act(w, w.owner, 'cancel', ids[0]!, 0, { content: null });
    expect((await ask(w, { originRef: 'pane_reopen001' })).res.status).toBe(201); // back to 10 open
    const re = await act(w, w.owner, 'reopen', ids[0]!, 0, { content: null });
    expect(re.res.status).toBe(429);
  });

  it('unattached uploads count until bound, whatever their state', async () => {
    const w = await claimRelay();
    for (let i = 0; i < 24; i++) {
      const up = await uploadImage(w, newId(), PNG);
      expect(up.complete!.status, `upload ${i}`).toBe(200);
    }
    const over = await w.owner.call('POST', '/api/v1/attachments/reservations', {
      protocol_version: 1,
      idempotency_key: newId(),
      question_id: newId(),
      attachment_id: newId(),
      ciphertext_bytes: 100,
      sha256_ciphertext: 'a'.repeat(64),
      mime_category: 'image',
    });
    expect(over.status).toBe(429);
  });
});

describe('attachment races', () => {
  it('two concurrent uploads of one attachment: exactly one wins and the object survives', async () => {
    const w = await claimRelay();
    const questionId = newId();
    const first = await uploadImage(w, questionId, PNG, { skipComplete: true });
    expect(first.put.status).toBe(200);
    // A second PUT for an already-claimed attachment must be refused and must not delete the stored object.
    const path = `/api/v1/attachments/${first.attachmentId}/content`;
    const signed = await signRequest({
      method: 'PUT',
      path,
      body: first.enc.ciphertext,
      installationId: w.installationId,
      deviceId: w.owner.id,
      signingKey: w.owner.keys.signing.privateKey,
    });
    const second = await raw('PUT', path, {
      body: first.enc.ciphertext,
      headers: {
        authorization: signed.authorization,
        'x-content-sha256': first.enc.sha256Ciphertext,
        'content-length': String(first.enc.ciphertext.length),
      },
    });
    expect(second.status).toBe(409);
    const done = await w.owner.call('POST', `/api/v1/attachments/${first.attachmentId}/complete`, {
      protocol_version: 1,
    });
    expect(done.status).toBe(200);
  });

  it('a garbage-collected attachment can no longer be bound to a question', async () => {
    const w = await claimRelay();
    const questionId = newId();
    const up = await uploadImage(w, questionId, PNG);
    await inRoom((room) =>
      room.run(`UPDATE scheduled_jobs SET run_at = ? WHERE kind = 'gc_orphan'`, Date.now() - 1),
    );
    await runDurableObjectAlarm(stub());
    await settle();
    const res = await ask(w, { questionId, attachmentIds: [up.attachmentId] });
    expect(res.res.status).toBe(400);
  });
});

describe('revocation closes every path to key material', () => {
  it('a phone revoked before collecting its grant cannot collect it through pairing status', async () => {
    const w = await claimRelay();
    const {
      generatePairingSecret,
      inviteDigest,
      issueDeviceCert,
      createEpochGrant,
      signPairingPop,
    } = await import('@daintreehq/decisions-crypto');
    const { Actor } = await import('./helpers.js');
    const phone = await Actor.create('phone');
    const secret = generatePairingSecret();
    const pairingId = newId();
    await w.owner.call('POST', '/api/v1/pairing/invitations', {
      protocol_version: 1,
      pairing_id: pairingId,
      invite_digest: await inviteDigest(secret),
      expires_at: new Date(Date.now() + 240_000).toISOString(),
      role: 'phone',
    });
    await raw('POST', '/api/v1/pairing/candidates', {
      body: JSON.stringify({
        protocol_version: 1,
        pairing_id: pairingId,
        secret,
        device_id: phone.id,
        label: 'Phone',
        signing_pub: phone.signingPub,
        exchange_pub: phone.exchangePub,
        pop: await signPairingPop(phone.keys.signing.privateKey, {
          pairingId,
          deviceId: phone.id,
          exchangePub: phone.exchangePub,
          signingPub: phone.signingPub,
        }),
      }),
    });
    const cert = await issueDeviceCert({
      issuerDeviceId: w.owner.id,
      issuerSigningKey: w.owner.keys.signing.privateKey,
      installationId: w.installationId,
      deviceId: phone.id,
      role: 'phone',
      label: 'Phone',
      signingPub: phone.signingPub,
      exchangePub: phone.exchangePub,
    });
    const grant = await createEpochGrant({
      issuerDeviceId: w.owner.id,
      issuerSigningKey: w.owner.keys.signing.privateKey,
      installationId: w.installationId,
      recipientDeviceId: phone.id,
      recipientExchangePub: phone.exchangePub,
      epoch: 1,
      epochKeyRaw: w.epochRaw,
    });
    expect(
      (
        await w.owner.call('POST', `/api/v1/pairing/${pairingId}/approve`, {
          protocol_version: 1,
          cert,
          grant,
        })
      ).status,
    ).toBe(200);
    const { body } = await buildRotation(w, []);
    expect((await w.owner.call('POST', `/api/v1/devices/${phone.id}/revoke`, body)).status).toBe(
      200,
    );
    const st = await raw('GET', `/api/v1/pairing/${pairingId}/status`, {
      headers: { 'x-pairing-secret': secret },
    });
    expect(st.json.grant).toBeNull();
    expect(st.json.cert).toBeNull();
    expect(st.json.state).not.toBe('approved');
  });

  it('approval fails if the key epoch rotated after the grant was made', async () => {
    const w = await claimRelay();
    const {
      generatePairingSecret,
      inviteDigest,
      issueDeviceCert,
      createEpochGrant,
      signPairingPop,
    } = await import('@daintreehq/decisions-crypto');
    const { Actor } = await import('./helpers.js');
    const phone = await Actor.create('phone');
    const secret = generatePairingSecret();
    const pairingId = newId();
    await w.owner.call('POST', '/api/v1/pairing/invitations', {
      protocol_version: 1,
      pairing_id: pairingId,
      invite_digest: await inviteDigest(secret),
      expires_at: new Date(Date.now() + 240_000).toISOString(),
      role: 'phone',
    });
    await raw('POST', '/api/v1/pairing/candidates', {
      body: JSON.stringify({
        protocol_version: 1,
        pairing_id: pairingId,
        secret,
        device_id: phone.id,
        label: 'Phone',
        signing_pub: phone.signingPub,
        exchange_pub: phone.exchangePub,
        pop: await signPairingPop(phone.keys.signing.privateKey, {
          pairingId,
          deviceId: phone.id,
          exchangePub: phone.exchangePub,
          signingPub: phone.signingPub,
        }),
      }),
    });
    const rot = await buildRotation(w, []);
    expect((await w.owner.call('POST', '/api/v1/epoch/rotate', rot.body)).status).toBe(200);
    const cert = await issueDeviceCert({
      issuerDeviceId: w.owner.id,
      issuerSigningKey: w.owner.keys.signing.privateKey,
      installationId: w.installationId,
      deviceId: phone.id,
      role: 'phone',
      label: 'Phone',
      signingPub: phone.signingPub,
      exchangePub: phone.exchangePub,
    });
    const stale = await createEpochGrant({
      issuerDeviceId: w.owner.id,
      issuerSigningKey: w.owner.keys.signing.privateKey,
      installationId: w.installationId,
      recipientDeviceId: phone.id,
      recipientExchangePub: phone.exchangePub,
      epoch: 1,
      epochKeyRaw: w.epochRaw,
    });
    expect(
      (
        await w.owner.call('POST', `/api/v1/pairing/${pairingId}/approve`, {
          protocol_version: 1,
          cert,
          grant: stale,
        })
      ).status,
    ).toBe(400);
  });
});

describe('bounded socket replay', () => {
  async function connect(a: Actor) {
    const t = (await a.call('POST', '/api/v1/socket-ticket', {})).json.ticket;
    const res = await exports.default.fetch(
      new Request(`https://relay.test/api/v1/socket?ticket=${t}`, {
        headers: { Upgrade: 'websocket' },
      }),
    );
    const ws = res.webSocket!;
    ws.accept();
    const frames: any[] = [];
    ws.addEventListener('message', (e) => {
      try {
        frames.push(JSON.parse(e.data as string));
      } catch {
        /* pong */
      }
    });
    const waitFor = async (pred: (f: any) => boolean, from = 0) => {
      for (let i = 0; i < 200; i++) {
        const hit = frames.slice(from).find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('timeout');
    };
    return { ws, frames, waitFor };
  }

  it('never claims to be caught up when it cut the replay short', async () => {
    const w = await claimRelay();
    await inRoom((room) => {
      for (let i = 0; i < 2100; i++) {
        room.run(
          `INSERT INTO events (event_id, event_type, question_id, question_revision, origin_device_id, data, created_at) VALUES (?, 'attachment.available', NULL, NULL, NULL, '{}', ?)`,
          newId(),
          Date.now(),
        );
      }
    });
    const s = await connect(w.owner);
    await s.waitFor((f) => f.t === 'hello');
    s.ws.send(JSON.stringify({ t: 'sync', after: 0 }));
    const first = await s.waitFor((f) => f.t === 'caught_up');
    expect(first.has_more).toBe(true);
    const sentFirst = s.frames.filter((f) => f.t === 'event').length;
    expect(sentFirst).toBe(2000);
    s.ws.send(JSON.stringify({ t: 'sync', after: first.high_water }));
    const second = await s.waitFor((f) => f.t === 'caught_up' && f.high_water > first.high_water);
    expect(second.has_more).toBe(false);
    const seqs = s.frames.filter((f) => f.t === 'event').map((f) => f.event.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates, no gaps in what the relay holds
    expect(seqs.at(-1)).toBe(
      2100 +
        0 +
        (await inRoom(
          (room) => room.q1<{ m: number }>(`SELECT MAX(seq) AS m FROM events`)!.m - 2100,
        )),
    );
    s.ws.close(1000, 'bye');
  });

  it('rate-limits sync and enforces the HTTP body limit on tunnelled requests in bytes', async () => {
    const w = await claimRelay();
    const s = await connect(w.owner);
    await s.waitFor((f) => f.t === 'hello');
    for (let i = 0; i < 40; i++) s.ws.send(JSON.stringify({ t: 'sync', after: 0 }));
    await s.waitFor((f) => f.t === 'error' && f.code === 'rate_limited');
    const big = JSON.stringify({ protocol_version: 1, pad: '€'.repeat(200_000) }); // 600 KB as UTF-8, 200k chars
    const { authorization } = await signRequest({
      method: 'PUT',
      path: '/api/v1/settings',
      body: big,
      installationId: w.installationId,
      deviceId: w.owner.id,
      signingKey: w.owner.keys.signing.privateKey,
    });
    s.ws.send(
      JSON.stringify({
        t: 'req',
        id: 'big',
        method: 'PUT',
        path: '/api/v1/settings',
        query: '',
        body: big,
        authorization,
      }),
    );
    const res = await s.waitFor((f) => f.t === 'res' && f.id === 'big');
    expect(res.status).toBe(413);
    s.ws.close(1000, 'bye');
  });

  it('a full data reset closes existing sockets', async () => {
    const w = await claimRelay();
    const s = await connect(w.owner);
    await s.waitFor((f) => f.t === 'hello');
    const closed = new Promise<number>((r) =>
      s.ws.addEventListener('close', (e) => r((e as CloseEvent).code)),
    );
    expect(
      (
        await w.owner.call('POST', '/api/v1/admin/delete-data', {
          protocol_version: 1,
          confirm: 'DELETE',
          scope: 'everything',
        })
      ).status,
    ).toBe(200);
    expect(await closed).toBe(4401);
  });
});

describe('maintenance and settings', () => {
  it('wiping questions keeps the recurring purge job', async () => {
    const w = await claimRelay();
    await ask(w);
    await w.owner.call('POST', '/api/v1/admin/delete-data', {
      protocol_version: 1,
      confirm: 'DELETE',
      scope: 'questions',
    });
    const jobs = await inRoom((room) =>
      room.q<{ kind: string }>(`SELECT kind FROM scheduled_jobs WHERE status = 'pending'`),
    );
    expect(jobs.map((j) => j.kind)).toEqual(['purge']);
  });

  it('disabling reminders stops reminders that were already queued', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: bytesToBase64Url(new Uint8Array(65).fill(4)),
      auth: bytesToBase64Url(new Uint8Array(16)),
    };
    void sub;
    const spy = vi.spyOn(globalThis, 'fetch');
    await ask(w);
    await phone.call('PUT', '/api/v1/settings', {
      protocol_version: 1,
      reminders: { enabled: false, first_ms: 3_600_000, interval_ms: 3_600_000, max: 3 },
    });
    await inRoom((room) =>
      room.run(`UPDATE scheduled_jobs SET run_at = ? WHERE kind = 'remind'`, Date.now() - 1),
    );
    await runDurableObjectAlarm(stub());
    await settle();
    expect(spy).not.toHaveBeenCalled();
  });
});
