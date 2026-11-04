import { exports } from 'cloudflare:workers';
import { testEnv as env } from './env.js';
import { runInDurableObject } from 'cloudflare:test';
import {
  MESSAGE_RECORD_TYPE,
  MessagesPage,
  PROTOCOL_VERSION,
  bytesToBase64Url,
  type CryptoEnvelope,
  type DeviceCert,
  type EpochGrant,
  type PairingInvitePayload,
  type Requirement,
  type Role,
} from '@daintreehq/decisions-protocol';
import {
  buildSignedAction,
  buildSignedQuestion,
  createEpochGrant,
  encryptAttachment,
  encryptEnvelope,
  envelopeDigest,
  exportPublicKey,
  generateDeviceKeys,
  generateEpochKeyBytes,
  generatePairingSecret,
  importEpochKey,
  inviteDigest,
  issueDeviceCert,
  newId,
  nowIso,
  openEpochGrant,
  signObject,
  signPairingPop,
  signRequest,
  verifyDeviceCert,
  type DeviceKeys,
  type EpochKey,
  sha256Hex,
} from '@daintreehq/decisions-crypto';
import type { DecisionRoom } from '../src/decision-room.js';

export const ORIGIN = 'https://relay.test';
export const CLAIM_SECRET = 'test-claim-secret-0123456789abcdef';

export interface Res<T = any> {
  status: number;
  json: T;
  headers: Headers;
  text: string;
}

export async function raw(
  method: string,
  path: string,
  opts: { body?: string | Uint8Array; headers?: Record<string, string> } = {},
): Promise<Res> {
  const res = await exports.default.fetch(
    new Request(ORIGIN + path, {
      method,
      headers: opts.headers,
      body: opts.body as BodyInit | undefined,
    }),
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, headers: res.headers, text };
}

export class Actor {
  constructor(
    public readonly role: Role,
    public readonly id: string,
    public readonly keys: DeviceKeys,
    public readonly signingPub: string,
    public readonly exchangePub: string,
    public readonly label: string,
    public installationId = '',
    public epochs = new Map<number, EpochKey>(),
  ) {}

  static async create(role: Role, label: string = role): Promise<Actor> {
    const keys = await generateDeviceKeys(role === 'owner-desktop' || role === 'desktop-host');
    return new Actor(
      role,
      newId(),
      keys,
      await exportPublicKey(keys.signing.publicKey),
      await exportPublicKey(keys.exchange.publicKey),
      label,
    );
  }

  get epoch(): EpochKey {
    return [...this.epochs.values()].sort((a, b) => b.epoch - a.epoch)[0]!;
  }

  async call(method: string, path: string, body?: unknown, query = ''): Promise<Res> {
    const text = body === undefined ? '' : JSON.stringify(body);
    const { authorization } = await signRequest({
      method,
      path,
      query,
      body: text,
      installationId: this.installationId,
      deviceId: this.id,
      signingKey: this.keys.signing.privateKey,
    });
    return raw(method, path + (query ? `?${query}` : ''), {
      body: text || undefined,
      headers: { authorization, ...(text ? { 'content-type': 'application/json' } : {}) },
    });
  }

  /** Same signature, different bytes sent: for tamper tests. */
  async callSignedFor(
    method: string,
    path: string,
    signedBody: string,
    sentBody: string,
  ): Promise<Res> {
    const { authorization } = await signRequest({
      method,
      path,
      body: signedBody,
      installationId: this.installationId,
      deviceId: this.id,
      signingKey: this.keys.signing.privateKey,
    });
    return raw(method, path, { body: sentBody, headers: { authorization } });
  }

  async authHeader(method: string, path: string, query = '', body = ''): Promise<string> {
    return (
      await signRequest({
        method,
        path,
        query,
        body,
        installationId: this.installationId,
        deviceId: this.id,
        signingKey: this.keys.signing.privateKey,
      })
    ).authorization;
  }
}

export interface World {
  owner: Actor;
  epoch: EpochKey;
  epochRaw: Uint8Array;
  installationId: string;
}

export async function claimRelay(): Promise<World> {
  const owner = await Actor.create('owner-desktop', 'Test Mac');
  owner.installationId = newId();
  const epochRaw = generateEpochKeyBytes();
  const epoch = await importEpochKey(epochRaw, 1, true);
  owner.epochs.set(1, epoch);
  const cert = await issueDeviceCert({
    issuerDeviceId: owner.id,
    issuerSigningKey: owner.keys.signing.privateKey,
    installationId: owner.installationId,
    deviceId: owner.id,
    role: 'owner-desktop',
    label: owner.label,
    signingPub: owner.signingPub,
    exchangePub: owner.exchangePub,
  });
  const res = await raw('POST', '/api/v1/setup/claim', {
    body: JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      claim_secret: CLAIM_SECRET,
      installation_id: owner.installationId,
      cert,
    }),
  });
  if (res.status !== 201) throw new Error(`claim failed: ${res.status} ${res.text}`);
  return { owner, epoch, epochRaw, installationId: owner.installationId };
}

export async function pairDevice(
  w: World,
  role: 'phone' | 'tablet' = 'phone',
  label = 'Test iPhone',
): Promise<Actor> {
  const phone = await Actor.create(role, label);
  phone.installationId = w.installationId;
  const secret = generatePairingSecret();
  const pairingId = newId();
  const inv = await w.owner.call('POST', '/api/v1/pairing/invitations', {
    protocol_version: PROTOCOL_VERSION,
    pairing_id: pairingId,
    invite_digest: await inviteDigest(secret),
    expires_at: new Date(Date.now() + 4 * 60_000).toISOString(),
    role,
  });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.text}`);
  const cand = await raw('POST', '/api/v1/pairing/candidates', {
    body: JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      pairing_id: pairingId,
      secret,
      device_id: phone.id,
      label,
      signing_pub: phone.signingPub,
      exchange_pub: phone.exchangePub,
      pop: await signPairingPop(phone.keys.signing.privateKey, {
        pairingId,
        deviceId: phone.id,
        exchangePub: phone.exchangePub,
        signingPub: phone.signingPub,
      }),
    }),
  });
  if (cand.status !== 201) throw new Error(`candidate failed ${cand.text}`);
  const cert = await issueDeviceCert({
    issuerDeviceId: w.owner.id,
    issuerSigningKey: w.owner.keys.signing.privateKey,
    installationId: w.installationId,
    deviceId: phone.id,
    role,
    label,
    signingPub: phone.signingPub,
    exchangePub: phone.exchangePub,
  });
  const grant = await createEpochGrant({
    issuerDeviceId: w.owner.id,
    issuerSigningKey: w.owner.keys.signing.privateKey,
    installationId: w.installationId,
    recipientDeviceId: phone.id,
    recipientExchangePub: phone.exchangePub,
    epoch: w.epoch.epoch,
    epochKeyRaw: w.epochRaw,
  });
  const ap = await w.owner.call('POST', `/api/v1/pairing/${pairingId}/approve`, {
    protocol_version: PROTOCOL_VERSION,
    cert,
    grant,
  });
  if (ap.status !== 200) throw new Error(`approve failed ${ap.text}`);
  const st = await raw('GET', `/api/v1/pairing/${pairingId}/status`, {
    headers: { 'x-pairing-secret': secret },
  });
  const ownerCert = st.json.owner_cert as DeviceCert;
  const ownerKey = w.owner.keys.signing.publicKey;
  if (!(await verifyDeviceCert(ownerCert, ownerKey))) throw new Error('owner cert');
  phone.epochs.set(
    1,
    await openEpochGrant({
      grant: st.json.grant as EpochGrant,
      ownerSigningPublicKey: ownerKey,
      exchangePrivateKey: phone.keys.exchange.privateKey,
      expectedInstallationId: w.installationId,
      expectedDeviceId: phone.id,
    }),
  );
  return phone;
}

export interface AskOpts {
  requirement?: Requirement;
  questionId?: string;
  expiresAt?: string | null;
  originRef?: string;
  host?: string;
  attachmentIds?: string[];
  content?: Record<string, unknown>;
  idempotencyKey?: string;
}

export async function ask(w: World, o: AskOpts = {}) {
  const questionId = o.questionId ?? newId();
  const envelope = await encryptEnvelope({
    epochKey: w.epoch,
    installationId: w.installationId,
    questionId,
    recordId: newId(),
    recordType: 'question',
    revision: 0,
    senderDeviceId: w.owner.id,
    purpose: 'question-content',
    plaintext: o.content ?? {
      content_version: 1,
      question: 'Use the compact sidebar?',
      kind: 'approval',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      attachments: [],
      allow_text: true,
    },
  });
  const q = await buildSignedQuestion({
    installationId: w.installationId,
    questionId,
    signerDeviceId: w.owner.id,
    signingKey: w.owner.keys.signing.privateKey,
    targetHostId: o.host ?? 'host_aaaaaaaa',
    originRef: o.originRef ?? 'pane_aaaaaaaa',
    requirement: o.requirement ?? 'human-required',
    expiresAt:
      o.expiresAt === undefined ? new Date(Date.now() + 7 * 86400_000).toISOString() : o.expiresAt,
    attachmentIds: o.attachmentIds ?? [],
    envelope,
  });
  const res = await w.owner.call('POST', '/api/v1/questions', {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: o.idempotencyKey ?? newId(),
    question: q,
  });
  return { res, questionId, question: q };
}

export type ActionKindT =
  'answer' | 'override' | 'proxy-answer' | 'proxy-abstain' | 'confirm-proxy' | 'cancel' | 'reopen';

/** Builds, signs and posts an action. `expected` is the revision the actor believes is current. */
export async function act(
  w: World,
  actor: Actor,
  kind: ActionKindT,
  questionId: string,
  expected: number,
  opts: {
    content?: Record<string, unknown> | null;
    confirmsActionId?: string;
    expiresAt?: string | null;
    idempotencyKey?: string;
    actionId?: string;
    epoch?: EpochKey;
  } = {},
) {
  const bumps = ['answer', 'override', 'proxy-answer', 'confirm-proxy', 'reopen'].includes(kind);
  const needsEnvelope = ['answer', 'override', 'proxy-answer'].includes(kind);
  const content =
    opts.content === undefined
      ? needsEnvelope
        ? { selected_option_ids: ['approve'], text: 'go' }
        : null
      : opts.content;
  const envelope: CryptoEnvelope | null = content
    ? await encryptEnvelope({
        epochKey: opts.epoch ?? actor.epoch ?? w.epoch,
        installationId: w.installationId,
        questionId,
        recordId: newId(),
        recordType: kind,
        revision: bumps ? expected + 1 : expected,
        senderDeviceId: actor.id,
        purpose: 'answer-content',
        plaintext: content,
      })
    : null;
  const signed = await buildSignedAction({
    installationId: w.installationId,
    questionId,
    action: kind,
    signerDeviceId: actor.id,
    signingKey: actor.keys.signing.privateKey,
    expectedRevision: expected,
    envelope,
    confirmsActionId: opts.confirmsActionId ?? null,
    expiresAt: opts.expiresAt ?? null,
    ...(opts.actionId ? { actionId: opts.actionId } : {}),
  });
  const res = await actor.call('POST', `/api/v1/questions/${questionId}/${kind}`, {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: opts.idempotencyKey ?? newId(),
    action: signed,
  });
  return { res, signed };
}

export const stub = () => env.DECISION_ROOM.get(env.DECISION_ROOM.idFromName('primary'));

export async function inRoom<R>(
  fn: (room: DecisionRoom, state: DurableObjectState) => R | Promise<R>,
): Promise<R> {
  return runInDurableObject(stub(), fn as never) as Promise<R>;
}

export async function events(a: Actor, after = 0): Promise<any[]> {
  const r = await a.call('GET', '/api/v1/events', undefined, `after=${after}&limit=100`);
  return r.json.events;
}

export interface Uploaded {
  attachmentId: string;
  enc: Awaited<ReturnType<typeof encryptAttachment>>;
  put: Res;
  complete: Res | null;
}

/** Client-side attachment flow: choose id, encrypt, reserve, PUT ciphertext, complete. */
export async function uploadImage(
  w: World,
  questionId: string,
  plaintext: Uint8Array,
  o: { sendBytes?: Uint8Array; skipComplete?: boolean } = {},
): Promise<Uploaded> {
  const attachmentId = newId();
  const enc = await encryptAttachment(
    w.epoch,
    { installationId: w.installationId, questionId, attachmentId, keyEpoch: w.epoch.epoch },
    plaintext,
  );
  const reservation = await w.owner.call('POST', '/api/v1/attachments/reservations', {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: newId(),
    question_id: questionId,
    attachment_id: attachmentId,
    ciphertext_bytes: enc.ciphertext.length,
    sha256_ciphertext: enc.sha256Ciphertext,
    mime_category: 'image',
  });
  if (reservation.status !== 201) throw new Error(`reserve failed ${reservation.text}`);
  const path = `/api/v1/attachments/${attachmentId}/content`;
  const body = o.sendBytes ?? enc.ciphertext;
  const authorization = await w.owner.authHeader('PUT', path, '', '');
  // The signature covers the *declared* ciphertext digest, exactly as the real client does.
  const signed = await signRequest({
    method: 'PUT',
    path,
    body: enc.ciphertext,
    installationId: w.installationId,
    deviceId: w.owner.id,
    signingKey: w.owner.keys.signing.privateKey,
  });
  void authorization;
  const put = await raw('PUT', path, {
    body,
    headers: {
      authorization: signed.authorization,
      'x-content-sha256': enc.sha256Ciphertext,
      'content-length': String(body.length),
    },
  });
  let complete: Res | null = null;
  if (put.status === 200 && !o.skipComplete) {
    complete = await w.owner.call('POST', `/api/v1/attachments/${attachmentId}/complete`, {
      protocol_version: PROTOCOL_VERSION,
    });
  }
  return { attachmentId, enc, put, complete };
}

export { sha256Hex, bytesToBase64Url, type PairingInvitePayload };

/** Declares `features` the way a client does, on a socket ticket; the relay records it for the device. */
export async function declare(
  a: Actor,
  features: string[] = ['thread-messages-v1'],
): Promise<string> {
  const r = await a.call('POST', '/api/v1/socket-ticket', {
    protocol_version: PROTOCOL_VERSION,
    features,
  });
  if (r.status !== 200) throw new Error(`ticket failed ${r.status} ${r.text}`);
  return r.json.ticket as string;
}

/** Enrolls a `desktop-host` device; `world` is the same relay with the host as the asking desktop. */
export async function enrollHost(w: World): Promise<{ host: Actor; world: World }> {
  const host = await Actor.create('desktop-host', 'Remote Host');
  host.installationId = w.installationId;
  const cert = await issueDeviceCert({
    issuerDeviceId: w.owner.id,
    issuerSigningKey: w.owner.keys.signing.privateKey,
    installationId: w.installationId,
    deviceId: host.id,
    role: 'desktop-host',
    label: host.label,
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
  if (res.status !== 201) throw new Error(`enroll failed ${res.status} ${res.text}`);
  host.epochs.set(w.epoch.epoch, w.epoch);
  return { host, world: { ...w, owner: host } };
}

export interface SayOpts {
  side?: 'human' | 'agent';
  text?: string;
  expectsReply?: boolean;
  messageId?: string;
  idempotencyKey?: string;
  attachmentIds?: string[];
  epoch?: EpochKey;
  /** Edits the record before it is signed (for binding tests). */
  edit?: (record: Record<string, unknown>) => void;
  /** Signs with this key instead of the actor's (forgery tests). */
  signingKey?: CryptoKey;
  /** Build the body without posting it. */
  post?: boolean;
}

/** Encrypts, signs and posts a thread message. The side follows the actor's role unless given. */
export async function say(w: World, actor: Actor, questionId: string, o: SayOpts = {}) {
  const human = actor.role === 'phone' || actor.role === 'tablet';
  const side = o.side ?? (human ? 'human' : 'agent');
  const messageId = o.messageId ?? newId();
  const text = o.text ?? (side === 'human' ? 'Also check the footer' : 'Which footer?');
  const envelope = await encryptEnvelope({
    epochKey: o.epoch ?? actor.epoch ?? w.epoch,
    installationId: w.installationId,
    questionId,
    recordId: messageId,
    recordType: MESSAGE_RECORD_TYPE,
    revision: 0,
    senderDeviceId: actor.id,
    purpose: 'message-content',
    plaintext:
      side === 'human'
        ? { content_version: 1, side, text, images: [] }
        : { content_version: 1, side, text },
  });
  const unsigned: Record<string, unknown> = {
    v: PROTOCOL_VERSION,
    type: MESSAGE_RECORD_TYPE,
    installation_id: w.installationId,
    question_id: questionId,
    message_id: messageId,
    side,
    expects_reply: o.expectsReply ?? false,
    attachment_ids: o.attachmentIds ?? [],
    created_at: nowIso(),
    envelope_digest: await envelopeDigest(envelope),
    signer_device_id: actor.id,
  };
  o.edit?.(unsigned);
  const record = await signObject(o.signingKey ?? actor.keys.signing.privateKey, unsigned);
  const body = {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: o.idempotencyKey ?? newId(),
    message: { record, envelope },
  };
  const res =
    o.post === false
      ? (null as unknown as Res)
      : await actor.call('POST', `/api/v1/questions/${questionId}/messages`, body);
  return { res, record, envelope, body, messageId };
}

/** Every message of a question, following `next_after` across pages. */
export async function thread(a: Actor, questionId: string, limit = 50): Promise<any[]> {
  const out: any[] = [];
  let after = 0;
  for (;;) {
    const r = await a.call(
      'GET',
      `/api/v1/questions/${questionId}/messages`,
      undefined,
      `after=${after}&limit=${limit}`,
    );
    if (r.status !== 200) throw new Error(`thread failed ${r.status} ${r.text}`);
    MessagesPage.parse(r.json);
    out.push(...r.json.messages);
    after = r.json.next_after;
    if (!r.json.has_more) return out;
  }
}

/**
 * Alarms also fire on their own in the test runtime, so after forcing jobs due we wait until nothing due is
 * left pending (and any push in flight has finished) before asserting. Keeps timing-sensitive tests deterministic.
 */
export async function settle(maxMs = 5000): Promise<void> {
  const end = Date.now() + maxMs;
  for (;;) {
    const due = await inRoom(
      (room) =>
        room.q1<{ n: number }>(
          `SELECT COUNT(*) AS n FROM scheduled_jobs WHERE status = 'pending' AND run_at <= ?`,
          Date.now(),
        )!.n,
    );
    if (due === 0 || Date.now() > end) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 120));
}
