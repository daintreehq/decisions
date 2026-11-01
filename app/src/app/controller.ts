import type { z } from 'zod';
import {
  DevicesResponse,
  KeyGrantsResponse,
  SettingsResponse,
  PROTOCOL_VERSION,
  type AttachmentDescriptor,
  type InfoResponse,
  type LedgerEvent,
  type SettingsBody,
} from '@daintree/decisions-protocol';
import {
  decryptAttachment,
  importSigningPublicKey,
  openEpochGrant,
  sniffImageMime,
  newId,
  type EpochKey,
} from '@daintree/decisions-crypto';
import { Db, type ConfigRecord, type DeviceKeyRecord } from '../data/db.js';
import { Drafts, Outbox } from '../data/outbox.js';
import { runPairing, type PairingPhase } from '../data/pairing.js';
import { publicJson, Relay, RelayError } from '../data/relay.js';
import { SyncEngine, type Connection } from '../data/sync.js';
import { buildAnswerRequest, highestEpoch, type HumanActionKind } from '../domain/answer.js';
import { QuestionStore, type QuestionView } from '../domain/model.js';
import { TrustStore } from '../domain/trust.js';
import { applyTheme, DEFAULT_PREFS, type LocalPrefs } from './prefs.js';
import { checkInvite } from '../data/pairing.js';
import type { PairingInvitePayload } from '@daintree/decisions-protocol';

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
  updateAvailable: boolean;
  prefs: LocalPrefs;
  info: InfoResponse | null;
  devices: DevicesResponse | null;
}

export interface LoadedImage {
  url: string;
  sha256: string;
  mime: string;
}

export type ImageResult =
  { ok: true; image: LoadedImage } | { ok: false; reason: 'expired' | 'error'; message: string };

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
  private images = new Map<string, Promise<ImageResult>>();
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

  private loadInfo() {
    publicJson<InfoResponse>(this.origin, 'GET', '/api/v1/info')
      .then((info) => this.patch({ info }))
      .catch(() => undefined);
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
    await this.store.rebuild(await db.eventsAfter(0));

    this.outbox = new Outbox(db, cacheKey, () => this.relay!, {
      onChange: () => this.patch({}),
      onCommitted: () =>
        void this.sync
          ?.catchUp()
          .catch((e) => this.patch({ lastError: e instanceof Error ? e.message : String(e) })),
    });
    this.drafts = new Drafts(db, cacheKey);
    await this.outbox.load();

    this.sync = new SyncEngine({
      relay: this.relay,
      db,
      origin: config.relayOrigin,
      ingest: (events) => this.store!.ingestAll(events),
      onConnection: (connection) => {
        this.patch({ connection });
        if (connection === 'live') void this.outbox?.flush();
      },
      onSynced: (at) => this.patch({ lastSyncedAt: at, syncing: false, lastError: null }),
      onRevoked: () => this.patch({ phase: 'revoked' }),
      onError: (e) => this.patch({ lastError: e instanceof Error ? e.message : String(e) }),
    });
    this.patch({ phase: 'ready', config, syncing: true });
    this.bindPageEvents();
    void this.sync.start().then(() => this.outbox?.flush());
    void this.refreshDevices().catch(() => undefined);
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

  async wipe(): Promise<void> {
    this.sync?.stop();
    for (const p of this.images.values()) {
      const r = await p;
      if (r.ok) URL.revokeObjectURL(r.image.url);
    }
    this.images.clear();
    await this.db?.wipe();
    this.db = null;
    this.relay = this.store = this.outbox = this.drafts = this.sync = this.trust = null;
    this.keys = this.cacheKey = null;
    this.epochKeys.clear();
    if (typeof caches !== 'undefined') for (const k of await caches.keys()) await caches.delete(k);
    this.patch({ phase: 'unpaired', config: null, devices: null, connection: 'idle' });
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

  async submit(args: {
    view: QuestionView;
    kind: HumanActionKind;
    selected: string[];
    text: string;
    reason?: string;
    reviewedDigests: string[];
  }): Promise<void> {
    if (!this.keys || !this.snap.config || !this.outbox) throw new Error('not paired');
    const req = await buildAnswerRequest({
      installationId: this.snap.config.installationId,
      deviceId: this.snap.config.deviceId,
      signingKey: this.keys.signingPrivate,
      epochKey: highestEpoch(this.epochKeys),
      view: args.view,
      kind: args.kind,
      selected: args.selected,
      text: args.text,
      reason: args.reason,
      reviewedDigests: args.reviewedDigests,
      explicitApproval: args.view.content?.kind === 'approval' ? true : undefined,
    });
    await this.outbox.enqueue({
      id: newId(),
      questionId: args.view.id,
      kind: req.kind,
      path: req.path,
      bodyText: req.bodyText,
      idempotencyKey: req.idempotencyKey,
      expectedRevision: req.expectedRevision,
      selected: args.selected,
      text: args.text,
      reason: args.reason ?? '',
    });
    await this.drafts?.delete(args.view.id);
    void this.outbox.flush();
  }

  /* ---------------- attachments ---------------- */

  loadImage(view: QuestionView, d: AttachmentDescriptor): Promise<ImageResult> {
    const cached = this.images.get(d.attachment_id);
    if (cached) return cached;
    const p = this.fetchImage(view, d);
    this.images.set(d.attachment_id, p);
    p.then((r) => {
      if (!r.ok) this.images.delete(d.attachment_id); // allow retry on failure
    });
    return p;
  }

  private async fetchImage(view: QuestionView, d: AttachmentDescriptor): Promise<ImageResult> {
    try {
      const epoch = this.epochKeys.get(d.key_epoch);
      if (!epoch || !this.relay || !this.snap.config)
        return { ok: false, reason: 'error', message: 'Missing key for this attachment' };
      const cipher = await this.relay.bytes(`/attachments/${d.attachment_id}/content`);
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
      );
      const mime = sniffImageMime(plain);
      if (!mime || mime !== d.mime)
        return { ok: false, reason: 'error', message: 'The file is not the image it claims to be' };
      const blob = new Blob([plain as unknown as BlobPart], { type: mime });
      if (typeof createImageBitmap === 'function') (await createImageBitmap(blob)).close();
      return { ok: true, image: { url: URL.createObjectURL(blob), sha256: d.sha256, mime } };
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

  applyUpdate(): void {
    const w = this.swReg?.waiting;
    if (!w) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
      once: true,
    });
    w.postMessage({ type: 'SKIP_WAITING' });
  }

  /** Exposed for tests. */
  async ingestForTest(events: LedgerEvent[]) {
    await this.store?.ingestAll(events);
  }
}

export const app = new AppController();
