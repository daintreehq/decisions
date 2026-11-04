import {
  ApiError,
  EnrollHostBody,
  LIMITS,
  RevokeDeviceBody,
  RotateEpochBody,
  SocketTicketBody,
  type DeviceCert,
  type EpochGrant,
} from '@daintreehq/decisions-protocol';
import { verifyDeviceCert, verifyObject } from '@daintreehq/decisions-crypto';
import type { Auth, DeviceRow, Handler, Room } from '../room/types.js';
import { iso, isoOrNull, json, nowMs } from '../util.js';

export const listDevices: Handler = async (room) => {
  const rows = room.q<DeviceRow & { push_enabled: number }>(
    `SELECT d.*, EXISTS(SELECT 1 FROM push_subscriptions p WHERE p.device_id = d.device_id AND p.enabled = 1) AS push_enabled
     FROM devices d ORDER BY d.created_at`,
  );
  const owner = rows.find((r) => r.role === 'owner-desktop');
  return json(200, {
    key_epoch: room.currentEpoch(),
    owner_device_id: owner?.device_id,
    devices: rows.map((r) => ({
      device_id: r.device_id,
      role: r.role,
      label: r.label,
      created_at: iso(r.created_at),
      revoked_at: isoOrNull(r.revoked_at),
      last_seen_at: isoOrNull(r.last_seen_at),
      last_ack_seq: r.last_ack_seq,
      cert: JSON.parse(r.cert_json) as DeviceCert,
      push_enabled: Boolean(r.push_enabled),
      features: storedFeatures(r.features),
    })),
  });
};

export const keyGrants: Handler = async (room, c) => {
  if (c.params[0] !== c.auth!.deviceId)
    throw new ApiError('forbidden', 'devices may only read their own grants');
  const rows = room.q<{ grant_json: string }>(
    `SELECT grant_json FROM device_key_grants WHERE device_id = ? ORDER BY key_epoch`,
    c.auth!.deviceId,
  );
  return json(200, {
    current_epoch: room.currentEpoch(),
    grants: rows.map((r) => JSON.parse(r.grant_json) as EpochGrant),
  });
};

/**
 * Registers a `desktop-host` device (another Daintree Host). The owner generates nothing for the host: the host
 * creates its own key pairs and sends the public halves to the owner, who signs the certificate and seals the
 * current epoch key to the host's exchange key.
 */
export const enrollHost: Handler = async (room, c) => {
  const auth = c.auth!;
  const b = c.body(EnrollHostBody);
  const { cert, grant } = b;
  const bad = (m: string) => new ApiError('validation_error', m);
  if (
    cert.role !== 'desktop-host' ||
    cert.installation_id !== auth.installationId ||
    cert.issuer_device_id !== auth.deviceId
  ) {
    throw bad('certificate must be an owner-issued desktop-host certificate');
  }
  if (
    grant.device_id !== cert.device_id ||
    grant.installation_id !== auth.installationId ||
    grant.issuer_device_id !== auth.deviceId
  ) {
    throw bad('grant does not match the host');
  }
  const ownerKey = await room.devicePublicKey(room.getDevice(auth.deviceId)!);
  if (!(await verifyDeviceCert(cert, ownerKey))) throw bad('certificate signature invalid');
  if (!(await verifyObject(ownerKey, grant))) throw bad('grant signature invalid');
  await room.tx(() => {
    room.assertActive(auth.deviceId);
    if (grant.key_epoch !== room.currentEpoch()) {
      throw new ApiError('revision_conflict', 'key epoch changed; enroll again');
    }
    if (room.getDevice(cert.device_id))
      throw new ApiError('invalid_state', 'device id already registered');
    const n = room.q1<{ n: number }>(
      `SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL`,
    )!.n;
    if (n >= LIMITS.maxDevices) throw new ApiError('forbidden', 'device limit reached');
    room.run(
      `INSERT INTO devices (device_id, role, label, signing_pub, exchange_pub, cert_json, created_at) VALUES (?, 'desktop-host', ?, ?, ?, ?, ?)`,
      cert.device_id,
      cert.label,
      cert.signing_pub,
      cert.exchange_pub,
      JSON.stringify(cert),
      nowMs(),
    );
    room.run(
      `INSERT INTO device_key_grants (device_id, key_epoch, grant_json) VALUES (?, ?, ?)`,
      grant.device_id,
      grant.key_epoch,
      JSON.stringify(grant),
    );
    room.emit('device.approved', { deviceId: auth.deviceId, data: { cert } });
  });
  return json(201, { device_id: cert.device_id });
};

const storedFeatures = (raw: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
};

/** The features a device declared on its latest socket ticket (section 19); empty for a 0.3.0 client. */
export const deviceFeatures = (room: Room, deviceId: string): string[] =>
  storedFeatures(room.getDevice(deviceId)?.features);

/**
 * Today's phone app sends `{}`, so `protocol_version` stays optional here; a declared feature list must be
 * well formed. No declaration, the 0.3.0 baseline, also clears what the device declared before.
 */
const TicketBody = SocketTicketBody.extend({
  protocol_version: SocketTicketBody.shape.protocol_version.optional(),
});

export const socketTicket: Handler = async (room, c) => {
  const auth = c.auth!;
  room.hit(`ticket:${auth.deviceId}`, 30, 60_000);
  const body = c.req.body.trim() === '' ? {} : c.body(TicketBody);
  const features = [...new Set(body.features ?? [])].sort();
  const ttl = LIMITS.wsTicketTtlMs;
  const ticket = await room.mintTicket('ws', auth.deviceId, { features }, ttl);
  room.run(
    `UPDATE devices SET features = ? WHERE device_id = ?`,
    JSON.stringify(features),
    auth.deviceId,
  );
  return json(200, { ticket, expires_at: iso(nowMs() + ttl), ws_path: '/api/v1/socket' });
};

/** Validates and stores a full set of grants for a new epoch. Runs inside the caller's transaction. */
async function verifyRotation(
  room: Room,
  auth: Auth,
  newEpoch: number,
  grants: EpochGrant[],
  excludeDeviceId: string | null,
): Promise<void> {
  if (newEpoch !== room.currentEpoch() + 1) {
    throw new ApiError('validation_error', `new_key_epoch must be ${room.currentEpoch() + 1}`);
  }
  assertGrantSet(room, grants, excludeDeviceId);
  const ownerKey = await room.devicePublicKey(room.getDevice(auth.deviceId)!);
  for (const g of grants) {
    if (
      g.key_epoch !== newEpoch ||
      g.installation_id !== auth.installationId ||
      g.issuer_device_id !== auth.deviceId
    ) {
      throw new ApiError('validation_error', 'grant fields do not match this rotation');
    }
    if (!(await verifyObject(ownerKey, g)))
      throw new ApiError('validation_error', 'grant signature invalid');
  }
}

/** Grants must cover every remaining non-owner device exactly once. Re-run inside the commit transaction. */
function assertGrantSet(room: Room, grants: EpochGrant[], excludeDeviceId: string | null): void {
  const expected = room
    .q<{ device_id: string }>(
      `SELECT device_id FROM devices WHERE revoked_at IS NULL AND role != 'owner-desktop'`,
    )
    .map((d) => d.device_id)
    .filter((id) => id !== excludeDeviceId)
    .sort();
  const got = grants.map((g) => g.device_id).sort();
  if (expected.length !== got.length || expected.some((id, i) => id !== got[i])) {
    throw new ApiError(
      'validation_error',
      'grants must cover every remaining non-owner device exactly once',
    );
  }
}

function commitRotation(room: Room, auth: Auth, newEpoch: number, grants: EpochGrant[]): void {
  for (const g of grants) {
    room.run(
      `INSERT OR REPLACE INTO device_key_grants (device_id, key_epoch, grant_json) VALUES (?, ?, ?)`,
      g.device_id,
      g.key_epoch,
      JSON.stringify(g),
    );
  }
  room.setMeta('current_epoch', String(newEpoch));
  room.emit('device.key_rotated', { deviceId: auth.deviceId, data: { key_epoch: newEpoch } });
}

export const revokeDevice: Handler = async (room, c) => {
  const id = c.params[0]!;
  const auth = c.auth!;
  const b = c.body(RevokeDeviceBody);
  const target = room.getDevice(id);
  if (!target) throw new ApiError('not_found', 'no such device');
  if (target.role === 'owner-desktop')
    throw new ApiError('forbidden', 'the owner device cannot be revoked');
  if (target.revoked_at !== null) throw new ApiError('invalid_state', 'already revoked');
  await verifyRotation(room, auth, b.new_key_epoch, b.grants, id);
  await room.tx(() => {
    room.assertActive(auth.deviceId);
    const cur = room.getDevice(id);
    if (!cur || cur.revoked_at !== null) throw new ApiError('invalid_state', 'already revoked');
    // A device may have been approved while the grants were being verified: recheck the whole set.
    assertGrantSet(room, b.grants, id);
    if (b.new_key_epoch !== room.currentEpoch() + 1)
      throw new ApiError('revision_conflict', 'epoch changed concurrently');
    room.run(`UPDATE devices SET revoked_at = ? WHERE device_id = ?`, nowMs(), id);
    room.run(`DELETE FROM push_subscriptions WHERE device_id = ?`, id);
    room.run(`DELETE FROM tickets WHERE device_id = ?`, id);
    room.run(
      `UPDATE pairing_sessions SET state = 'rejected', grant_json = NULL, cert_json = NULL WHERE state = 'approved' AND candidate_json LIKE ?`,
      `%"device_id":"${id}"%`,
    );
    room.emit('device.revoked', {
      deviceId: auth.deviceId,
      data: { device_id: id, key_epoch: b.new_key_epoch },
    });
    commitRotation(room, auth, b.new_key_epoch, b.grants);
  });
  room.forgetDeviceKey(id);
  room.closeDeviceSockets(id, { t: 'revoked' });
  return json(200, { device_id: id, key_epoch: b.new_key_epoch });
};

export const rotateEpoch: Handler = async (room, c) => {
  const auth = c.auth!;
  const b = c.body(RotateEpochBody);
  await verifyRotation(room, auth, b.new_key_epoch, b.grants, null);
  await room.tx(() => {
    room.assertActive(auth.deviceId);
    if (b.new_key_epoch !== room.currentEpoch() + 1)
      throw new ApiError('revision_conflict', 'epoch changed concurrently');
    assertGrantSet(room, b.grants, null);
    commitRotation(room, auth, b.new_key_epoch, b.grants);
  });
  return json(200, { key_epoch: b.new_key_epoch });
};
