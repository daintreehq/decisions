import {
  ApiError,
  LIMITS,
  PairingApproveBody,
  PairingCandidateBody,
  PairingInvitationBody,
  PairingRejectBody,
  timingSafeEqual,
  type DeviceCert,
  type EpochGrant,
} from '@daintree/decisions-protocol';
import { base64UrlToBytes } from '@daintree/decisions-protocol';
import {
  pairingShortCode,
  sha256Hex,
  verifyDeviceCert,
  verifyObject,
  verifyPairingPop,
  importSigningPublicKey,
} from '@daintree/decisions-crypto';
import type { Handler, Room } from '../room/types.js';
import { iso, json, nowMs } from '../util.js';

interface PairingRow {
  pairing_id: string;
  role: 'phone' | 'tablet';
  invite_digest: string;
  expires_at: number;
  state: 'waiting-for-candidate' | 'pending-approval' | 'approved' | 'rejected';
  candidate_json: string | null;
  cert_json: string | null;
  grant_json: string | null;
  attempts: number;
}

interface Candidate {
  device_id: string;
  label: string;
  signing_pub: string;
  exchange_pub: string;
  short_code: string;
}

const ownerRow = (room: Room) =>
  room.q1<{ device_id: string; cert_json: string }>(
    `SELECT device_id, cert_json FROM devices WHERE role = 'owner-desktop' AND revoked_at IS NULL LIMIT 1`,
  );

/** Approved payloads stay fetchable briefly after the invitation itself expires. */
const APPROVED_GRACE_MS = 15 * 60_000;

export const createInvitation: Handler = async (room, c) => {
  const b = c.body(PairingInvitationBody);
  const t = nowMs();
  const exp = Date.parse(b.expires_at);
  if (!(exp > t) || exp > t + LIMITS.pairingTtlMs + LIMITS.requestSkewMs) {
    throw new ApiError('validation_error', 'invitation must expire within 5 minutes');
  }
  await room.tx(() => {
    const active = room.q1<{ n: number }>(
      `SELECT COUNT(*) AS n FROM pairing_sessions WHERE expires_at > ? AND state IN ('waiting-for-candidate','pending-approval')`,
      t,
    )!.n;
    if (active >= 3)
      throw new ApiError('rate_limited', 'too many open invitations', { retryAfterMs: 60_000 });
    const devices = room.q1<{ n: number }>(
      `SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL`,
    )!.n;
    if (devices >= LIMITS.maxDevices) throw new ApiError('forbidden', 'device limit reached');
    const r = room.run(
      `INSERT OR IGNORE INTO pairing_sessions (pairing_id, role, invite_digest, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      b.pairing_id,
      b.role,
      b.invite_digest,
      exp,
      t,
    );
    if (r === 0) throw new ApiError('invalid_state', 'pairing id already used');
  });
  return json(201, { pairing_id: b.pairing_id, expires_at: iso(exp) });
};

export const submitCandidate: Handler = async (room, c) => {
  room.hit(`pair:${c.req.ip}`, 20, 10 * 60_000);
  const b = c.body(PairingCandidateBody);
  const row = room.q1<PairingRow>(
    `SELECT * FROM pairing_sessions WHERE pairing_id = ?`,
    b.pairing_id,
  );
  const t = nowMs();
  // Same response for unknown / expired / wrong secret so ids cannot be probed.
  const reject = () => new ApiError('not_authenticated', 'invalid or expired invitation');
  if (!row || row.expires_at <= t || row.state !== 'waiting-for-candidate') throw reject();
  if (row.attempts >= 5) throw reject();
  const digest = await sha256Hex(base64UrlToBytes(b.secret));
  if (
    !timingSafeEqual(new TextEncoder().encode(digest), new TextEncoder().encode(row.invite_digest))
  ) {
    room.run(
      `UPDATE pairing_sessions SET attempts = attempts + 1 WHERE pairing_id = ?`,
      b.pairing_id,
    );
    throw reject();
  }
  const popOk = await verifyPairingPop(b.pop, {
    pairingId: b.pairing_id,
    deviceId: b.device_id,
    exchangePub: b.exchange_pub,
    signingPub: b.signing_pub,
  }).catch(() => false);
  if (!popOk) throw new ApiError('validation_error', 'proof of possession invalid');
  const owner = ownerRow(room);
  if (!owner) throw new ApiError('internal_error', 'no owner');
  const short = await pairingShortCode({
    pairingId: b.pairing_id,
    signingPub: b.signing_pub,
    exchangePub: b.exchange_pub,
  });
  const cand: Candidate = {
    device_id: b.device_id,
    label: b.label,
    signing_pub: b.signing_pub,
    exchange_pub: b.exchange_pub,
    short_code: short,
  };
  await room.tx(() => {
    const cur = room.q1<{ state: string }>(
      `SELECT state FROM pairing_sessions WHERE pairing_id = ?`,
      b.pairing_id,
    );
    if (cur?.state !== 'waiting-for-candidate') throw reject();
    if (room.getDevice(b.device_id))
      throw new ApiError('invalid_state', 'device id already registered');
    room.run(
      `UPDATE pairing_sessions SET state = 'pending-approval', candidate_json = ? WHERE pairing_id = ?`,
      JSON.stringify(cand),
      b.pairing_id,
    );
  });
  room.broadcastToRole(['owner-desktop'], { t: 'pairing', pairing_id: b.pairing_id });
  return json(201, {
    pairing_id: b.pairing_id,
    short_code: short,
    expires_at: iso(row.expires_at),
    owner_cert: JSON.parse(owner.cert_json) as DeviceCert,
    installation_id: room.installationId(),
  });
};

export const listPending: Handler = async (room) => {
  const t = nowMs();
  const rows = room.q<PairingRow>(
    `SELECT * FROM pairing_sessions WHERE state = 'pending-approval' AND expires_at > ? ORDER BY created_at`,
    t,
  );
  return json(200, {
    pending: rows.map((r) => {
      const cand = JSON.parse(r.candidate_json!) as Candidate;
      return {
        pairing_id: r.pairing_id,
        device_id: cand.device_id,
        label: cand.label,
        role: r.role,
        signing_pub: cand.signing_pub,
        exchange_pub: cand.exchange_pub,
        short_code: cand.short_code,
        expires_at: iso(r.expires_at),
      };
    }),
  });
};

export const approve: Handler = async (room, c) => {
  const id = c.params[0]!;
  const b = c.body(PairingApproveBody);
  const row = room.q1<PairingRow>(`SELECT * FROM pairing_sessions WHERE pairing_id = ?`, id);
  const t = nowMs();
  if (!row) throw new ApiError('not_found', 'no such pairing');
  if (row.expires_at <= t) throw new ApiError('expired', 'pairing expired');
  if (row.state !== 'pending-approval')
    throw new ApiError('invalid_state', `pairing is ${row.state}`);
  const cand = JSON.parse(row.candidate_json!) as Candidate;
  const { cert, grant } = b;
  const auth = c.auth!;
  const bad = (m: string) => new ApiError('validation_error', m);
  if (
    cert.device_id !== cand.device_id ||
    cert.signing_pub !== cand.signing_pub ||
    cert.exchange_pub !== cand.exchange_pub ||
    cert.label !== cand.label ||
    cert.role !== row.role ||
    cert.installation_id !== auth.installationId ||
    cert.issuer_device_id !== auth.deviceId
  ) {
    throw bad('certificate does not match the candidate');
  }
  const ownerKey = await room.devicePublicKey(room.getDevice(auth.deviceId)!);
  if (!(await verifyDeviceCert(cert, ownerKey))) throw bad('certificate signature invalid');
  if (
    grant.device_id !== cand.device_id ||
    grant.installation_id !== auth.installationId ||
    grant.issuer_device_id !== auth.deviceId ||
    grant.key_epoch !== room.currentEpoch()
  ) {
    throw bad('grant does not match the candidate or current epoch');
  }
  if (!(await verifyObject(ownerKey, grant))) throw bad('grant signature invalid');
  await room.tx(() => {
    room.assertActive(auth.deviceId);
    // The epoch may have rotated while the signatures above were being verified.
    if (grant.key_epoch !== room.currentEpoch()) {
      throw new ApiError('revision_conflict', 'key epoch changed; approve again');
    }
    const cur = room.q1<{ state: string }>(
      `SELECT state FROM pairing_sessions WHERE pairing_id = ?`,
      id,
    );
    if (cur?.state !== 'pending-approval')
      throw new ApiError('invalid_state', 'pairing is no longer pending');
    const n = room.q1<{ n: number }>(
      `SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL`,
    )!.n;
    if (n >= LIMITS.maxDevices) throw new ApiError('forbidden', 'device limit reached');
    room.run(
      `INSERT INTO devices (device_id, role, label, signing_pub, exchange_pub, cert_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      cert.device_id,
      cert.role,
      cert.label,
      cert.signing_pub,
      cert.exchange_pub,
      JSON.stringify(cert),
      t,
    );
    room.run(
      `INSERT INTO device_key_grants (device_id, key_epoch, grant_json) VALUES (?, ?, ?)`,
      grant.device_id,
      grant.key_epoch,
      JSON.stringify(grant),
    );
    room.run(
      `UPDATE pairing_sessions SET state = 'approved', cert_json = ?, grant_json = ?, consumed_at = ? WHERE pairing_id = ?`,
      JSON.stringify(cert),
      JSON.stringify(grant),
      t,
      id,
    );
    room.emit('device.approved', { deviceId: auth.deviceId, data: { cert } });
  });
  return json(200, { device_id: cert.device_id });
};

export const reject: Handler = async (room, c) => {
  c.body(PairingRejectBody);
  const id = c.params[0]!;
  await room.tx(() => {
    const n = room.run(
      `UPDATE pairing_sessions SET state = 'rejected' WHERE pairing_id = ? AND state IN ('waiting-for-candidate','pending-approval')`,
      id,
    );
    if (n === 0) throw new ApiError('invalid_state', 'nothing to reject');
  });
  return json(200, { ok: true });
};

export const status: Handler = async (room, c) => {
  room.hit(`pairstatus:${c.req.ip}`, 120, 10 * 60_000);
  const id = c.params[0]!;
  const secret = c.req.headers?.['x-pairing-secret'] ?? '';
  const first = room.q1<PairingRow>(`SELECT * FROM pairing_sessions WHERE pairing_id = ?`, id);
  const nope = () => new ApiError('not_authenticated', 'invalid or expired invitation');
  if (!first || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw nope();
  const digest = await sha256Hex(base64UrlToBytes(secret));
  // Re-read after the await: the device may have been revoked, or the pairing changed, meanwhile.
  const row = room.q1<PairingRow>(`SELECT * FROM pairing_sessions WHERE pairing_id = ?`, id);
  if (!row) throw nope();
  if (
    !timingSafeEqual(new TextEncoder().encode(digest), new TextEncoder().encode(row.invite_digest))
  )
    throw nope();
  const t = nowMs();
  const owner = ownerRow(room);
  const cand = row.candidate_json ? (JSON.parse(row.candidate_json) as Candidate) : null;
  let state: string = row.state;
  if (row.state === 'approved') {
    // A device revoked before it collected its grant must never be able to collect it afterwards.
    const approvedDevice = (JSON.parse(row.cert_json!) as DeviceCert).device_id;
    if (
      t > row.expires_at + APPROVED_GRACE_MS ||
      room.getDevice(approvedDevice)?.revoked_at != null
    ) {
      state = 'expired';
    }
  } else if (row.expires_at <= t) {
    state = 'expired';
  }
  const approved = state === 'approved';
  return json(200, {
    state,
    short_code: cand?.short_code ?? null,
    expires_at: iso(row.expires_at),
    owner_cert: owner ? (JSON.parse(owner.cert_json) as DeviceCert) : null,
    cert: approved ? (JSON.parse(row.cert_json!) as DeviceCert) : null,
    grant: approved ? (JSON.parse(row.grant_json!) as EpochGrant) : null,
  });
};
