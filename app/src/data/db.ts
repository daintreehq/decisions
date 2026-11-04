import { deleteDB, openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { DeviceCert, LedgerEvent } from '@daintreehq/decisions-protocol';
import type { SealedBlob } from './seal.js';

export const DB_NAME = 'daintree-decisions';

export interface DeviceKeyRecord {
  signingPrivate: CryptoKey;
  signingPublic: string;
  exchangePrivate: CryptoKey;
  exchangePublic: string;
}

export interface ConfigRecord {
  relayOrigin: string;
  installationId: string;
  deviceId: string;
  role: 'phone' | 'tablet';
  label: string;
  ownerCert: DeviceCert;
  pairedAt: string;
}

export interface StoredEpoch {
  epoch: number;
  key: CryptoKey;
}

export interface StoredCert {
  device_id: string;
  cert: DeviceCert;
  revoked_at: string | null;
}

export interface OutboxRow {
  id: string;
  createdAt: number;
  questionId: string;
  sealed: SealedBlob;
}

export interface DraftRow {
  questionId: string;
  updatedAt: number;
  sealed: SealedBlob;
}

/**
 * Photo bytes waiting to be sent, sealed under the device's cache key: a draft's chosen photos (plaintext inside the
 * seal) and a queued answer's or follow-up's encrypted images. `owner` is the draft or outbox row they belong to, so
 * they go when it goes.
 */
export interface BlobRow {
  id: string;
  owner: string;
  createdAt: number;
  sealed: SealedBlob;
}

export type UpgradeTx = IDBPTransaction<unknown, string[], 'versionchange'>;
export type Migration = (db: IDBPDatabase<unknown>, tx: UpgradeTx) => void;

/**
 * Append-only migration list: index i upgrades the database to version i + 1. Migrations may add or reshape
 * stores but MUST NOT delete or clear `outbox` or `drafts`; unsent answers outlive every app update.
 */
export const MIGRATIONS: Migration[] = [
  (db) => {
    db.createObjectStore('kv');
    db.createObjectStore('epochKeys', { keyPath: 'epoch' });
    db.createObjectStore('events', { keyPath: 'seq' });
    db.createObjectStore('certs', { keyPath: 'device_id' });
    const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
    outbox.createIndex('byCreated', 'createdAt');
    db.createObjectStore('drafts', { keyPath: 'questionId' });
  },
  // Photos attached to drafts and to queued answers and follow-ups (sealed bytes, kept beside their rows).
  (db) => {
    const blobs = db.createObjectStore('blobs', { keyPath: 'id' });
    blobs.createIndex('byOwner', 'owner');
  },
];

export function openAppDb(name = DB_NAME, migrations: Migration[] = MIGRATIONS) {
  return openDB(name, migrations.length, {
    upgrade(db, oldVersion, newVersion, tx) {
      for (let v = oldVersion; v < (newVersion ?? migrations.length); v++) {
        migrations[v]!(db as IDBPDatabase<unknown>, tx as unknown as UpgradeTx);
      }
    },
  });
}

export interface PairingBundle {
  config: ConfigRecord;
  keys: DeviceKeyRecord;
  cacheKey: CryptoKey;
  epoch: StoredEpoch;
  certs: StoredCert[];
}

/** Typed facade over IndexedDB. Everything that is plaintext-sensitive is stored sealed or as ciphertext. */
export class Db {
  private constructor(
    readonly name: string,
    private readonly raw: IDBPDatabase<unknown>,
  ) {}

  static async open(name = DB_NAME, migrations: Migration[] = MIGRATIONS): Promise<Db> {
    return new Db(name, (await openAppDb(name, migrations)) as IDBPDatabase<unknown>);
  }

  close(): void {
    this.raw.close();
  }

  /** Delete every byte this app stored (unpair / wipe). */
  async wipe(): Promise<void> {
    this.raw.close();
    await deleteDB(this.name);
  }

  /* ----- single-record kv ----- */

  getConfig() {
    return this.raw.get('kv', 'config') as Promise<ConfigRecord | undefined>;
  }
  getKeys() {
    return this.raw.get('kv', 'deviceKeys') as Promise<DeviceKeyRecord | undefined>;
  }
  getCacheKey() {
    return this.raw.get('kv', 'cacheKey') as Promise<CryptoKey | undefined>;
  }
  async getCursor(): Promise<number> {
    return ((await this.raw.get('kv', 'cursor')) as number | undefined) ?? 0;
  }
  setCursor(seq: number) {
    return this.raw.put('kv', seq, 'cursor');
  }
  getPref<T>(key: string) {
    return this.raw.get('kv', `pref:${key}`) as Promise<T | undefined>;
  }
  setPref(key: string, value: unknown) {
    return this.raw.put('kv', value, `pref:${key}`);
  }

  /** Atomically persist everything learned during pairing; either all of it exists or none of it. */
  async savePairing(b: PairingBundle): Promise<void> {
    const tx = this.raw.transaction(['kv', 'epochKeys', 'certs'], 'readwrite');
    await Promise.all([
      tx.objectStore('kv').put(b.config, 'config'),
      tx.objectStore('kv').put(b.keys, 'deviceKeys'),
      tx.objectStore('kv').put(b.cacheKey, 'cacheKey'),
      tx.objectStore('kv').put(0, 'cursor'),
      tx.objectStore('epochKeys').put(b.epoch),
      ...b.certs.map((c) => tx.objectStore('certs').put(c)),
      tx.done,
    ]);
  }

  /* ----- epoch keys and certificates ----- */

  async epochKeys(): Promise<StoredEpoch[]> {
    return (await this.raw.getAll('epochKeys')) as StoredEpoch[];
  }
  putEpoch(e: StoredEpoch) {
    return this.raw.put('epochKeys', e);
  }
  async certs(): Promise<StoredCert[]> {
    return (await this.raw.getAll('certs')) as StoredCert[];
  }
  putCert(c: StoredCert) {
    return this.raw.put('certs', c);
  }

  /* ----- ledger cache (ciphertext as received) ----- */

  async putEvents(events: LedgerEvent[]): Promise<void> {
    const tx = this.raw.transaction('events', 'readwrite');
    await Promise.all([...events.map((e) => tx.store.put(e)), tx.done]);
  }
  async eventsAfter(seq: number): Promise<LedgerEvent[]> {
    return (await this.raw.getAll('events', IDBKeyRange.lowerBound(seq, true))) as LedgerEvent[];
  }
  async countEvents(): Promise<number> {
    return this.raw.count('events');
  }
  clearEvents() {
    return this.raw.clear('events');
  }

  /* ----- outbox and drafts (sealed) ----- */

  putOutbox(row: OutboxRow) {
    return this.raw.put('outbox', row);
  }
  deleteOutbox(id: string) {
    return this.raw.delete('outbox', id);
  }
  async outbox(): Promise<OutboxRow[]> {
    return (await this.raw.getAllFromIndex('outbox', 'byCreated')) as OutboxRow[];
  }
  putDraft(row: DraftRow) {
    return this.raw.put('drafts', row);
  }
  getDraft(questionId: string) {
    return this.raw.get('drafts', questionId) as Promise<DraftRow | undefined>;
  }
  deleteDraft(questionId: string) {
    return this.raw.delete('drafts', questionId);
  }
  async drafts(): Promise<DraftRow[]> {
    return (await this.raw.getAll('drafts')) as DraftRow[];
  }

  /* ----- photo bytes (sealed) ----- */

  putBlob(row: BlobRow) {
    return this.raw.put('blobs', row);
  }
  getBlob(id: string) {
    return this.raw.get('blobs', id) as Promise<BlobRow | undefined>;
  }
  deleteBlob(id: string) {
    return this.raw.delete('blobs', id);
  }
  /** Ids of every blob a draft or outbox row owns (no contents are read). */
  async blobIds(owner: string): Promise<string[]> {
    return (await this.raw.getAllKeysFromIndex('blobs', 'byOwner', owner)) as string[];
  }
  async deleteBlobs(owner: string): Promise<void> {
    const tx = this.raw.transaction('blobs', 'readwrite');
    const ids = (await tx.store.index('byOwner').getAllKeys(owner)) as string[];
    await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
  }
  async countBlobs(): Promise<number> {
    return this.raw.count('blobs');
  }
}
