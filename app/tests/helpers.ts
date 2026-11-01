import type { DeviceCert, LedgerEvent, Requirement } from '@daintreehq/decisions-protocol';
import {
  buildSignedAction,
  buildSignedQuestion,
  encryptEnvelope,
  exportPublicKey,
  generateDeviceKeys,
  generateEpochKeyBytes,
  importEpochKey,
  issueDeviceCert,
  newId,
  nowIso,
  type DeviceKeys,
  type EpochKey,
} from '@daintreehq/decisions-crypto';
import { TrustStore } from '../src/domain/trust.js';

export interface Actor {
  id: string;
  keys: DeviceKeys;
  cert: DeviceCert;
  signingPub: string;
  exchangePub: string;
}

export interface World {
  installationId: string;
  owner: Actor;
  desktop: Actor;
  phone: Actor;
  epochRaw: Uint8Array;
  epoch: EpochKey;
  /** Epoch map as a viewer on the phone holds it (HKDF key only). */
  epochs: Map<number, EpochKey>;
  trust: TrustStore;
}

async function actor(
  installationId: string,
  role: DeviceCert['role'],
  issuer: Actor | null,
  extractable = true,
): Promise<Actor> {
  const keys = await generateDeviceKeys(extractable);
  const id = newId();
  const signingPub = await exportPublicKey(keys.signing.publicKey);
  const exchangePub = await exportPublicKey(keys.exchange.publicKey);
  const cert = await issueDeviceCert({
    issuerDeviceId: issuer?.id ?? id,
    issuerSigningKey: (issuer?.keys ?? keys).signing.privateKey,
    installationId,
    deviceId: id,
    role,
    label: role,
    signingPub,
    exchangePub,
  });
  return { id, keys, cert, signingPub, exchangePub };
}

export async function makeWorld(): Promise<World> {
  const installationId = newId();
  const owner = await actor(installationId, 'owner-desktop', null);
  const desktop = owner; // the owner desktop is the asking machine
  const phone = await actor(installationId, 'phone', owner, false);
  const epochRaw = generateEpochKeyBytes();
  const epoch = await importEpochKey(epochRaw, 1, true);
  const trust = await TrustStore.create(installationId, owner.cert, owner.signingPub);
  await trust.addCert(phone.cert, null);
  return {
    installationId,
    owner,
    desktop,
    phone,
    epochRaw,
    epoch,
    epochs: new Map([[1, { epoch: 1, key: epoch.key }]]),
    trust,
  };
}

let seqCounter = 0;
export const nextSeq = () => ++seqCounter;

function ev(
  partial: Pick<LedgerEvent, 'event_type' | 'question_id' | 'question_revision' | 'data'> &
    Partial<LedgerEvent>,
): LedgerEvent {
  return {
    protocol_version: 1,
    seq: nextSeq(),
    event_id: newId(),
    occurred_at: nowIso(),
    origin_device_id: null,
    ...partial,
  } as LedgerEvent;
}

export const SAMPLE_CONTENT = {
  content_version: 1,
  question: 'Use the compact sidebar?',
  context: 'Design review',
  kind: 'choice',
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  attachments: [],
  allow_text: true,
  project_label: 'daintree',
  machine_label: 'studio-mac',
};

export async function questionEvent(
  w: World,
  o: {
    questionId?: string;
    requirement?: Requirement;
    content?: unknown;
    signer?: Actor;
    expiresAt?: string | null;
    seq?: number;
    /** Encrypt the envelope for a different question id than the one the record is signed for. */
    envelopeQuestionId?: string;
    tamper?: (e: { ciphertext: string }) => void;
  } = {},
): Promise<LedgerEvent> {
  const signer = o.signer ?? w.desktop;
  const questionId = o.questionId ?? newId();
  const envelope = await encryptEnvelope({
    epochKey: w.epoch,
    installationId: w.installationId,
    questionId: o.envelopeQuestionId ?? questionId,
    recordId: questionId,
    recordType: 'question',
    revision: 0,
    senderDeviceId: signer.id,
    purpose: 'question-content',
    plaintext: o.content ?? SAMPLE_CONTENT,
  });
  const requirement = o.requirement ?? 'human-required';
  const q = await buildSignedQuestion({
    installationId: w.installationId,
    questionId,
    signerDeviceId: signer.id,
    signingKey: signer.keys.signing.privateKey,
    targetHostId: 'host_aaaaaaaa',
    originRef: 'pane_aaaaaaaa',
    requirement,
    expiresAt: o.expiresAt ?? null,
    attachmentIds: [],
    envelope,
  });
  if (o.tamper) o.tamper(q.envelope);
  return ev({
    ...(o.seq ? { seq: o.seq } : {}),
    event_type: 'decision.created',
    question_id: questionId,
    question_revision: 0,
    origin_device_id: signer.id,
    data: {
      record: q.record,
      envelope: q.envelope,
      requirement,
      target_host_id: 'host_aaaaaaaa',
      expires_at: o.expiresAt ?? null,
    },
  });
}

export async function actionEvent(
  w: World,
  o: {
    questionId: string;
    action:
      | 'answer'
      | 'override'
      | 'proxy-answer'
      | 'proxy-abstain'
      | 'confirm-proxy'
      | 'cancel'
      | 'reopen';
    signer?: Actor;
    expectedRevision?: number;
    plaintext?: unknown;
    status?: 'open' | 'proxy-answered' | 'human-answered' | 'cancelled' | 'expired';
    provenance?: 'human' | 'proxy' | null;
    occurredAt?: string;
    envelopeQuestionId?: string;
    confirms?: string | null;
    seq?: number;
  },
): Promise<LedgerEvent> {
  const human = o.action === 'answer' || o.action === 'override' || o.action === 'confirm-proxy';
  const signer = o.signer ?? (human ? w.phone : w.desktop);
  const expected = o.expectedRevision ?? 0;
  const carries = o.action === 'answer' || o.action === 'override' || o.action === 'proxy-answer';
  const actionId = newId();
  const envelope = carries
    ? await encryptEnvelope({
        epochKey: w.epoch,
        installationId: w.installationId,
        questionId: o.envelopeQuestionId ?? o.questionId,
        recordId: actionId,
        recordType: o.action,
        revision: expected + 1,
        senderDeviceId: signer.id,
        purpose: 'answer-content',
        plaintext:
          o.plaintext ??
          (o.action === 'proxy-answer'
            ? {
                content_version: 1,
                selected_option_ids: ['yes'],
                reviewed_attachment_digests: [],
                model_id: 'test-model',
                prompt_template_version: 'v1',
                confidence: 0.9,
                retrieval_reference_ids: [],
              }
            : {
                content_version: 1,
                selected_option_ids: ['yes'],
                text: 'go ahead',
                reviewed_attachment_digests: [],
              }),
      })
    : null;
  const a = await buildSignedAction({
    installationId: w.installationId,
    questionId: o.questionId,
    action: o.action,
    signerDeviceId: signer.id,
    signingKey: signer.keys.signing.privateKey,
    expectedRevision: expected,
    envelope,
    actionId,
    confirmsActionId: o.confirms ?? null,
  });
  const provenance =
    o.provenance !== undefined
      ? o.provenance
      : human
        ? 'human'
        : o.action === 'proxy-answer'
          ? 'proxy'
          : null;
  const status =
    o.status ??
    (o.action === 'proxy-answer'
      ? 'proxy-answered'
      : o.action === 'cancel'
        ? 'cancelled'
        : o.action === 'reopen' || o.action === 'proxy-abstain'
          ? 'open'
          : 'human-answered');
  const bumps = o.action !== 'cancel' && o.action !== 'proxy-abstain';
  const typeMap = {
    answer: 'decision.answer.committed',
    override: 'decision.answer.overridden',
    'proxy-answer': 'decision.proxy.committed',
    'proxy-abstain': 'decision.proxy.abstained',
    'confirm-proxy': 'decision.proxy.confirmed',
    cancel: 'decision.cancelled',
    reopen: 'decision.reopened',
  } as const;
  return ev({
    ...(o.seq ? { seq: o.seq } : {}),
    event_type: typeMap[o.action],
    question_id: o.questionId,
    question_revision: bumps ? expected + 1 : expected,
    origin_device_id: signer.id,
    ...(o.occurredAt ? { occurred_at: o.occurredAt } : {}),
    data: {
      action: o.action,
      record: a.record,
      envelope: a.envelope,
      provenance,
      status,
      revision: bumps ? expected + 1 : expected,
      target_host_id: 'host_aaaaaaaa',
      deliverable: carries,
    },
  });
}

export function plainEvent(
  type: LedgerEvent['event_type'],
  questionId: string | null,
  data: Record<string, unknown>,
  extra: Partial<LedgerEvent> = {},
): LedgerEvent {
  return ev({ event_type: type, question_id: questionId, question_revision: null, data, ...extra });
}
