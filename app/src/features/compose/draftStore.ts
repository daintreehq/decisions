import { useSyncExternalStore } from 'react';
import { app } from '../../app/controller.js';
import { draftRowId, type Draft } from '../../data/outbox.js';
import type { ComposeMode, FieldId } from '../../domain/compose.js';

/**
 * The one in-memory home of every open draft, outside React, so the composer, the editor sheet and the dictation
 * owner all edit the same text, and words that land after the workspace unmounted (Stop & questions, then another
 * question) still reach the draft they belong to and nothing else.
 *
 * A draft is keyed by question and mode, and bound to the revision it was reviewed against. Two counters guard late
 * writes: `editGen` moves on every edit the person makes (so a cleanup computed against older text never lands), and
 * `epoch` moves when the draft is sent or cleared (so nothing in flight can recreate a cleared draft).
 */

export interface Caret {
  field: FieldId;
  start: number;
  end: number;
}

/** The last dictated passage, kept while "Use original wording" can still apply to it. */
export interface Passage {
  field: FieldId;
  start: number;
  /** The field's text ahead of the passage when it landed: an edit there means the offsets no longer hold. */
  before: string;
  raw: string;
  /** What sits in the draft now (equal to `raw` until a cleanup lands). */
  cleaned: string;
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface Undo {
  message: string;
  restore: () => void;
}

export interface DraftModel {
  key: string;
  questionId: string;
  mode: ComposeMode;
  revision: number;
  selected: string[];
  text: string;
  reason: string;
  caret: Caret | null;
  passage: Passage | null;
  loaded: boolean;
  editGen: number;
  epoch: number;
  save: SaveState;
  /** Shown once on return: the draft came back, or came back from an earlier revision. */
  notice: 'restored' | 'earlier' | null;
  undo: Undo | null;
}

type Patch = Partial<Pick<DraftModel, 'selected' | 'text' | 'reason' | 'caret' | 'passage'>>;

const SAVE_DEBOUNCE_MS = 400;
/** "Saving…" appears only when a write takes long enough to notice. */
const SAVING_VISIBLE_MS = 300;

/** The revision of a restored draft that never recorded one: it matches no question revision, so it needs review. */
export const UNKNOWN_REVISION = -1;

const isEmpty = (d: Pick<DraftModel, 'selected' | 'text' | 'reason'>) =>
  d.selected.length === 0 && !d.text.trim() && !d.reason.trim();

export function fieldValue(d: Pick<DraftModel, 'text' | 'reason'>, f: FieldId): string {
  return f === 'reason' ? d.reason : d.text;
}

class DraftStore {
  private drafts = new Map<string, DraftModel>();
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private writes = new Map<string, Promise<void>>();
  private undoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private session = 0;

  constructor() {
    if (typeof document !== 'undefined') {
      // A phone can kill a backgrounded tab at any moment; whatever is pending is written now.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flushAll();
      });
      window.addEventListener('pagehide', () => void this.flushAll());
    }
    // Unpairing erases storage; plaintext drafts held here go with it.
    app.subscribe(() => {
      if (app.getSnapshot().phase !== 'ready' && this.drafts.size) this.reset();
    });
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private emit() {
    for (const l of this.listeners) l();
  }
  private put(d: DraftModel) {
    this.drafts.set(d.key, d);
    this.emit();
  }

  get(key: string): DraftModel | undefined {
    return this.drafts.get(key);
  }

  /** The draft for this question and mode, created (and its stored copy loaded) on first use. */
  ensure(questionId: string, mode: ComposeMode, revision: number): DraftModel {
    const key = draftRowId(questionId, mode);
    const have = this.drafts.get(key);
    if (have) return have;
    const d: DraftModel = {
      key,
      questionId,
      mode,
      revision,
      selected: [],
      text: '',
      reason: '',
      caret: null,
      passage: null,
      loaded: false,
      editGen: 0,
      epoch: 0,
      save: 'idle',
      notice: null,
      undo: null,
    };
    this.drafts.set(key, d);
    void this.load(key, revision);
    return d;
  }

  private async load(key: string, revision: number) {
    const session = this.session;
    let stored: Awaited<ReturnType<NonNullable<typeof app.drafts>['load']>> = null;
    try {
      stored = (await app.drafts?.load(key)) ?? null;
    } catch {
      stored = null;
    }
    const d = this.drafts.get(key);
    if (!d || session !== this.session) return;
    // Anything typed or dictated before storage answered wins over the stored copy.
    if (!stored || d.editGen > 0 || d.text || d.reason || d.selected.length) {
      this.put({ ...d, loaded: true });
      return;
    }
    // A version 1 row knows no revision: it was written against the question before any answer, so revision 0.
    const same = (stored.revision ?? 0) === revision;
    // The draft stays bound to the revision it was reviewed against, so a newer question needs Review update before
    // Send. A row that never recorded one needs that review too.
    const reviewed = stored.revision ?? UNKNOWN_REVISION;
    this.put({
      ...d,
      loaded: true,
      revision: reviewed,
      // A choice made against other wording is never carried over: the text is kept, the choice made again.
      selected: same ? stored.selected : [],
      text: stored.text,
      reason: stored.reason,
      caret: stored.caret ?? null,
      passage: same && stored.passage ? { ...stored.passage } : null,
      notice: isEmpty(stored) ? null : reviewed === revision ? 'restored' : 'earlier',
    });
  }

  /** An edit the person made: typing, choosing, clearing a choice. */
  edit(key: string, patch: Patch): void {
    const d = this.drafts.get(key);
    if (!d) return;
    this.put({ ...d, ...patch, editGen: d.editGen + 1, notice: null, undo: null });
    this.schedule(key);
  }

  /** Caret moves are remembered (dictation starts there) but are not edits. */
  setCaret(key: string, caret: Caret): void {
    const d = this.drafts.get(key);
    if (!d) return;
    const c = d.caret;
    if (c && c.field === caret.field && c.start === caret.start && c.end === caret.end) return;
    this.drafts.set(key, { ...d, caret });
  }

  /**
   * A write from outside the person's hands (dictated words, a cleanup). Refused when the draft was sent or cleared
   * since `epoch`, (with `revision`) when it was rebound to another revision, or (with `editGen`) when the person
   * edited since the write was planned. Never counts as an edit.
   */
  write(
    key: string,
    guard: { epoch: number; revision?: number; editGen?: number },
    fn: (d: DraftModel) => Patch | null,
  ): boolean {
    const d = this.drafts.get(key);
    if (!d || d.epoch !== guard.epoch) return false;
    // Words planned against one revision never land in a draft since bound to another.
    if (guard.revision !== undefined && d.revision !== guard.revision) return false;
    if (guard.editGen !== undefined && d.editGen !== guard.editGen) return false;
    const patch = fn(d);
    if (!patch) return false;
    this.put({ ...d, ...patch, notice: null });
    this.schedule(key);
    return true;
  }

  /** Bind the draft to a newer revision (Review update): the choice made against the old wording is cleared. */
  rebind(key: string, revision: number): void {
    const d = this.drafts.get(key);
    if (!d) return;
    this.put({ ...d, revision, selected: [], editGen: d.editGen + 1, notice: null });
    this.schedule(key);
  }

  /** Clear with Undo. Late writes from before the clear are refused. */
  clear(key: string, message = 'Draft cleared'): void {
    const d = this.drafts.get(key);
    if (!d) return;
    const snapshot = { selected: d.selected, text: d.text, reason: d.reason, caret: d.caret };
    this.put({
      ...d,
      selected: [],
      text: '',
      reason: '',
      caret: null,
      passage: null,
      editGen: d.editGen + 1,
      epoch: d.epoch + 1,
      notice: null,
    });
    this.offerUndo(key, message, () => this.edit(key, snapshot));
    this.schedule(key);
  }

  /** Offer an Undo for a few seconds (only the latest one is kept). */
  offerUndo(key: string, message: string, restore: () => void): void {
    const d = this.drafts.get(key);
    if (!d) return;
    clearTimeout(this.undoTimers.get(key));
    const undo: Undo = {
      message,
      restore: () => {
        this.dismissUndo(key);
        restore();
      },
    };
    this.put({ ...d, undo });
    this.undoTimers.set(
      key,
      setTimeout(() => this.dismissUndo(key), 8_000),
    );
  }

  dismissUndo(key: string): void {
    clearTimeout(this.undoTimers.get(key));
    const d = this.drafts.get(key);
    if (d?.undo) this.put({ ...d, undo: null });
  }

  dismissNotice(key: string): void {
    const d = this.drafts.get(key);
    if (d?.notice) this.put({ ...d, notice: null });
  }

  /**
   * The answer was sealed into the outbox: the draft goes, and the epoch moves so no autosave, dictation or cleanup
   * still in flight can bring it back.
   */
  async sent(key: string): Promise<void> {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    const d = this.drafts.get(key);
    if (d)
      this.put({
        ...d,
        selected: [],
        text: '',
        reason: '',
        caret: null,
        passage: null,
        editGen: d.editGen + 1,
        epoch: d.epoch + 1,
        save: 'idle',
        notice: null,
        undo: null,
      });
    await this.writes.get(key)?.catch(() => undefined);
    await app.drafts?.delete(key);
  }

  private schedule(key: string) {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => void this.flush(key), SAVE_DEBOUNCE_MS),
    );
  }

  /** Write now (Stop, navigation, collapse, Send, hide). Resolves once storage has it, or rejects. */
  flush(key: string): Promise<void> {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    const prior = this.writes.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => this.persist(key));
    this.writes.set(key, run);
    return run;
  }

  async flushAll(): Promise<void> {
    const pending = [...this.timers.keys()];
    await Promise.all([...pending.map((k) => this.flush(k)), ...this.writes.values()]);
  }

  private async persist(key: string) {
    const d = this.drafts.get(key);
    const store = app.drafts;
    if (!d || !store || !d.loaded) return;
    const session = this.session;
    const slow = setTimeout(() => this.status(key, 'saving'), SAVING_VISIBLE_MS);
    try {
      if (isEmpty(d)) await store.delete(key);
      else {
        const draft: Draft = {
          v: 2,
          mode: d.mode,
          revision: d.revision === UNKNOWN_REVISION ? null : d.revision,
          selected: d.selected,
          text: d.text,
          reason: d.reason,
          caret: d.caret,
          passage: d.passage,
        };
        await store.save(key, draft);
      }
      if (session === this.session) this.status(key, isEmpty(d) ? 'idle' : 'saved');
    } catch (e) {
      if (session === this.session) this.status(key, 'error');
      throw e;
    } finally {
      clearTimeout(slow);
    }
  }

  private status(key: string, save: SaveState) {
    const d = this.drafts.get(key);
    if (d && d.save !== save) this.put({ ...d, save });
  }

  /** Erase everything held in memory (unpair). */
  reset(): void {
    this.session++;
    for (const t of this.timers.values()) clearTimeout(t);
    for (const t of this.undoTimers.values()) clearTimeout(t);
    this.timers.clear();
    this.undoTimers.clear();
    this.writes.clear();
    this.drafts.clear();
    this.emit();
  }
}

export const drafts = new DraftStore();

/** The draft for this question and mode, re-rendering on every change to it. */
export function useDraft(questionId: string, mode: ComposeMode, revision: number): DraftModel {
  const key = draftRowId(questionId, mode);
  return useSyncExternalStore(
    drafts.subscribe,
    () => drafts.get(key) ?? drafts.ensure(questionId, mode, revision),
  );
}
