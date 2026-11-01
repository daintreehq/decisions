import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import { Actor, CLAIM_SECRET, claimRelay, inRoom, raw } from './helpers.js';
import { issueDeviceCert, newId } from '@daintreehq/decisions-crypto';

describe('health, info and claim', () => {
  it('serves /health and unclaimed /info publicly', async () => {
    expect((await raw('GET', '/health')).json).toMatchObject({ ok: true });
    const info = await raw('GET', '/api/v1/info');
    expect(info.status).toBe(200);
    expect(info.json).toMatchObject({
      name: 'daintree-decisions',
      claimed: false,
      claim_configured: true,
      protocol_max: 1,
    });
  });

  it('adds security headers to API and never emits CORS headers', async () => {
    const r = await raw('GET', '/api/v1/info');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  async function claimBody(secret: string, mutate?: (c: any) => void) {
    const owner = await Actor.create('owner-desktop');
    owner.installationId = newId();
    const cert: any = await issueDeviceCert({
      issuerDeviceId: owner.id,
      issuerSigningKey: owner.keys.signing.privateKey,
      installationId: owner.installationId,
      deviceId: owner.id,
      role: 'owner-desktop',
      label: 'Mac',
      signingPub: owner.signingPub,
      exchangePub: owner.exchangePub,
    });
    mutate?.(cert);
    return JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      claim_secret: secret,
      installation_id: owner.installationId,
      cert,
    });
  }

  it('rejects a wrong claim secret and stays unclaimed', async () => {
    const r = await raw('POST', '/api/v1/setup/claim', { body: await claimBody('x'.repeat(40)) });
    expect(r.status).toBe(401);
    expect((await raw('GET', '/api/v1/info')).json.claimed).toBe(false);
  });

  it('rejects a forged certificate even with the right secret', async () => {
    const r = await raw('POST', '/api/v1/setup/claim', {
      body: await claimBody(CLAIM_SECRET, (c) => {
        c.label = 'tampered';
      }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects a non-owner role certificate', async () => {
    const owner = await Actor.create('owner-desktop');
    owner.installationId = newId();
    const cert = await issueDeviceCert({
      issuerDeviceId: owner.id,
      issuerSigningKey: owner.keys.signing.privateKey,
      installationId: owner.installationId,
      deviceId: owner.id,
      role: 'phone',
      label: 'x',
      signingPub: owner.signingPub,
      exchangePub: owner.exchangePub,
    });
    const r = await raw('POST', '/api/v1/setup/claim', {
      body: JSON.stringify({
        protocol_version: 1,
        claim_secret: CLAIM_SECRET,
        installation_id: owner.installationId,
        cert,
      }),
    });
    expect(r.status).toBe(400);
  });

  it('claims once, generates VAPID keys, and permanently closes the claim path', async () => {
    const w = await claimRelay();
    const info = await raw('GET', '/api/v1/info');
    expect(info.json.claimed).toBe(true);
    const cfg = await w.owner.call('GET', '/api/v1/push/config');
    expect(cfg.status).toBe(200);
    expect(cfg.json.vapid_public_key).toHaveLength(87);
    const again = await raw('POST', '/api/v1/setup/claim', { body: await claimBody(CLAIM_SECRET) });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('already_claimed');
    // the VAPID private key never leaves the Durable Object
    const leaked = await inRoom((room) => room.getMeta('vapid'));
    expect(leaked).toContain('"d"');
    expect(JSON.stringify(cfg.json)).not.toContain('"d"');
  });
});
