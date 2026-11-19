import { settle } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testEnv as env } from './env.js';
import { runDurableObjectAlarm } from 'cloudflare:test';
import {
  AgentStoppedPushResponse,
  LIMITS,
  PresenceResponse,
  PushPayload,
  bytesToBase64Url,
} from '@daintreehq/decisions-protocol';
import { newId } from '@daintreehq/decisions-crypto';
import { PRESENCE_META, presenceHold } from '../src/room/presence.js';
import { PROXY_GRACE_MS } from '../src/routes/questions.js';
import { AGENT_STOPPED_RATE_KEY } from '../src/routes/push.js';
import { sendNotification } from '../src/jobs/notify.js';
import type { Room } from '../src/room/types.js';
import {
  act,
  ask,
  claimRelay,
  declare,
  enrollHost,
  events,
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
 * Polls until the room's alarm is set at the earliest pending job and that job lies in the future. workerd
 * fires a due alarm by itself, and while that handler runs `getAlarm()` reads null until the handler sets the
 * next alarm, so a single read can land mid-run. Each poll reads the alarm and the jobs together; a lost alarm
 * never matches, and the wait times out on the last mismatch.
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
    await vi.waitFor(async () => expect((await pending('notify_new'))[0]?.attempt_count).toBe(1), {
      timeout: 5000,
      interval: 20,
    });
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
      // handler's own refresh then finds already stored and leaves alone. The time is taken inside the object,
      // so the alarm is stored before it passes.
      soon = await inRoom(async (room) => {
        const at = Date.now() + 500;
        await room.tx(() => {
          room.cancelJobs({ questionId });
          room.schedule({ kind: 'purge', runAt: at });
        });
        return at;
      });
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

/**
 * A push subscriber that keeps its private key, so a test can read exactly what the relay sent. `features` is the
 * subscription's declaration of what its service worker can show; `resubscribe` sends the same endpoint again.
 */
async function subscriber(phone: Actor, features?: string[]) {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = `https://fcm.googleapis.com/fcm/send/${newId()}`;
  const resubscribe = (declared?: string[]) =>
    phone.call('POST', '/api/v1/push/subscriptions', {
      protocol_version: 1,
      endpoint,
      p256dh: bytesToBase64Url(pub),
      auth: bytesToBase64Url(auth),
      ...(declared ? { features: declared } : {}),
    });
  const r = await resubscribe(features);
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
  return { open, endpoint, resubscribe, id: r.json.subscription_id as string, created: r.json };
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

  it('counts an answer made on the owner desktop as the person answering', async () => {
    await subscriber(phone);
    await declare(w.owner, ['thread-messages-v1', 'owner-desktop-answers-v1']);
    const questionId = await asked();
    await quiet(true);
    await say(w, w.owner, questionId, { expectsReply: true });
    await runDue('notify_reply');
    expect((await replyJobs(questionId)).map((j) => j.status)).toEqual(['pending']);
    expect((await act(w, w.owner, 'answer', questionId, 0)).res.status).toBe(201);
    // The answer cancels the held push; put it back, so only the alarm's own check can drop it.
    await inRoom((room) =>
      room.run(
        `UPDATE scheduled_jobs SET status = 'pending' WHERE kind = 'notify_reply' AND question_id = ?`,
        questionId,
      ),
    );
    await quiet(false);
    calls.length = 0;
    await runDue('notify_reply');
    expect(calls).toEqual([]);
    expect((await replyJobs(questionId)).map((j) => j.status)).toEqual(['done']);
  });

  it('counts a message from the owner desktop as the person writing back', async () => {
    await subscriber(phone);
    await declare(w.owner, ['thread-messages-v1', 'owner-desktop-messages-v1']);
    const questionId = await asked();
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(201);
    await quiet(true);
    await say(w, w.owner, questionId, { expectsReply: true });
    // Run it into its quiet-hour deferral first, so the runtime's own alarm cannot settle it early.
    await runDue('notify_reply');
    expect((await replyJobs(questionId)).map((j) => j.status)).toEqual(['pending']);
    // The person replies on the computer: a human message, which cancels no push job.
    expect((await say(w, w.owner, questionId, { side: 'human' })).res.status).toBe(201);
    expect((await replyJobs(questionId)).map((j) => j.status)).toEqual(['pending']);
    await quiet(false);
    calls.length = 0;
    await runDue('notify_reply');
    expect(calls).toEqual([]);
    expect((await replyJobs(questionId)).map((j) => j.status)).toEqual(['done']);
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

describe("presence holds a new question's push (docs/protocol.md section 11)", () => {
  let w: World;
  let phone: Actor;
  const calls: { url: string; init: RequestInit }[] = [];
  let first: Awaited<ReturnType<typeof subscribe>>;
  /**
   * The least time left on a hold a test checks: the room's own alarm fires a due job by itself, so a hold that
   * ends sooner could send while the test still expects nothing.
   */
  const MARGIN = 45_000;

  beforeEach(async () => {
    calls.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 201 });
    }) as never);
    w = await claimRelay();
    phone = await pairDevice(w);
    first = await subscribe(phone);
  });
  afterEach(() => vi.restoreAllMocks());

  const present = (a: Actor, on = true) =>
    a.call('PUT', '/api/v1/presence', { protocol_version: 1, present: on });
  const lease = () => inRoom((room) => room.getMeta(PRESENCE_META));
  /** Sets when the lease ends, as if relay time had moved on. */
  const leaseEnds = (at: number) => inRoom((room) => room.setMeta(PRESENCE_META, String(at)));
  /** Moves a question's creation `ms` into the past, as if that long had passed since. */
  const age = (questionId: string, ms: number) =>
    inRoom((room) =>
      room.run(
        `UPDATE questions SET created_at = created_at - ? WHERE question_id = ?`,
        ms,
        questionId,
      ),
    );
  /** Moves a question's latest reopen `ms` into the past. */
  const ageReopen = (questionId: string, ms: number) =>
    inRoom((room) =>
      room.run(
        `UPDATE actions SET created_at = created_at - ? WHERE action_id = (
           SELECT action_id FROM actions WHERE question_id = ? AND action = 'reopen' ORDER BY event_seq DESC LIMIT 1)`,
        ms,
        questionId,
      ),
    );
  const createdAt = (questionId: string) =>
    inRoom(
      (room) =>
        room.q1<{ created_at: number }>(
          `SELECT created_at FROM questions WHERE question_id = ?`,
          questionId,
        )!.created_at,
    );
  const newPushes = async (questionId: string) =>
    (await pending('notify_new')).filter((j) => j.question_id === questionId);
  const heldPush = async (questionId: string) =>
    (await newPushes(questionId)).find((j) => j.status === 'pending');
  /** Quiet hours that hold for hours either side of now, whatever the time of day. */
  const quiet = (enabled: boolean) => {
    const h = new Date().getUTCHours();
    const at = (n: number) => `${String((n + 24) % 24).padStart(2, '0')}:00`;
    return phone.call('PUT', '/api/v1/settings', {
      protocol_version: 1,
      quiet_hours: { enabled, start: at(h - 2), end: at(h + 3), time_zone: 'UTC' },
    });
  };

  it('takes presence from the owner desktop only, as a lease that keeps nothing else', async () => {
    const { host } = await enrollHost(w);
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    await present(w.owner);
    const seeded = await lease();
    for (const a of [phone, tablet, host]) expect((await present(a)).status).toBe(403);
    for (const body of [
      { protocol_version: 1 },
      { protocol_version: 1, present: 'false' },
      { protocol_version: 1, present: 0 },
      { protocol_version: 1, present: null },
      { protocol_version: 2, present: true },
    ]) {
      const r = await w.owner.call('PUT', '/api/v1/presence', body);
      expect(r.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
    }
    expect(await lease()).toBe(seeded);

    // A renewal replaces the lease's end with a fresh one, even when the old one was about to lapse.
    await leaseEnds(Date.now() + 5_000);
    const jobs = (await pending()).length;
    const evs = (await events(w.owner)).length;
    const before = Date.now();
    const on = await present(w.owner);
    expect(on.status).toBe(200);
    const res = PresenceResponse.parse(on.json);
    expect(res.present).toBe(true);
    const until = Date.parse(res.until!);
    expect(until).toBeGreaterThanOrEqual(before + LIMITS.presenceLeaseMs);
    expect(until).toBeLessThanOrEqual(Date.now() + LIMITS.presenceLeaseMs);
    expect(await lease()).toBe(String(until));

    const off = await present(w.owner, false);
    expect(off.json).toEqual({ present: false, until: null });
    expect(await lease()).toBeUndefined();
    // No job, event or push: presence is a lease and nothing more.
    expect((await pending()).length).toBe(jobs);
    expect((await events(w.owner)).length).toBe(evs);
    expect(calls).toEqual([]);
  });

  it('reads only a current, well-formed lease, and nothing else without one', () => {
    const now = 1_800_000_000_000;
    const q = { question_id: 'q_presence01', created_at: now };
    /** A room holding `lease`, whose question history must not be read unless the lease is current. */
    const room = (lease: string | undefined, history = false) =>
      ({
        getMeta: (key: string) => (key === PRESENCE_META ? lease : undefined),
        q1: () => {
          if (!history) throw new Error('read the question history without a current lease');
          return undefined;
        },
      }) as unknown as Room;
    // Absent, malformed, lapsed, or ending exactly now: no hold.
    for (const v of [undefined, '', 'soon', 'NaN', 'Infinity', String(now - 1), String(now)])
      expect(presenceHold(room(v), q, now), String(v)).toBeNull();
    expect(presenceHold(room(String(now + 30_000), true), q, now)).toBe(now + 30_000);
    expect(presenceHold(room(String(now + 600_000), true), q, now)).toBe(
      now + LIMITS.presenceHoldMs,
    );
  });

  it('holds a human-required question while the lease is current, and sends once it lapses', async () => {
    const until = Date.parse((await present(w.owner)).json.until);
    const { questionId } = await ask(w);
    // Held to the lease's end, which comes before the hold's own bound.
    expect((await heldPush(questionId))!.run_at).toBe(until);

    // Run early, it waits again rather than sending, and spends no attempt.
    await runDue('notify_new');
    expect(calls).toEqual([]);
    expect(await heldPush(questionId)).toMatchObject({ run_at: until, attempt_count: 0 });

    // The desktop slept: its lease lapsed, so nothing holds the push any more.
    await leaseEnds(Date.now() - 1);
    await runDue('notify_new');
    expect(calls).toHaveLength(1);
    expect((await newPushes(questionId)).map((j) => j.status)).toEqual(['done']);
  });

  it('never holds past the bound, however often the lease is renewed', async () => {
    await present(w.owner);
    const { questionId } = await ask(w);
    await age(questionId, LIMITS.presenceHoldMs - MARGIN);
    // Renewed now, the lease would outlast the hold: the hold ends first.
    await present(w.owner);
    await runDue('notify_new');
    expect(calls).toEqual([]);
    expect((await heldPush(questionId))!.run_at).toBe(
      (await createdAt(questionId)) + LIMITS.presenceHoldMs,
    );

    await age(questionId, MARGIN);
    await present(w.owner);
    await runDue('notify_new');
    expect(calls).toHaveLength(1);
  });

  it('sends nothing for a question answered, declined, withdrawn or expired during the hold', async () => {
    await declare(w.owner, ['owner-desktop-answers-v1', 'person-declines-v1']);
    await present(w.owner);
    const answered = (await ask(w)).questionId;
    const declined = (await ask(w)).questionId;
    const withdrawn = (await ask(w)).questionId;
    const expired = (await ask(w, { expiresAt: new Date(Date.now() + 90_000).toISOString() }))
      .questionId;
    expect((await newPushes(expired)).map((j) => j.status)).toEqual(['pending']);
    expect((await act(w, w.owner, 'answer', answered, 0)).res.status).toBe(201);
    expect((await act(w, phone, 'cancel', declined, 0)).res.status).toBe(201);
    expect((await act(w, w.owner, 'cancel', withdrawn, 0)).res.status).toBe(201);
    for (const q of [answered, declined, withdrawn])
      expect((await newPushes(q)).map((j) => j.status)).toEqual(['cancelled']);
    // The deadline passed while the push was held, before the expiry job ran.
    await inRoom((room) =>
      room.run(
        `UPDATE questions SET expires_at = ? WHERE question_id = ?`,
        Date.now() - 1,
        expired,
      ),
    );

    // Should a held push outlive its question's resolution, the job's own check still drops it.
    await inRoom((room) =>
      room.run(`UPDATE scheduled_jobs SET status = 'pending' WHERE kind = 'notify_new'`),
    );
    await leaseEnds(Date.now() - 1);
    await runDue('notify_new');
    expect(calls).toEqual([]);
  });

  it('keeps the proxy grace whatever the lease, and holds a push whose grace ends while the person is there', async () => {
    // A lease current at creation lapses before the grace ends: the grace stands as it was.
    await present(w.owner);
    const early = (await ask(w, { requirement: 'proxy-first' })).questionId;
    expect((await heldPush(early))!.run_at).toBe((await createdAt(early)) + PROXY_GRACE_MS);

    // The grace has just ended and a lease is current: the push waits for the person, within the bound.
    const { questionId } = await ask(w, {
      requirement: 'proxy-first',
      originRef: 'pane_presence2',
    });
    await age(questionId, PROXY_GRACE_MS);
    await present(w.owner);
    await runDue('notify_new');
    expect(calls).toEqual([]);
    expect((await heldPush(questionId))!.run_at).toBe(
      (await createdAt(questionId)) + LIMITS.presenceHoldMs,
    );
  });

  it('holds a proxy abstaining only until the hold that began with the question ends', async () => {
    await present(w.owner);
    const { questionId } = await ask(w, { requirement: 'proxy-first' });
    await age(questionId, LIMITS.presenceHoldMs - MARGIN);
    await present(w.owner);
    expect(
      (await act(w, w.owner, 'proxy-abstain', questionId, 0, { content: null })).res.status,
    ).toBe(201);
    expect((await heldPush(questionId))!.run_at).toBe(
      (await createdAt(questionId)) + LIMITS.presenceHoldMs,
    );
    await runDue('notify_new');
    expect(calls).toEqual([]);
    await age(questionId, MARGIN);
    await runDue('notify_new');
    expect(calls).toHaveLength(1);
  });

  it('gives each reopen a hold of its own, counted from the latest reopen', async () => {
    await present(w.owner);
    const { questionId } = await ask(w);
    const reopen = async (expected: number) => {
      expect((await act(w, w.owner, 'cancel', questionId, expected)).res.status).toBe(201);
      expect(
        (await act(w, w.owner, 'reopen', questionId, expected, { content: null })).res.status,
      ).toBe(201);
    };
    await age(questionId, 10 * 60_000);
    await reopen(0);
    expect((await heldPush(questionId))!.run_at).toBeGreaterThan(Date.now());
    await runDue('notify_new');
    expect(calls).toEqual([]);
    await ageReopen(questionId, LIMITS.presenceHoldMs);
    await runDue('notify_new');
    expect(calls).toHaveLength(1);

    // Reopened again: the earlier reopen's hold is spent, the new one's is not.
    calls.length = 0;
    await reopen(1);
    await runDue('notify_new');
    expect(calls).toEqual([]);
    await ageReopen(questionId, LIMITS.presenceHoldMs);
    await runDue('notify_new');
    expect(calls).toHaveLength(1);
  });

  it("keeps a retry's attempts and finished sends while it is held", async () => {
    const second = await subscribe(phone);
    await present(w.owner);
    const { questionId } = await ask(w);
    // A retry, as a transient failure leaves it: the first subscription got the push, the second did not.
    const payload = JSON.stringify({ done: [first.id] });
    await inRoom((room) =>
      room.run(
        `UPDATE scheduled_jobs SET attempt_count = 1, payload = ? WHERE kind = 'notify_new' AND question_id = ?`,
        payload,
        questionId,
      ),
    );
    await runDue('notify_new');
    expect(calls).toEqual([]);
    expect(await heldPush(questionId)).toMatchObject({ attempt_count: 1, payload });

    await leaseEnds(Date.now() - 1);
    await runDue('notify_new');
    expect(calls.map((c) => c.url)).toEqual([second.endpoint]);
  });

  it("holds only a new question's push: a proxy answer, a reply push and a reminder go as before", async () => {
    await declare(w.owner);
    await present(w.owner);
    const proxied = (await ask(w, { requirement: 'proxy-ok' })).questionId;
    await act(w, w.owner, 'proxy-answer', proxied, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.9,
      },
    });
    await runDue('notify_new');
    expect(calls).toHaveLength(1); // the proxy answer's notice

    calls.length = 0;
    const asked = (await ask(w)).questionId;
    await say(w, w.owner, asked, { expectsReply: true });
    await runDue('notify_reply');
    expect(calls).toHaveLength(1);

    calls.length = 0;
    await runDue('remind');
    expect(calls).toHaveLength(1);
    // The new question's own push is still held.
    expect(await heldPush(asked)).toBeTruthy();
  });

  it('leaves quiet hours deferring a push once the hold ends', async () => {
    await present(w.owner);
    await ask(w);
    expect((await quiet(true)).status).toBe(200);
    await leaseEnds(Date.now() - 1);
    await runDue('notify_new');
    expect(calls).toEqual([]);
    expect((await quiet(false)).status).toBe(200);
    await runDue('notify_new');
    expect(calls).toHaveLength(1);
  });

  it('keeps the lease through a questions wipe and drops it with everything', async () => {
    await present(w.owner);
    const wipe = (scope: string) =>
      w.owner.call('POST', '/api/v1/admin/delete-data', {
        protocol_version: 1,
        confirm: 'DELETE',
        scope,
      });
    expect((await wipe('questions')).status).toBe(200);
    expect(await lease()).toBeTruthy();
    expect((await wipe('everything')).status).toBe(200);
    expect(await lease()).toBeUndefined();
  });
});

describe('agent-stopped pushes (docs/protocol.md section 11)', () => {
  let w: World;
  let phone: Actor;
  const calls: { url: string; init: RequestInit }[] = [];
  /** Endpoints whose push service refuses a send. */
  const refusing = new Set<string>();
  // Holds every push send while true. A flag rather than a promise: the send runs in the Durable Object's context.
  let held = false;
  const CAN = ['agent-stopped-push-v1'];

  beforeEach(async () => {
    calls.length = 0;
    refusing.clear();
    held = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      while (held) await new Promise((r) => setTimeout(r, 5));
      return new Response(null, { status: refusing.has(String(url)) ? 500 : 201 });
    }) as never);
    w = await claimRelay();
    phone = await pairDevice(w);
  });
  afterEach(() => {
    held = false;
    vi.restoreAllMocks();
  });

  const stopped = (a: Actor = w.owner, body: unknown = { protocol_version: 1 }) =>
    a.call('POST', '/api/v1/push/agent-stopped', body);
  const outcome = async (a?: Actor) => {
    const r = await stopped(a);
    expect(r.status).toBe(200);
    return AgentStoppedPushResponse.parse(r.json).outcome;
  };
  /** Moves the current window's start `ms` into the past, as if that long had passed. */
  const windowAges = (ms: number) =>
    inRoom((room) =>
      room.run(
        `UPDATE rate_limits SET window_start = window_start - ? WHERE key = ?`,
        ms,
        AGENT_STOPPED_RATE_KEY,
      ),
    );
  const window = () =>
    inRoom((room) =>
      room.q1<{ window_start: number }>(
        `SELECT window_start FROM rate_limits WHERE key = ?`,
        AGENT_STOPPED_RATE_KEY,
      ),
    );
  /** Quiet hours around now (`around`), or a window that ends hours before now, whatever the time of day. */
  const quiet = (enabled: boolean, around = true) => {
    const h = new Date().getUTCHours();
    const at = (n: number) => `${String((n + 24) % 24).padStart(2, '0')}:00`;
    return phone.call('PUT', '/api/v1/settings', {
      protocol_version: 1,
      quiet_hours: around
        ? { enabled, start: at(h - 2), end: at(h + 3), time_zone: 'UTC' }
        : { enabled, start: at(h - 6), end: at(h - 3), time_zone: 'UTC' },
    });
  };
  const header = (c: { init: RequestInit }, name: string) =>
    (c.init.headers as Record<string, string>)[name];
  const sentTo = (endpoint: string) => calls.find((c) => c.url === endpoint)!;
  const body = (c: { init: RequestInit }) => new Uint8Array(c.init.body as ArrayBuffer);
  /** Sends with the first push held until `during` has run, then lets it finish. */
  async function whileSending<T>(during: () => Promise<T>) {
    held = true;
    const asked = stopped();
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5_000 });
      return { during: await during(), first: calls[0]! };
    } finally {
      held = false;
      await asked;
    }
  }

  it('takes the request from the owner desktop only, and nothing but its protocol version', async () => {
    await subscriber(phone, CAN);
    const { host } = await enrollHost(w);
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    for (const a of [phone, tablet, host]) expect((await stopped(a)).status).toBe(403);
    for (const b of [
      {},
      { protocol_version: 2 },
      { protocol_version: '1' },
      { protocol_version: 1, project: 'site' },
      { protocol_version: 1, count: 2 },
    ]) {
      expect((await stopped(w.owner, b)).status, JSON.stringify(b)).toBe(400);
    }
    // Nothing refused above sent a push or took the window.
    expect(calls).toEqual([]);
    expect(await window()).toBeUndefined();
    expect(await outcome()).toBe('sent');
  });

  it('pushes only a type, briefly and replaceably, to the endpoints that said they can show it', async () => {
    const can = await subscriber(phone, CAN);
    expect(can.created.features).toEqual(CAN);
    const cannot = await subscriber(phone);
    expect(cannot.created.features).toEqual([]);
    // Unknown tokens and other features are ignored; the declaration may sit anywhere in the list.
    const unknown = await subscriber(phone, ['some-future-v9']);
    const otherFeature = await subscriber(phone, ['presence-v1']);
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    const tabletCan = await subscriber(tablet, ['presence-v1', ...CAN]);
    expect(tabletCan.created.features).toEqual(CAN);
    // A socket-ticket declaration speaks for the device, never for an endpoint.
    await declare(phone, CAN);

    const jobs = await pending();
    expect(await outcome()).toBe('sent');
    expect(calls.map((c) => c.url).sort()).toEqual([can.endpoint, tabletCan.endpoint].sort());
    for (const c of calls) {
      expect(header(c, 'TTL')).toBe('600');
      expect(header(c, 'Urgency')).toBe('high');
      expect(header(c, 'Topic')).toBe('agent-stopped');
    }
    for (const s of [can, tabletCan]) {
      expect(await s.open(body(sentTo(s.endpoint)))).toEqual({ type: 'agent-stopped' });
    }
    // No job comes of it.
    expect(await pending()).toEqual(jobs);

    const listed = await phone.call('GET', '/api/v1/push/subscriptions');
    const byId = Object.fromEntries(
      (listed.json.subscriptions as { subscription_id: string; features: string[] }[]).map((s) => [
        s.subscription_id,
        s.features,
      ]),
    );
    expect(byId).toEqual({
      [can.id]: CAN,
      [cannot.id]: [],
      [unknown.id]: [],
      [otherFeature.id]: [],
    });
  });

  it('sends nothing the strict payload refuses, whoever calls the sender', async () => {
    await subscriber(phone, CAN);
    const err = await inRoom((room) =>
      sendNotification(room, { type: 'agent-stopped', project: 'site' } as never).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(err).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('forgets an endpoint’s declaration when an older app subscribes it again', async () => {
    const s = await subscriber(phone, CAN);
    const again = await s.resubscribe();
    expect(again.status).toBe(201);
    expect(again.json.subscription_id).toBe(s.id);
    expect(again.json.features).toEqual([]);
    expect(await outcome()).toBe('no-subscription');
    expect(calls).toEqual([]);
    // Nowhere to send takes no window: once the endpoint says so again, the next request goes out.
    expect(await window()).toBeUndefined();
    expect((await s.resubscribe(CAN)).json.features).toEqual(CAN);
    expect(await outcome()).toBe('sent');
    expect(calls).toHaveLength(1);
  });

  it('keeps one declaration per endpoint when a browser pairs again without revoking its old device', async () => {
    const s = await subscriber(phone, CAN);
    // The same browser, paired again as a new device, subscribes the same endpoint from an app that declares
    // nothing: the old device's row must not keep sending to it.
    const repaired = await pairDevice(w);
    const sub = await inRoom((room) =>
      room.q1<{ p256dh: string; auth: string }>(
        `SELECT p256dh, auth FROM push_subscriptions WHERE subscription_id = ?`,
        s.id,
      ),
    );
    const plain = {
      protocol_version: 1,
      endpoint: s.endpoint,
      p256dh: sub!.p256dh,
      auth: sub!.auth,
    };
    expect((await repaired.call('POST', '/api/v1/push/subscriptions', plain)).status).toBe(201);
    expect(await outcome()).toBe('no-subscription');
    expect(calls).toEqual([]);
    // And the other way round: declaring under the new device covers the old row too, and both rows send.
    const declared = await repaired.call('POST', '/api/v1/push/subscriptions', {
      ...plain,
      features: CAN,
    });
    expect(declared.json.features).toEqual(CAN);
    const listed = await phone.call('GET', '/api/v1/push/subscriptions');
    expect(listed.json.subscriptions[0].features).toEqual(CAN);
    // A registration of the same endpoint with other keys is another subscription: it changes no other row.
    const other = await pairDevice(w, 'tablet', 'Test iPad');
    const otherKeys = await subscription();
    const foreign = await other.call('POST', '/api/v1/push/subscriptions', {
      ...plain,
      p256dh: otherKeys.p256dh,
      auth: otherKeys.auth,
    });
    expect(foreign.json.features).toEqual([]);
    const after = await phone.call('GET', '/api/v1/push/subscriptions');
    expect(after.json.subscriptions[0].features).toEqual(CAN);
  });

  it('skips an endpoint whose declaration is withdrawn while the push is going out', async () => {
    const first = await subscriber(phone, CAN);
    const second = await subscriber(phone, CAN);
    let waiting = second;
    const { first: sent } = await whileSending(async () => {
      waiting = calls[0]!.url === first.endpoint ? second : first;
      expect((await waiting.resubscribe()).status).toBe(201);
    });
    expect(calls).toHaveLength(1);
    expect(sent.url).not.toBe(waiting.endpoint);
  });

  it('still reaches an endpoint removed and subscribed again while the push is going out', async () => {
    const first = await subscriber(phone, CAN);
    const second = await subscriber(phone, CAN);
    let waiting = second;
    await whileSending(async () => {
      waiting = calls[0]!.url === first.endpoint ? second : first;
      const gone = await phone.call('DELETE', `/api/v1/push/subscriptions/${waiting.id}`);
      expect(gone.status).toBe(200);
      const back = await waiting.resubscribe(CAN);
      expect(back.json.subscription_id).not.toBe(waiting.id);
    });
    expect(calls.map((c) => c.url).sort()).toEqual([first.endpoint, second.endpoint].sort());
  });

  it('drops a request in quiet hours rather than deferring it, presence or not', async () => {
    await subscriber(phone, CAN);
    expect((await quiet(true)).status).toBe(200);
    const jobs = await pending();
    expect(await outcome()).toBe('quiet-hours');
    // The person at the computer changes nothing: quiet hours still drop it.
    const lease = await w.owner.call('PUT', '/api/v1/presence', {
      protocol_version: 1,
      present: true,
    });
    expect(lease.status).toBe(200);
    expect(await outcome()).toBe('quiet-hours');
    expect(calls).toEqual([]);
    expect(await pending()).toEqual(jobs);
    expect(await window()).toBeUndefined();
    // Nothing waits for quiet hours to end, and a dropped request took no window.
    expect((await quiet(false)).status).toBe(200);
    await runDurableObjectAlarm(stub());
    expect(calls).toEqual([]);
    // Quiet hours that are on but not now drop nothing, and the presence hold is for questions only.
    expect((await quiet(true, false)).status).toBe(200);
    expect(await outcome()).toBe('sent');
    expect(calls).toHaveLength(1);
  });

  it('accepts one per window, whether or not it was delivered', async () => {
    const s = await subscriber(phone, CAN);
    refusing.add(s.endpoint);
    expect(await outcome()).toBe('failed');
    refusing.clear();
    expect(await outcome()).toBe('rate-limited');
    expect(calls).toHaveLength(1);
    // A refusal is final, not a "try again later".
    const refused = await stopped();
    expect(refused.status).toBe(200);
    expect(refused.headers.get('Retry-After')).toBeNull();
    // The window is 60 s from the accepted request.
    await windowAges(59_000);
    expect(await outcome()).toBe('rate-limited');
    await windowAges(1_000);
    expect(await outcome()).toBe('sent');
    expect(calls).toHaveLength(2);
  });

  it('takes the window before sending, so requests during a send are dropped, not queued', async () => {
    await subscriber(phone, CAN);
    const { during } = await whileSending(() => Promise.all([stopped(), stopped()]));
    expect(during.map((r) => r.json.outcome)).toEqual(['rate-limited', 'rate-limited']);
    expect(calls).toHaveLength(1);
  });

  it('says sent when one endpoint took it and another refused', async () => {
    const ok = await subscriber(phone, CAN);
    const bad = await subscriber(phone, CAN);
    refusing.add(bad.endpoint);
    expect(await outcome()).toBe('sent');
    expect(calls.map((c) => c.url).sort()).toEqual([ok.endpoint, bad.endpoint].sort());
  });

  it('forgets the window with everything else', async () => {
    await subscriber(phone, CAN);
    expect(await outcome()).toBe('sent');
    const wipe = (scope: string) =>
      w.owner.call('POST', '/api/v1/admin/delete-data', {
        protocol_version: 1,
        confirm: 'DELETE',
        scope,
      });
    expect((await wipe('questions')).status).toBe(200);
    expect(await window()).toBeTruthy();
    expect((await wipe('everything')).status).toBe(200);
    expect(await window()).toBeUndefined();
  });
});

/* ---------- push lifetime (docs/protocol.md section 11) ---------- */

describe("a question's push lives only while the person can answer it (docs/protocol.md section 11)", () => {
  let w: World;
  let phone: Actor;
  const calls: { url: string; init: RequestInit }[] = [];
  /** Endpoints whose push service is down. */
  const refusing = new Set<string>();
  /** How long the first send waits before the push service answers it, as a slow one would. */
  let firstSendDelay = 0;

  beforeEach(async () => {
    calls.length = 0;
    refusing.clear();
    firstSendDelay = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1 && firstSendDelay > 0) {
        const until = Date.now() + firstSendDelay;
        while (Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      }
      return new Response(null, { status: refusing.has(String(url)) ? 503 : 201 });
    }) as never);
    w = await claimRelay();
    phone = await pairDevice(w);
  });
  afterEach(() => {
    firstSendDelay = 0;
    vi.restoreAllMocks();
  });

  /** The TTL header a push service received, in seconds. */
  const ttl = (c: { init: RequestInit }) => Number((c.init.headers as Record<string, string>).TTL);
  const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
  /** Moves a question's deadline to `ms` from now, as if relay time had moved on. */
  const deadlineIn = (questionId: string, ms: number) =>
    inRoom((room) =>
      room.run(
        `UPDATE questions SET expires_at = ? WHERE question_id = ?`,
        Date.now() + ms,
        questionId,
      ),
    );
  /** Quiet hours from two hours ago until two to three hours from now, whatever the time of day. */
  const quiet = async (enabled: boolean) => {
    const h = new Date().getUTCHours();
    const at = (n: number) => `${String((n + 24) % 24).padStart(2, '0')}:00`;
    const r = await phone.call('PUT', '/api/v1/settings', {
      protocol_version: 1,
      quiet_hours: { enabled, start: at(h - 2), end: at(h + 3), time_zone: 'UTC' },
    });
    expect(r.status).toBe(200);
  };
  const statuses = async (kind: string) => (await pending(kind)).map((j) => j.status);

  it("caps a new question's push TTL at the time left to answer it", async () => {
    await subscribe(phone);
    await ask(w, { expiresAt: inMs(15 * 60_000) });
    await runDue('notify_new');
    expect(calls).toHaveLength(1);
    expect(ttl(calls[0]!)).toBeLessThanOrEqual(900);
    expect(ttl(calls[0]!)).toBeGreaterThan(870);
  });

  it('keeps a day for a question without a deadline, a proxy answer and a test push', async () => {
    await subscribe(phone);
    await ask(w, { expiresAt: null });
    await runDue('notify_new');
    // A proxy answer ends the deadline (it cancels the expiry), so its notice and its review reminder keep a day.
    const { questionId } = await ask(w, { requirement: 'proxy-ok', expiresAt: inMs(15 * 60_000) });
    await act(w, w.owner, 'proxy-answer', questionId, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.9,
      },
    });
    await runDue('notify_new');
    await runDue('proxy_review');
    expect((await phone.call('POST', '/api/v1/push/test', {})).json.delivered).toBe(1);
    expect(calls.map(ttl)).toEqual([86_400, 86_400, 86_400, 86_400]);
  });

  it('caps a reminder, and a reply push while the question is open, but not one after it was answered', async () => {
    await declare(w.owner);
    await subscribe(phone);
    const r = await phone.call('PUT', '/api/v1/settings', {
      protocol_version: 1,
      reminders: { enabled: true, first_ms: 60_000, interval_ms: 86_400_000, max: 3 },
    });
    expect(r.status).toBe(200);
    const { questionId } = await ask(w, { expiresAt: inMs(10 * 60_000) });
    await runDue('notify_new');
    calls.length = 0;
    await runDue('remind');
    await say(w, w.owner, questionId, { expectsReply: true });
    await runDue('notify_reply');
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(ttl(c)).toBeLessThanOrEqual(600);
      expect(ttl(c)).toBeGreaterThan(570);
    }
    // Once answered, the deadline no longer applies: the agent's next question in the thread keeps a day.
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(201);
    calls.length = 0;
    await say(w, w.owner, questionId, { expectsReply: true });
    await runDue('notify_reply');
    expect(calls.map(ttl)).toEqual([86_400]);
  });

  it('sends nothing at the deadline, nor with less than a second left', async () => {
    await subscribe(phone);
    // A proxy-first question's push waits out the grace, so nothing sends it before the test moves the deadline.
    const at = (await ask(w, { requirement: 'proxy-first', expiresAt: inMs(15 * 60_000) }))
      .questionId;
    const under = (await ask(w, { requirement: 'proxy-first', expiresAt: inMs(15 * 60_000) }))
      .questionId;
    await deadlineIn(at, 0);
    await deadlineIn(under, 500);
    await runDue('notify_new');
    expect(calls).toEqual([]);
    expect(await statuses('notify_new')).toEqual(['done', 'done']);
  });

  it('works the TTL out again for a retry that quiet hours deferred, and sends it only where it failed', async () => {
    const up = await subscribe(phone);
    const down = await subscribe(phone);
    refusing.add(down.endpoint);
    const { questionId } = await ask(w, { expiresAt: inMs(6 * 3_600_000) });
    // The notify_new is due at once, so the room's own alarm makes the first attempt.
    await vi.waitFor(
      async () => expect((await pending('notify_new'))[0]?.attempt_count).toBeGreaterThan(0),
      { timeout: 5000, interval: 20 },
    );
    expect(calls.map((c) => c.url).sort()).toEqual([up.endpoint, down.endpoint].sort());
    for (const c of calls) expect(ttl(c)).toBeGreaterThan(6 * 3_600 - 30);
    // Quiet hours begin before the retry: it waits, keeping its attempts and what was delivered.
    await quiet(true);
    await runDue('notify_new');
    const [held] = await pending('notify_new');
    expect(held).toMatchObject({ status: 'pending' });
    expect(held!.attempt_count).toBeGreaterThan(0);
    expect(JSON.parse(held!.payload).done).toEqual([up.id]);
    // Quiet hours end with 30 seconds left, and the push service is back.
    await deadlineIn(questionId, 30_000);
    await quiet(false);
    refusing.clear();
    calls.length = 0;
    await runDue('notify_new');
    expect(calls.map((c) => c.url)).toEqual([down.endpoint]);
    expect(ttl(calls[0]!)).toBeLessThanOrEqual(30);
    expect(ttl(calls[0]!)).toBeGreaterThan(20);
    expect(await statuses('notify_new')).toEqual(['done']);
  });

  it('lines no retry up when the deadline passes during a failed send', async () => {
    const down = await subscribe(phone);
    refusing.add(down.endpoint);
    firstSendDelay = 3_500;
    await ask(w, { expiresAt: inMs(3_000) });
    await vi.waitFor(
      async () => expect((await pending('notify_new'))[0]?.status).not.toBe('pending'),
      { timeout: 10_000, interval: 20 },
    );
    expect(calls).toHaveLength(1);
    expect((await pending('notify_new'))[0]).toMatchObject({ status: 'done', attempt_count: 0 });
  });

  it('works the TTL out again for a push that quiet hours deferred', async () => {
    await subscribe(phone);
    await quiet(true);
    const { questionId } = await ask(w, { expiresAt: inMs(6 * 3_600_000) });
    await runDue('notify_new');
    expect(calls).toEqual([]);
    expect(await statuses('notify_new')).toEqual(['pending']);
    // Quiet hours end with 40 seconds left.
    await deadlineIn(questionId, 40_000);
    await quiet(false);
    await runDue('notify_new');
    expect(calls).toHaveLength(1);
    expect(ttl(calls[0]!)).toBeLessThanOrEqual(40);
    expect(ttl(calls[0]!)).toBeGreaterThan(30);
  });

  it('drops a push that quiet hours would hold past the deadline', async () => {
    await declare(w.owner);
    await subscribe(phone);
    await quiet(true);
    // The first reminder falls due before the deadline, and the one after it would not.
    const r = await phone.call('PUT', '/api/v1/settings', {
      protocol_version: 1,
      reminders: { enabled: true, first_ms: 600_000, interval_ms: 7_200_000, max: 3 },
    });
    expect(r.status).toBe(200);
    const { questionId } = await ask(w, { expiresAt: inMs(3_600_000) });
    expect(await statuses('remind')).toEqual(['pending']);
    await say(w, w.owner, questionId, { expectsReply: true });
    await runDue('notify_new');
    await runDue('notify_reply');
    await runDue('remind');
    expect(calls).toEqual([]);
    // Nothing is deferred, and no later reminder is lined up past the deadline.
    expect(await statuses('notify_new')).toEqual(['done']);
    expect(await statuses('notify_reply')).toEqual(['done']);
    expect(await statuses('remind')).toEqual(['done']);
    // Quiet hours still hold a push for a question that outlasts them.
    await ask(w, { expiresAt: inMs(6 * 3_600_000) });
    await runDue('notify_new');
    expect(calls).toEqual([]);
    expect(await statuses('notify_new')).toEqual(['done', 'pending']);
  });

  it('drops a new question push that the presence hold would keep past the deadline', async () => {
    await subscribe(phone);
    // The question outlasts the hold when it is asked, so its push is queued for the hold's end.
    const { questionId } = await ask(w, { expiresAt: inMs(LIMITS.presenceHoldMs + 60_000) });
    await runDue('notify_new');
    calls.length = 0;
    const r = await w.owner.call('PUT', '/api/v1/presence', { protocol_version: 1, present: true });
    expect(r.status).toBe(200);
    // The lease outlasts the question, so the hold ends with the round's bound, after the deadline.
    await inRoom((room) => room.setMeta(PRESENCE_META, String(Date.now() + 10 * 60_000)));
    const held = (await ask(w, { expiresAt: inMs(LIMITS.presenceHoldMs) })).questionId;
    // Asked now, nothing is queued; a push already queued is dropped when it is due.
    expect((await pending('notify_new')).filter((j) => j.question_id === held)).toEqual([]);
    await inRoom((room) =>
      room.schedule({ kind: 'notify_new', runAt: Date.now(), questionId: held }),
    );
    await runDue('notify_new');
    expect(calls).toEqual([]);
    expect(
      (await pending('notify_new')).filter((j) => j.question_id === held).map((j) => j.status),
    ).toEqual(['done']);
    void questionId;
  });

  it('works the TTL out again for each subscription it sends to', async () => {
    await subscribe(phone);
    await subscribe(phone);
    firstSendDelay = 1_500;
    await ask(w, { expiresAt: inMs(15 * 60_000) });
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 10_000, interval: 20 });
    expect(ttl(calls[1]!)).toBeLessThan(ttl(calls[0]!));
    await expectAlarmAtEarliestJob();
  });

  it('sends to no further subscription once the question is answered during a send', async () => {
    await subscribe(phone);
    await subscribe(phone);
    firstSendDelay = 1_500;
    const { questionId } = await ask(w);
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5000, interval: 20 });
    const topic = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>).Topic;
    const answered = topic(calls[0]!);
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(201);
    // Another question's push goes out only once that alarm run is over.
    await ask(w);
    await vi.waitFor(() => expect(calls.filter((c) => topic(c) !== answered)).toHaveLength(2), {
      timeout: 10_000,
      interval: 20,
    });
    expect(calls.filter((c) => topic(c) === answered)).toHaveLength(1);
    await expectAlarmAtEarliestJob();
  });

  it('sends to no further subscription once the deadline passes during a send', async () => {
    await subscribe(phone);
    await subscribe(phone);
    firstSendDelay = 3_500;
    await ask(w, { expiresAt: inMs(3_000) });
    // The first send outlasts the question: the rest is dropped, with no retry.
    await vi.waitFor(
      async () => expect((await pending('notify_new'))[0]?.status).not.toBe('pending'),
      { timeout: 10_000, interval: 20 },
    );
    expect(calls).toHaveLength(1);
    expect((await pending('notify_new'))[0]).toMatchObject({ status: 'done', attempt_count: 0 });
  });
});
