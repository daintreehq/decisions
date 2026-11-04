import { settle } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testEnv as env } from './env.js';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { PushPayload, bytesToBase64Url } from '@daintreehq/decisions-protocol';
import { newId } from '@daintreehq/decisions-crypto';
import {
  act,
  ask,
  claimRelay,
  declare,
  inRoom,
  pairDevice,
  say,
  stub,
  type Actor,
  type World,
} from './helpers.js';

async function subscription() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const p256dh = bytesToBase64Url(
    new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer),
  );
  const auth = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${newId()}`, p256dh, auth };
}

async function subscribe(phone: Actor) {
  const sub = await subscription();
  const r = await phone.call('POST', '/api/v1/push/subscriptions', { protocol_version: 1, ...sub });
  expect(r.status).toBe(201);
  return { ...sub, id: r.json.subscription_id as string };
}

/** Moves every pending job of `kind` to "due now" and runs the single alarm once. */
async function runDue(kind?: string) {
  await inRoom((room) =>
    room.run(
      `UPDATE scheduled_jobs SET run_at = ? WHERE status = 'pending' ${kind ? `AND kind = '${kind}'` : ''}`,
      Date.now() - 1,
    ),
  );
  await runDurableObjectAlarm(stub());
  await settle();
}

const pending = (kind?: string) =>
  inRoom((room) =>
    room.q<{
      kind: string;
      question_id: string;
      payload: string;
      run_at: number;
      attempt_count: number;
      status: string;
    }>(
      `SELECT kind, question_id, payload, run_at, attempt_count, status FROM scheduled_jobs ${kind ? `WHERE kind = '${kind}'` : ''} ORDER BY run_at`,
    ),
  );

/**
 * Waits for the room's own alarm runs to finish, then checks that the one alarm is set at the earliest pending
 * job. workerd fires a due alarm by itself, and while that handler runs `getAlarm()` reads null until the
 * handler sets the next alarm, so a single read can land mid-run. The alarm and the jobs are read together.
 */
async function expectAlarmAtEarliestJob() {
  await vi.waitFor(
    async () => {
      const { alarm, next } = await inRoom(async (room, state) => ({
        next: room.q1<{ m: number | null }>(
          `SELECT MIN(run_at) AS m FROM scheduled_jobs WHERE status = 'pending'`,
        )!.m,
        alarm: await state.storage.getAlarm(),
      }));
      expect(next).toBeGreaterThan(Date.now());
      expect(alarm).toBe(next);
    },
    { timeout: 5000, interval: 20 },
  );
}

describe('push, reminders and expiry', () => {
  let w: World;
  let phone: Actor;
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 201;
  // Holds every push send while true, stalling the alarm run that makes it. A flag rather than a promise: the
  // send runs in the Durable Object's context, and a promise settled across contexts crashes workerd.
  let held = false;

  beforeEach(async () => {
    calls.length = 0;
    status = 201;
    held = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      while (held) await new Promise((r) => setTimeout(r, 5));
      return new Response(null, { status });
    }) as never);
    w = await claimRelay();
    phone = await pairDevice(w);
  });
  afterEach(() => {
    held = false;
    vi.restoreAllMocks();
  });

  it('rejects subscriptions to anything but a known push service (SSRF)', async () => {
    const base = await subscription();
    for (const endpoint of [
      'https://127.0.0.1/x',
      'http://fcm.googleapis.com/x',
      'https://evil.example/x',
      'https://fcm.googleapis.com.evil.example/x',
    ]) {
      const r = await phone.call('POST', '/api/v1/push/subscriptions', {
        protocol_version: 1,
        ...base,
        endpoint,
      });
      expect(r.status, endpoint).toBe(400);
    }
    expect(
      (await w.owner.call('POST', '/api/v1/push/subscriptions', { protocol_version: 1, ...base }))
        .status,
    ).toBe(403); // desktops don't subscribe
  });

  it('caps subscriptions per device and upserts the same endpoint', async () => {
    const sub = await subscription();
    const a = await phone.call('POST', '/api/v1/push/subscriptions', {
      protocol_version: 1,
      ...sub,
    });
    const b = await phone.call('POST', '/api/v1/push/subscriptions', {
      protocol_version: 1,
      ...sub,
    });
    expect(b.json.subscription_id).toBe(a.json.subscription_id);
    for (let i = 0; i < 4; i++) await subscribe(phone);
    expect(
      (
        await phone.call('POST', '/api/v1/push/subscriptions', {
          protocol_version: 1,
          ...(await subscription()),
        })
      ).status,
    ).toBe(403);
    expect(
      (await phone.call('DELETE', `/api/v1/push/subscriptions/${a.json.subscription_id}`)).status,
    ).toBe(200);
    expect(
      (await phone.call('DELETE', `/api/v1/push/subscriptions/${a.json.subscription_id}`)).status,
    ).toBe(404);
  });

  it('sends a generic, encrypted push for a new human-required question', async () => {
    await subscribe(phone);
    const { questionId } = await ask(w);
    await runDue('notify_new');
    expect(calls).toHaveLength(1);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toMatch(/^https:\/\/fcm\.googleapis\.com\/fcm\/send\//);
    expect(h['Content-Encoding']).toBe('aes128gcm');
    expect(h.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(h.Topic).toHaveLength(32);
    expect(h.Urgency).toBe('high');
    // the question text never reaches the push service: the body is opaque ciphertext
    const body = calls[0]!.init.body as Uint8Array;
    expect(new TextDecoder('latin1').decode(body)).not.toContain(questionId);
    expect(body.length).toBeGreaterThan(80);
  });

  it('push test reports delivery and disables a gone subscription', async () => {
    const s = await subscribe(phone);
    const ok = await phone.call('POST', '/api/v1/push/test', {});
    expect(ok.json).toMatchObject({ attempted: 1, delivered: 1 });
    status = 410;
    const gone = await phone.call('POST', '/api/v1/push/test', {});
    expect(gone.json).toMatchObject({ attempted: 1, delivered: 0 });
    const row = await inRoom((room) =>
      room.q1<{ enabled: number; last_error_code: string }>(
        `SELECT enabled, last_error_code FROM push_subscriptions WHERE subscription_id = ?`,
        s.id,
      ),
    );
    expect(row).toMatchObject({ enabled: 0, last_error_code: 'gone' });
    expect((await phone.call('POST', '/api/v1/push/test', {})).json.attempted).toBe(0);
  });

  it('retries transient push failures with backoff instead of dropping the notification', async () => {
    await subscribe(phone);
    status = 503;
    await ask(w);
    // The notify_new is due at once, so the room's own alarm makes the first attempt. Running it by hand
    // as well could make a second one.
    await vi.waitFor(
      async () => expect((await pending('notify_new'))[0]?.attempt_count).toBe(1),
      { timeout: 5000, interval: 20 },
    );
    const [job] = await pending('notify_new');
    expect(job).toMatchObject({ status: 'pending', attempt_count: 1 });
    expect(job!.run_at).toBeGreaterThan(Date.now());
    status = 201;
    calls.length = 0;
    await runDue('notify_new');
    expect(calls).toHaveLength(1);
    expect((await pending('notify_new'))[0]!.status).toBe('done');
  });

  it('proxy-first questions wait for the proxy: no push until it abstains', async () => {
    await subscribe(phone);
    const { questionId } = await ask(w, { requirement: 'proxy-first' });
    const [grace] = await pending('notify_new');
    expect(grace!.run_at).toBeGreaterThan(Date.now() + 60_000); // ~90 s grace
    await act(w, w.owner, 'proxy-abstain', questionId, 0, { content: null });
    await runDue('notify_new');
    expect(calls).toHaveLength(1);
  });

  it('a proxy answer pushes a review request, and the grace-period push is cancelled', async () => {
    await subscribe(phone);
    const { questionId } = await ask(w, { requirement: 'proxy-ok' });
    await act(w, w.owner, 'proxy-answer', questionId, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.9,
      },
    });
    await runDue('notify_new');
    expect(calls).toHaveLength(1); // only the proxy-review notice
    const kinds = (await pending()).map((j) => j.kind + ':' + j.status);
    expect(kinds).toContain('proxy_review:pending');
  });

  it('reminders chain up to the limit and stop once a human answers', async () => {
    await subscribe(phone);
    const { questionId } = await ask(w);
    await runDue('notify_new'); // the initial notification is separate from reminders
    for (let n = 1; n <= 3; n++) {
      calls.length = 0;
      await runDue('remind');
      expect(calls, `reminder ${n}`).toHaveLength(1);
    }
    const left = (await pending('remind')).filter((j) => j.status === 'pending');
    expect(left).toHaveLength(0); // 3 reminders max

    const b = await ask(w, { originRef: 'pane_remind002' });
    await act(w, phone, 'answer', b.questionId, 0);
    calls.length = 0;
    await runDue('remind');
    expect(calls).toHaveLength(0);
    void questionId;
  });

  it('quiet hours defer pushes without losing them', async () => {
    await subscribe(phone);
    const put = await phone.call('PUT', '/api/v1/settings', {
      protocol_version: 1,
      quiet_hours: { enabled: true, start: '00:00', end: '23:59', time_zone: 'UTC' },
    });
    expect(put.status).toBe(200);
    await ask(w);
    await runDue('notify_new');
    expect(calls).toHaveLength(0);
    const [job] = await pending('notify_new');
    expect(job).toMatchObject({ status: 'pending' });
    expect(job!.run_at).toBeGreaterThan(Date.now());
    await phone.call('PUT', '/api/v1/settings', {
      protocol_version: 1,
      quiet_hours: { enabled: false, start: '00:00', end: '23:59', time_zone: 'UTC' },
    });
    await runDue('notify_new');
    expect(calls).toHaveLength(1);
  });

  it('the alarm expires due questions and tells the desktop', async () => {
    const { questionId } = await ask(w, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await inRoom((room) =>
      room.run(
        `UPDATE questions SET expires_at = ? WHERE question_id = ?`,
        Date.now() - 1,
        questionId,
      ),
    );
    await runDue('expire');
    const d = await phone.call('GET', `/api/v1/questions/${questionId}`);
    expect(d.json.status).toBe('expired');
    const evs = (await w.owner.call('GET', '/api/v1/events', undefined, 'after=0')).json.events;
    expect(evs.filter((e: any) => e.event_type === 'decision.expired')).toHaveLength(1);
    // reminders for an expired question are cancelled
    calls.length = 0;
    await runDue('remind');
    expect(calls).toHaveLength(0);
  });

  it('keeps exactly one alarm scheduled for the earliest pending job', async () => {
    await ask(w); // its notify_new is due now, so the room's own alarm fires and runs it
    await expectAlarmAtEarliestJob();
    expect((await pending('notify_new')).map((j) => j.status)).toEqual(['done']);
  });

  it('keeps the alarm a transaction sets while an alarm run is in flight', async () => {
    await subscribe(phone);
    held = true;
    let soon = 0;
    try {
      const { questionId } = await ask(w);
      // The room's own alarm fires for the notify_new and stalls in its push send.
      await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5000 });
      // Until a running handler sets the next alarm, workerd reports none, so the plugin's hand-run does
      // nothing and an immediate read sees null.
      expect(await inRoom((_r, state) => state.storage.getAlarm())).toBeNull();
      expect(await runDurableObjectAlarm(stub())).toBe(false);
      // A transaction withdraws the job being run and schedules one shortly after, so it sets the alarm the
      // handler's own refresh then finds already stored and leaves alone.
      soon = Date.now() + 500;
      await inRoom((room) =>
        room.tx(() => {
          room.cancelJobs({ questionId });
          room.schedule({ kind: 'purge', runAt: soon });
        }),
      );
      expect(await inRoom((_r, state) => state.storage.getAlarm())).toBe(soon);
    } finally {
      held = false;
    }
    // The handler finishing does not take that alarm with it: the job still runs.
    await vi.waitFor(
      async () =>
        expect((await pending('purge')).find((j) => j.run_at === soon)?.status).toBe('done'),
      { timeout: 5000, interval: 20 },
    );
    await expectAlarmAtEarliestJob();
  });
});

describe('settings, voice sessions and admin', () => {
  it('validates and persists settings; rejects unknown time zones', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    expect((await phone.call('GET', '/api/v1/settings')).json.settings.reminders.max).toBe(3);
    expect(
      (
        await phone.call('PUT', '/api/v1/settings', {
          protocol_version: 1,
          quiet_hours: { enabled: true, start: '22:00', end: '07:00', time_zone: 'Mars/Olympus' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await phone.call('PUT', '/api/v1/settings', {
          protocol_version: 1,
          quiet_hours: { enabled: true, start: '25:00', end: '07:00', time_zone: 'UTC' },
        })
      ).status,
    ).toBe(400);
    const ok = await phone.call('PUT', '/api/v1/settings', {
      protocol_version: 1,
      reminders: { enabled: true, first_ms: 3_600_000, interval_ms: 7_200_000, max: 2 },
      attachment_retention_days: 7,
    });
    expect(ok.json.settings).toMatchObject({ attachment_retention_days: 7, reminders: { max: 2 } });
    expect(
      (await w.owner.call('GET', '/api/v1/settings')).json.settings.attachment_retention_days,
    ).toBe(7);
  });

  it('voice sessions require consent, a configured provider and a human device', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const body = { protocol_version: 1, provider: 'xai', consent: true, keyterms: [] };
    expect(
      (await phone.call('POST', '/api/v1/voice/session', { ...body, consent: false })).status,
    ).toBe(400);
    const notConfigured = await phone.call('POST', '/api/v1/voice/session', body);
    expect(notConfigured.status).toBe(503);
    expect(notConfigured.json.code).toBe('not_configured');
    expect((await w.owner.call('POST', '/api/v1/voice/session', body)).status).toBe(403);
    expect((await env.XAI_API_KEY) ?? '').toBe('');
  });

  it('voice correction needs a signed human device and degrades to a retryable error', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const body = {
      protocol_version: 1,
      provider: 'anthropic',
      consent: true,
      raw_transcript: 'yes ship it',
      question: 'Ship?',
      option_labels: [],
      keyterms: [],
    };
    const { exports } = await import('cloudflare:workers');
    const unsigned = await exports.default.fetch(
      new Request('https://relay.test/api/v1/voice/correct', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
    expect(unsigned.status).toBe(401);
    const text = JSON.stringify(body);
    const auth = await phone.authHeader('POST', '/api/v1/voice/correct', '', text);
    const res = await exports.default.fetch(
      new Request('https://relay.test/api/v1/voice/correct', {
        method: 'POST',
        body: text,
        headers: { authorization: auth },
      }),
    );
    expect(res.status).toBe(503); // no provider key configured in tests
    const json = (await res.json()) as { code: string; message: string };
    expect(json.code).toBe('temporarily_unavailable');
    expect(json.message).not.toMatch(/anthropic|key/i);
  });

  it('diagnostics expose counters only, never content', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    await ask(w);
    const d = await w.owner.call('GET', '/api/v1/admin/diagnostics');
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({
      key_epoch: 1,
      counts: { devices: 2, questions: 1 },
      jobs: { failed: 0 },
    });
    expect(d.json.jobs.pending).toBeGreaterThan(0);
    expect(d.json.jobs.next_run_at).toBeTruthy(); // the alarm itself may already have fired and re-armed
    expect(JSON.stringify(d.json)).not.toMatch(/ciphertext|signing_pub/);
    expect((await phone.call('GET', '/api/v1/admin/diagnostics')).status).toBe(403);
  });

  it('delete-data wipes questions or everything, and "everything" releases the claim', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const q = await ask(w);
    expect(
      (
        await phone.call('POST', '/api/v1/admin/delete-data', {
          protocol_version: 1,
          confirm: 'DELETE',
          scope: 'questions',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await w.owner.call('POST', '/api/v1/admin/delete-data', {
          protocol_version: 1,
          confirm: 'nope',
          scope: 'questions',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await w.owner.call('POST', '/api/v1/admin/delete-data', {
          protocol_version: 1,
          confirm: 'DELETE',
          scope: 'questions',
        })
      ).status,
    ).toBe(200);
    expect((await phone.call('GET', `/api/v1/questions/${q.questionId}`)).status).toBe(404);
    expect((await phone.call('GET', '/api/v1/devices')).status).toBe(200); // devices kept
    expect(
      (
        await w.owner.call('POST', '/api/v1/admin/delete-data', {
          protocol_version: 1,
          confirm: 'DELETE',
          scope: 'everything',
        })
      ).status,
    ).toBe(200);
    const { raw } = await import('./helpers.js');
    expect((await raw('GET', '/api/v1/info')).json.claimed).toBe(false);
    expect((await phone.call('GET', '/api/v1/devices')).status).toBe(401);
  });
});

/* ---------- reply pushes for thread messages (docs/protocol.md section 16.2) ---------- */

const utf8 = (t: string) => new TextEncoder().encode(t);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8),
  );
}

/** A push subscriber that keeps its private key, so a test can read exactly what the relay sent. */
async function subscriber(phone: Actor) {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const r = await phone.call('POST', '/api/v1/push/subscriptions', {
    protocol_version: 1,
    endpoint: `https://fcm.googleapis.com/fcm/send/${newId()}`,
    p256dh: bytesToBase64Url(pub),
    auth: bytesToBase64Url(auth),
  });
  expect(r.status).toBe(201);
  /** RFC 8291 / RFC 8188 (aes128gcm, one record), the way a browser's push service client opens it. */
  const open = async (body: Uint8Array): Promise<unknown> => {
    const salt = body.slice(0, 16);
    const idlen = body[20]!;
    const serverPub = body.slice(21, 21 + idlen);
    const serverKey = await crypto.subtle.importKey(
      'raw',
      serverPub,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'ECDH', public: serverKey } as never,
        kp.privateKey,
        256,
      ),
    );
    const ikm = await hkdf(auth, shared, concat(utf8('WebPush: info\0'), pub, serverPub), 32);
    const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
    const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)),
    );
    let end = plain.length - 1;
    while (end > 0 && plain[end] === 0) end--;
    expect(plain[end]).toBe(2); // last-record delimiter
    return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
  };
  return { open };
}

describe('reply pushes', () => {
  let w: World;
  let phone: Actor;
  const calls: { url: string; init: RequestInit }[] = [];

  beforeEach(async () => {
    calls.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 201 });
    }) as never);
    w = await claimRelay();
    await declare(w.owner);
    phone = await pairDevice(w);
  });
  afterEach(() => vi.restoreAllMocks());

  /** Sends the new-question push first, so only what follows is counted. */
  async function asked(opts?: Parameters<typeof ask>[1]) {
    const { questionId } = await ask(w, opts);
    await runDue('notify_new');
    calls.length = 0;
    return questionId;
  }

  it('pushes the same content-free notice as a new question when an agent message expects a reply', async () => {
    const s = await subscriber(phone);
    const questionId = await asked();
    const msg = await say(w, w.owner, questionId, { expectsReply: true, text: 'Which footer?' });
    expect(msg.res.status).toBe(201);
    await runDue('notify_reply');
    expect(calls).toHaveLength(1);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Urgency).toBe('high');
    expect(h.Topic).toHaveLength(32);
    const payload = await s.open(calls[0]!.init.body as Uint8Array);
    // A type and the question id, exactly: no message id, no text, nothing about the pane.
    expect(payload).toEqual({ type: 'decision-reply', question_id: questionId });
    expect(PushPayload.safeParse(payload).success).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(msg.messageId);

    // An answered question that the agent asks about again pushes too.
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(201);
    calls.length = 0;
    await say(w, w.owner, questionId, { expectsReply: true });
    await runDue('notify_reply');
    expect(calls).toHaveLength(1);
    expect(await s.open(calls[0]!.init.body as Uint8Array)).toEqual({
      type: 'decision-reply',
      question_id: questionId,
    });
  });

  it('pushes nothing for an agent message that asks nothing, or for a human message', async () => {
    await subscriber(phone);
    const questionId = await asked();
    expect((await say(w, w.owner, questionId)).res.status).toBe(201);
    expect((await say(w, phone, questionId)).res.status).toBe(201);
    expect(await pending('notify_reply')).toEqual([]);
    await runDue('notify_reply');
    expect(calls).toEqual([]);
  });

  /** Quiet hours from an hour ago to an hour from now (UTC), so the hold is certain whenever the test runs. */
  const quiet = (enabled: boolean) => {
    const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    return inRoom((room) =>
      room.setMeta(
        'settings',
        JSON.stringify({
          quiet_hours: {
            enabled,
            start: hhmm(Date.now() - 3_600_000),
            end: hhmm(Date.now() + 3_600_000),
            time_zone: 'UTC',
          },
        }),
      ),
    );
  };
  const replyJobs = async (questionId: string) =>
    (await pending('notify_reply')).filter((j) => j.question_id === questionId);

  it('holds a reply push through quiet hours, and sends it after', async () => {
    const s = await subscriber(phone);
    const questionId = await asked();
    await quiet(true);
    await say(w, w.owner, questionId, { expectsReply: true });
    await runDue('notify_reply');
    expect(calls).toEqual([]);
    const [held] = await replyJobs(questionId);
    expect(held!.status).toBe('pending');
    expect(held!.run_at).toBeGreaterThan(Date.now() + 30 * 60_000);
    await quiet(false);
    await runDue('notify_reply');
    expect(calls).toHaveLength(1);
    expect(await s.open(calls[0]!.init.body as Uint8Array)).toEqual({
      type: 'decision-reply',
      question_id: questionId,
    });
  });

  it('drops a held reply push once the person has answered it, in the thread or otherwise', async () => {
    await subscriber(phone);
    // The person writes back.
    const wroteBack = await asked();
    await quiet(true);
    await say(w, w.owner, wroteBack, { expectsReply: true });
    await say(w, phone, wroteBack);
    // The person confirms the model's answer: a human action after the request, though it cancels no push job.
    const proxied = await asked({ requirement: 'proxy-ok' });
    const proxy = await act(w, w.owner, 'proxy-answer', proxied, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.9,
      },
    });
    expect(proxy.res.status).toBe(201);
    await say(w, w.owner, proxied, { expectsReply: true });
    // Run it into its quiet-hour deferral first, so the runtime's own alarm cannot settle it early.
    await runDue('notify_reply');
    const [deferred] = await replyJobs(proxied);
    expect(deferred).toMatchObject({ status: 'pending' });
    expect(deferred!.run_at).toBeGreaterThan(Date.now() + 30 * 60_000);
    const confirm = await act(w, phone, 'confirm-proxy', proxied, 1, {
      content: null,
      confirmsActionId: proxy.signed.record.action_id,
    });
    expect(confirm.res.status).toBe(201);
    expect((await replyJobs(proxied)).map((j) => j.status)).toEqual(['pending']);
    // The agent withdraws its request with a message that asks nothing.
    const withdrawn = await asked();
    await say(w, w.owner, withdrawn, { expectsReply: true });
    await say(w, w.owner, withdrawn, { expectsReply: false });

    await quiet(false);
    calls.length = 0;
    await runDue('notify_reply');
    expect(calls).toEqual([]);
    for (const q of [wroteBack, proxied, withdrawn])
      expect((await replyJobs(q)).map((j) => j.status)).toEqual(['done']);
  });

  it('keeps one reply push per question, and a cancelled question takes it along', async () => {
    await subscriber(phone);
    const twice = await asked();
    await quiet(true);
    await say(w, w.owner, twice, { expectsReply: true });
    await say(w, w.owner, twice, { expectsReply: true });
    expect((await replyJobs(twice)).map((j) => j.status).sort()).toEqual(['cancelled', 'pending']);
    expect((await act(w, w.owner, 'cancel', twice, 0)).res.status).toBe(201);
    expect((await replyJobs(twice)).map((j) => j.status)).toEqual(['cancelled', 'cancelled']);
    await quiet(false);
    await runDue('notify_reply');
    expect(calls).toEqual([]);
  });
});
