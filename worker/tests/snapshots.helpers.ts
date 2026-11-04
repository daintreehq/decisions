import { exports } from 'cloudflare:workers';
import {
  PROTOCOL_VERSION,
  formatFeatures,
  type ProtocolFeature,
} from '@daintreehq/decisions-protocol';
import { SNAPSHOT_FIXTURE } from '@daintreehq/decisions-protocol/fixtures';
import {
  createEpochGrant,
  encryptEnvelope,
  envelopeDigest,
  issueDeviceCert,
  newId,
  signObject,
  type EpochKey,
} from '@daintreehq/decisions-crypto';
import type { CryptoEnvelope } from '@daintreehq/decisions-protocol';
import { Actor, type World } from './helpers.js';

/** Enrolls a `desktop-host` (another Daintree Host) and returns it with the epoch key it was granted. */
export async function enrollHost(w: World, label = 'Remote Host'): Promise<Actor> {
  const host = await Actor.create('desktop-host', label);
  host.installationId = w.installationId;
  const cert = await issueDeviceCert({
    issuerDeviceId: w.owner.id,
    issuerSigningKey: w.owner.keys.signing.privateKey,
    installationId: w.installationId,
    deviceId: host.id,
    role: 'desktop-host',
    label,
    signingPub: host.signingPub,
    exchangePub: host.exchangePub,
  });
  const grant = await createEpochGrant({
    issuerDeviceId: w.owner.id,
    issuerSigningKey: w.owner.keys.signing.privateKey,
    installationId: w.installationId,
    recipientDeviceId: host.id,
    recipientExchangePub: host.exchangePub,
    epoch: w.epoch.epoch,
    epochKeyRaw: w.epochRaw,
  });
  const res = await w.owner.call('POST', '/api/v1/devices/enroll-host', {
    protocol_version: PROTOCOL_VERSION,
    cert,
    grant,
  });
  if (res.status !== 201) throw new Error(`enroll failed ${res.text}`);
  host.epochs.set(w.epoch.epoch, w.epoch);
  return host;
}

/** Declares features on a socket ticket, which the relay records as the device's latest declaration. */
export async function declare(a: Actor, features: string[]): Promise<string> {
  const res = await a.call('POST', '/api/v1/socket-ticket', {
    protocol_version: PROTOCOL_VERSION,
    features,
  });
  if (res.status !== 200) throw new Error(`ticket failed ${res.text}`);
  return res.json.ticket as string;
}

export const SNAPSHOTS: ProtocolFeature[] = ['pane-snapshots-v1'];

/** `GET /events` with a feature declaration (the signed query is sorted by key). */
export async function eventsWith(a: Actor, features: ProtocolFeature[], after = 0): Promise<any[]> {
  const query = `after=${after}&features=${formatFeatures(features)}&limit=100`;
  const r = await a.call('GET', '/api/v1/events', undefined, query);
  if (r.status !== 200) throw new Error(`events failed ${r.text}`);
  return r.json.events;
}

export interface SnapshotOpts {
  revision?: number;
  /** Desktop time the pane was read; defaults to now. */
  observedAt?: string;
  sharing?: 'on' | 'off';
  snapshotId?: string;
  content?: Record<string, unknown>;
  /** Encrypt under this epoch key instead of the signer's latest. */
  epoch?: EpochKey;
  /** Claim this installation in the record and the envelope. */
  installationId?: string;
}

/** Encrypts and signs a pane snapshot exactly as a desktop would. */
export async function buildSnapshot(
  w: World,
  signer: Actor,
  questionId: string,
  o: SnapshotOpts = {},
) {
  const snapshotId = o.snapshotId ?? newId();
  const observedAt = o.observedAt ?? new Date().toISOString();
  const sharing = o.sharing ?? 'on';
  const installationId = o.installationId ?? w.installationId;
  const envelope =
    sharing === 'on'
      ? await encryptEnvelope({
          epochKey: o.epoch ?? signer.epoch ?? w.epoch,
          installationId,
          questionId,
          recordId: snapshotId,
          recordType: 'pane.snapshot',
          revision: 0,
          senderDeviceId: signer.id,
          purpose: 'snapshot-content',
          plaintext: o.content ?? { ...SNAPSHOT_FIXTURE.content, observed_at: observedAt },
        })
      : null;
  const record = await signObject(signer.keys.signing.privateKey, {
    v: PROTOCOL_VERSION,
    type: 'pane.snapshot' as const,
    installation_id: installationId,
    question_id: questionId,
    snapshot_id: snapshotId,
    question_revision: o.revision ?? 0,
    observed_at: observedAt,
    sharing,
    envelope_digest: envelope ? await envelopeDigest(envelope) : null,
    signer_device_id: signer.id,
  });
  return { record, envelope };
}

/** Signs `record` again with `signer`'s key, its digest recomputed for `envelope`: a valid signature on any fields. */
export async function resign(
  signer: Actor,
  record: Record<string, unknown>,
  envelope: CryptoEnvelope | null,
) {
  const { signature: _signature, ...unsigned } = record;
  return {
    record: await signObject(signer.keys.signing.privateKey, {
      ...unsigned,
      envelope_digest: envelope ? await envelopeDigest(envelope) : null,
    }),
    envelope,
  } as Awaited<ReturnType<typeof buildSnapshot>>;
}

export async function putSnapshot(
  a: Actor,
  questionId: string,
  snapshot: Awaited<ReturnType<typeof buildSnapshot>>,
  idempotencyKey = newId(),
) {
  return a.call('PUT', `/api/v1/questions/${questionId}/snapshot`, {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: idempotencyKey,
    snapshot,
  });
}

/** Builds and publishes a snapshot in one step; `at` offsets `observed_at` from now in ms. */
export async function publish(
  w: World,
  signer: Actor,
  questionId: string,
  o: SnapshotOpts & { at?: number } = {},
) {
  const snap = await buildSnapshot(w, signer, questionId, {
    ...o,
    observedAt: o.observedAt ?? new Date(Date.now() + (o.at ?? 0)).toISOString(),
  });
  return { snap, res: await putSnapshot(signer, questionId, snap) };
}

export async function getSnapshot(a: Actor, questionId: string) {
  return a.call('GET', `/api/v1/questions/${questionId}/snapshot`);
}

export async function refresh(a: Actor, questionId: string, idempotencyKey = newId()) {
  return a.call('POST', `/api/v1/questions/${questionId}/snapshot/refresh`, {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: idempotencyKey,
  });
}

export interface Sock {
  ws: WebSocket;
  frames: any[];
  waitFor(pred: (f: any) => boolean, ms?: number): Promise<any>;
  close(): void;
}

/** Opens a socket from a ticket body (`features` omitted is the 0.3.0 baseline). */
export async function openSocket(a: Actor, features?: string[]): Promise<Sock> {
  const ticket = (
    await a.call('POST', '/api/v1/socket-ticket', {
      protocol_version: PROTOCOL_VERSION,
      ...(features ? { features } : {}),
    })
  ).json.ticket;
  const res = await exports.default.fetch(
    new Request(`https://relay.test/api/v1/socket?ticket=${ticket}`, {
      headers: { Upgrade: 'websocket' },
    }),
  );
  if (res.status !== 101) throw new Error(`socket failed ${res.status}`);
  const ws = res.webSocket!;
  ws.accept();
  const frames: any[] = [];
  ws.addEventListener('message', (ev) => {
    if (ev.data === 'pong') return;
    frames.push(JSON.parse(ev.data as string));
  });
  const waitFor = async (pred: (f: any) => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error('timeout waiting for frame');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  await waitFor((f) => f.t === 'hello');
  return { ws, frames, waitFor, close: () => ws.close(1000, 'bye') };
}
