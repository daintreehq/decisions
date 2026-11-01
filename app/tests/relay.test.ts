import { describe, expect, it, vi } from 'vitest';
import { generateDeviceKeys, verifyRequestSignature } from '@daintree/decisions-crypto';
import { parseAuthHeader, API_PREFIX } from '@daintree/decisions-protocol';
import { Relay, RelayError } from '../src/data/relay.js';
import { sha256Hex } from '@daintree/decisions-crypto';

async function relay(fetchImpl?: typeof fetch) {
  const keys = await generateDeviceKeys(true);
  return {
    keys,
    relay: new Relay({
      origin: 'https://relay.example',
      installationId: 'installation_aaaa',
      deviceId: 'device_aaaaaaaa',
      signingKey: keys.signing.privateKey,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  };
}

describe('relay client', () => {
  it('signs every request with the method, path, normalised query and body hash it actually sends', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const { relay: r, keys } = await relay((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch);
    await r.json('POST', '/questions/abc/answer', {
      query: { b: 2, a: 1 },
      body: { hello: 'world' },
    });
    const { url, init } = seen!;
    expect(url).toBe(`https://relay.example${API_PREFIX}/questions/abc/answer?a=1&b=2`);
    const header = parseAuthHeader((init.headers as Record<string, string>).authorization)!;
    expect(
      await verifyRequestSignature({
        header,
        method: 'POST',
        path: `${API_PREFIX}/questions/abc/answer`,
        query: 'a=1&b=2',
        bodySha256: await sha256Hex(String(init.body)),
        devicePublicKey: keys.signing.publicKey,
      }),
    ).toBe(true);
    expect(init.credentials).toBe('omit');
  });

  it('uses a fresh nonce for each attempt but sends byte-identical raw bodies', async () => {
    const bodies: string[] = [];
    const nonces: string[] = [];
    const { relay: r } = await relay((async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      nonces.push(parseAuthHeader((init.headers as Record<string, string>).authorization)!.nonce);
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch);
    await r.jsonRaw('POST', '/x', '{"a":1}');
    await r.jsonRaw('POST', '/x', '{"a":1}');
    expect(bodies).toEqual(['{"a":1}', '{"a":1}']);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('maps error bodies and network failures to RelayError', async () => {
    const { relay: r } = await relay(
      (async () =>
        new Response(
          JSON.stringify({
            code: 'revision_conflict',
            message: 'changed',
            details: { latest_revision: 3 },
          }),
          { status: 409 },
        )) as unknown as typeof fetch,
    );
    await expect(r.json('GET', '/x')).rejects.toMatchObject({
      code: 'revision_conflict',
      status: 409,
      details: { latest_revision: 3 },
      retryable: false,
    });
    const { relay: down } = await relay((async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    const e = await down.json('GET', '/x').catch((x) => x);
    expect(e).toBeInstanceOf(RelayError);
    expect(e).toMatchObject({ code: 'network', status: 0, retryable: true });
  });

  it('calls the global fetch with the right receiver (regression: "Illegal invocation" in browsers)', async () => {
    const original = globalThis.fetch;
    const calls: unknown[] = [];
    // Like a browser, refuse to run if invoked as a method of anything but the global object.
    globalThis.fetch = function (this: unknown, ..._a: unknown[]) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(1);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    } as unknown as typeof fetch;
    try {
      const { relay: r } = await relay(); // no injected fetch: uses the global
      await expect(r.json('GET', '/ping')).resolves.toEqual({ ok: true });
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
    vi.restoreAllMocks();
  });
});
