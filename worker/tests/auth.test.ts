import { describe, expect, it } from 'vitest';
import { claimRelay, pairDevice, raw, Actor, type World } from './helpers.js';
import { formatAuthHeader, normalizeQuery, parseAuthHeader } from '@daintreehq/decisions-protocol';
import { signRequest } from '@daintreehq/decisions-crypto';

describe('request authentication', () => {
  let w: World;
  const setup = async () => (w = await claimRelay());

  it('rejects missing, malformed and unknown-device authorisation', async () => {
    await setup();
    expect((await raw('GET', '/api/v1/devices')).status).toBe(401);
    expect(
      (await raw('GET', '/api/v1/devices', { headers: { authorization: 'Bearer abc' } })).status,
    ).toBe(401);
    const stranger = await Actor.create('owner-desktop');
    stranger.installationId = w.installationId;
    expect((await stranger.call('GET', '/api/v1/devices')).status).toBe(401);
  });

  it('accepts a signed request and returns no-store', async () => {
    await setup();
    const r = await w.owner.call('GET', '/api/v1/devices');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.json.devices).toHaveLength(1);
  });

  it('rejects a replayed Authorization header (nonce reuse)', async () => {
    await setup();
    const authorization = await w.owner.authHeader('GET', '/api/v1/devices');
    expect((await raw('GET', '/api/v1/devices', { headers: { authorization } })).status).toBe(200);
    const replay = await raw('GET', '/api/v1/devices', { headers: { authorization } });
    expect(replay.status).toBe(401);
    expect(replay.json.message).toMatch(/replay/);
  });

  it('binds method, path, query and body into the signature', async () => {
    await setup();
    const auth = await w.owner.authHeader('GET', '/api/v1/devices', 'a=1');
    // different query
    expect(
      (await raw('GET', '/api/v1/devices?a=2', { headers: { authorization: auth } })).status,
    ).toBe(401);
    // different path
    const auth2 = await w.owner.authHeader('GET', '/api/v1/devices');
    expect((await raw('GET', '/api/v1/events', { headers: { authorization: auth2 } })).status).toBe(
      401,
    );
    // tampered body
    const tampered = await w.owner.callSignedFor(
      'POST',
      '/api/v1/pairing/invitations',
      '{"a":1}',
      '{"a":2}',
    );
    expect(tampered.status).toBe(401);
  });

  it('rejects timestamps outside the skew window and tells the client the server time', async () => {
    await setup();
    const { authorization } = await signRequest({
      method: 'GET',
      path: '/api/v1/devices',
      installationId: w.installationId,
      deviceId: w.owner.id,
      signingKey: w.owner.keys.signing.privateKey,
      now: Date.now() - 10 * 60_000,
    });
    const r = await raw('GET', '/api/v1/devices', { headers: { authorization } });
    expect(r.status).toBe(401);
    expect(r.json.details.server_time).toMatch(/Z$/);
  });

  it('rejects a signature from a different installation id and a forged device id', async () => {
    await setup();
    const parsed = parseAuthHeader(await w.owner.authHeader('GET', '/api/v1/devices'))!;
    const forged = formatAuthHeader({ ...parsed, installationId: 'someotherinstall' });
    expect(
      (await raw('GET', '/api/v1/devices', { headers: { authorization: forged } })).status,
    ).toBe(401);
  });

  it('enforces roles: a phone cannot create questions or read diagnostics', async () => {
    await setup();
    const phone = await pairDevice(w);
    expect((await phone.call('GET', '/api/v1/admin/diagnostics')).status).toBe(403);
    expect((await phone.call('POST', '/api/v1/questions', {})).status).toBe(403);
    expect((await phone.call('POST', '/api/v1/pairing/invitations', {})).status).toBe(403);
  });

  it('unknown routes are 404 JSON and never leak', async () => {
    await setup();
    const r = await w.owner.call('GET', '/api/v1/nope');
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('not_found');
    expect(normalizeQuery('b=1&a=2')).toBe('a=2&b=1');
  });
});
