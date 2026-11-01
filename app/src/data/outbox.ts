import type { HumanActionKind } from '../domain/answer.js';
import type { Db } from './db.js';
import { open, seal } from './seal.js';
import { RelayError } from './relay.js';

export type OutboxState = 'queued' | 'sending' | 'conflicted' | 'rejected' | 'expired';

export interface OutboxEntry {
  id: string;
  createdAt: number;
  questionId: string;
  kind: HumanActionKind;
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
}

export interface Poster {
  jsonRaw<T>(method: string, path: string, bodyText: string): Promise<T>;
}

export interface OutboxHooks {
  onCommitted?: (e: OutboxEntry) => void;
  onChange?: () => void;
}

const label = (id: string) => `outbox:${id}`;

/**
 * Encrypted, durable queue of human actions. An action lives here from the moment the human taps Submit
 * until the relay has committed (or definitively refused) it. Nothing in it is plaintext at rest.
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
        await this.discard(e.id);
        this.hooks.onCommitted?.(e);
      } catch (err) {
        if (err instanceof RelayError && !err.retryable) {
          e.state =
            err.code === 'revision_conflict' || err.code === 'invalid_state'
              ? 'conflicted'
              : err.code === 'expired'
                ? 'expired'
                : 'rejected';
          e.error = err.message;
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

/** Per-question drafts, sealed at rest. */
export interface Draft {
  selected: string[];
  text: string;
  reason: string;
}

export class Drafts {
  constructor(
    private readonly db: Db,
    private readonly cacheKey: CryptoKey,
  ) {}
  async save(questionId: string, d: Draft): Promise<void> {
    await this.db.putDraft({
      questionId,
      updatedAt: Date.now(),
      sealed: await seal(this.cacheKey, d, `draft:${questionId}`),
    });
  }
  async load(questionId: string): Promise<Draft | null> {
    const row = await this.db.getDraft(questionId);
    if (!row) return null;
    try {
      return await open<Draft>(this.cacheKey, row.sealed, `draft:${questionId}`);
    } catch {
      return null;
    }
  }
  delete(questionId: string) {
    return this.db.deleteDraft(questionId);
  }
}
