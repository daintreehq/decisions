import { useSyncExternalStore } from 'react';
import { newId, sha256Hex, sniffImageMime } from '@daintreehq/decisions-crypto';
import { app } from '../../app/controller.js';
import { announce } from '../../lib/announce.js';
import { draftRowId, type Draft, type DraftPhotoMeta } from '../../data/outbox.js';
import { preparePhoto, type PhotoMime, type PreparedPhoto } from '../../data/photos.js';
import type { ComposeMode, FieldId } from '../../domain/compose.js';

/**
 * The one in-memory home of every open draft, outside React, so the composer and the dictation owner all edit the
 * same text, and words that land after the workspace unmounted (leaving mid-dictation for another
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

/**
 * A photo chosen for the draft. While it is `preparing` it holds its place in the tray; once `ready` it carries the
 * scaled, stripped bytes that will be encrypted at Send, and an object URL for its thumbnail.
 */
export type DraftPhoto =
  | { id: string; status: 'preparing' }
  | ({ id: string; status: 'ready'; url: string } & PreparedPhoto);

/** What the lane says about photos: a limit reached, or one that could not be added. */
export interface PhotoNotice {
  text: string;
  tone: 'info' | 'error';
}

/** How many photos the draft may still take, and how to say so when a choice goes past it. */
export interface PhotoRoom {
  room: number;
  /** The words when `over` of the chosen photos did not fit. */
  overflow: (over: number) => string;
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
  /** Photos going with it, in the order chosen. */
  photos: DraftPhoto[];
  photoNotice: PhotoNotice | null;
}

type Patch = Partial<
  Pick<DraftModel, 'selected' | 'text' | 'reason' | 'caret' | 'passage' | 'photos'>
>;

const SAVE_DEBOUNCE_MS = 400;
/** "Saving…" appears only when a write takes long enough to notice. */
const SAVING_VISIBLE_MS = 300;

/** The revision of a restored draft that never recorded one: it matches no question revision, so it needs review. */
export const UNKNOWN_REVISION = -1;

const isEmpty = (
  d: Pick<DraftModel, 'selected' | 'text' | 'reason'> & { photos?: readonly unknown[] },
) => d.selected.length === 0 && !d.text.trim() && !d.reason.trim() && !d.photos?.length;

/** The photos ready to send, in order. */
export const readyPhotos = (d: Pick<DraftModel, 'photos'>) =>
  d.photos.filter((p): p is Extract<DraftPhoto, { status: 'ready' }> => p.status === 'ready');

const revoke = (photos: readonly DraftPhoto[]) => {
  for (const p of photos) if (p.status === 'ready') URL.revokeObjectURL(p.url);
};

const thumbUrl = (p: PreparedPhoto) =>
  URL.createObjectURL(new Blob([p.bytes as unknown as BlobPart], { type: p.mime }));

/** A stored photo comes back only if it is still exactly the photo that was chosen. */
async function restorePhoto(key: string, meta: DraftPhotoMeta): Promise<DraftPhoto | null> {
  const bytes = await app.drafts?.loadPhoto(key, meta.id).catch(() => null);
  if (!bytes || sniffImageMime(bytes) !== meta.mime || (await sha256Hex(bytes)) !== meta.sha256)
    return null;
  const photo: PreparedPhoto = {
    bytes,
    mime: meta.mime as PhotoMime,
    width: meta.width,
    height: meta.height,
    sha256: meta.sha256,
  };
  return { id: meta.id, status: 'ready', url: thumbUrl(photo), ...photo };
}

export function fieldValue(d: Pick<DraftModel, 'text' | 'reason'>, f: FieldId): string {
  return f === 'reason' ? d.reason : d.text;
}

class DraftStore {
  private drafts = new Map<string, DraftModel>();
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private writes = new Map<string, Promise<void>>();
  private undoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The photo ids each draft has in storage, so a save writes only new photos. */
  private storedPhotos = new Map<string, Set<string>>();
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
      photos: [],
      photoNotice: null,
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
    let d = this.drafts.get(key);
    if (!d || session !== this.session) return;
    // Anything typed or dictated before storage answered wins over the stored copy.
    if (!stored || d.editGen > 0 || !isEmpty(d)) {
      this.put({ ...d, loaded: true });
      return;
    }
    const photos: DraftPhoto[] = [];
    let lost = 0;
    for (const meta of stored.photos ?? []) {
      const p = await restorePhoto(key, meta);
      if (p) photos.push(p);
      else lost++;
    }
    d = this.drafts.get(key);
    if (!d || session !== this.session || d.editGen > 0 || !isEmpty(d)) {
      revoke(photos);
      if (d && session === this.session) this.put({ ...d, loaded: true });
      return;
    }
    this.storedPhotos.set(key, new Set(photos.map((p) => p.id)));
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
      photos,
      // A photo that could not be read back is said, never quietly dropped from a draft that still looks whole.
      photoNotice: lost
        ? {
            text:
              lost === 1
                ? '1 photo couldn’t be restored on this device. Add it again.'
                : `${lost} photos couldn’t be restored on this device. Add them again.`,
            tone: 'error',
          }
        : null,
      notice: isEmpty({ ...stored, photos })
        ? null
        : reviewed === revision
          ? 'restored'
          : 'earlier',
    });
  }

  /**
   * Put photos that were already prepared back into a draft (a refused answer's photos, moved to a follow-up or a
   * correction): as many as fit, the rest said in the lane.
   */
  adoptPhotos(key: string, photos: readonly PreparedPhoto[], room: number): void {
    const d = this.drafts.get(key);
    if (!d || !photos.length) return;
    const fit = photos.slice(0, Math.max(0, room));
    const ready: DraftPhoto[] = fit.map((p) => ({
      id: newId(),
      status: 'ready',
      url: thumbUrl(p),
      ...p,
    }));
    const left = photos.length - fit.length;
    this.put({
      ...d,
      photos: [...d.photos, ...ready],
      editGen: d.editGen + 1,
      notice: null,
      photoNotice: left
        ? {
            text:
              left === 1
                ? '1 photo didn’t fit, so it wasn’t moved.'
                : `${left} photos didn’t fit, so they weren’t moved.`,
            tone: 'error',
          }
        : null,
    });
    this.schedule(key);
  }

  /**
   * Add chosen photos: as many as there is room for, each holding its place while it is scaled and stripped. What did
   * not fit, and anything that could not be read, is said in the lane; nothing is dropped silently.
   */
  addPhotos(key: string, files: readonly Blob[], room: PhotoRoom): void {
    const d = this.drafts.get(key);
    if (!d || files.length === 0) return;
    const images = files.filter((f) => !f.type || f.type.startsWith('image/'));
    const take = images.slice(0, Math.max(0, room.room));
    const over = images.length - take.length;
    const notice: PhotoNotice | null =
      over > 0
        ? { text: room.overflow(over), tone: 'info' }
        : images.length < files.length
          ? { text: 'Only photos can be attached.', tone: 'info' }
          : null;
    const slots = take.map(() => ({ id: newId(), status: 'preparing' as const }));
    if (take.length)
      announce(take.length === 1 ? 'Adding 1 photo.' : `Adding ${take.length} photos.`);
    this.put({
      ...d,
      photos: [...d.photos, ...slots],
      editGen: d.editGen + 1,
      notice: null,
      undo: null,
      photoNotice: notice,
    });
    const { epoch } = d;
    const session = this.session;
    void (async () => {
      // One at a time: four 48 MP decodes at once can exhaust a phone's memory.
      for (let i = 0; i < take.length; i++) {
        const slot = slots[i]!;
        const r = await preparePhoto(take[i]!);
        const cur = this.drafts.get(key);
        const live = cur && session === this.session && cur.epoch === epoch;
        if (!live || !cur.photos.some((p) => p.id === slot.id)) {
          continue;
        }
        if (r.ok) {
          const ready: DraftPhoto = {
            id: slot.id,
            status: 'ready',
            url: thumbUrl(r.photo),
            ...r.photo,
          };
          this.put({ ...cur, photos: cur.photos.map((p) => (p.id === slot.id ? ready : p)) });
        } else {
          this.put({
            ...cur,
            photos: cur.photos.filter((p) => p.id !== slot.id),
            photoNotice: {
              text:
                r.reason === 'unsupported'
                  ? 'That photo couldn’t be read here. Try a JPEG or PNG.'
                  : 'That photo couldn’t be prepared. Try again.',
              tone: 'error',
            },
          });
        }
        this.schedule(key);
      }
    })();
  }

  /** Remove one photo before sending, with Undo. */
  removePhoto(key: string, id: string): void {
    const d = this.drafts.get(key);
    const at = d?.photos.findIndex((p) => p.id === id) ?? -1;
    if (!d || at < 0) return;
    const photo = d.photos[at]!;
    this.put({
      ...d,
      photos: d.photos.filter((p) => p.id !== id),
      editGen: d.editGen + 1,
      notice: null,
      photoNotice: null,
    });
    this.schedule(key);
    if (photo.status !== 'ready') return;
    announce('Photo removed. Undo is available.');
    let restored = false;
    this.offerUndo(key, 'Photo removed', () => {
      const cur = this.drafts.get(key);
      if (!cur || restored) return;
      restored = true;
      const photos = [...cur.photos];
      photos.splice(Math.min(at, photos.length), 0, photo);
      this.edit(key, { photos });
      announce('Photo restored.');
    });
    // Its thumbnail goes once Undo can no longer bring it back.
    setTimeout(() => {
      if (!restored && !this.drafts.get(key)?.photos.some((p) => p.id === id)) revoke([photo]);
      restored = true;
    }, 9_000);
  }

  dismissPhotoNotice(key: string): void {
    const d = this.drafts.get(key);
    if (d?.photoNotice) this.put({ ...d, photoNotice: null });
  }

  /** Say something about photos in the lane (the limit, when `+` is tapped with no room left). */
  notePhotos(key: string, notice: PhotoNotice): void {
    const d = this.drafts.get(key);
    if (d) this.put({ ...d, photoNotice: notice });
  }

  /** Resolves once the draft's stored copy has been read (or there was none), so a merge never races the load. */
  async whenLoaded(key: string, timeoutMs = 5_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const d = this.drafts.get(key);
      if (!d) return false;
      if (d.loaded) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
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
    const photos = d.photos.filter((p) => p.status === 'ready');
    const snapshot = {
      selected: d.selected,
      text: d.text,
      reason: d.reason,
      caret: d.caret,
      photos,
    };
    let restored = false;
    this.put({
      ...d,
      selected: [],
      text: '',
      reason: '',
      caret: null,
      passage: null,
      photos: [],
      photoNotice: null,
      editGen: d.editGen + 1,
      epoch: d.epoch + 1,
      notice: null,
    });
    this.offerUndo(key, message, () => {
      restored = true;
      this.edit(key, snapshot);
    });
    if (photos.length)
      setTimeout(() => {
        if (!restored) revoke(photos);
      }, 9_000);
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
    if (d) {
      revoke(d.photos);
      this.put({
        ...d,
        selected: [],
        text: '',
        reason: '',
        caret: null,
        passage: null,
        photos: [],
        photoNotice: null,
        editGen: d.editGen + 1,
        epoch: d.epoch + 1,
        save: 'idle',
        notice: null,
        undo: null,
      });
    }
    await this.writes.get(key)?.catch(() => undefined);
    this.storedPhotos.delete(key);
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
    if (!d || !app.drafts || !d.loaded) return;
    const session = this.session;
    const slow = setTimeout(() => this.status(key, 'saving'), SAVING_VISIBLE_MS);
    try {
      await this.writeDraft(key, d);
      const empty = isEmpty({ ...d, photos: readyPhotos(d) });
      if (session === this.session) this.status(key, empty ? 'idle' : 'saved');
    } catch (e) {
      if (session === this.session) this.status(key, 'error');
      throw e;
    } finally {
      clearTimeout(slow);
    }
  }

  /** Writes `d` as the stored draft for `key`: its photos first, then the row that lists them, then old photos go. */
  private async writeDraft(key: string, d: DraftModel) {
    const store = app.drafts;
    if (!store) throw new Error('not paired');
    {
      const ready = readyPhotos(d);
      if (isEmpty({ ...d, photos: ready })) {
        await store.delete(key);
        this.storedPhotos.delete(key);
      } else {
        // The photos first, then the row that lists them: a row never names a photo storage doesn't have.
        const have = this.storedPhotos.get(key) ?? new Set<string>();
        for (const p of ready) {
          if (have.has(p.id)) continue;
          await store.savePhoto(key, p.id, p.bytes);
          have.add(p.id);
        }
        this.storedPhotos.set(key, have);
        const draft: Draft = {
          v: 2,
          mode: d.mode,
          revision: d.revision === UNKNOWN_REVISION ? null : d.revision,
          selected: d.selected,
          text: d.text,
          reason: d.reason,
          caret: d.caret,
          passage: d.passage,
          photos: ready.map((p) => ({
            id: p.id,
            mime: p.mime,
            width: p.width,
            height: p.height,
            size: p.bytes.length,
            sha256: p.sha256,
          })),
        };
        await store.save(key, draft);
        const keep = new Set(ready.map((p) => p.id));
        if ([...have].some((id) => !keep.has(id))) {
          await store.prunePhotos(key, keep);
          this.storedPhotos.set(key, keep);
        }
      }
    }
  }

  /**
   * Move words and photos from somewhere else (a refused answer) into a draft as one step: the merged draft is
   * written to storage and read back first, and only then becomes the draft on screen. A failure changes nothing,
   * so trying again moves the same things once, never twice.
   */
  async mergeInto(
    key: string,
    words: string,
    photos: readonly PreparedPhoto[],
    patch?: { selected: string[] },
  ): Promise<boolean> {
    const session = this.session;
    if (!(await this.whenLoaded(key))) return false;
    const d = this.drafts.get(key);
    if (!d || !app.drafts || session !== this.session) return false;
    const said = d.text.trim() ? d.text.trimEnd() : '';
    const add = words.trim();
    // Nothing to move (a choice-only answer being dismissed): the draft stays exactly as it is.
    if (!add && !photos.length && !patch) return true;
    const text = add ? (said ? `${said}\n\n${add}` : add) : d.text;
    const ready: DraftPhoto[] = photos.map((p) => ({
      id: newId(),
      status: 'ready',
      url: thumbUrl(p),
      ...p,
    }));
    const next: DraftModel = {
      ...d,
      ...(patch ?? {}),
      text,
      photos: [...d.photos, ...ready],
      editGen: d.editGen + 1,
      notice: null,
      undo: null,
      photoNotice: null,
    };
    try {
      clearTimeout(this.timers.get(key));
      await this.writes.get(key)?.catch(() => undefined);
      await this.writeDraft(key, next);
      // An empty result has no row to read back (writing it deleted the row): there is nothing to lose.
      if (!isEmpty({ ...next, photos: readyPhotos(next) })) {
        const saved = await app.drafts.load(key);
        const want = readyPhotos(next).length;
        if (!saved || (saved.photos?.length ?? 0) < want || (text.trim() && !saved.text.trim()))
          throw new Error('not saved');
      }
    } catch {
      revoke(ready);
      return false;
    }
    // Unpaired or revoked meanwhile: nothing comes back into memory behind the lock.
    if (session !== this.session || !this.drafts.has(key)) {
      revoke(ready);
      return false;
    }
    this.put({ ...next, save: 'saved' });
    return true;
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
    for (const d of this.drafts.values()) revoke(d.photos);
    this.drafts.clear();
    this.storedPhotos.clear();
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
