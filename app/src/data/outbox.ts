import { PROTOCOL_VERSION, type PhoneImageReference } from '@daintreehq/decisions-protocol';
import type { HumanActionKind } from '../domain/answer.js';
import type { Db } from './db.js';
import { open, openBytes, seal, sealBytes } from './seal.js';
import { RelayError } from './relay.js';
import type { PhotoMime } from './photos.js';

/**
 * `committed`: the relay has it, but this device has not yet read it back into the thread; the local copy stays (as
 * "Saved on your relay") until the thread holds the record, so nothing the person sent ever blinks out of view.
 */
export type OutboxState =
  'queued' | 'sending' | 'committed' | 'conflicted' | 'rejected' | 'expired';

/** What an entry sends: one of the person's actions on the question, or a follow-up message in its thread. */
export type OutboxKind = HumanActionKind | 'message';

/**
 * One photo going with an answer or follow-up (docs/protocol.md section 17). It is encrypted on this device when the
 * person taps Send; its ciphertext waits, sealed, in the `blobs` store until the relay has it. Before the signed record
 * that lists it can commit, it is reserved for that record, uploaded and completed, in that order; `stage` records how
 * far it got, so a retry (after a restart too) carries on from there with the same reservation.
 */
export interface OutboxImage {
  attachmentId: string;
  /** The reservation's idempotency key: the same on every attempt. */
  reserveKey: string;
  mime: PhotoMime;
  /** Plaintext bytes. */
  size: number;
  /** Plaintext SHA-256 (hex), as signed into the content. */
  sha256: string;
  nonce: string;
  keyEpoch: number;
  ciphertextBytes: number;
  sha256Ciphertext: string;
  width: number;
  height: number;
  stage: 'new' | 'reserved' | 'uploaded' | 'done';
}

export interface OutboxEntry {
  id: string;
  createdAt: number;
  questionId: string;
  kind: OutboxKind;
  /** A follow-up's signed message id (the same on every attempt). */
  messageId?: string;
  /** The signed record's own id (an answer's action id or a follow-up's message id): what its photos are reserved for. */
  recordId?: string;
  path: string;
  /** Exact serialised request; identical on every attempt. */
  bodyText: string;
  idempotencyKey: string;
  expectedRevision: number;
  /** What the human typed/selected, kept so a conflict never destroys it. */
  selected: string[];
  text: string;
  reason: string;
  /** The question files an answer acknowledged, kept so the request can be signed again with fresh photo ids. */
  reviewedDigests?: string[];
  /** The photos going with it, in the order the person attached them. */
  images?: OutboxImage[];
  /** How many times its photos were encrypted again under fresh ids after a reservation was lost. */
  rebuilt?: number;
  /** Where a refusal happened: the relay turned down one of its photos rather than the answer or message. */
  refusedAt?: 'image';
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
  upload?(
    path: string,
    bytes: Uint8Array,
    sha256Ciphertext: string,
    onProgress?: (fraction: number) => void,
  ): Promise<unknown>;
}

/** A fresh build of an entry whose photos were lost on the relay: new photo ids, a new record, the same words. */
export interface Rebuilt {
  entry: Pick<
    OutboxEntry,
    'bodyText' | 'idempotencyKey' | 'recordId' | 'messageId' | 'images' | 'path'
  >;
  /** Each new photo's ciphertext, by attachment id. */
  ciphertexts: Map<string, Uint8Array>;
}

export interface OutboxHooks {
  onCommitted?: (e: OutboxEntry) => void;
  /**
   * Awaited after the relay commits an entry and before its local copy goes: reading the commit back first means
   * the thread never shows a gap where the sent item was. A failure here never keeps the entry.
   */
  settle?: (e: OutboxEntry) => Promise<unknown> | undefined;
  onChange?: () => void;
  /**
   * The relay lost an entry's photo reservation (its upload window or orphan deadline passed) or refused the record's
   * photos: sign the same answer or follow-up again with the photos encrypted under fresh ids. Null when it can't be.
   */
  rebuild?: (e: OutboxEntry, plaintexts: Uint8Array[]) => Promise<Rebuilt | null>;
  /** Decrypts one of an entry's stored ciphertexts back to the photo (for a rebuild). */
  decrypt?: (e: OutboxEntry, img: OutboxImage, ciphertext: Uint8Array) => Promise<Uint8Array>;
  /**
   * Whether the thread on this device now holds what the entry committed (its action or message id), or can never
   * hold it (the question is gone). Without it, a commit counts as read back as soon as `settle` resolves.
   */
  inThread?: (e: OutboxEntry) => boolean;
}

/**
 * Where one queued photo is, as the thread shows it: waiting its turn (or for a connection), going up, sent and being
 * confirmed by the relay, on the relay, or stopped part-way by a dropped connection.
 */
export type PhotoState =
  | { kind: 'waiting' }
  | { kind: 'uploading'; fraction: number }
  | { kind: 'finishing' }
  | { kind: 'done' }
  | { kind: 'interrupted' };

const label = (id: string) => `outbox:${id}`;
const blobLabel = (entryId: string, attachmentId: string) =>
  `outbox-image:${entryId}:${attachmentId}`;
const blobId = blobLabel;

/** A photo's reservation is gone for good (expired or collected): the entry needs fresh photo ids. */
class ImageLost extends Error {}

/** A relay answer that will not change on a retry. */
const definite = (e: unknown): e is RelayError => e instanceof RelayError && !e.retryable;

/** The references an entry's content carries, as the thread shows them before the relay has it. */
export function entryImages(e: Pick<OutboxEntry, 'images'>): PhoneImageReference[] {
  return (e.images ?? []).map((i) => ({
    attachment_id: i.attachmentId,
    mime: i.mime,
    size: i.size,
    sha256: i.sha256,
    nonce: i.nonce,
    key_epoch: i.keyEpoch,
  }));
}

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
  /** Each photo's upload progress while it is being sent (0–1), by attachment id. Never stored. */
  private progress = new Map<string, number>();
  /**
   * Entries whose photos stopped on the way up. Kept through the retries that follow, so the recovery the person sees
   * stays put until a photo actually moves on; never stored, as a restart simply tries again.
   */
  private trouble = new Set<string>();
  /** The photo being uploaded right now, if any. */
  private current: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryStep = 0;

  constructor(
    private readonly db: Db,
    private readonly cacheKey: CryptoKey,
    private readonly poster: () => Poster,
    private readonly hooks: OutboxHooks = {},
    /** How long an entry with photos waits before trying again after the relay was unreachable mid-upload. */
    private readonly retryDelays: readonly number[] = [3_000, 10_000, 30_000],
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
        await this.db.deleteBlobs(label(row.id));
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

  /**
   * Where one of an entry's photos is. A photo is `done` only once the relay has confirmed it complete: every byte sent
   * is still `finishing` until then.
   */
  photoState(e: OutboxEntry, attachmentId: string): PhotoState {
    const img = e.images?.find((i) => i.attachmentId === attachmentId);
    if (!img || img.stage === 'done') return { kind: 'done' };
    // Being sent, or being confirmed, right now.
    if (this.current === attachmentId) {
      const f = this.progress.get(attachmentId) ?? 0;
      return f >= 1 ? { kind: 'finishing' } : { kind: 'uploading', fraction: f };
    }
    // The first photo not yet on the relay is the one that stopped (its bytes may be there, unconfirmed); the rest are
    // simply waiting their turn.
    if (this.trouble.has(e.id) && e.images!.find((i) => i.stage !== 'done') === img)
      return { kind: 'interrupted' };
    return { kind: 'waiting' };
  }

  /** The entry's photos stopped on their way up (a dropped connection, not a refusal); it is trying again. */
  uploadStopped(id: string): boolean {
    return this.trouble.has(id);
  }

  /** The photos of an entry already on the relay. */
  imagesSent(e: OutboxEntry): number {
    return (e.images ?? []).filter((i) => i.stage === 'done').length;
  }

  /**
   * A queued photo's ciphertext, for showing it in the thread before the relay has it (it is decrypted exactly as a
   * downloaded one would be). Null when no entry holds it.
   */
  async localCiphertext(attachmentId: string): Promise<Uint8Array | null> {
    for (const e of this.entries.values()) {
      if (e.images?.some((i) => i.attachmentId === attachmentId))
        return this.ciphertext(e, attachmentId).catch(() => null);
    }
    return null;
  }

  private async ciphertext(e: OutboxEntry, attachmentId: string): Promise<Uint8Array> {
    const row = await this.db.getBlob(blobId(e.id, attachmentId));
    if (!row) throw new ImageLost('photo missing on this device');
    return openBytes(this.cacheKey, row.sealed, blobLabel(e.id, attachmentId));
  }

  private async storeCiphertexts(id: string, ciphertexts: ReadonlyMap<string, Uint8Array>) {
    for (const [attachmentId, bytes] of ciphertexts) {
      await this.db.putBlob({
        id: blobId(id, attachmentId),
        owner: label(id),
        createdAt: Date.now(),
        sealed: await sealBytes(this.cacheKey, bytes, blobLabel(id, attachmentId)),
      });
    }
  }

  /** Put a refused entry back in the queue as it was (same request, same idempotency key) and send it. */
  async retry(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.state === 'queued' || e.state === 'sending') return;
    e.state = 'queued';
    delete e.error;
    // Asked for again by the person: photos the relay lost may be encrypted afresh once more.
    if (e.errorCode === 'image_lost') e.rebuilt = 0;
    delete e.errorCode;
    delete e.refusedAt;
    await this.persist(e);
    this.changed();
    void this.flush();
  }

  /** Try a waiting entry's photos again now (the person tapped Try again), rather than at the next scheduled attempt. */
  retryNow(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryStep = 0;
    return this.flush();
  }

  private async persist(e: OutboxEntry): Promise<void> {
    await this.db.putOutbox({
      id: e.id,
      createdAt: e.createdAt,
      questionId: e.questionId,
      sealed: await seal(this.cacheKey, e, label(e.id)),
    });
  }

  /**
   * Durable before anything else happens: the photos' ciphertexts first, then the entry that lists them, so a crash
   * between the two leaves at worst unowned bytes, never an entry whose photos are missing.
   */
  async enqueue(
    e: Omit<OutboxEntry, 'state' | 'attempts' | 'createdAt'> & { createdAt?: number },
    ciphertexts?: ReadonlyMap<string, Uint8Array>,
  ): Promise<OutboxEntry> {
    const entry: OutboxEntry = {
      ...e,
      createdAt: e.createdAt ?? Date.now(),
      state: 'queued',
      attempts: 0,
    };
    if (ciphertexts?.size) await this.storeCiphertexts(entry.id, ciphertexts);
    await this.persist(entry);
    this.entries.set(entry.id, entry);
    this.changed();
    return entry;
  }

  async discard(id: string): Promise<void> {
    const e = this.entries.get(id);
    this.entries.delete(id);
    this.trouble.delete(id);
    if (e?.images?.some((i) => i.attachmentId === this.current)) this.current = null;
    for (const img of e?.images ?? []) this.progress.delete(img.attachmentId);
    await this.db.deleteOutbox(id);
    await this.db.deleteBlobs(label(id));
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

  private setProgress(attachmentId: string, f: number) {
    const before = this.progress.get(attachmentId) ?? -1;
    this.progress.set(attachmentId, f);
    // A re-render per twentieth is plenty for a ring; every byte would be a re-render per packet.
    if (Math.floor(f * 20) !== Math.floor(before * 20)) this.changed();
  }

  /**
   * Reserve, upload and complete each photo not yet on the relay, in order. A retryable failure is thrown as it is
   * (the entry waits); a reservation the relay has lost for good is `ImageLost`; any other definite refusal is thrown
   * as the relay's error.
   */
  private async sendImages(e: OutboxEntry): Promise<void> {
    const poster = this.poster();
    const binding = { kind: e.kind === 'message' ? 'message' : 'answer', record_id: e.recordId };
    for (const img of e.images ?? []) {
      if (img.stage === 'done') continue;
      const id = img.attachmentId;
      if (img.stage === 'new') {
        try {
          await poster.jsonRaw(
            'POST',
            `/questions/${e.questionId}/images/reservations`,
            JSON.stringify({
              protocol_version: PROTOCOL_VERSION,
              idempotency_key: img.reserveKey,
              attachment_id: id,
              binding,
              ciphertext_bytes: img.ciphertextBytes,
              sha256_ciphertext: img.sha256Ciphertext,
              mime_category: 'image',
            }),
          );
        } catch (err) {
          if (definite(err)) {
            if (err.code === 'idempotency_collision') throw new ImageLost(err.message);
            e.refusedAt = 'image';
          }
          throw err;
        }
        img.stage = 'reserved';
        await this.persist(e);
      }
      if (img.stage === 'reserved') {
        if (!poster.upload) throw new RelayError('network', 0, 'Uploads are not available');
        const bytes = await this.ciphertext(e, id);
        this.current = id;
        this.setProgress(id, 0);
        try {
          await poster.upload(`/attachments/${id}/content`, bytes, img.sha256Ciphertext, (f) => {
            // Bytes moving again: whatever stopped them is over.
            if (f > 0 && this.trouble.delete(e.id)) this.changed();
            this.setProgress(id, f);
          });
        } catch (err) {
          this.current = null;
          this.progress.delete(id);
          if (!definite(err)) throw err;
          // The stream broke on the relay's side: the reservation is released for another try.
          if (err.code === 'validation_error') throw new RelayError('network', 0, err.message);
          // An upload whose answer was lost may already be stored: completing it says whether it is.
          if (err.code !== 'invalid_state') throw new ImageLost(err.message);
        }
        img.stage = 'uploaded';
        this.trouble.delete(e.id);
        await this.persist(e);
      }
      if (img.stage === 'uploaded') {
        // Confirming with the relay is part of this photo's turn: it shows as finishing while it runs.
        this.current = id;
        this.progress.set(id, 1);
        this.changed();
        try {
          await poster.jsonRaw(
            'POST',
            `/attachments/${id}/complete`,
            JSON.stringify({ protocol_version: PROTOCOL_VERSION }),
          );
        } catch (err) {
          this.current = null;
          this.progress.delete(id);
          if (definite(err)) throw new ImageLost(err.message);
          throw err;
        }
        img.stage = 'done';
        this.current = null;
        this.progress.delete(id);
        this.trouble.delete(e.id);
        await this.persist(e);
        this.changed();
      }
    }
  }

  /**
   * Sign the entry again with its photos under fresh ids, once. The words, choice and revision are unchanged; the
   * old photos, never listed by a committed record, are collected by the relay.
   */
  private async rebuild(e: OutboxEntry): Promise<boolean> {
    if (!this.hooks.rebuild || !this.hooks.decrypt || (e.rebuilt ?? 0) >= 1) return false;
    let next: Rebuilt | null = null;
    try {
      const plaintexts: Uint8Array[] = [];
      for (const img of e.images ?? [])
        plaintexts.push(
          await this.hooks.decrypt(e, img, await this.ciphertext(e, img.attachmentId)),
        );
      next = await this.hooks.rebuild(e, plaintexts);
    } catch {
      next = null;
    }
    if (!next) return false;
    const old = (e.images ?? []).map((i) => i.attachmentId);
    for (const id of old) this.progress.delete(id);
    // The new photos are durable before the entry switches to them, and the old ones go only after it has: a crash
    // at any point leaves an entry whose photos are all on this device.
    await this.storeCiphertexts(e.id, next.ciphertexts);
    Object.assign(e, next.entry, { rebuilt: (e.rebuilt ?? 0) + 1, state: 'queued' });
    delete e.refusedAt;
    await this.persist(e);
    for (const id of old) if (!next.ciphertexts.has(id)) await this.db.deleteBlob(blobId(e.id, id));
    this.trouble.delete(e.id);
    this.changed();
    return true;
  }

  private scheduleRetry() {
    if (this.retryTimer || this.retryDelays.length === 0) return;
    const ms = this.retryDelays[Math.min(this.retryStep, this.retryDelays.length - 1)]!;
    this.retryStep++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, ms);
  }

  private async pass(): Promise<void> {
    for (const e of this.list()) {
      if (e.state === 'committed') {
        await this.settled(e);
        continue;
      }
      if (e.state !== 'queued') continue;
      e.state = 'sending';
      e.attempts++;
      this.changed();
      let photoPhase = false;
      try {
        if (e.images?.length) {
          photoPhase = true;
          await this.sendImages(e);
          photoPhase = false;
        }
        try {
          await this.poster().jsonRaw('POST', e.path, e.bodyText);
        } catch (err) {
          // The record's photos did not bind (one passed its orphan deadline): they go again under fresh ids.
          if (e.images?.length && definite(err) && err.code === 'validation_error')
            throw new ImageLost(err.message);
          throw err;
        }
        // On the relay: it is never sent again. The local copy goes once the thread has read the record back.
        e.state = 'committed';
        this.retryStep = 0;
        this.trouble.delete(e.id);
        await this.persist(e);
        this.changed();
        this.hooks.onCommitted?.(e);
        await this.settled(e);
      } catch (err) {
        if (err instanceof ImageLost) {
          if (await this.rebuild(e)) {
            this.again = true;
            return;
          }
          e.state = 'rejected';
          e.refusedAt = 'image';
          e.error = 'Your relay no longer has these photos.';
          e.errorCode = 'image_lost';
          await this.persist(e);
          this.changed();
          continue;
        }
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
        // Network trouble or relay hiccup: keep it queued and stop, order matters. Photos part-way up say so, and
        // try again on their own while the device thinks it is online.
        e.state = 'queued';
        if (e.images?.length) {
          const online = typeof navigator === 'undefined' || navigator.onLine !== false;
          // Offline is simply waiting; a photo that stopped part-way while online is trouble worth saying.
          if (photoPhase && online) this.trouble.add(e.id);
          if (online) this.scheduleRetry();
        }
        await this.persist(e);
        this.changed();
        return;
      }
    }
  }

  /** Read a committed entry back; let its local copy go only once the thread holds what it committed. */
  private async settled(e: OutboxEntry): Promise<void> {
    await Promise.resolve(this.hooks.settle?.(e)).catch(() => undefined);
    if (!this.hooks.inThread || this.hooks.inThread(e)) await this.discard(e.id);
  }

  /** The thread changed: committed entries it now holds (or never will) can go. Synchronous check, async removal. */
  reconcile(): void {
    if (!this.hooks.inThread) return;
    for (const e of this.entries.values())
      if (e.state === 'committed' && this.hooks.inThread(e)) void this.discard(e.id);
  }

  /** Stop any scheduled retry (unpair, revocation). */
  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
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
  /** The photos chosen for it, in order; their bytes are sealed beside it (`Drafts.photo`). */
  photos?: DraftPhotoMeta[];
}

/** What a draft remembers of a chosen photo; the photo itself (already scaled and stripped) is a sealed blob. */
export interface DraftPhotoMeta {
  id: string;
  mime: PhotoMime;
  width: number;
  height: number;
  size: number;
  sha256: string;
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
    photos: Array.isArray(d.photos) ? d.photos.filter((p) => p && typeof p.id === 'string') : [],
  };
}

const photoOwner = (key: string) => `draft:${key}`;
const photoLabel = (key: string, id: string) => `draft-photo:${key}:${id}`;

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
  /** The draft and its photos. */
  async delete(key: string): Promise<void> {
    await this.db.deleteDraft(key);
    await this.db.deleteBlobs(photoOwner(key));
  }

  /** A chosen photo's bytes, sealed under the device key and bound to this draft and photo. */
  async savePhoto(key: string, id: string, bytes: Uint8Array): Promise<void> {
    await this.db.putBlob({
      id: photoLabel(key, id),
      owner: photoOwner(key),
      createdAt: Date.now(),
      sealed: await sealBytes(this.cacheKey, bytes, photoLabel(key, id)),
    });
  }
  async loadPhoto(key: string, id: string): Promise<Uint8Array | null> {
    const row = await this.db.getBlob(photoLabel(key, id));
    if (!row) return null;
    try {
      return await openBytes(this.cacheKey, row.sealed, photoLabel(key, id));
    } catch {
      return null;
    }
  }
  /** Keeps only the photos in `keep`; the rest of this draft's stored photos go. */
  async prunePhotos(key: string, keep: ReadonlySet<string>): Promise<void> {
    for (const id of await this.db.blobIds(photoOwner(key)))
      if (![...keep].some((k) => photoLabel(key, k) === id)) await this.db.deleteBlob(id);
  }
  /** Ids of this draft's stored photos. */
  async photoIds(key: string): Promise<string[]> {
    const prefix = photoLabel(key, '');
    return (await this.db.blobIds(photoOwner(key))).map((id) => id.slice(prefix.length));
  }

  /** Row ids of every stored draft (no contents are opened). */
  async keys(): Promise<string[]> {
    return (await this.db.drafts()).map((r) => r.questionId);
  }
}
