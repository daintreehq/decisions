import type { HumanActionKind } from '../domain/answer.js';
import type { Db } from './db.js';
import { open, seal } from './seal.js';
import { RelayError } from './relay.js';

export type OutboxState = 'queued' | 'sending' | 'conflicted' | 'rejected' | 'expired';

/** What an entry sends: one of the person's actions on the question, or a follow-up message in its thread. */
export type OutboxKind = HumanActionKind | 'message';

export interface OutboxEntry {
  id: string;
  createdAt: number;
  questionId: string;
  kind: OutboxKind;
  /** A follow-up's signed message id (the same on every attempt). */
  messageId?: string;
  path: string;
  /** Exact serialised request; identical on every attempt. */
  bodyText: string;
  idempotencyKey: string;
  expectedRevision: number;
  /** What the human typed/selected, kept so a conflict never destroys it. */
  selected: string[];
  text: string;
  reason: string;
  state: OutboxState;
  error?: string;
  attempts: number;
  /** Revision the relay reported when it refused (conflict). */
  latestRevision?: number;
  /** The relay's error code when it refused for good. */
  errorCode?: string;
}

export interface Poster {
  jsonRaw<T>(method: string, path: string, bodyText: string): Promise<T>;
}

export interface OutboxHooks {
  onCommitted?: (e: OutboxEntry) => void;
  /**
   * Awaited after the relay commits an entry and before its local copy goes: reading the commit back first means
   * the thread never shows a gap where the sent item was. A failure here never keeps the entry.
   */
  settle?: (e: OutboxEntry) => Promise<unknown> | undefined;
  onChange?: () => void;
}

const label = (id: string) => `outbox:${id}`;

/**
 * Encrypted, durable queue of what the person sends: answers and other actions, and follow-up messages. Each lives
 * here from the moment they tap Send until the relay has committed (or definitively refused) it, and goes out in the
 * order it was sent. Nothing in it is plaintext at rest.
 */
export class Outbox {
  private entries = new Map<string, OutboxEntry>();
  private flushing: Promise<void> | null = null;
  private again = false;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly db: Db,
    private readonly cacheKey: CryptoKey,
    private readonly poster: () => Poster,
    private readonly hooks: OutboxHooks = {},
  ) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;
  private changed() {
    this.version++;
    for (const l of this.listeners) l();
    this.hooks.onChange?.();
  }

  async load(): Promise<void> {
    this.entries.clear();
    for (const row of await this.db.outbox()) {
      try {
        const e = await open<OutboxEntry>(this.cacheKey, row.sealed, label(row.id));
        // A crash mid-send leaves "sending"; it is safe to retry because the idempotency key is stable.
        this.entries.set(e.id, e.state === 'sending' ? { ...e, state: 'queued' } : e);
      } catch {
        // Unreadable row (wrong key / tampering): drop it rather than block the queue forever.
        await this.db.deleteOutbox(row.id);
      }
    }
    this.changed();
  }

  list(): OutboxEntry[] {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  forQuestion(questionId: string): OutboxEntry[] {
    return this.list().filter((e) => e.questionId === questionId);
  }
  pendingState(questionId: string): 'queued' | 'sending' | undefined {
    const e = this.forQuestion(questionId).find(
      (x) => x.state === 'queued' || x.state === 'sending',
    );
    return e ? (e.state as 'queued' | 'sending') : undefined;
  }

  /** Put a refused entry back in the queue as it was (same request, same idempotency key) and send it. */
  async retry(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.state === 'queued' || e.state === 'sending') return;
    e.state = 'queued';
    delete e.error;
    delete e.errorCode;
    await this.persist(e);
    this.changed();
    void this.flush();
  }

  private async persist(e: OutboxEntry): Promise<void> {
    await this.db.putOutbox({
      id: e.id,
      createdAt: e.createdAt,
      questionId: e.questionId,
      sealed: await seal(this.cacheKey, e, label(e.id)),
    });
  }

  async enqueue(
    e: Omit<OutboxEntry, 'state' | 'attempts' | 'createdAt'> & { createdAt?: number },
  ): Promise<OutboxEntry> {
    const entry: OutboxEntry = {
      ...e,
      createdAt: e.createdAt ?? Date.now(),
      state: 'queued',
      attempts: 0,
    };
    await this.persist(entry); // durable before anything else happens
    this.entries.set(entry.id, entry);
    this.changed();
    return entry;
  }

  async discard(id: string): Promise<void> {
    this.entries.delete(id);
    await this.db.deleteOutbox(id);
    this.changed();
  }

  /** Send everything that is queued, oldest first. Safe to call from any trigger; calls coalesce. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  private async pass(): Promise<void> {
    for (const e of this.list()) {
      if (e.state !== 'queued') continue;
      e.state = 'sending';
      e.attempts++;
      this.changed();
      try {
        await this.poster().jsonRaw('POST', e.path, e.bodyText);
        await Promise.resolve(this.hooks.settle?.(e)).catch(() => undefined);
        await this.discard(e.id);
        this.hooks.onCommitted?.(e);
      } catch (err) {
        if (err instanceof RelayError && !err.retryable) {
          // A message has no revision to conflict with: a closed thread or a full one simply refuses it.
          e.state =
            e.kind !== 'message' &&
            (err.code === 'revision_conflict' || err.code === 'invalid_state')
              ? 'conflicted'
              : err.code === 'expired'
                ? 'expired'
                : 'rejected';
          e.error = err.message;
          e.errorCode = err.code;
          const latest = err.details?.latest_revision;
          if (typeof latest === 'number') e.latestRevision = latest;
          await this.persist(e);
          this.changed();
          continue;
        }
        // Network trouble or relay hiccup: keep it queued and stop, order matters.
        e.state = 'queued';
        await this.persist(e);
        this.changed();
        return;
      }
    }
  }
}

/**
 * A draft, sealed at rest. Version 2 binds it to the question revision it was written against and to its mode, and
 * carries the correction reason, the caret and what dictation needs to put back "Use original wording".
 */
export interface Draft {
  selected: string[];
  text: string;
  reason: string;
  /** Absent on version 1 rows (written before drafts knew their revision). */
  v?: 2;
  mode?: DraftMode;
  /** The question revision this draft was reviewed against; null when unknown (a version 1 row). */
  revision?: number | null;
  caret?: { field: 'text' | 'reason'; start: number; end: number } | null;
  /** The last dictated passage, while "Use original wording" can still apply to it. */
  passage?: {
    field: 'text' | 'reason';
    start: number;
    before: string;
    raw: string;
    cleaned: string;
  } | null;
}

/** What a draft is for: the answer, a correction (overruling a model answer), or a follow-up message. */
export type DraftMode = 'answer' | 'correction' | 'message';

/**
 * The row a draft lives in. An answer draft keeps the question id as its key, so version 1 rows are read in place;
 * a correction or follow-up draft sits beside it. Revision is inside the sealed draft, never in the key, so a draft
 * written against an earlier revision is still found (and flagged) rather than orphaned.
 */
export function draftRowId(questionId: string, mode: DraftMode = 'answer'): string {
  return mode === 'answer' ? questionId : `${questionId}#${mode}`;
}

/** Normalises any stored version to the current shape, conservatively: a version 1 row knows no revision. */
export function upgradeDraft(d: Draft): Draft & { v: 2; revision: number | null } {
  return {
    selected: Array.isArray(d.selected) ? d.selected.filter((s) => typeof s === 'string') : [],
    text: typeof d.text === 'string' ? d.text : '',
    reason: typeof d.reason === 'string' ? d.reason : '',
    v: 2,
    mode: d.mode === 'correction' || d.mode === 'message' ? d.mode : 'answer',
    revision: typeof d.revision === 'number' ? d.revision : null,
    caret: d.caret ?? null,
    passage: d.passage ?? null,
  };
}

export class Drafts {
  constructor(
    private readonly db: Db,
    private readonly cacheKey: CryptoKey,
  ) {}
  /** `key` is a row id from `draftRowId` (a bare question id is the answer draft). */
  async save(key: string, d: Draft): Promise<void> {
    await this.db.putDraft({
      questionId: key,
      updatedAt: Date.now(),
      sealed: await seal(this.cacheKey, { ...d, v: 2 }, `draft:${key}`),
    });
  }
  async load(key: string): Promise<(Draft & { v: 2; revision: number | null }) | null> {
    const row = await this.db.getDraft(key);
    if (!row) return null;
    try {
      // The seal is bound to the row id, so a draft moved to another question or mode will not open.
      return upgradeDraft(await open<Draft>(this.cacheKey, row.sealed, `draft:${key}`));
    } catch {
      return null;
    }
  }
  delete(key: string) {
    return this.db.deleteDraft(key);
  }
  /** Row ids of every stored draft (no contents are opened). */
  async keys(): Promise<string[]> {
    return (await this.db.drafts()).map((r) => r.questionId);
  }
}
