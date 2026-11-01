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
import { RelayClient } from './relay.js';

export interface RelayConfig {
  relayOrigin: string;
  installationId: string;
  deviceId: string;
  label: string;
}

/** Everything secret the owner desktop holds. Daintree stores this with Electron safeStorage. */
export interface StoredIdentity {
  v: 1;
  /** `false` while a setup is staged but not yet confirmed by the relay. Absent once claimed. */
  claimed?: boolean;
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
  if (s.claimed === false) {
    throw new Error(
      'setup was interrupted before the relay confirmed it: run `decisions setup` again',
    );
  }
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

/**
 * First-time setup: generate owner keys + epoch 1, self-signed cert, claim the relay once.
 *
 * The complete identity is staged DURABLY (marked `claimed: false`) BEFORE the claim request, and reused on
 * retry. A crash or dropped connection after the relay accepted the claim therefore never strands the owner
 * keys: the next run reuses the same keys and finishes the claim instead of generating new ones.
 */
export async function claimRelay(
  opts: ClaimOptions,
): Promise<{ identity: Identity; claim: ClaimResponse }> {
  const f = opts.fetch ?? fetch;
  const origin = normalizeOrigin(opts.origin);
  const existing = await opts.store.load();
  if (existing && existing.claimed !== false) {
    throw new Error('an identity already exists in this key store; refusing to overwrite it');
  }
  let stored: StoredIdentity;
  if (existing) {
    // Resume an interrupted setup, but only for the same relay.
    if (existing.config.relayOrigin !== origin) {
      throw new Error(
        `an unfinished setup for ${existing.config.relayOrigin} exists; finish it or remove it first`,
      );
    }
    stored = existing;
  } else {
    const keys = await generateDeviceKeys(true);
    stored = {
      v: 1,
      claimed: false,
      config: {
        relayOrigin: origin,
        installationId: newId(),
        deviceId: newId(),
        label: (opts.label ?? 'Daintree').slice(0, 60),
      },
      keys: await serializeDeviceKeys(keys),
      epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
      currentEpoch: 1,
    };
    await opts.store.save(stored); // durable BEFORE the relay can possibly learn about these keys
  }
  const identity = await importIdentity(stored);
  const cert = await issueDeviceCert({
    issuerDeviceId: identity.config.deviceId,
    issuerSigningKey: identity.keys.signing.privateKey,
    installationId: identity.config.installationId,
    deviceId: identity.config.deviceId,
    role: 'owner-desktop',
    label: identity.config.label,
    signingPub: identity.signingPub,
    exchangePub: identity.exchangePub,
  });
  const finish = async (claim: ClaimResponse) => {
    const done: StoredIdentity = { ...stored, vapidPublicKey: claim.vapid_public_key };
    delete done.claimed;
    await opts.store.save(done);
    return { identity: await importIdentity(done), claim };
  };
  const res = await f(`${origin}/api/v1/setup/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      claim_secret: opts.claimSecret,
      installation_id: identity.config.installationId,
      cert,
    }),
  }).catch((e: Error) => {
    // Network trouble: the relay may or may not have accepted it. The staged identity stays for the retry.
    throw new RelayError('network_error', e.message || 'network error', 0);
  });
  const text = await res.text();
  if (res.ok) return finish(JSON.parse(text) as ClaimResponse);
  const err = RelayError.fromBody(res.status, text);
  if (err.code === 'already_claimed') {
    // Was it OUR earlier attempt that succeeded (response lost)? Prove it with a signed request.
    const client = new RelayClient({ identity, fetch: f, maxRetries: 0 });
    try {
      await client.devices();
    } catch (probe) {
      if (probe instanceof RelayError && probe.code !== 'network_error' && !probe.retryable) {
        // Definitely claimed by someone else: the staged keys are useless.
        await opts.store.clear();
        throw err;
      }
      throw probe; // unreachable right now: keep the staged identity and try again later
    }
    let vapid = '';
    try {
      vapid = (await client.pushConfig()).vapid_public_key;
    } catch {
      /* optional */
    }
    return finish({
      installation_id: identity.config.installationId,
      vapid_public_key: vapid,
      server_time: new Date().toISOString(),
    });
  }
  throw err;
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
