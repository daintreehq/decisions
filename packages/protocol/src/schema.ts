import { z } from 'zod';
import { CRYPTO_SUITE, CRYPTO_VERSION, PROTOCOL_VERSION } from './version.js';
import { LIMITS } from './limits.js';
import { utf8ByteLength } from './encoding.js';

/* ---------- primitives ---------- */

export const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'invalid id');
export const B64Url = z.string().regex(/^[A-Za-z0-9_-]*$/, 'invalid base64url');
export const IsoTime = z.iso.datetime({ offset: false, precision: 3 });
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'invalid sha256 hex');

export const Requirement = z.enum(['human-required', 'proxy-ok', 'proxy-first']);
export type Requirement = z.infer<typeof Requirement>;

export const Role = z.enum(['owner-desktop', 'desktop-host', 'phone', 'tablet']);
export type Role = z.infer<typeof Role>;
export const DESKTOP_ROLES: readonly Role[] = ['owner-desktop', 'desktop-host'];
export const HUMAN_ROLES: readonly Role[] = ['phone', 'tablet'];

export const QuestionStatus = z.enum([
  'open',
  'proxy-answered',
  'human-answered',
  'cancelled',
  'expired',
]);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

export const DeliveryStatus = z.enum([
  'not-sent',
  'relay-queued',
  'desktop-received',
  'needs-attention',
  'delivery-uncertain',
  'terminal-delivered',
  'agent-consumed',
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

export const Provenance = z.enum(['human', 'proxy']);
export type Provenance = z.infer<typeof Provenance>;

/* ---------- keys, certificates, grants ---------- */

/** Uncompressed SEC1 P-256 point (65 bytes) = 87 base64url chars. */
export const PublicKeyB64 = B64Url.length(87);
/** ECDSA P-256 signature, IEEE P1363 r||s (64 bytes) = 86 base64url chars. */
export const SigB64 = B64Url.length(86);
/** 32-byte random salt / secret = 43 chars. */
export const Bytes32B64 = B64Url.length(43);
/** AES-GCM 96-bit nonce = 16 chars. */
export const NonceB64 = B64Url.length(16);

export const DeviceCertBody = z.looseObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('device.cert'),
  installation_id: Id,
  device_id: Id,
  role: Role,
  label: z.string().min(1).max(LIMITS.deviceLabelChars),
  signing_pub: PublicKeyB64,
  exchange_pub: PublicKeyB64,
  issued_at: IsoTime,
  issuer_device_id: Id,
});
export const DeviceCert = DeviceCertBody.extend({ signature: SigB64 });
export type DeviceCert = z.infer<typeof DeviceCert>;

export const EpochGrant = z.looseObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('epoch.grant'),
  installation_id: Id,
  device_id: Id,
  key_epoch: z.number().int().min(1),
  ephemeral_pub: PublicKeyB64,
  salt: Bytes32B64,
  nonce: NonceB64,
  /** AES-GCM(32-byte epoch key) = 48 bytes = 64 chars. */
  sealed: B64Url.length(64),
  issuer_device_id: Id,
  issued_at: IsoTime,
  signature: SigB64,
});
export type EpochGrant = z.infer<typeof EpochGrant>;

/* ---------- encrypted envelope ---------- */

export const EnvelopePurpose = z.enum(['question-content', 'answer-content', 'history-export']);
export type EnvelopePurpose = z.infer<typeof EnvelopePurpose>;

export const EnvelopeAad = z.strictObject({
  installation_id: Id,
  question_id: Id,
  record_type: z.string().min(1).max(32),
  revision: z.number().int().min(0),
  sender_device_id: Id,
});

export const CryptoEnvelope = z.looseObject({
  crypto_version: z.literal(CRYPTO_VERSION),
  suite: z.literal(CRYPTO_SUITE),
  key_epoch: z.number().int().min(1),
  record_id: Id,
  purpose: EnvelopePurpose,
  nonce: NonceB64,
  ciphertext: B64Url.min(22).max(LIMITS.envelopeCiphertextChars),
  aad: EnvelopeAad,
});
export type CryptoEnvelope = z.infer<typeof CryptoEnvelope>;

/* ---------- signed records ---------- */

export const QuestionRecord = z.looseObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('question'),
  installation_id: Id,
  question_id: Id,
  originating_device_id: Id,
  target_host_id: Id,
  /** Opaque hash of the originating pane, for per-pane quotas only. */
  origin_ref: Id,
  requirement: Requirement,
  workflow_gate_id_hash: Sha256Hex.nullable(),
  policy_version: z.number().int().min(0).nullable(),
  created_at: IsoTime,
  expires_at: IsoTime.nullable(),
  key_epoch: z.number().int().min(1),
  envelope_digest: Sha256Hex,
  attachment_ids: z.array(Id).max(LIMITS.attachmentsPerQuestion),
  signer_device_id: Id,
  signature: SigB64,
});
export type QuestionRecord = z.infer<typeof QuestionRecord>;

export const ActionKind = z.enum([
  'answer',
  'override',
  'proxy-answer',
  'proxy-abstain',
  'confirm-proxy',
  'cancel',
  'reopen',
]);
export type ActionKind = z.infer<typeof ActionKind>;

/** Actions whose purpose is to carry an answer; they must include an encrypted envelope. */
export const ANSWER_ACTIONS: readonly ActionKind[] = ['answer', 'override', 'proxy-answer'];

export const ActionRecord = z
  .looseObject({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('action'),
    action: ActionKind,
    installation_id: Id,
    question_id: Id,
    action_id: Id,
    /** Revision the signer observed; the relay compare-and-swaps on this. */
    expected_revision: z.number().int().min(0),
    created_at: IsoTime,
    /** answer/override/proxy-answer: required. confirm-proxy/cancel/abstain/reopen: optional. */
    envelope_digest: Sha256Hex.nullable(),
    /** confirm-proxy: the proxy action being confirmed. */
    confirms_action_id: Id.nullable(),
    /** reopen: new deadline. */
    expires_at: IsoTime.nullable(),
    signer_device_id: Id,
    signature: SigB64,
  })
  .superRefine((r, ctx) => {
    if (ANSWER_ACTIONS.includes(r.action) && r.envelope_digest === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['envelope_digest'],
        message: `${r.action} requires an encrypted answer`,
      });
    }
    if (r.action === 'confirm-proxy' && r.confirms_action_id === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirms_action_id'],
        message: 'confirm-proxy requires a target',
      });
    }
  });
export type ActionRecord = z.infer<typeof ActionRecord>;

export const SignedQuestion = z.object({ record: QuestionRecord, envelope: CryptoEnvelope });
export type SignedQuestion = z.infer<typeof SignedQuestion>;

export const SignedAction = z
  .object({
    record: ActionRecord,
    envelope: CryptoEnvelope.nullable(),
  })
  .superRefine((a, ctx) => {
    if ((a.envelope === null) !== (a.record.envelope_digest === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['envelope'],
        message: 'envelope and envelope_digest must both be present or both absent',
      });
    }
  });
export type SignedAction = z.infer<typeof SignedAction>;

/* ---------- decrypted content (inside envelopes) ---------- */

export const QuestionKind = z.enum(['choice', 'approval', 'text', 'mixed']);

export const OptionSchema = z.object({
  id: z.string().min(1).max(LIMITS.optionIdChars),
  label: z.string().min(1).max(LIMITS.optionLabelChars),
  description: z.string().max(LIMITS.optionDescriptionChars).optional(),
});

export const AttachmentDescriptor = z.object({
  attachment_id: Id,
  role: z.enum(['before', 'after', 'reference', 'other']).default('other'),
  alt: z.string().max(500).optional(),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  size: z.number().int().min(1).max(LIMITS.attachmentBytes),
  /** SHA-256 hex of the plaintext image; approvals bind to this. */
  sha256: Sha256Hex,
  /** AES-GCM nonce used for the R2 object (b64url, 12 bytes). */
  nonce: NonceB64,
  key_epoch: z.number().int().min(1),
});
export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptor>;

export const DecisionContentV1 = z.object({
  content_version: z.literal(1).default(1),
  question: z.string().min(1).max(LIMITS.questionChars),
  context: z
    .string()
    .refine((v) => utf8ByteLength(v) <= LIMITS.contextBytes, 'context too large')
    .optional(),
  kind: QuestionKind.default('mixed'),
  options: z.array(OptionSchema).max(LIMITS.maxOptions).default([]),
  attachments: z.array(AttachmentDescriptor).max(LIMITS.attachmentsPerQuestion).default([]),
  /** If true, a free-text explanation is accepted alongside / instead of an option. */
  allow_text: z.boolean().default(true),
  project_label: z.string().max(200).optional(),
  machine_label: z.string().max(200).optional(),
  origin_summary: z.string().max(500).optional(),
});
export type DecisionContentV1 = z.infer<typeof DecisionContentV1>;

export const HumanAnswerContentV1 = z.object({
  content_version: z.literal(1).default(1),
  selected_option_ids: z
    .array(z.string().max(LIMITS.optionIdChars))
    .max(LIMITS.maxOptions)
    .default([]),
  text: z
    .string()
    .refine((v) => utf8ByteLength(v) <= LIMITS.answerTextBytes, 'answer text too large')
    .optional(),
  /** Hashes of the plaintext attachments the human reviewed (design approvals bind to these). */
  reviewed_attachment_digests: z.array(Sha256Hex).default([]),
  explicit_approval: z.boolean().optional(),
  /** override / confirm: why. */
  reason: z.string().max(2_000).optional(),
});
export type HumanAnswerContentV1 = z.infer<typeof HumanAnswerContentV1>;

export const ProxyAnswerContentV1 = HumanAnswerContentV1.extend({
  model_id: z.string().max(120),
  prompt_template_version: z.string().max(60),
  confidence: z.number().min(0).max(1),
  retrieval_reference_ids: z.array(z.string().max(80)).max(50).default([]),
  rationale: z.string().max(2_000).optional(),
});
export type ProxyAnswerContentV1 = z.infer<typeof ProxyAnswerContentV1>;

/* ---------- events ---------- */

export const EventType = z.enum([
  'decision.created',
  'decision.answer.committed',
  'decision.answer.overridden',
  'decision.proxy.committed',
  'decision.proxy.abstained',
  'decision.proxy.confirmed',
  'decision.cancelled',
  'decision.expired',
  'decision.reopened',
  'decision.deleted',
  'device.approved',
  'device.revoked',
  'device.key_rotated',
  'attachment.available',
  'delivery.received',
  'delivery.terminal_delivered',
  'delivery.needs_attention',
]);
export type EventType = z.infer<typeof EventType>;

export const LedgerEvent = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  seq: z.number().int().min(1),
  event_id: Id,
  event_type: EventType,
  occurred_at: IsoTime,
  question_id: Id.nullable(),
  question_revision: z.number().int().min(0).nullable(),
  origin_device_id: Id.nullable(),
  /** Event-type specific payload; see docs/protocol.md. */
  data: z.record(z.string(), z.unknown()),
});
export type LedgerEvent = z.infer<typeof LedgerEvent>;

export const EventsPage = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  from_exclusive: z.number().int().min(0),
  high_water_seq: z.number().int().min(0),
  events: z.array(LedgerEvent),
  next_after: z.number().int().min(0),
  has_more: z.boolean(),
});
export type EventsPage = z.infer<typeof EventsPage>;

/* ---------- API request bodies ---------- */

const Idem = z.object({ idempotency_key: Id });

export const SetupClaimBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  claim_secret: z.string().min(16).max(256),
  installation_id: Id,
  cert: DeviceCert,
});

export const CreateQuestionBody = Idem.extend({
  protocol_version: z.literal(PROTOCOL_VERSION),
  question: SignedQuestion,
});

export const ActionBody = Idem.extend({
  protocol_version: z.literal(PROTOCOL_VERSION),
  action: SignedAction,
});

export const PairingInvitationBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  pairing_id: Id,
  /** sha256 hex of the 256-bit pairing secret. */
  invite_digest: Sha256Hex,
  expires_at: IsoTime,
  role: z.enum(['phone', 'tablet']),
});

export const PairingCandidateBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  pairing_id: Id,
  /** The raw pairing secret; relay compares sha256(secret) to invite_digest. */
  secret: Bytes32B64,
  device_id: Id,
  label: z.string().min(1).max(LIMITS.deviceLabelChars),
  signing_pub: PublicKeyB64,
  exchange_pub: PublicKeyB64,
  /** Proof of possession: signature by signing key over canonical {pairing_id, device_id, exchange_pub}. */
  pop: SigB64,
});

export const PairingApproveBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  cert: DeviceCert,
  grant: EpochGrant,
});

/** Owner-signed enrollment of an additional desktop (a Daintree Host) as a `desktop-host` device. */
export const EnrollHostBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  cert: DeviceCert,
  grant: EpochGrant,
});

export const PairingRejectBody = z.object({ protocol_version: z.literal(PROTOCOL_VERSION) });

export const RevokeDeviceBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  new_key_epoch: z.number().int().min(2),
  /** One grant for every remaining active device (excluding the revoked one), sealed to the new epoch key. */
  grants: z.array(EpochGrant).max(LIMITS.maxDevices),
});

export const RotateEpochBody = RevokeDeviceBody;

export const AttachmentReserveBody = Idem.extend({
  protocol_version: z.literal(PROTOCOL_VERSION),
  /** The question the attachment will belong to; the question is created after upload completes. */
  question_id: Id,
  /**
   * Chosen by the client, because the ciphertext's AAD binds the attachment id and the ciphertext digest
   * is needed to reserve. The relay rejects an id that is already in use.
   */
  attachment_id: Id,
  ciphertext_bytes: z
    .number()
    .int()
    .min(29)
    .max(LIMITS.attachmentBytes + 64),
  sha256_ciphertext: Sha256Hex,
  mime_category: z.literal('image'),
});

export const AttachmentCompleteBody = z.object({ protocol_version: z.literal(PROTOCOL_VERSION) });

export const PushSubscribeBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  endpoint: z.url().max(2048),
  p256dh: PublicKeyB64,
  auth: B64Url.length(22),
});

export const DeliveryReceivedBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  /** Highest contiguous seq durably recorded by the desktop. */
  seq: z.number().int().min(0),
});

export const DeliveryTerminalBody = Idem.extend({
  protocol_version: z.literal(PROTOCOL_VERSION),
  question_id: Id,
  answer_revision: z.number().int().min(1),
  injection_id: Id,
  host_id: Id,
});

export const DeliveryFailedBody = Idem.extend({
  protocol_version: z.literal(PROTOCOL_VERSION),
  question_id: Id,
  answer_revision: z.number().int().min(1),
  host_id: Id,
  status: z.enum(['needs-attention', 'delivery-uncertain']),
  error_code: z.string().regex(/^[a-z0-9_.-]{1,48}$/),
});

export const SettingsBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  /** Notification preferences only; never delays sync. */
  quiet_hours: z
    .object({
      enabled: z.boolean(),
      start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      time_zone: z.string().max(64),
    })
    .optional(),
  reminders: z
    .object({
      enabled: z.boolean(),
      first_ms: z
        .number()
        .int()
        .min(60_000)
        .max(7 * 86_400_000),
      interval_ms: z
        .number()
        .int()
        .min(60_000)
        .max(7 * 86_400_000),
      max: z.number().int().min(0).max(10),
    })
    .optional(),
  proxy_review_reminder: z.boolean().optional(),
  attachment_retention_days: z.number().int().min(1).max(365).optional(),
});
export type SettingsBody = z.infer<typeof SettingsBody>;

export const VoiceSessionBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  provider: z.enum(['xai', 'openai']),
  consent: z.literal(true),
  /** Keyterms (<=100 x 50 chars) derived from the question; sent to the provider. */
  keyterms: z.array(z.string().min(1).max(50)).max(100).default([]),
  language: z.string().max(16).optional(),
});

export const VoiceCorrectBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  provider: z.enum(['anthropic', 'openai']),
  consent: z.literal(true),
  raw_transcript: z.string().min(1).max(LIMITS.voiceCorrectionChars),
  question: z.string().max(LIMITS.questionChars).default(''),
  option_labels: z
    .array(z.string().max(LIMITS.optionLabelChars))
    .max(LIMITS.maxOptions)
    .default([]),
  keyterms: z.array(z.string().min(1).max(50)).max(100).default([]),
});

/** Strict result contract for AI correction (mirrors Daintree desktop dictation correction). */
export const CorrectionResult = z.strictObject({
  corrected_text: z.string().max(LIMITS.voiceCorrectionChars * 2),
  uncertain_spans: z
    .array(
      z.strictObject({
        start: z.number().int().min(0),
        end: z.number().int().min(0),
        raw: z.string().max(200),
        candidate: z.string().max(200),
        reason: z.string().max(200),
      }),
    )
    .max(50),
  applied_commands: z.array(z.string().max(40)).max(20),
  warnings: z.array(z.string().max(200)).max(10),
});
export type CorrectionResult = z.infer<typeof CorrectionResult>;

export const DeleteDataBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  confirm: z.literal('DELETE'),
  scope: z.enum(['questions', 'everything']),
});

export const InfoResponse = z.object({
  name: z.literal('daintree-decisions'),
  protocol_min: z.number().int(),
  protocol_max: z.number().int(),
  worker_version: z.string(),
  claimed: z.boolean(),
  claim_configured: z.boolean(),
  voice: z.object({
    xai: z.boolean(),
    anthropic: z.boolean(),
    openai: z.boolean(),
  }),
});
export type InfoResponse = z.infer<typeof InfoResponse>;
