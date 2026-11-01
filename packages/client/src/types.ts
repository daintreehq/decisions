import type { Requirement } from '@daintree/decisions-protocol';

/** Where a question came from. Everything the desktop needs to route an answer back; never sent to the relay. */
export interface QuestionOrigin {
  host_id: string;
  pane_id: string;
  /** Increments each time the terminal process is relaunched; guards against pane-id reuse. */
  terminal_generation: number;
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
  /** Plaintext question content, kept locally for history and the decision model. */
  content_json: string | null;
  /** Decrypted answer history (human and proxy), newest last. */
  answers_json: string;
  /** Imported records are never delivered. */
  history_only: boolean;
  /** Highest answer revision already typed into the terminal (dedupe). */
  delivered_revision: number;
  /** Attachment SHA-256 hex digests of the plaintext images shown to the human. */
  attachment_digests: string[];
}

export type OutboxKind = 'create' | 'cancel' | 'proxy-answer' | 'proxy-abstain';

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
  answer_revision: number;
  host_id: string;
  pane_id: string;
  terminal_generation: number;
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
