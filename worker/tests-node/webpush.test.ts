import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bytesToBase64Url } from '@daintree/decisions-protocol';
// http_ece is an independent RFC 8188/8291 implementation used here only as an oracle.
// @ts-expect-error untyped
import ece from 'http_ece';
import {
  encryptPushPayload,
  isAllowedPushEndpoint,
  generateVapidKeys,
  vapidAuthorization,
  sendWebPush,
} from '../src/push/webpush.js';
import { isQuiet, nextAllowed } from '../src/push/quiet-hours.js';
import { openaiBridge, resample16kTo24k } from '../src/voice-proxy.js';
import { correct } from '../src/voice-correct.js';

function subscriber() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    target: {
      p256dh: bytesToBase64Url(new Uint8Array(ecdh.getPublicKey())),
      auth: bytesToBase64Url(new Uint8Array(auth)),
    },
  };
}

describe('Web Push payload encryption (RFC 8291)', () => {
  it('is decryptable by an independent implementation', async () => {
    const sub = subscriber();
    const payload = JSON.stringify({ type: 'decision-new', question_id: 'abc' });
    const body = await encryptPushPayload(sub.target, new TextEncoder().encode(payload));
    const plain = ece.decrypt(Buffer.from(body), {
      version: 'aes128gcm',
      privateKey: sub.ecdh,
      authSecret: sub.auth,
    });
    expect(plain.toString('utf8')).toBe(payload);
  });
  it('uses a fresh key and salt every time and rejects bad keys / oversize payloads', async () => {
    const sub = subscriber();
    const a = await encryptPushPayload(sub.target, new Uint8Array([1]));
    const b = await encryptPushPayload(sub.target, new Uint8Array([1]));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    await expect(
      encryptPushPayload({ p256dh: 'AAAA', auth: sub.target.auth }, new Uint8Array(1)),
    ).rejects.toThrow();
    await expect(encryptPushPayload(sub.target, new Uint8Array(5000))).rejects.toThrow();
  });
});

describe('VAPID and sending', () => {
  it('produces an ES256 JWT with audience, expiry and subject, verifiable with the public key', async () => {
    const keys = await generateVapidKeys();
    const h = await vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/x',
      keys,
      'mailto:a@b.test',
    );
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h)!;
    expect(m[4]).toBe(keys.publicKey);
    const claims = JSON.parse(Buffer.from(m[2]!, 'base64url').toString());
    expect(claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:a@b.test' });
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    const pub = await crypto.subtle.importKey(
      'raw',
      Buffer.from(keys.publicKey, 'base64url'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pub,
        Buffer.from(m[3]!, 'base64url'),
        new TextEncoder().encode(`${m[1]}.${m[2]}`),
      ),
    ).toBe(true);
  });
  it('sends the documented headers and never follows redirects', async () => {
    const keys = await generateVapidKeys();
    const sub = subscriber();
    let seen: RequestInit | undefined;
    const status = await sendWebPush(
      { endpoint: 'https://fcm.googleapis.com/fcm/send/x', ...sub.target },
      { type: 'test' },
      keys,
      'mailto:a@b.test',
      { urgency: 'high', topic: 'tpc' },
      (async (_u: string, init: RequestInit) => {
        seen = init;
        return new Response(null, { status: 201 });
      }) as never,
    );
    expect(status).toBe(201);
    const h = seen!.headers as Record<string, string>;
    expect(h['Content-Encoding']).toBe('aes128gcm');
    expect(h.TTL).toBe('86400');
    expect(h.Urgency).toBe('high');
    expect(h.Topic).toBe('tpc');
    expect(h.Authorization.startsWith('vapid t=')).toBe(true);
    expect(seen!.redirect).toBe('manual');
  });
});

describe('push endpoint allowlist (SSRF guard)', () => {
  it.each([
    ['https://fcm.googleapis.com/fcm/send/abc', true],
    ['https://updates.push.services.mozilla.com/wpush/v2/abc', true],
    ['https://web.push.apple.com/abc', true],
    ['https://wns2-par02p.notify.windows.com/x', true],
    ['http://fcm.googleapis.com/x', false],
    ['https://127.0.0.1/x', false],
    ['https://[::1]/x', false],
    ['https://localhost/x', false],
    ['https://evil.example/x', false],
    ['https://fcm.googleapis.com.evil.example/x', false],
    ['https://evilfcm.googleapis.com.attacker.io/x', false],
    ['https://fcm.googleapis.com:8443/x', false],
    ['https://user:pw@fcm.googleapis.com/x', false],
    ['not a url', false],
  ])('%s -> %s', (url, ok) => expect(isAllowedPushEndpoint(url)).toBe(ok));
  it('honours an operator-supplied extra host suffix', () => {
    expect(isAllowedPushEndpoint('https://push.example.org/x', ['example.org'])).toBe(true);
  });
});

describe('quiet hours', () => {
  const qh = { enabled: true, start: '22:00', end: '07:00', time_zone: 'UTC' };
  const at = (iso: string) => Date.parse(iso);
  it('wraps midnight and respects the zone', () => {
    expect(isQuiet(at('2026-11-02T23:00:00Z'), qh)).toBe(true);
    expect(isQuiet(at('2026-11-02T03:00:00Z'), qh)).toBe(true);
    expect(isQuiet(at('2026-11-02T12:00:00Z'), qh)).toBe(false);
    expect(isQuiet(at('2026-11-02T23:00:00Z'), { ...qh, time_zone: 'Asia/Tokyo' })).toBe(false); // 08:00 in Tokyo
    expect(isQuiet(at('2026-11-02T23:00:00Z'), { ...qh, enabled: false })).toBe(false);
    expect(isQuiet(at('2026-11-02T23:00:00Z'), undefined)).toBe(false);
    expect(isQuiet(at('2026-11-02T23:00:00Z'), { ...qh, time_zone: 'Not/AZone' })).toBe(true); // falls back to UTC
  });
  it('defers to the end of the window', () => {
    expect(nextAllowed(at('2026-11-02T23:30:00Z'), qh)).toBe(at('2026-11-03T07:00:00Z'));
    expect(nextAllowed(at('2026-11-02T03:30:30Z'), qh)).toBe(at('2026-11-02T07:00:00Z'));
    expect(nextAllowed(at('2026-11-02T12:00:00Z'), qh)).toBe(at('2026-11-02T12:00:00Z'));
  });
});

describe('quiet hours across DST changes', () => {
  const ny = { enabled: true, start: '23:00', end: '07:00', time_zone: 'America/New_York' };
  it('spring forward: ends at 07:00 local (11:00Z), not an hour late', () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT. 00:30 EST is 05:30Z.
    expect(nextAllowed(Date.parse('2026-03-08T05:30:00Z'), ny)).toBe(
      Date.parse('2026-03-08T11:00:00Z'),
    );
  });
  it('fall back: ends at 07:00 local (12:00Z), not an hour early', () => {
    // 2026-11-01 02:00 EDT falls back to 01:00 EST. 00:30 EDT is 04:30Z.
    expect(nextAllowed(Date.parse('2026-11-01T04:30:00Z'), ny)).toBe(
      Date.parse('2026-11-01T12:00:00Z'),
    );
  });
});

describe('OpenAI transcript turns', () => {
  function fake() {
    const sent: any[] = [];
    return { sent, ws: { send: (m: string) => sent.push(JSON.parse(m)) } as unknown as WebSocket };
  }
  it('emits finished turns once, in audio order, even when completions arrive out of order', () => {
    const client = fake();
    const up = fake();
    const b = openaiBridge(client.ws, up.ws, { keyterms: [], language: null });
    b.audio(new Int16Array(1600).buffer);
    b.control('finalize');
    b.audio(new Int16Array(1600).buffer);
    b.control('audio.done');
    b.upstream(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'A' }));
    b.upstream(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'B' }));
    b.upstream(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'B',
        delta: 'second',
      }),
    );
    b.upstream(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'B',
        transcript: 'second part',
      }),
    );
    expect(client.sent.filter((m) => m.is_final)).toHaveLength(0); // B must wait for A
    b.upstream(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'A',
        transcript: 'first part',
      }),
    );
    const finals = client.sent
      .filter((m) => m.type === 'transcript.partial' && m.is_final)
      .map((m) => m.text);
    expect(finals).toEqual(['first part', 'second part']);
    expect(client.sent.at(-1)).toEqual({ type: 'transcript.done', text: 'first part second part' });
    // in-progress text is per turn, not cumulative
    expect(client.sent.find((m) => m.is_final === false)?.text).toBe('second');
  });
  it('does not finish while a commit is still unacknowledged', () => {
    const client = fake();
    const b = openaiBridge(client.ws, fake().ws, { keyterms: [], language: null });
    b.audio(new Int16Array(1600).buffer);
    b.control('audio.done');
    expect(client.sent.some((m) => m.type === 'transcript.done')).toBe(false);
  });
});

describe('dictation helpers', () => {
  it('resamples 16 kHz to 24 kHz preserving length ratio and endpoints', () => {
    const out = resample16kTo24k(Int16Array.from([0, 300, 600, 900]));
    expect(out.length).toBe(6);
    expect(out[0]).toBe(0);
    expect(out[3]).toBe(600);
    expect(out[1]).toBe(200);
    expect(resample16kTo24k(new Int16Array(0)).length).toBe(0);
  });

  const env = {
    ANTHROPIC_API_KEY: 'k',
    OPENAI_API_KEY: 'k',
    CORRECTION_MODEL: 'claude-haiku-5-5',
    OPENAI_CORRECTION_MODEL: 'm',
    CLAIM_SECRET: '',
    PUSH_SUBJECT: '',
  } as never;
  const body = {
    protocol_version: 1 as const,
    provider: 'anthropic' as const,
    consent: true as const,
    raw_transcript: 'um yes approve it',
    question: 'Ship?',
    option_labels: ['Approve'],
    keyterms: ['Daintree'],
  };
  const good = {
    corrected_text: 'Yes, approve it.',
    uncertain_spans: [],
    applied_commands: [],
    warnings: [],
  };
  const reply = (input: unknown, status = 200) =>
    (async () =>
      new Response(JSON.stringify({ content: [{ type: 'tool_use', input }] }), {
        status,
      })) as never;

  it('accepts a schema-valid correction and sends the key only to the provider', async () => {
    let req: { url: string; init: RequestInit } | undefined;
    const out = await correct(env, body, (async (url: string, init: RequestInit) => {
      req = { url, init };
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', input: good }] }));
    }) as never);
    expect(out).toMatchObject({ ok: true, model: 'claude-haiku-5-5' });
    expect(req!.url).toBe('https://api.anthropic.com/v1/messages');
    const sent = JSON.parse(req!.init.body as string);
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'return_correction' });
    expect(sent.system).toMatch(/untrusted/);
  });
  it('fails closed on malformed, extra-field, oversize or erroring responses', async () => {
    expect((await correct(env, body, reply({ ...good, extra: 1 }))).ok).toBe(false);
    expect((await correct(env, body, reply({ corrected_text: 5 }))).ok).toBe(false);
    expect((await correct(env, body, reply(good, 500))).ok).toBe(false);
    expect(
      (
        await correct(env, body, (async () => {
          throw new Error('boom');
        }) as never)
      ).ok,
    ).toBe(false);
    expect((await correct({ ...env, ANTHROPIC_API_KEY: '' } as never, body, reply(good))).ok).toBe(
      false,
    );
  });
});
