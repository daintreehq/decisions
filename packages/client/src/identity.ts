import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PROTOCOL_VERSION,
  base64UrlToBytes,
  bytesToBase64Url,
  type ClaimResponse,
} from '@daintree/decisions-protocol';
import {
  decryptRecoveryBundle,
  deserializeDeviceKeys,
  encryptRecoveryBundle,
  exportPublicKey,
  generateDeviceKeys,
  generateEpochKeyBytes,
  importEpochKey,
  issueDeviceCert,
  newId,
  serializeDeviceKeys,
  signString,
  verifyString,
  type DeviceKeys,
  type EpochKey,
  type RecoveryBundleFile,
  type SerializedDeviceKeys,
} from '@daintree/decisions-crypto';
import { RelayError } from './errors.js';

export interface RelayConfig {
  relayOrigin: string;
  installationId: string;
  deviceId: string;
  label: string;
}

/** Everything secret the owner desktop holds. Daintree stores this with Electron safeStorage. */
export interface StoredIdentity {
  v: 1;
  config: RelayConfig;
  keys: SerializedDeviceKeys;
  /** All epoch keys ever issued, raw base64url; old epochs stay so history remains readable. */
  epochs: { epoch: number; raw: string }[];
  currentEpoch: number;
  vapidPublicKey?: string;
}

export interface KeyStore {
  load(): Promise<StoredIdentity | null>;
  save(identity: StoredIdentity): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryKeyStore implements KeyStore {
  private v: StoredIdentity | null = null;
  async load() {
    return this.v ? structuredClone(this.v) : null;
  }
  async save(i: StoredIdentity) {
    this.v = structuredClone(i);
  }
  async clear() {
    this.v = null;
  }
}

export function defaultHome(): string {
  return process.env.DECISIONS_HOME || join(homedir(), '.decisions');
}

/**
 * File-backed key store: directory 0700, files 0600. With a passphrase the identity is wrapped with the
 * recovery-bundle scheme (PBKDF2 + AES-GCM) instead of being stored in the clear.
 */
export class FileKeyStore implements KeyStore {
  constructor(
    private readonly dir: string = defaultHome(),
    private readonly passphrase?: string,
  ) {}

  private get file(): string {
    return join(this.dir, this.passphrase ? 'identity.enc.json' : 'identity.json');
  }

  async load(): Promise<StoredIdentity | null> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    if (this.passphrase) {
      return decryptRecoveryBundle<StoredIdentity>(
        JSON.parse(text) as RecoveryBundleFile,
        this.passphrase,
      );
    }
    return JSON.parse(text) as StoredIdentity;
  }

  async save(identity: StoredIdentity): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const body = this.passphrase
      ? JSON.stringify(await encryptRecoveryBundle(identity, this.passphrase))
      : JSON.stringify(identity);
    const tmp = this.file + '.tmp';
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }

  get directory(): string {
    return dirname(this.file);
  }
}

/** Live, imported form of a StoredIdentity. */
export interface Identity {
  config: RelayConfig;
  keys: DeviceKeys;
  signingPub: string;
  exchangePub: string;
  epochs: Map<number, EpochKey>;
  currentEpoch: number;
  stored: StoredIdentity;
}

export async function importIdentity(stored: StoredIdentity): Promise<Identity> {
  const keys = await deserializeDeviceKeys(stored.keys, true);
  const epochs = new Map<number, EpochKey>();
  for (const e of stored.epochs)
    epochs.set(e.epoch, await importEpochKey(base64UrlToBytes(e.raw), e.epoch, true));
  return {
    config: stored.config,
    keys,
    signingPub: stored.keys.signing_public,
    exchangePub: stored.keys.exchange_public,
    epochs,
    currentEpoch: stored.currentEpoch,
    stored,
  };
}

export async function loadIdentity(store: KeyStore): Promise<Identity> {
  const s = await store.load();
  if (!s)
    throw new Error(
      'not set up: run `decisions setup` (or claim the relay from Daintree settings)',
    );
  return importIdentity(s);
}

export function currentEpochKey(id: Identity): EpochKey {
  const k = id.epochs.get(id.currentEpoch);
  if (!k) throw new Error('missing current epoch key');
  return k;
}

export async function addEpoch(
  store: KeyStore,
  id: Identity,
  epoch: number,
  raw: Uint8Array,
  opts: { makeCurrent?: boolean } = {},
): Promise<Identity> {
  const stored: StoredIdentity = {
    ...id.stored,
    epochs: [
      ...id.stored.epochs.filter((e) => e.epoch !== epoch),
      { epoch, raw: bytesToBase64Url(raw) },
    ],
    currentEpoch: opts.makeCurrent === false ? id.currentEpoch : Math.max(id.currentEpoch, epoch),
  };
  await store.save(stored);
  return importIdentity(stored);
}

export function normalizeOrigin(url: string): string {
  const u = new URL(url);
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
  ) {
    throw new Error('relay origin must be https (http is only allowed for localhost development)');
  }
  return u.origin;
}

export interface ClaimOptions {
  origin: string;
  claimSecret: string;
  label?: string;
  store: KeyStore;
  fetch?: typeof fetch;
}

/** First-time setup: generate owner keys + epoch 1, self-signed cert, claim the relay once. */
export async function claimRelay(
  opts: ClaimOptions,
): Promise<{ identity: Identity; claim: ClaimResponse }> {
  const f = opts.fetch ?? fetch;
  const origin = normalizeOrigin(opts.origin);
  if ((await opts.store.load()) !== null) {
    throw new Error('an identity already exists in this key store; refusing to overwrite it');
  }
  const keys = await generateDeviceKeys(true);
  const installationId = newId();
  const deviceId = newId();
  const label = (opts.label ?? 'Daintree').slice(0, 60);
  const signingPub = await exportPublicKey(keys.signing.publicKey);
  const exchangePub = await exportPublicKey(keys.exchange.publicKey);
  const cert = await issueDeviceCert({
    issuerDeviceId: deviceId,
    issuerSigningKey: keys.signing.privateKey,
    installationId,
    deviceId,
    role: 'owner-desktop',
    label,
    signingPub,
    exchangePub,
  });
  const res = await f(`${origin}/api/v1/setup/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      claim_secret: opts.claimSecret,
      installation_id: installationId,
      cert,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw RelayError.fromBody(res.status, text);
  const claim = JSON.parse(text) as ClaimResponse;
  const raw = generateEpochKeyBytes();
  const stored: StoredIdentity = {
    v: 1,
    config: { relayOrigin: origin, installationId, deviceId, label },
    keys: await serializeDeviceKeys(keys),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(raw) }],
    currentEpoch: 1,
    vapidPublicKey: claim.vapid_public_key,
  };
  // The relay is claimed at this point; persist immediately so the keys cannot be lost.
  await opts.store.save(stored);
  return { identity: await importIdentity(stored), claim };
}

/* ---------- recovery kit ---------- */

export async function exportRecoveryKit(
  store: KeyStore,
  passphrase: string,
): Promise<RecoveryBundleFile> {
  const s = await store.load();
  if (!s) throw new Error('nothing to export: not set up');
  return encryptRecoveryBundle({ kind: 'decisions-recovery-kit', identity: s }, passphrase);
}

export async function importRecoveryKit(
  store: KeyStore,
  file: RecoveryBundleFile,
  passphrase: string,
  opts: { overwrite?: boolean } = {},
): Promise<Identity> {
  const body = await decryptRecoveryBundle<{ kind: string; identity: StoredIdentity }>(
    file,
    passphrase,
  );
  if (body.kind !== 'decisions-recovery-kit') throw new Error('not a Decisions recovery kit');
  if (!opts.overwrite && (await store.load()))
    throw new Error('an identity already exists; pass overwrite to replace it');
  await store.save(body.identity);
  return importIdentity(body.identity);
}

/** Decrypts a kit and proves the contained keys actually work, without installing anything. */
export async function verifyRecoveryKit(
  file: RecoveryBundleFile,
  passphrase: string,
): Promise<{ ok: true; installationId: string; deviceId: string; epochs: number[] }> {
  const body = await decryptRecoveryBundle<{ kind: string; identity: StoredIdentity }>(
    file,
    passphrase,
  );
  if (body.kind !== 'decisions-recovery-kit') throw new Error('not a Decisions recovery kit');
  const id = await importIdentity(body.identity);
  const probe = `verify:${newId()}`;
  const sig = await signString(id.keys.signing.privateKey, probe);
  if (!(await verifyString(id.keys.signing.publicKey, probe, sig)))
    throw new Error('recovery kit signing key is broken');
  if (!id.epochs.get(id.currentEpoch)) throw new Error('recovery kit lacks the current epoch key');
  return {
    ok: true,
    installationId: id.config.installationId,
    deviceId: id.config.deviceId,
    epochs: [...id.epochs.keys()],
  };
}
