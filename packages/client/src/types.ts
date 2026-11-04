import type { Requirement } from '@daintreehq/decisions-protocol';

/** Where a question came from. Everything the desktop needs to route an answer back; never sent to the relay. */
export interface QuestionOrigin {
  host_id: string;
  pane_id: string;
  /** Increments each time the terminal process is relaunched; guards against pane-id reuse. */
  terminal_generation: number;
  /**
   * The host's owner of this run of the pane (Daintree: the pane's ownership principal). It changes on every
   * relaunch, even when the pane id stays the same, so an answer for the old run never reaches the new one.
   * Required and non-empty; the standalone CLI uses a fixed value because its pane is never relaunched.
   */
  ownership_principal: string;
  /** Which start of the agent inside the pane asked (Daintree: `agentIncarnation`). Required and non-empty. */
  agent_incarnation: string;
  agent_kind: string;
  agent_session_id: string | null;
  project_id: string;
  worktree_id: string;
  /** Local only. */
  worktree_root: string;
  workflow_gate_id: string | null;
  /**
   * Human names shown on the phone (encrypted with the question). Optional: without them the phone shows
   * the raw ids, which are often opaque ("host_01JC…").
   */
  project_label?: string;
  machine_label?: string;
}

export type LocalStatus =
  | 'queued' // committed locally, not yet published
  | 'open'
  | 'proxy-answered'
  | 'human-answered'
  | 'cancelled'
  | 'expired'
  | 'publish-failed';

export type LocalDeliveryStatus =
  | 'not-sent'
  | 'relay-queued'
  | 'desktop-received'
  | 'pending-host'
  | 'needs-attention'
  | 'delivery-uncertain'
  | 'terminal-delivered';

export interface QuestionRow {
  question_id: string;
  /** Cosmetic `q-N` alias, monotonic per installation. */
  alias: number;
  origin: QuestionOrigin;
  requirement: Requirement;
  question_revision: number;
  remote_event_seq: number | null;
  origin_created_at: string;
  expires_at: string | null;
  local_status: LocalStatus;
  delivery_status: LocalDeliveryStatus;
  last_injection_id: string | null;
  last_attempt_at: string | null;
  agent_resume_strategy: string | null;
  error_code: string | null;
  /**
   * The question content, sealed: the JSON of the `CryptoEnvelope` the question was published with (the same
   * ciphertext the relay holds), or a local seal under the identity's epoch key for imported and migrated
   * rows. Opened on demand with `openQuestionContent`; question text never sits in a row in clear.
   */
  content_sealed: string | null;
  /**
   * Plaintext content of a row written before content was sealed. Only a store migrated from an older schema
   * ever returns it; the bridge seals it and clears it to null when it starts (`sealStoredContent`). New code
   * never writes it.
   */
  legacy_content_json?: string | null;
  /** Answer history (human and proxy), newest last: `AnswerEntry[]` whose content is sealed per entry. */
  answers_json: string;
  /**
   * The question's thread messages, both sides, in ledger order: `StoredMessage[]` (`messages.ts`) whose content
   * is sealed per message. Each human message carries its own delivery state; nothing here changes the answer.
   */
  messages_json: string;
  /** Imported records are never delivered. */
  history_only: boolean;
  /** Highest answer revision already typed into the terminal (dedupe). */
  delivered_revision: number;
  /** Attachment SHA-256 hex digests of the plaintext images shown to the human. */
  attachment_digests: string[];
}

/** `message` is an agent message for a question's thread (`MessagePayload`); it never touches the answer. */
export type OutboxKind = 'create' | 'cancel' | 'proxy-answer' | 'proxy-abstain' | 'message';

export interface OutboxItem {
  /** Also the relay idempotency key. */
  id: string;
  kind: OutboxKind;
  question_id: string;
  payload: unknown;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  last_error: string | null;
}

export interface InboundEvent {
  seq: number;
  event_id: string;
  event_type: string;
  json: string;
  received_at: number;
  processed_at: number | null;
}

export type IntentState = 'intent' | 'typed' | 'acked' | 'uncertain' | 'abandoned';

/** Written BEFORE the terminal is touched, so a crash can be reconciled instead of blindly re-pasting. */
export interface InjectionIntent {
  injection_id: string;
  question_id: string;
  /** The answer revision typed, or 0 for a follow-up message. */
  answer_revision: number;
  /**
   * The follow-up message typed, or null for an answer. Its delivery is keyed by `(question_id, message_id)`
   * (protocol `messageDeliveryKey`), never by an answer revision, and never blocks the question's answers.
   */
  message_id: string | null;
  host_id: string;
  pane_id: string;
  terminal_generation: number;
  /** The run the text was typed into (`''` on intents written before these fields existed). */
  ownership_principal: string;
  agent_incarnation: string;
  state: IntentState;
  created_at: number;
  updated_at: number;
}

export interface AuditEntry {
  at: string;
  event: string;
  question_id?: string;
  requirement?: string;
  provenance?: string;
  result?: string;
  detail?: Record<string, string | number | boolean | null>;
}
