import {
  createEpochGrant,
  generateEpochKeyBytes,
  issueDeviceCert,
  generatePairingSecret,
  inviteDigest,
  inviteUrl,
  newId,
  pairingShortCode,
  verifyDeviceCert,
  importSigningPublicKey,
} from '@daintreehq/decisions-crypto';
import type {
  DeviceInfo,
  EpochGrant,
  PairingInvitePayload,
  PendingPairing,
} from '@daintreehq/decisions-protocol';
import {
  addEpoch,
  assertOwner,
  currentEpochKey,
  type Identity,
  type KeyStore,
} from './identity.js';
import type { RelayClient } from './relay.js';

/** Create a one-time pairing invitation and return the link/QR payload. */
export async function createPairingInvite(
  client: RelayClient,
  role: 'phone' | 'tablet' = 'phone',
  now = Date.now(),
): Promise<{ url: string; payload: PairingInvitePayload; pairingId: string; expiresAt: number }> {
  const id = client.identity;
  assertOwner(id, 'pairing a device');
  const secret = generatePairingSecret();
  const pairingId = newId();
  const expiresAt = now + 5 * 60 * 1000 - 5_000;
  await client.createInvitation({
    pairing_id: pairingId,
    invite_digest: await inviteDigest(secret),
    expires_at: new Date(expiresAt).toISOString(),
    role,
  });
  const payload: PairingInvitePayload = {
    v: 1,
    o: id.config.relayOrigin,
    i: id.config.installationId,
    p: pairingId,
    s: secret,
    e: expiresAt,
    k: id.signingPub,
    d: id.config.deviceId,
    r: role,
  };
  return { url: inviteUrl(payload), payload, pairingId, expiresAt };
}

/** Recompute the short code locally so a lying relay cannot show a different one on the desktop. */
export async function localShortCode(p: PendingPairing, pairingId = p.pairing_id): Promise<string> {
  return pairingShortCode({ pairingId, signingPub: p.signing_pub, exchangePub: p.exchange_pub });
}

/** Owner approves a candidate after the human confirmed the code: issue cert + sealed epoch grant. */
export async function approveCandidate(
  client: RelayClient,
  candidate: PendingPairing,
): Promise<void> {
  const id = client.identity;
  assertOwner(id, 'approving a device');
  // The code the human compared must be derived from the exact keys we are about to certify.
  if ((await localShortCode(candidate)) !== candidate.short_code) {
    throw new Error(
      'the relay reported a confirmation code that does not match the candidate keys; refusing to approve',
    );
  }
  const cert = await issueDeviceCert({
    issuerDeviceId: id.config.deviceId,
    issuerSigningKey: id.keys.signing.privateKey,
    installationId: id.config.installationId,
    deviceId: candidate.device_id,
    role: candidate.role,
    label: candidate.label,
    signingPub: candidate.signing_pub,
    exchangePub: candidate.exchange_pub,
  });
  const epoch = currentEpochKey(id);
  const grant = await createEpochGrant({
    issuerDeviceId: id.config.deviceId,
    issuerSigningKey: id.keys.signing.privateKey,
    installationId: id.config.installationId,
    recipientDeviceId: candidate.device_id,
    recipientExchangePub: candidate.exchange_pub,
    epoch: epoch.epoch,
    epochKeyRaw: epoch.raw!,
  });
  await client.approvePairing(candidate.pairing_id, cert, grant);
}

async function grantsFor(
  id: Identity,
  devices: DeviceInfo[],
  epoch: number,
  raw: Uint8Array,
): Promise<EpochGrant[]> {
  // Never seal key material to a key the relay merely CLAIMS belongs to a device: every recipient certificate
  // must verify against our pinned owner key and be bound to this installation and device.
  for (const d of devices) {
    const c = d.cert;
    const ok =
      c.issuer_device_id === id.config.deviceId &&
      c.installation_id === id.config.installationId &&
      c.device_id === d.device_id &&
      c.role === d.role &&
      c.role !== 'owner-desktop' &&
      (await verifyDeviceCert(c, id.keys.signing.publicKey));
    if (!ok) {
      throw new Error(
        `refusing to seal the content key: device ${d.device_id} has a certificate that does not verify against your owner key`,
      );
    }
  }
  const out: EpochGrant[] = [];
  for (const d of devices) {
    out.push(
      await createEpochGrant({
        issuerDeviceId: id.config.deviceId,
        issuerSigningKey: id.keys.signing.privateKey,
        installationId: id.config.installationId,
        recipientDeviceId: d.device_id,
        recipientExchangePub: d.cert.exchange_pub,
        epoch,
        epochKeyRaw: raw,
      }),
    );
  }
  return out;
}

/**
 * Revoke a device and rotate the content key for future records. The new epoch key is stored locally
 * BEFORE the relay call (so a crash cannot lose it) but only becomes current once the relay accepted it.
 */
export async function revokeAndRotate(
  client: RelayClient,
  store: KeyStore,
  deviceId: string,
): Promise<Identity> {
  const id = client.identity;
  assertOwner(id, 'revoking a device');
  if (deviceId === id.config.deviceId) throw new Error('cannot revoke the owner device');
  const list = await client.devices();
  const remaining = list.devices.filter(
    (d) => d.device_id !== deviceId && d.device_id !== id.config.deviceId && !d.revoked_at,
  );
  // The relay requires exactly its current epoch + 1; a staged-but-rejected epoch is simply overwritten.
  const newEpoch = list.key_epoch + 1;
  const raw = generateEpochKeyBytes();
  const staged = await addEpoch(store, id, newEpoch, raw, { makeCurrent: false });
  const grants = await grantsFor(id, remaining, newEpoch, raw);
  await client.revokeDevice(deviceId, newEpoch, grants);
  return addEpoch(store, staged, newEpoch, raw, { makeCurrent: true });
}

export async function rotateEpoch(client: RelayClient, store: KeyStore): Promise<Identity> {
  const id = client.identity;
  assertOwner(id, 'rotating the content key');
  const list = await client.devices();
  const active = list.devices.filter((d) => d.device_id !== id.config.deviceId && !d.revoked_at);
  // The relay requires exactly its current epoch + 1; a staged-but-rejected epoch is simply overwritten.
  const newEpoch = list.key_epoch + 1;
  const raw = generateEpochKeyBytes();
  const staged = await addEpoch(store, id, newEpoch, raw, { makeCurrent: false });
  await client.rotateEpoch(newEpoch, await grantsFor(id, active, newEpoch, raw));
  return addEpoch(store, staged, newEpoch, raw, { makeCurrent: true });
}

/** Verify every returned device certificate against the pinned owner key (our own key on the owner desktop). */
export async function verifiedDevices(client: RelayClient): Promise<DeviceInfo[]> {
  const list = await client.devices();
  const id = client.identity;
  const out: DeviceInfo[] = [];
  for (const d of list.devices) {
    // Every certificate (including our own) must be signed by the pinned owner key, and the only owner-desktop
    // is the pinned owner itself (the same rules the bridge's EventVerifier applies).
    const isOwner = d.cert.device_id === id.owner.deviceId;
    const ok =
      d.cert.issuer_device_id === id.owner.deviceId &&
      d.cert.installation_id === id.config.installationId &&
      d.cert.device_id === d.device_id &&
      isOwner === (d.cert.role === 'owner-desktop') &&
      (!isOwner || d.cert.signing_pub === id.owner.signingPub) &&
      (await verifyDeviceCert(d.cert, id.owner.signingKey)) &&
      (d.cert.device_id !== id.config.deviceId || d.cert.signing_pub === id.signingPub);
    if (ok) {
      await importSigningPublicKey(d.cert.signing_pub);
      out.push(d);
    }
  }
  return out;
}
