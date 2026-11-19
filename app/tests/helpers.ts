import type { DeviceCert, LedgerEvent, Requirement } from '@daintreehq/decisions-protocol';
import {
  ADVISORY_QUESTION_FIXTURE,
  BLOCKING_APPROVAL_FIXTURE,
} from '@daintreehq/decisions-protocol/fixtures';
import {
  buildSignedAction,
  buildSignedMessage,
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
  label: string = role,
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
    label,
    signingPub,
    exchangePub,
  });
  return { id, keys, cert, signingPub, exchangePub };
}

/** Another desktop the owner certified: it can sign, but it did not publish the world's questions. */
export async function otherDesktop(w: World): Promise<Actor> {
  const d = await actor(w.installationId, 'desktop-host', w.owner);
  await w.trust.addCert(d.cert, null);
  return d;
}

/** Another paired phone or tablet, certified by the owner and trusted. */
export async function otherHuman(w: World, role: 'phone' | 'tablet' = 'tablet'): Promise<Actor> {
  const d = await actor(w.installationId, role, w.owner, false);
  await w.trust.addCert(d.cert, null);
  return d;
}

export async function makeWorld(o: { ownerLabel?: string } = {}): Promise<World> {
  const installationId = newId();
  const owner = await actor(installationId, 'owner-desktop', null, true, o.ownerLabel);
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
    /** Seal (and sign) the envelope for another purpose than question content. */
    purpose?: 'question-content' | 'answer-content';
    /** Mark the question advisory in its envelope's AAD (docs/protocol.md section 21). */
    replyMode?: 'advisory';
    /** Ask it under a named workflow gate (its signed hash). */
    gate?: string;
    occurredAt?: string;
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
    purpose: o.purpose ?? 'question-content',
    ...(o.replyMode ? { replyMode: o.replyMode } : {}),
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
    ...(o.gate ? { workflowGateIdHash: o.gate, policyVersion: 1 } : {}),
  });
  if (o.tamper) o.tamper(q.envelope);
  return ev({
    ...(o.seq ? { seq: o.seq } : {}),
    event_type: 'decision.created',
    question_id: questionId,
    question_revision: 0,
    origin_device_id: signer.id,
    ...(o.occurredAt ? { occurred_at: o.occurredAt } : {}),
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
    provenance?: 'human' | 'human-desktop' | 'proxy' | null;
    occurredAt?: string;
    envelopeQuestionId?: string;
    confirms?: string | null;
    seq?: number;
    /** A `cancel` signed with `decline: true` (the owner desktop's decline for the person). */
    decline?: true;
    /** A `reopen`'s signed new deadline (null: never). */
    expiresAt?: string | null;
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
    ...(o.decline ? { decline: o.decline } : {}),
    ...(o.expiresAt !== undefined ? { expiresAt: o.expiresAt } : {}),
  });
  const provenance =
    o.provenance !== undefined
      ? o.provenance
      : human
        ? o.action === 'answer' && signer.cert.role === 'owner-desktop'
          ? 'human-desktop'
          : 'human'
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

/** A `decision.message.posted` event: a human follow-up signed by the phone, or the publishing desktop's agent. */
export async function messageEvent(
  w: World,
  o: {
    questionId: string;
    side: 'human' | 'agent';
    text?: string;
    expectsReply?: boolean;
    signer?: Actor;
    /** Content to seal in place of the side's usual shape. */
    plaintext?: unknown;
    seq?: number;
    messageSeq?: number;
  },
): Promise<LedgerEvent> {
  const signer = o.signer ?? (o.side === 'human' ? w.phone : w.desktop);
  const messageId = newId();
  const envelope = await encryptEnvelope({
    epochKey: w.epoch,
    installationId: w.installationId,
    questionId: o.questionId,
    recordId: messageId,
    recordType: 'thread.message',
    revision: 0,
    senderDeviceId: signer.id,
    purpose: 'message-content',
    plaintext: o.plaintext ?? {
      content_version: 1,
      side: o.side,
      text: o.text ?? (o.side === 'human' ? 'Also bump the version.' : 'Which version?'),
      ...(o.side === 'human' ? { images: [] } : {}),
    },
  });
  const m = await buildSignedMessage({
    installationId: w.installationId,
    questionId: o.questionId,
    messageId,
    side: o.side,
    signerDeviceId: signer.id,
    signingKey: signer.keys.signing.privateKey,
    expectsReply: o.expectsReply ?? false,
    envelope,
  });
  return ev({
    ...(o.seq ? { seq: o.seq } : {}),
    event_type: 'decision.message.posted',
    question_id: o.questionId,
    question_revision: null,
    origin_device_id: signer.id,
    data: {
      message_seq: o.messageSeq ?? 1,
      committed_at: nowIso(),
      record: m.record,
      envelope: m.envelope,
      target_host_id: 'host_aaaaaaaa',
    },
  });
}

/* ---------- deadline scenarios (docs/protocol.md section 21) ---------- */

export const MINUTE = 60_000;

/** The relay expiring a question's open round at `at` (relay time), as `expireQuestionNow` emits it. */
export function expiredEvent(questionId: string, at: number, revision = 0): LedgerEvent {
  return plainEvent(
    'decision.expired',
    questionId,
    { expired_at: new Date(at).toISOString(), target_host_id: 'host_aaaaaaaa' },
    { occurred_at: new Date(at).toISOString(), question_revision: revision },
  );
}

export type ScenarioKind =
  'old-content' | 'no-expiry' | 'advisory' | 'dismissed' | 'required-expiry';

export interface Scenario {
  questionId: string;
  /** When it was asked, and its signed deadline (null for none), in ms. */
  asked: number;
  deadline: number | null;
  events: LedgerEvent[];
}

/**
 * The phone's deadline fixtures, signed with the world's keys:
 * - `old-content`: a blocking question as 0.8.0 signed it (no reply mode in its AAD), due 15 minutes after it was asked;
 * - `no-expiry`: a blocking question with no deadline;
 * - `advisory`: the 15-minute advisory question (`ADVISORY_QUESTION_FIXTURE`'s content and plan);
 * - `dismissed`: that advisory question, declined from this phone;
 * - `required-expiry`: a gated approval that needs a person (`BLOCKING_APPROVAL_FIXTURE`), which the relay expired.
 */
export async function deadlineScenario(
  w: World,
  kind: ScenarioKind,
  asked = kind === 'required-expiry' ? Date.now() - 20 * MINUTE : Date.now(),
): Promise<Scenario> {
  const questionId = newId();
  const deadline = kind === 'no-expiry' ? null : asked + 15 * MINUTE;
  const expiresAt = deadline === null ? null : new Date(deadline).toISOString();
  const occurredAt = new Date(asked).toISOString();
  const advisory = kind === 'advisory' || kind === 'dismissed';
  const created = await questionEvent(w, {
    questionId,
    expiresAt,
    occurredAt,
    ...(advisory
      ? { replyMode: 'advisory' as const, content: { ...ADVISORY_QUESTION_FIXTURE.content } }
      : kind === 'required-expiry'
        ? {
            gate: BLOCKING_APPROVAL_FIXTURE.record.workflow_gate_id_hash!,
            content: { ...BLOCKING_APPROVAL_FIXTURE.content },
          }
        : {}),
  });
  const events = [created];
  if (kind === 'dismissed')
    events.push(
      await actionEvent(w, {
        questionId,
        action: 'cancel',
        signer: w.phone,
        occurredAt: new Date(asked + 2 * MINUTE).toISOString(),
      }),
    );
  if (kind === 'required-expiry') events.push(expiredEvent(questionId, deadline! + 1_000));
  return { questionId, asked, deadline, events };
}
