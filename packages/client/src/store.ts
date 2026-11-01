import type { Requirement } from '@daintreehq/decisions-protocol';
import type {
  AuditEntry,
  InboundEvent,
  InjectionIntent,
  OutboxItem,
  QuestionRow,
} from './types.js';

/**
 * Durable desktop-side state. Daintree supplies its own implementation over better-sqlite3; every method
 * is async so either synchronous or asynchronous drivers fit. Implementations MUST make each method atomic.
 */
export interface LocalStore {
  /** True for stores that survive a restart; they require a durable attachment spool. */
  readonly durable: boolean;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  /** Next cosmetic `q-N` alias. */
  nextAlias(): Promise<number>;

  /** Atomically insert the question row and its outbound `create` item (local commit BEFORE any network I/O). */
  commitNewQuestion(row: QuestionRow, outbox: OutboxItem): Promise<void>;
  getQuestion(id: string): Promise<QuestionRow | null>;
  updateQuestion(id: string, patch: Partial<QuestionRow>): Promise<QuestionRow | null>;
  listQuestions(filter?: {
    status?: QuestionRow['local_status'][];
    paneId?: string;
  }): Promise<QuestionRow[]>;
  countOpenForPane(hostId: string, paneId: string): Promise<number>;

  putOutbox(item: OutboxItem): Promise<void>;
  dueOutbox(now: number, limit: number): Promise<OutboxItem[]>;
  recordOutboxFailure(id: string, error: string, nextAttemptAt: number): Promise<void>;
  deleteOutbox(id: string): Promise<void>;
  outboxFor(questionId: string): Promise<OutboxItem[]>;

  /** Insert a ledger event. Returns false if `seq` was already stored (duplicate). */
  insertEvent(ev: InboundEvent): Promise<boolean>;
  markEventProcessed(seq: number, at: number): Promise<void>;
  unprocessedEvents(limit: number): Promise<InboundEvent[]>;
  /** Highest seq such that every event from 1..seq has been stored, starting from the persisted cursor. */
  advanceCursor(): Promise<number>;
  getCursor(): Promise<number>;
  /** Move the cursor forward after a COMPLETE relay-asserted HTTP page (covers server-side tombstoned gaps). */
  forceCursor(seq: number): Promise<void>;

  putIntent(i: InjectionIntent): Promise<void>;
  updateIntent(id: string, patch: Partial<InjectionIntent>): Promise<InjectionIntent | null>;
  getIntent(id: string): Promise<InjectionIntent | null>;
  openIntents(): Promise<InjectionIntent[]>;
  /** True while any intent for this question is unresolved-uncertain: delivery must stay blocked. */
  hasUncertainIntent(questionId: string): Promise<boolean>;
  /** Update an intent and its question in ONE atomic write (no crash window between them). */
  settleIntent(
    intentId: string,
    intentPatch: Partial<InjectionIntent>,
    questionId: string,
    questionPatch: Partial<QuestionRow>,
  ): Promise<void>;

  appendAudit(e: AuditEntry): Promise<void>;
  listAudit(limit: number): Promise<AuditEntry[]>;

  close(): Promise<void>;
}

export type { Requirement };
