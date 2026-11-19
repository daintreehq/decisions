import { z } from 'zod';

/*
 * A question reader shaped like 0.8.0, the last release before advisory questions (docs/protocol.md section 21):
 * frozen copies of the schemas a phone app, desktop library or relay pinned to @daintreehq/decisions-protocol 0.8.0
 * reads a question with. They prove that such a reader refuses an advisory question outright, through its strict
 * `EnvelopeAad`, rather than showing it as one that waits for a decision, and that it still reads a blocking question
 * after it. Never update them to match the current protocol: they stand for software that is already installed.
 */

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const B64Url = z.string().regex(/^[A-Za-z0-9_-]*$/);
const IsoTime = z.iso.datetime({ offset: false, precision: 3 });
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Requirement = z.enum(['human-required', 'proxy-ok', 'proxy-first']);

/** Strict: a field it does not know, such as `reply_mode`, fails the whole envelope. */
const EnvelopeAad = z.strictObject({
  installation_id: Id,
  question_id: Id,
  record_type: z.string().min(1).max(32),
  revision: z.number().int().min(0),
  sender_device_id: Id,
});

const CryptoEnvelope = z.looseObject({
  crypto_version: z.literal(1),
  suite: z.literal('P256-ECDH-HKDF-SHA256-A256GCM-ECDSA-P256'),
  key_epoch: z.number().int().min(1),
  record_id: Id,
  purpose: z.enum([
    'question-content',
    'answer-content',
    'history-export',
    'message-content',
    'snapshot-content',
  ]),
  nonce: B64Url.length(16),
  ciphertext: B64Url.min(22).max(180 * 1024),
  aad: EnvelopeAad,
});

const QuestionRecord = z.looseObject({
  v: z.literal(1),
  type: z.literal('question'),
  installation_id: Id,
  question_id: Id,
  originating_device_id: Id,
  target_host_id: Id,
  origin_ref: Id,
  requirement: Requirement,
  workflow_gate_id_hash: Sha256Hex.nullable(),
  policy_version: z.number().int().min(0).nullable(),
  created_at: IsoTime,
  expires_at: IsoTime.nullable(),
  key_epoch: z.number().int().min(1),
  envelope_digest: Sha256Hex,
  attachment_ids: z.array(Id).max(8),
  signer_device_id: Id,
  signature: B64Url.length(86),
});

/** `EventData.created` as 0.8.0 parses a `decision.created` event's data; a failure marks the question malformed. */
const CreatedEventData = z.object({
  record: QuestionRecord,
  envelope: CryptoEnvelope,
  requirement: Requirement,
  target_host_id: Id,
  expires_at: IsoTime.nullable(),
});

/** `POST /questions` as a 0.8.0 relay parses it: an advisory create is `400 validation_error`. */
const CreateQuestionBody = z.object({
  idempotency_key: Id,
  protocol_version: z.literal(1),
  question: z.object({ record: QuestionRecord, envelope: CryptoEnvelope }),
});

export const Legacy080Question = {
  EnvelopeAad,
  CryptoEnvelope,
  QuestionRecord,
  CreatedEventData,
  CreateQuestionBody,
} as const;
