import {
  ApiError,
  LIMITS,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SetupClaimBody,
  utf8ToBytes,
  timingSafeEqual,
  type ProtocolFeature,
} from '@daintreehq/decisions-protocol';
import { sha256, verifySelfSignedCert } from '@daintreehq/decisions-crypto';
import { WORKER_VERSION } from '../env.js';
import { generateVapidKeys } from '../push/webpush.js';
import type { Handler } from '../room/types.js';
import { iso, json, nowMs } from '../util.js';

/** The extensions this relay implements (docs/protocol.md section 19), advertised in `GET /info`. */
export const RELAY_FEATURES: readonly ProtocolFeature[] = [
  'pane-snapshots-v1',
  'thread-messages-v1',
];

export const info: Handler = async (room) =>
  json(200, {
    name: 'daintree-decisions',
    protocol_min: MIN_PROTOCOL_VERSION,
    protocol_max: PROTOCOL_VERSION,
    worker_version: WORKER_VERSION,
    claimed: Boolean(room.installationId()),
    claim_configured: (room.env.CLAIM_SECRET ?? '').length >= 16,
    voice: {
      xai: Boolean(room.env.XAI_API_KEY),
      anthropic: Boolean(room.env.ANTHROPIC_API_KEY),
      openai: Boolean(room.env.OPENAI_API_KEY),
    },
    features: RELAY_FEATURES,
  });

/** One-time owner claim. After success the claim path is permanently closed. */
export const claim: Handler = async (room, c) => {
  room.hit(`claim:${c.req.ip}`, 10, 3_600_000);
  const body = c.body(SetupClaimBody);
  if (room.installationId())
    throw new ApiError('already_claimed', 'this relay has already been claimed');
  const secret = room.env.CLAIM_SECRET ?? '';
  if (secret.length < 16) {
    throw new ApiError(
      'not_configured',
      'CLAIM_SECRET is not set on this Worker (min 16 characters)',
    );
  }
  // Compare digests so length differences do not leak through timing.
  const ok = timingSafeEqual(
    await sha256(utf8ToBytes(secret)),
    await sha256(utf8ToBytes(body.claim_secret)),
  );
  if (!ok) {
    room.hit(`claimfail:${c.req.ip}`, 5, 3_600_000);
    throw new ApiError('not_authenticated', 'invalid claim secret');
  }
  const cert = body.cert;
  if (
    cert.role !== 'owner-desktop' ||
    cert.issuer_device_id !== cert.device_id ||
    cert.installation_id !== body.installation_id
  ) {
    throw new ApiError(
      'validation_error',
      'claim certificate must be a self-signed owner-desktop certificate',
    );
  }
  if (!(await verifySelfSignedCert(cert)))
    throw new ApiError('validation_error', 'certificate signature invalid');
  const vapid = await generateVapidKeys();
  const t = nowMs();
  await room.tx(() => {
    if (room.installationId())
      throw new ApiError('already_claimed', 'this relay has already been claimed');
    room.run(
      `INSERT INTO devices (device_id, role, label, signing_pub, exchange_pub, cert_json, created_at)
       VALUES (?, 'owner-desktop', ?, ?, ?, ?, ?)`,
      cert.device_id,
      cert.label,
      cert.signing_pub,
      cert.exchange_pub,
      JSON.stringify(cert),
      t,
    );
    room.setMeta('installation_id', body.installation_id);
    room.setMeta('claimed_at', String(t));
    room.setMeta('current_epoch', '1');
    if (c.req.origin?.startsWith('https://')) room.setMeta('origin', c.req.origin);
    room.setMeta('vapid', JSON.stringify(vapid));
    room.schedule({ kind: 'purge', runAt: t + 24 * 3_600_000 });
  });
  return json(201, {
    installation_id: body.installation_id,
    vapid_public_key: vapid.publicKey,
    server_time: iso(t),
  });
};
