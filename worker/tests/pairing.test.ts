import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@daintree/decisions-protocol';
import {
  createEpochGrant,
  generatePairingSecret,
  inviteDigest,
  issueDeviceCert,
  newId,
  pairingShortCode,
  signPairingPop,
} from '@daintree/decisions-crypto';
import { Actor, claimRelay, inRoom, pairDevice, raw, type World } from './helpers.js';

async function invite(w: World, role: 'phone' | 'tablet' = 'phone', ttlMs = 4 * 60_000) {
  const secret = generatePairingSecret();
  const pairingId = newId();
  const res = await w.owner.call('POST', '/api/v1/pairing/invitations', {
    protocol_version: PROTOCOL_VERSION,
    pairing_id: pairingId,
    invite_digest: await inviteDigest(secret),
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
    role,
  });
  return { secret, pairingId, res };
}

async function candidate(
  w: World,
  pairingId: string,
  secret: string,
  phone: Actor,
  over: Record<string, unknown> = {},
) {
  return raw('POST', '/api/v1/pairing/candidates', {
    body: JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      pairing_id: pairingId,
      secret,
      device_id: phone.id,
      label: 'My Phone',
      signing_pub: phone.signingPub,
      exchange_pub: phone.exchangePub,
      pop: await signPairingPop(phone.keys.signing.privateKey, {
        pairingId,
        deviceId: phone.id,
        exchangePub: phone.exchangePub,
        signingPub: phone.signingPub,
      }),
      ...over,
    }),
  });
}

describe('pairing', () => {
  it('completes the full flow and the new device can authenticate', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const devices = await phone.call('GET', '/api/v1/devices');
    expect(devices.status).toBe(200);
    expect(devices.json.devices.map((d: any) => d.role).sort()).toEqual(['owner-desktop', 'phone']);
    const grants = await phone.call('GET', `/api/v1/devices/${phone.id}/key-grants`);
    expect(grants.json.grants).toHaveLength(1);
    // a device may not read someone else's grants
    expect((await phone.call('GET', `/api/v1/devices/${w.owner.id}/key-grants`)).status).toBe(403);
  });

  it('shows the same short code to candidate and owner', async () => {
    const w = await claimRelay();
    const phone = await Actor.create('phone');
    const { secret, pairingId } = await invite(w);
    const c = await candidate(w, pairingId, secret, phone);
    expect(c.status).toBe(201);
    const expected = await pairingShortCode({
      pairingId,
      signingPub: phone.signingPub,
      exchangePub: phone.exchangePub,
    });
    expect(c.json.short_code).toBe(expected);
    const pending = await w.owner.call('GET', '/api/v1/pairing/pending');
    expect(pending.json.pending[0]).toMatchObject({
      pairing_id: pairingId,
      short_code: expected,
      device_id: phone.id,
      role: 'phone',
    });
  });

  it('refuses a wrong secret, and the invitation locks after repeated failures', async () => {
    const w = await claimRelay();
    const phone = await Actor.create('phone');
    const { pairingId, secret } = await invite(w);
    const wrong = generatePairingSecret();
    for (let i = 0; i < 5; i++)
      expect((await candidate(w, pairingId, wrong, phone)).status).toBe(401);
    expect((await candidate(w, pairingId, secret, phone)).status).toBe(401);
  });

  it('is single use: a second candidate is rejected after the first', async () => {
    const w = await claimRelay();
    const { pairingId, secret } = await invite(w);
    expect((await candidate(w, pairingId, secret, await Actor.create('phone'))).status).toBe(201);
    expect((await candidate(w, pairingId, secret, await Actor.create('phone'))).status).toBe(401);
  });

  it('rejects a candidate without proof of possession', async () => {
    const w = await claimRelay();
    const phone = await Actor.create('phone');
    const other = await Actor.create('phone');
    const { pairingId, secret } = await invite(w);
    const bad = await signPairingPop(other.keys.signing.privateKey, {
      pairingId,
      deviceId: phone.id,
      exchangePub: phone.exchangePub,
      signingPub: phone.signingPub,
    });
    expect((await candidate(w, pairingId, secret, phone, { pop: bad })).status).toBe(400);
  });

  it('rejects expired invitations and absurd lifetimes', async () => {
    const w = await claimRelay();
    expect((await invite(w, 'phone', 3_600_000)).res.status).toBe(400);
    const { pairingId, secret } = await invite(w);
    await inRoom((room) =>
      room.run(
        `UPDATE pairing_sessions SET expires_at = ? WHERE pairing_id = ?`,
        Date.now() - 1000,
        pairingId,
      ),
    );
    expect((await candidate(w, pairingId, secret, await Actor.create('phone'))).status).toBe(401);
  });

  it('an unapproved candidate gets no access and no key material', async () => {
    const w = await claimRelay();
    const phone = await Actor.create('phone');
    phone.installationId = w.installationId;
    const { pairingId, secret } = await invite(w);
    await candidate(w, pairingId, secret, phone);
    expect((await phone.call('GET', '/api/v1/devices')).status).toBe(401);
    const st = await raw('GET', `/api/v1/pairing/${pairingId}/status`, {
      headers: { 'x-pairing-secret': secret },
    });
    expect(st.json).toMatchObject({ state: 'pending-approval', cert: null, grant: null });
    // wrong secret cannot read status
    const bad = await raw('GET', `/api/v1/pairing/${pairingId}/status`, {
      headers: { 'x-pairing-secret': generatePairingSecret() },
    });
    expect(bad.status).toBe(401);
  });

  it('approval must match the candidate: swapped keys, role and epoch are refused', async () => {
    const w = await claimRelay();
    const phone = await Actor.create('phone');
    const mallory = await Actor.create('phone');
    const { pairingId, secret } = await invite(w);
    await candidate(w, pairingId, secret, phone);
    const mk = (a: Actor, role: 'phone' | 'tablet', label = 'My Phone') =>
      issueDeviceCert({
        issuerDeviceId: w.owner.id,
        issuerSigningKey: w.owner.keys.signing.privateKey,
        installationId: w.installationId,
        deviceId: a.id,
        role,
        label,
        signingPub: a.signingPub,
        exchangePub: a.exchangePub,
      });
    const grantFor = (a: Actor, epoch = 1) =>
      createEpochGrant({
        issuerDeviceId: w.owner.id,
        issuerSigningKey: w.owner.keys.signing.privateKey,
        installationId: w.installationId,
        recipientDeviceId: a.id,
        recipientExchangePub: a.exchangePub,
        epoch,
        epochKeyRaw: w.epochRaw,
      });
    const approve = async (cert: unknown, grant: unknown) =>
      w.owner.call('POST', `/api/v1/pairing/${pairingId}/approve`, {
        protocol_version: 1,
        cert,
        grant,
      });
    expect((await approve(await mk(mallory, 'phone'), await grantFor(mallory))).status).toBe(400); // other device
    expect((await approve(await mk(phone, 'tablet'), await grantFor(phone))).status).toBe(400); // role change
    expect((await approve(await mk(phone, 'phone', 'Renamed'), await grantFor(phone))).status).toBe(
      400,
    ); // label change
    expect((await approve(await mk(phone, 'phone'), await grantFor(phone, 5))).status).toBe(400); // wrong epoch
    expect((await approve(await mk(phone, 'phone'), await grantFor(mallory))).status).toBe(400); // grant for someone else
    expect((await approve(await mk(phone, 'phone'), await grantFor(phone))).status).toBe(200);
    expect((await approve(await mk(phone, 'phone'), await grantFor(phone))).status).toBe(409); // already approved
  });

  it('only the owner can approve, reject or list', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    expect((await phone.call('GET', '/api/v1/pairing/pending')).status).toBe(403);
    expect(
      (await phone.call('POST', `/api/v1/pairing/${newId()}/reject`, { protocol_version: 1 }))
        .status,
    ).toBe(403);
  });

  it('reject ends the pairing', async () => {
    const w = await claimRelay();
    const { pairingId, secret } = await invite(w);
    await candidate(w, pairingId, secret, await Actor.create('phone'));
    expect(
      (await w.owner.call('POST', `/api/v1/pairing/${pairingId}/reject`, { protocol_version: 1 }))
        .status,
    ).toBe(200);
    const st = await raw('GET', `/api/v1/pairing/${pairingId}/status`, {
      headers: { 'x-pairing-secret': secret },
    });
    expect(st.json.state).toBe('rejected');
  });
});
