import type { z } from 'zod';
import {
  DevicesResponse,
  KeyGrantsResponse,
  MessagesPage,
  SettingsResponse,
  PROTOCOL_VERSION,
  type AttachmentDescriptor,
  type InfoResponse,
  type LedgerEvent,
  type PhoneImageReference,
  type SettingsBody,
} from '@daintreehq/decisions-protocol';
import {
  decryptAttachment,
  encryptAttachment,
  importSigningPublicKey,
  openEpochGrant,
  sniffImageMime,
  newId,
  type EpochKey,
} from '@daintreehq/decisions-crypto';
import { Db, type ConfigRecord, type DeviceKeyRecord } from '../data/db.js';
import { ImageCache, type ImageContext, type ImageResult } from '../data/images.js';
import {
  Drafts,
  Outbox,
  type OutboxEntry,
  type OutboxImage,
  type Rebuilt,
} from '../data/outbox.js';
import type { PreparedPhoto } from '../data/photos.js';
import { runPairing, type PairingPhase } from '../data/pairing.js';
import { publicJson, Relay, RelayError } from '../data/relay.js';
import { SnapshotStore } from '../data/snapshots.js';
import { SyncEngine, type Connection } from '../data/sync.js';
import { buildAnswerRequest, highestEpoch, type HumanActionKind } from '../domain/answer.js';
import { buildMessageRequest } from '../domain/message.js';
import { QuestionStore, type QuestionView } from '../domain/model.js';
import { verifySnapshotResponse } from '../domain/snapshot.js';
import { TrustStore } from '../domain/trust.js';
import { applyTheme, DEFAULT_PREFS, type LocalPrefs } from './prefs.js';
import { checkInvite } from '../data/pairing.js';
import type { PairingInvitePayload, ProtocolFeature } from '@daintreehq/decisions-protocol';

/** The extension this app understands: pane snapshots, read for each question's observed agent state. */
const SNAPSHOT_FEATURE: ProtocolFeature = 'pane-snapshots-v1';
/** Set once this device has read every open question's snapshot after first declaring the feature. */
const SNAPSHOT_BACKFILL_PREF = 'snapshot-backfill-v1';
/** Thread messages: the person's follow-ups after an answer, and the agent's messages (docs/protocol.md section 16). */
const THREAD_FEATURE: ProtocolFeature = 'thread-messages-v1';
/** Set once this device has read every question's thread after first declaring the feature. */
const THREAD_BACKFILL_PREF = 'thread-backfill-v1';
/** Phone images: photos the person attaches to an answer or a follow-up (docs/protocol.md section 17). */
const PHOTO_FEATURE: ProtocolFeature = 'phone-images-v1';

/** A photo the composer hands over at Send: scaled, stripped and hashed, still plaintext. */
export type OutgoingPhoto = PreparedPhoto;

export type ServerSettings = z.infer<typeof SettingsResponse>['settings'];

export type Phase = 'loading' | 'unpaired' | 'ready' | 'revoked';

export interface AppSnapshot {
  rev: number;
  phase: Phase;
  config: ConfigRecord | null;
  connection: Connection;
  online: boolean;
  syncing: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
  /** The relay's last request failed and nothing has synced since: polling on is not a connection. */
  relayUnreachable: boolean;
  updateAvailable: boolean;
  prefs: LocalPrefs;
  info: InfoResponse | null;
  devices: DevicesResponse | null;
}

export type { ImageResult, LoadedImage } from '../data/images.js';

export class AppController {
  private snap: AppSnapshot;
  private listeners = new Set<() => void>();
  private db: Db | null = null;
  private relay: Relay | null = null;
  private keys: DeviceKeyRecord | null = null;
  private cacheKey: CryptoKey | null = null;
  private epochKeys = new Map<number, EpochKey>();
  trust: TrustStore | null = null;
  store: QuestionStore | null = null;
  outbox: Outbox | null = null;
  drafts: Drafts | null = null;
  sync: SyncEngine | null = null;
  /** Each question's latest pane snapshot, while the relay serves them. */
  snapshots: SnapshotStore | null = null;
  readonly images = new ImageCache({
    createUrl: (b) => URL.createObjectURL(b),
    revokeUrl: (u) => URL.revokeObjectURL(u),
  });
  private swReg: ServiceWorkerRegistration | null = null;
  private bound = false;

  constructor(private readonly origin: string = globalThis.location?.origin ?? '') {
    this.snap = {
      rev: 0,
      phase: 'loading',
      config: null,
      connection: 'idle',
      online: globalThis.navigator?.onLine ?? true,
      syncing: false,
      lastSyncedAt: null,
      lastError: null,
      relayUnreachable: false,
      updateAvailable: false,
      prefs: DEFAULT_PREFS,
      info: null,
      devices: null,
    };
  }

  /* ---------------- external store plumbing ---------------- */

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): AppSnapshot => this.snap;
  private patch(p: Partial<AppSnapshot>) {
    this.snap = { ...this.snap, ...p, rev: this.snap.rev + 1 };
    for (const l of this.listeners) l();
  }

  /* ---------------- lifecycle ---------------- */

  async init(): Promise<void> {
    this.db = await Db.open();
    const prefs = { ...DEFAULT_PREFS, ...((await this.db.getPref<LocalPrefs>('ui')) ?? {}) };
    prefs.voice = { ...DEFAULT_PREFS.voice, ...prefs.voice };
    applyTheme(prefs.theme);
    this.patch({ prefs });
    this.loadInfo();
    const config = await this.db.getConfig();
    if (!config) {
      this.patch({ phase: 'unpaired' });
      return;
    }
    await this.boot(config);
  }

  /** Settles once `GET /info` has answered or failed; boot waits for it briefly so the first socket is right. */
  private infoLoaded: Promise<void> = Promise.resolve();

  private loadInfo() {
    this.infoLoaded = publicJson<InfoResponse>(this.origin, 'GET', '/api/v1/info')
      .then((info) => {
        const before = this.declaredFeatures().join(',');
        this.patch({ info });
        // Info can arrive after sync has started: declare the features now and read what was missed.
        if (this.declaredFeatures().join(',') !== before && this.sync?.running) {
          this.sync.redeclare();
          void this.backfillSnapshots();
          void this.backfillThreads();
        }
      })
      .catch(() => undefined);
  }

  /** Whether the relay advertises pane snapshots (`GET /info`); until it does, the app never asks for them. */
  private snapshotsServed(): boolean {
    return this.snap.info?.features?.includes(SNAPSHOT_FEATURE) ?? false;
  }

  /** Whether the relay advertises thread messages; until it does, the app neither reads nor sends any. */
  threadsServed(): boolean {
    return this.snap.info?.features?.includes(THREAD_FEATURE) ?? false;
  }

  /** Whether the relay takes phone images; until it does, nothing offers to attach a photo. */
  photosServed(): boolean {
    return this.snap.info?.features?.includes(PHOTO_FEATURE) ?? false;
  }

  /**
   * What this app declares to the relay: only features the relay advertises (docs/protocol.md section 19). Phone
   * images are declared with thread messages, so a photo sent from this or another phone is never hidden from it.
   */
  private declaredFeatures(): ProtocolFeature[] {
    return [
      ...(this.snapshotsServed() ? [SNAPSHOT_FEATURE] : []),
      ...(this.threadsServed() ? [THREAD_FEATURE] : []),
      ...(this.photosServed() ? [PHOTO_FEATURE] : []),
    ];
  }

  /**
   * Whether photos can go with this question's answer or follow-ups: the relay takes them and the desktop that asked
   * declares them (it is what hands them to the agent). The relay refuses a reservation otherwise, so nothing offers it.
   */
  photosFor(view: QuestionView): boolean {
    if (!this.photosServed() || !view.verification.ok) return false;
    const d = this.snap.devices?.devices.find((x) => x.device_id === view.originatingDeviceId);
    return !!d?.features?.includes(PHOTO_FEATURE);
  }

  /**
   * Whether the person can send follow-ups on this question: the relay serves threads and the desktop that asked it
   * declared them too (it is what types them into the terminal). The relay refuses a message otherwise.
   */
  followUpsFor(view: QuestionView): 'yes' | 'desktop' | 'no' {
    if (!this.threadsServed()) return 'no';
    const d = this.snap.devices?.devices.find((x) => x.device_id === view.originatingDeviceId);
    if (!d) return 'no';
    return d.features?.includes(THREAD_FEATURE) ? 'yes' : 'desktop';
  }

  /**
   * Read every question's thread once, the first time this device declares thread messages: the event cursor may
   * already be past messages the relay never sent it. Each is verified as its event would be and cached like one.
   */
  private async backfillThreads(): Promise<void> {
    const db = this.db;
    const store = this.store;
    const relay = this.relay;
    if (!db || !store || !relay || !this.threadsServed()) return;
    if ((await db.getPref<boolean>(THREAD_BACKFILL_PREF)) ?? false) return;
    let complete = true;
    for (const v of store.list()) {
      if (!v.verification.ok) continue;
      try {
        let after = 0;
        for (;;) {
          const page = MessagesPage.parse(
            await relay.json('GET', `/questions/${v.id}/messages`, { query: { after, limit: 50 } }),
          );
          if (page.messages.length)
            await db.putEvents(await store.adoptMessages(v.id, page.messages));
          if (!page.has_more || page.next_after <= after) break;
          after = page.next_after;
        }
      } catch (e) {
        // A deleted question has nothing to read; anything else is tried again on the next start.
        if (!(e instanceof RelayError && (e.status === 404 || e.status === 410))) complete = false;
      }
    }
    if (complete) await db.setPref(THREAD_BACKFILL_PREF, true);
  }

  private async backfillSnapshots(): Promise<void> {
    if (!this.snapshots || !this.store || !this.db || !this.snapshotsServed()) return;
    const done = (await this.db.getPref<boolean>(SNAPSHOT_BACKFILL_PREF)) ?? false;
    this.snapshots.backfill(this.store.list(), !done);
    if (!done) await this.db.setPref(SNAPSHOT_BACKFILL_PREF, true);
  }

  private async boot(config: ConfigRecord): Promise<void> {
    const db = this.db!;
    const keys = await db.getKeys();
    const cacheKey = await db.getCacheKey();
    if (!keys || !cacheKey) {
      this.patch({ phase: 'unpaired' });
      return;
    }
    this.keys = keys;
    this.cacheKey = cacheKey;
    this.epochKeys = new Map(
      (await db.epochKeys()).map((e) => [e.epoch, { epoch: e.epoch, key: e.key }]),
    );
    this.trust = await TrustStore.create(
      config.installationId,
      config.ownerCert,
      config.ownerCert.signing_pub,
    );
    for (const c of await db.certs()) await this.trust.addCert(c.cert, c.revoked_at);
    this.relay = new Relay({
      origin: config.relayOrigin,
      installationId: config.installationId,
      deviceId: config.deviceId,
      signingKey: keys.signingPrivate,
    });
    this.store = new QuestionStore({
      installationId: config.installationId,
      trust: this.trust,
      epochKeys: () => this.epochKeys,
      refreshDevices: () => this.refreshDevices(),
      onKeyRotated: () => void this.refreshGrants(),
    });
    this.store.subscribe(() => this.patch({}));
    const cached = await db.eventsAfter(0);
    await this.store.rebuild(cached);
    this.snapshots = new SnapshotStore({
      fetch: (id) => this.relay!.json('GET', `/questions/${id}/snapshot`),
      verify: (raw, view) =>
        verifySnapshotResponse(raw, view, {
          installationId: config.installationId,
          trust: this.trust!,
          epochKeys: this.epochKeys,
        }),
      view: (id) => this.store?.get(id),
      refresh: (id) =>
        this.relay!.json('POST', `/questions/${id}/snapshot/refresh`, {
          body: { protocol_version: PROTOCOL_VERSION, idempotency_key: newId() },
        }),
    });
    this.snapshots.noteEvents(cached, false);

    this.outbox = new Outbox(db, cacheKey, () => this.relay!, {
      onChange: () => this.patch({}),
      // What the relay just committed is read back before its local copy goes, so an answer or follow-up never blinks
      // out of the thread (the thread hides the local copy once the committed one is in), and its photos stay put.
      settle: () => this.sync?.catchUp(),
      onCommitted: () =>
        void this.sync
          ?.catchUp()
          .catch((e) => this.patch({ lastError: e instanceof Error ? e.message : String(e) })),
      decrypt: (e, img, ciphertext) => this.decryptQueued(e, img, ciphertext),
      rebuild: (e, plaintexts) => this.rebuildEntry(e, plaintexts),
      inThread: (e) => {
        const v = this.store?.get(e.questionId);
        if (!v) return true; // deleted: nothing will ever show it, and the relay has it
        const id = e.recordId ?? e.messageId;
        if (!id) return true;
        return e.kind === 'message'
          ? v.messages.some((m) => m.messageId === id)
          : v.actions.some((a) => a.actionId === id);
      },
    });
    // Whatever the thread reads (a socket event, a catch-up, a backfill) may be what a committed entry waited for.
    this.store.subscribe(() => this.outbox?.reconcile());
    this.drafts = new Drafts(db, cacheKey);
    await this.outbox.load();

    const sync = (this.sync = new SyncEngine({
      relay: this.relay,
      db,
      origin: config.relayOrigin,
      ingest: async (events) => {
        await this.store!.ingestAll(events);
        if (this.snapshotsServed()) this.snapshots?.noteEvents(events, true);
      },
      features: () => this.declaredFeatures(),
      onServerTime: (iso) => this.snapshots?.setServerTime(iso),
      onConnection: (connection) => {
        this.patch(
          connection === 'live' ? { connection, relayUnreachable: false } : { connection },
        );
        if (connection === 'live') void this.outbox?.flush();
      },
      onSynced: (at) =>
        this.patch({ lastSyncedAt: at, syncing: false, lastError: null, relayUnreachable: false }),
      onUnreachable: () => {
        if (!this.snap.relayUnreachable) this.patch({ relayUnreachable: true });
      },
      onRevoked: () => this.lockRevoked(),
      onError: (e) => this.patch({ lastError: e instanceof Error ? e.message : String(e) }),
    }));
    this.patch({ phase: 'ready', config, syncing: true });
    this.bindPageEvents();
    // The socket's ticket declares the features the relay advertises, so give `GET /info` a moment first; if it
    // answers later, the sync engine redeclares on a new socket.
    await Promise.race([this.infoLoaded, new Promise((r) => setTimeout(r, 1500))]);
    if (this.sync !== sync) return;
    void sync.start().then(() => {
      void this.outbox?.flush();
      void this.backfillSnapshots();
      void this.backfillThreads();
    });
    void this.refreshDevices().catch(() => undefined);
  }

  /** This device was revoked: nothing decrypted stays alive behind the lock screen, and late downloads are dropped. */
  lockRevoked(): void {
    this.teardown();
    this.outbox?.stop();
    this.snapshots?.clear();
    this.images.dispose();
    this.patch({ phase: 'revoked' });
  }

  private bindPageEvents() {
    if (this.bound || typeof document === 'undefined') return;
    this.bound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.resume();
    });
    window.addEventListener('online', () => {
      this.patch({ online: true });
      this.resume();
    });
    window.addEventListener('offline', () => this.patch({ online: false }));
  }

  private resume() {
    this.sync?.kick();
    void this.outbox?.flush();
  }

  /* ---------------- pairing ---------------- */

  async pair(
    invite: PairingInvitePayload,
    label: string,
    onPhase: (p: PairingPhase) => void,
    signal?: AbortSignal,
  ) {
    const db = this.db!;
    checkInvite(invite, this.origin, Date.now());
    await runPairing({ invite, expectedOrigin: this.origin, label, db, onPhase, signal });
    const config = (await db.getConfig())!;
    await this.boot(config);
  }

  /** What unpairing would erase, counted from this device's own stores (shown before the person confirms). */
  async localDataSummary(): Promise<{ questions: number; unsent: number; drafts: number }> {
    const drafts = this.db ? (await this.db.drafts()).length : 0;
    return {
      questions: this.store?.list().length ?? 0,
      // An entry already on the relay, only waiting to be read back here, is not unsent.
      unsent: this.outbox?.list().filter((e) => e.state !== 'committed').length ?? 0,
      drafts,
    };
  }

  private teardowns = new Set<() => void>();

  /**
   * In-memory owners outside this controller (dictation) that must forget everything, synchronously, when the device
   * is unpaired or revoked.
   */
  registerTeardown(fn: () => void): () => void {
    this.teardowns.add(fn);
    return () => this.teardowns.delete(fn);
  }

  private teardown() {
    for (const fn of this.teardowns) {
      try {
        fn();
      } catch {
        /* one owner failing must not keep the others alive */
      }
    }
  }

  async wipe(): Promise<void> {
    // Order matters: cut off everything that could still deliver or reveal data BEFORE touching storage, and
    // never wait on the network. A stalled download must not be able to delay or undo an erase.
    this.teardown();
    this.sync?.stop();
    this.outbox?.stop();
    this.snapshots?.clear();
    this.images.dispose();
    const db = this.db;
    this.db = null;
    this.relay = this.store = this.outbox = this.drafts = this.sync = this.trust = null;
    this.snapshots = null;
    this.keys = this.cacheKey = null;
    this.epochKeys.clear();
    applyTheme(DEFAULT_PREFS.theme);
    this.patch({
      phase: 'unpaired',
      config: null,
      devices: null,
      connection: 'idle',
      relayUnreachable: false,
      prefs: DEFAULT_PREFS,
    });
    await db?.wipe();
    if (typeof caches !== 'undefined') for (const k of await caches.keys()) await caches.delete(k);
    this.db = await Db.open();
  }

  /* ---------------- devices, grants, settings ---------------- */

  async refreshDevices(): Promise<void> {
    if (!this.relay || !this.trust || !this.db) return;
    const res = DevicesResponse.parse(await this.relay.json('GET', '/devices'));
    for (const d of res.devices) {
      const ok = await this.trust.addCert(d.cert, d.revoked_at);
      if (ok)
        await this.db.putCert({ device_id: d.device_id, cert: d.cert, revoked_at: d.revoked_at });
      else if (d.device_id !== this.trust.ownerDeviceId) {
        // A certificate the pinned owner key did not sign: ignored, never trusted.
      }
    }
    this.patch({ devices: res });
    // The current epoch may be newer than what we hold (rotation while we were away).
    if (res.key_epoch > Math.max(0, ...this.epochKeys.keys())) await this.refreshGrants();
  }

  async refreshGrants(): Promise<void> {
    if (!this.relay || !this.trust || !this.keys || !this.db || !this.snap.config) return;
    const res = KeyGrantsResponse.parse(
      await this.relay.json('GET', `/devices/${this.snap.config.deviceId}/key-grants`),
    );
    const ownerPub = await importSigningPublicKey(this.snap.config.ownerCert.signing_pub);
    let added = false;
    for (const g of res.grants) {
      if (this.epochKeys.has(g.key_epoch)) continue;
      try {
        const k = await openEpochGrant({
          grant: g,
          ownerSigningPublicKey: ownerPub,
          exchangePrivateKey: this.keys.exchangePrivate,
          expectedInstallationId: this.snap.config.installationId,
          expectedDeviceId: this.snap.config.deviceId,
        });
        this.epochKeys.set(k.epoch, { epoch: k.epoch, key: k.key });
        await this.db.putEpoch({ epoch: k.epoch, key: k.key });
        added = true;
      } catch {
        /* a grant we cannot verify is skipped, not trusted */
      }
    }
    if (added && this.store) await this.store.rebuild(await this.db.eventsAfter(0));
  }

  async getServerSettings(): Promise<ServerSettings> {
    return SettingsResponse.parse(await this.relay!.json('GET', '/settings')).settings;
  }
  async putServerSettings(s: Omit<SettingsBody, 'protocol_version'>): Promise<void> {
    await this.relay!.json('PUT', '/settings', {
      body: { protocol_version: PROTOCOL_VERSION, ...s },
    });
  }

  async setPrefs(p: Partial<LocalPrefs>): Promise<void> {
    const prefs = { ...this.snap.prefs, ...p };
    applyTheme(prefs.theme);
    await this.db?.setPref('ui', prefs);
    this.patch({ prefs });
  }

  getRelay(): Relay | null {
    return this.relay;
  }

  /* ---------------- answering ---------------- */

  /**
   * Encrypts each photo for this question under the newest content key, with a fresh attachment id, exactly as a
   * question attachment is: only ciphertext ever leaves the device. Returns the references the signed content
   * carries, the outbox's bookkeeping, and the ciphertexts to seal beside the entry.
   */
  private async sealPhotos(
    view: QuestionView,
    photos: readonly OutgoingPhoto[],
  ): Promise<{
    refs: PhoneImageReference[];
    images: OutboxImage[];
    ciphertexts: Map<string, Uint8Array>;
  }> {
    const epoch = highestEpoch(this.epochKeys);
    const refs: PhoneImageReference[] = [];
    const images: OutboxImage[] = [];
    const ciphertexts = new Map<string, Uint8Array>();
    for (const p of photos) {
      const attachmentId = newId();
      const enc = await encryptAttachment(
        epoch,
        {
          installationId: this.snap.config!.installationId,
          questionId: view.id,
          attachmentId,
          keyEpoch: epoch.epoch,
        },
        p.bytes,
      );
      if (enc.sha256Plaintext !== p.sha256)
        throw new Error('A photo changed while it was being prepared.');
      refs.push({
        attachment_id: attachmentId,
        mime: p.mime,
        size: p.bytes.length,
        sha256: enc.sha256Plaintext,
        nonce: enc.nonce,
        key_epoch: epoch.epoch,
      });
      images.push({
        attachmentId,
        reserveKey: newId(),
        mime: p.mime,
        size: p.bytes.length,
        sha256: enc.sha256Plaintext,
        nonce: enc.nonce,
        keyEpoch: epoch.epoch,
        ciphertextBytes: enc.ciphertext.length,
        sha256Ciphertext: enc.sha256Ciphertext,
        width: p.width,
        height: p.height,
        stage: 'new',
      });
      ciphertexts.set(attachmentId, enc.ciphertext);
    }
    return { refs, images, ciphertexts };
  }

  async submit(args: {
    view: QuestionView;
    kind: HumanActionKind;
    /** The revision the human reviewed; signed as-is and refused if the question has moved on. */
    expectedRevision: number;
    selected: string[];
    text: string;
    reason?: string;
    reviewedDigests: string[];
    /** Photos going with the answer (answer and override only). */
    photos?: readonly OutgoingPhoto[];
  }): Promise<void> {
    if (!this.keys || !this.snap.config || !this.outbox) throw new Error('not paired');
    const photos = args.kind === 'confirm-proxy' ? [] : (args.photos ?? []);
    const sealed = photos.length ? await this.sealPhotos(args.view, photos) : null;
    const req = await buildAnswerRequest({
      installationId: this.snap.config.installationId,
      deviceId: this.snap.config.deviceId,
      signingKey: this.keys.signingPrivate,
      epochKey: highestEpoch(this.epochKeys),
      view: args.view,
      kind: args.kind,
      expectedRevision: args.expectedRevision,
      selected: args.selected,
      text: args.text,
      reason: args.reason,
      reviewedDigests: args.reviewedDigests,
      explicitApproval: args.view.content?.kind === 'approval' ? true : undefined,
      ...(sealed ? { images: sealed.refs } : {}),
    });
    await this.outbox.enqueue(
      {
        id: newId(),
        questionId: args.view.id,
        kind: req.kind,
        recordId: req.actionId,
        path: req.path,
        bodyText: req.bodyText,
        idempotencyKey: req.idempotencyKey,
        expectedRevision: req.expectedRevision,
        selected: args.selected,
        text: args.text,
        reason: args.reason ?? '',
        ...(sealed ? { images: sealed.images, reviewedDigests: args.reviewedDigests } : {}),
      },
      sealed?.ciphertexts,
    );
    await this.drafts?.delete(args.view.id);
    void this.outbox.flush();
  }

  /** A follow-up in the question's thread: sealed and queued durably, then sent. It never changes the answer in force. */
  async sendMessage(args: {
    view: QuestionView;
    text: string;
    photos?: readonly OutgoingPhoto[];
  }): Promise<void> {
    if (!this.keys || !this.snap.config || !this.outbox) throw new Error('not paired');
    const sealed = args.photos?.length ? await this.sealPhotos(args.view, args.photos) : null;
    const req = await buildMessageRequest({
      installationId: this.snap.config.installationId,
      deviceId: this.snap.config.deviceId,
      signingKey: this.keys.signingPrivate,
      epochKey: highestEpoch(this.epochKeys),
      view: args.view,
      text: args.text,
      ...(sealed ? { images: sealed.refs } : {}),
    });
    await this.outbox.enqueue(
      {
        id: newId(),
        questionId: args.view.id,
        kind: 'message',
        messageId: req.messageId,
        recordId: req.messageId,
        path: req.path,
        bodyText: req.bodyText,
        idempotencyKey: req.idempotencyKey,
        expectedRevision: args.view.revision,
        selected: [],
        text: args.text,
        reason: '',
        ...(sealed ? { images: sealed.images } : {}),
      },
      sealed?.ciphertexts,
    );
    void this.outbox.flush();
  }

  /**
   * A queued entry's photos, decrypted back from this device's copy, so a refused answer's photos can go back into
   * a draft (a follow-up, a correction, the answer again) rather than being lost with the entry.
   */
  async queuedPhotos(e: OutboxEntry): Promise<OutgoingPhoto[]> {
    // All or nothing: a caller that moves them on must know if even one is missing (it then keeps the entry).
    const out: OutgoingPhoto[] = [];
    for (const img of e.images ?? []) {
      const ct = await this.outbox?.localCiphertext(img.attachmentId);
      const bytes = ct ? await this.decryptQueued(e, img, ct).catch(() => null) : null;
      if (!bytes) return out;
      out.push({ bytes, mime: img.mime, width: img.width, height: img.height, sha256: img.sha256 });
    }
    return out;
  }

  /** One of a queued entry's photos, decrypted back from its stored ciphertext. */
  private async decryptQueued(e: OutboxEntry, img: OutboxImage, ciphertext: Uint8Array) {
    const epoch = this.epochKeys.get(img.keyEpoch);
    if (!epoch || !this.snap.config) throw new Error('Missing key for this photo');
    return decryptAttachment(
      epoch,
      {
        installationId: this.snap.config.installationId,
        questionId: e.questionId,
        attachmentId: img.attachmentId,
        keyEpoch: img.keyEpoch,
      },
      img.nonce,
      ciphertext,
      img.sha256,
    );
  }

  /**
   * The relay lost a queued entry's photo reservations: the same answer or follow-up, signed again, with the photos
   * encrypted under fresh ids for a fresh record. An answer is still refused if the question has moved on.
   */
  private async rebuildEntry(e: OutboxEntry, plaintexts: Uint8Array[]): Promise<Rebuilt | null> {
    const view = this.store?.get(e.questionId);
    if (!view || !this.keys || !this.snap.config || !e.images?.length) return null;
    const photos: OutgoingPhoto[] = e.images.map((img, i) => ({
      bytes: plaintexts[i]!,
      mime: img.mime,
      width: img.width,
      height: img.height,
      sha256: img.sha256,
    }));
    const sealed = await this.sealPhotos(view, photos);
    const base = {
      installationId: this.snap.config.installationId,
      deviceId: this.snap.config.deviceId,
      signingKey: this.keys.signingPrivate,
      epochKey: highestEpoch(this.epochKeys),
      view,
    };
    if (e.kind === 'message') {
      const req = await buildMessageRequest({ ...base, text: e.text, images: sealed.refs });
      return {
        entry: {
          path: req.path,
          bodyText: req.bodyText,
          idempotencyKey: req.idempotencyKey,
          messageId: req.messageId,
          recordId: req.messageId,
          images: sealed.images,
        },
        ciphertexts: sealed.ciphertexts,
      };
    }
    if (e.kind === 'confirm-proxy') return null;
    const req = await buildAnswerRequest({
      ...base,
      kind: e.kind,
      expectedRevision: e.expectedRevision,
      selected: e.selected,
      text: e.text,
      reason: e.reason || undefined,
      reviewedDigests: e.reviewedDigests ?? [],
      explicitApproval: view.content?.kind === 'approval' ? true : undefined,
      images: sealed.refs,
    });
    return {
      entry: {
        path: req.path,
        bodyText: req.bodyText,
        idempotencyKey: req.idempotencyKey,
        recordId: req.actionId,
        images: sealed.images,
      },
      ciphertexts: sealed.ciphertexts,
    };
  }

  /* ---------------- attachments ---------------- */

  loadImage(view: QuestionView, d: AttachmentDescriptor): Promise<ImageResult> {
    return this.images.load(d.attachment_id, (ctx) => this.fetchImage(view, d, ctx));
  }

  private async fetchImage(
    view: QuestionView,
    d: AttachmentDescriptor,
    ctx: ImageContext,
  ): Promise<ImageResult> {
    try {
      const epoch = this.epochKeys.get(d.key_epoch);
      if (!epoch || !this.relay || !this.snap.config)
        return { ok: false, reason: 'error', message: 'Missing key for this attachment' };
      // A photo still queued on this device is shown from its own ciphertext, checked exactly as a download is.
      const cipher =
        (await this.outbox?.localCiphertext(d.attachment_id)) ??
        (await this.relay.bytes(`/attachments/${d.attachment_id}/content`, ctx.signal));
      const unverified: ImageResult = {
        ok: false,
        reason: 'unverified',
        message: 'This file could not be verified',
      };
      const plain = await decryptAttachment(
        epoch,
        {
          installationId: this.snap.config.installationId,
          questionId: view.id,
          attachmentId: d.attachment_id,
          keyEpoch: d.key_epoch,
        },
        d.nonce,
        cipher,
        d.sha256,
      ).catch(() => null);
      if (!plain) return unverified;
      const mime = sniffImageMime(plain);
      if (!mime || mime !== d.mime) return unverified;
      const blob = new Blob([plain as unknown as BlobPart], { type: mime });
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob).catch(() => null);
        if (!bitmap) return unverified;
        bitmap.close();
      }
      return { ok: true, image: { url: ctx.makeUrl(blob), sha256: d.sha256, mime } };
    } catch (e) {
      if (e instanceof RelayError && (e.status === 404 || e.status === 410)) {
        return {
          ok: false,
          reason: 'expired',
          message: 'This attachment has expired and was deleted from your relay.',
        };
      }
      return {
        ok: false,
        reason: 'error',
        message: e instanceof Error ? e.message : 'Could not load the image',
      };
    }
  }

  /* ---------------- service worker ---------------- */

  setServiceWorker(reg: ServiceWorkerRegistration): void {
    this.swReg = reg;
    const check = () => {
      if (reg.waiting && navigator.serviceWorker.controller) this.patch({ updateAvailable: true });
    };
    check();
    reg.addEventListener('updatefound', () => {
      reg.installing?.addEventListener('statechange', check);
    });
  }

  /** Ask the browser to look for a newer app now. A found update raises `updateAvailable` once it has installed. */
  async checkForUpdate(): Promise<void> {
    await this.swReg?.update();
  }

  private updateGuards = new Set<() => Promise<boolean>>();

  /**
   * Work that must settle before the app reloads into an update (an active dictation stops and its words are
   * saved; drafts flush). A guard resolves false when it cannot make its work safe, and the update waits.
   */
  registerUpdateGuard(guard: () => Promise<boolean>): () => void {
    this.updateGuards.add(guard);
    return () => this.updateGuards.delete(guard);
  }

  /** Reload into the waiting version once every guard has made its work safe. Resolves false if one refused. */
  async applyUpdate(): Promise<boolean> {
    const w = this.swReg?.waiting;
    if (!w) return false;
    for (const guard of this.updateGuards) {
      if (!(await guard().catch(() => false))) return false;
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
      once: true,
    });
    w.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }

  /** Exposed for tests. */
  async ingestForTest(events: LedgerEvent[]) {
    await this.store?.ingestAll(events);
  }
}

export const app = new AppController();
