import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testEnv as env } from './env.js';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { bytesToBase64Url } from '@daintree/decisions-protocol';
import { newId } from '@daintree/decisions-crypto';
import {
  act,
  ask,
  claimRelay,
  inRoom,
  pairDevice,
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

describe('push, reminders and expiry', () => {
  let w: World;
  let phone: Actor;
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 201;

  beforeEach(async () => {
    calls.length = 0;
    status = 201;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status });
    }) as never);
    w = await claimRelay();
    phone = await pairDevice(w);
  });
  afterEach(() => vi.restoreAllMocks());

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
    await ask(w);
    status = 503;
    await runDue('notify_new');
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
    await ask(w);
    await runDurableObjectAlarm(stub()); // flush work that is due right now (alarms also fire on their own)
    const alarm = await inRoom((_r, state) => state.storage.getAlarm());
    const next = await inRoom((room) =>
      room.q1<{ m: number }>(
        `SELECT MIN(run_at) AS m FROM scheduled_jobs WHERE status = 'pending'`,
      )!,
    );
    expect(next!.m).toBeGreaterThan(Date.now());
    expect(alarm).toBe(next!.m);
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
    expect(d.json.jobs.alarm_at).toBeTruthy();
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
