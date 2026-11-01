/**
 * Enrolling a Daintree Host as a `desktop-host` device (protocol.md section 10, integration spec section 4.2).
 *
 *   Host:  createHostRequest()      generates its own key pairs, keeps the private halves, and prints a request
 *   Owner: enrollHost()             checks the request, issues the certificate, seals the current epoch key,
 *                                   registers both with the relay, and prints the enrollment
 *   Host:  acceptHostEnrollment()   checks the enrollment against the pending request, confirms the relay
 *                                   lists it, and stores it as this machine's identity
 *
 * The request and the enrollment are compact, versioned strings (`<prefix><base64url(JSON)>`) so they can be
 * passed over Daintree's authenticated link or copied by hand. The request carries public keys only and is
 * self-signed by the Host (proof that it holds the signing key). The enrollment is signed by the owner as a
 * whole, so the relay origin and installation it names cannot be swapped. The owner identity it carries is
 * pinned on the Host; both sides print fingerprints so a human can compare them when copying by hand.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DeviceCert,
  EpochGrant,
  Id,
  IsoTime,
  LIMITS,
  PROTOCOL_VERSION,
  PublicKeyB64,
  SigB64,
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalize,
  utf8ToBytes,
} from '@daintreehq/decisions-protocol';
import {
  createEpochGrant,
  decryptRecoveryBundle,
  deserializeDeviceKeys,
  encryptRecoveryBundle,
  fingerprint,
  generateDeviceKeys,
  importExchangePublicKey,
  importSigningPublicKey,
  issueDeviceCert,
  newId,
  nowIso,
  openEpochGrant,
  serializeDeviceKeys,
  sha256Hex,
  signObject,
  verifyDeviceCert,
  verifyObject,
  verifySelfSignedCert,
  type RecoveryBundleFile,
  type SerializedDeviceKeys,
} from '@daintreehq/decisions-crypto';
import { RelayError } from './errors.js';
import {
  assertOwner,
  defaultHome,
  importIdentity,
  normalizeOrigin,
  type Identity,
  type KeyStore,
  type StoredIdentity,
} from './identity.js';
import { Mutex } from './mutex.js';
import { RelayClient } from './relay.js';

/** Serializes read-merge-write commits to one key store within this process. */
const storeLocks = new WeakMap<KeyStore, Mutex>();
function lockFor(store: KeyStore): Mutex {
  let m = storeLocks.get(store);
  if (!m) storeLocks.set(store, (m = new Mutex()));
  return m;
}

export const HOST_REQUEST_PREFIX = 'decisions-host-request.v1.';
export const HOST_ENROLLMENT_PREFIX = 'decisions-host-enrollment.v1.';
/** A request older than this is refused: run `decisions host request` again (same keys, fresh signature). */
export const HOST_REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 10 * 60 * 1000;
const MAX_ENCODED_CHARS = 64 * 1024;

/* ---------- formats ---------- */

export const HostEnrollRequest = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('host.enroll-request'),
  device_id: Id,
  label: z.string().min(1).max(LIMITS.deviceLabelChars),
  signing_pub: PublicKeyB64,
  exchange_pub: PublicKeyB64,
  created_at: IsoTime,
  /** By the Host's own signing key, over the canonical request minus `signature`. */
  signature: SigB64,
});
export type HostEnrollRequest = z.infer<typeof HostEnrollRequest>;

export const HostEnrollment = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('host.enrollment'),
  relay_origin: z.string().min(1).max(2048),
  installation_id: Id,
  /** The owner's self-signed certificate: the Host pins it. */
  owner_cert: DeviceCert,
  /** The Host's owner-issued `desktop-host` certificate. */
  cert: DeviceCert,
  /** The relay's current epoch key, sealed to the Host's exchange key. */
  grant: EpochGrant,
  issued_at: IsoTime,
  /** By the owner's signing key, over the canonical enrollment minus `signature`. */
  signature: SigB64,
});
export type HostEnrollment = z.infer<typeof HostEnrollment>;

const REQUEST_WHAT = 'Decisions Host enrollment request';
const ENROLLMENT_WHAT = 'Decisions Host enrollment response';

function encode(prefix: string, obj: unknown): string {
  return prefix + bytesToBase64Url(utf8ToBytes(canonicalize(obj)));
}

function decode<T>(text: string, prefix: string, schema: z.ZodType<T>, what: string): T {
  const s = text.replace(/\s+/g, '');
  if (s.length > MAX_ENCODED_CHARS) throw new Error(`${what} is too long`);
  if (!s.startsWith(prefix)) throw new Error(`not a ${what} (it should start with ${prefix})`);
  let obj: unknown;
  try {
    obj = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(s.slice(prefix.length))),
    );
  } catch {
    throw new Error(`${what} is corrupted: was it copied completely?`);
  }
  const r = schema.safeParse(obj);
  if (!r.success)
    throw new Error(`${what} is malformed: ${r.error.issues[0]?.message ?? 'invalid'}`);
  return r.data;
}

export const encodeHostRequest = (r: HostEnrollRequest): string => encode(HOST_REQUEST_PREFIX, r);
export const decodeHostRequest = (s: string): HostEnrollRequest =>
  decode(s, HOST_REQUEST_PREFIX, HostEnrollRequest, REQUEST_WHAT);
export const encodeHostEnrollment = (e: HostEnrollment): string =>
  encode(HOST_ENROLLMENT_PREFIX, e);
export const decodeHostEnrollment = (s: string): HostEnrollment =>
  decode(s, HOST_ENROLLMENT_PREFIX, HostEnrollment, ENROLLMENT_WHAT);

/**
 * Fingerprint of the Host's device id and both public keys (128 bits, eight groups of four hex digits). The
 * Host prints it with the request and the owner prints it before enrolling, so a human copying by hand can
 * confirm the request was not swapped on the way.
 */
export async function hostRequestCode(r: {
  device_id: string;
  signing_pub: string;
  exchange_pub: string;
}): Promise<string> {
  const hex = await sha256Hex(
    canonicalize({
      t: 'host.enroll.code',
      device_id: r.device_id,
      signing_pub: r.signing_pub,
      exchange_pub: r.exchange_pub,
    }),
  );
  return (hex.slice(0, 32).match(/.{4}/g) ?? []).join(' ');
}

/** Fingerprint of the owner's signing key, printed on both sides for comparison. */
export const ownerFingerprint = (signingPub: string): Promise<string> => fingerprint(signingPub);

/** Checks freshness, key validity and the Host's self-signature. Throws with a reason. */
export async function verifyHostRequest(r: HostEnrollRequest, now = Date.now()): Promise<void> {
  const created = Date.parse(r.created_at);
  if (now - created > HOST_REQUEST_MAX_AGE_MS) {
    throw new Error(
      'this enrollment request has expired: run `decisions host request` on the Host again',
    );
  }
  if (created - now > FUTURE_SKEW_MS) {
    throw new Error('this enrollment request is dated in the future: check both clocks');
  }
  if (r.signing_pub === r.exchange_pub)
    throw new Error('the request reuses one key for both purposes');
  const signing = await importSigningPublicKey(r.signing_pub);
  await importExchangePublicKey(r.exchange_pub);
  if (!(await verifyObject(signing, r))) {
    throw new Error('the enrollment request signature is invalid: it was altered or corrupted');
  }
}

/* ---------- Host side: pending request ---------- */

/** The Host's not-yet-enrolled keys. Secret: holds the private keys. */
export interface PendingHostRequest {
  v: 1;
  kind: 'decisions-host-pending';
  deviceId: string;
  label: string;
  keys: SerializedDeviceKeys;
  createdAt: string;
}

export interface PendingHostStore {
  load(): Promise<PendingHostRequest | null>;
  save(p: PendingHostRequest): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryPendingHostStore implements PendingHostStore {
  private v: PendingHostRequest | null = null;
  async load() {
    return this.v ? structuredClone(this.v) : null;
  }
  async save(p: PendingHostRequest) {
    this.v = structuredClone(p);
  }
  async clear() {
    this.v = null;
  }
}

/** Same protection as FileKeyStore: directory 0700, file 0600, optionally passphrase-wrapped. */
export class FilePendingHostStore implements PendingHostStore {
  constructor(
    private readonly dir: string = defaultHome(),
    private readonly passphrase?: string,
  ) {}

  private get file(): string {
    return join(this.dir, this.passphrase ? 'host-request.enc.json' : 'host-request.json');
  }

  async load(): Promise<PendingHostRequest | null> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const v = this.passphrase
      ? await decryptRecoveryBundle<PendingHostRequest>(
          JSON.parse(text) as RecoveryBundleFile,
          this.passphrase,
        )
      : (JSON.parse(text) as PendingHostRequest);
    if (v.kind !== 'decisions-host-pending')
      throw new Error(`${this.file} is not a pending Host request`);
    return v;
  }

  async save(p: PendingHostRequest): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const body = this.passphrase
      ? JSON.stringify(await encryptRecoveryBundle(p, this.passphrase))
      : JSON.stringify(p);
    const tmp = this.file + '.tmp';
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

export interface CreateHostRequestOptions {
  pending: PendingHostStore;
  /** This machine's identity store: a request is refused when it already holds an identity. */
  keyStore?: KeyStore;
  label: string;
  /** Discard any pending keys and start over with a new device id. */
  fresh?: boolean;
  now?: number;
}

/**
 * Host side. Generates the Host's signing and exchange key pairs (or reuses the pending ones), stores them
 * durably BEFORE anything is printed, and returns a request carrying only the public halves.
 */
export async function createHostRequest(o: CreateHostRequestOptions): Promise<{
  request: string;
  parsed: HostEnrollRequest;
  code: string;
  reused: boolean;
}> {
  if (o.keyStore && (await o.keyStore.load())) {
    throw new Error(
      'this machine already has a Decisions identity (owner or enrolled Host); enroll from a separate state directory',
    );
  }
  const label = o.label.trim().slice(0, LIMITS.deviceLabelChars);
  if (!label) throw new Error('a Host label is required');
  const now = o.now ?? Date.now();
  let p = o.fresh ? null : await o.pending.load();
  const reused = p !== null;
  if (p) {
    if (p.label !== label) {
      p = { ...p, label };
      await o.pending.save(p);
    }
  } else {
    p = {
      v: 1,
      kind: 'decisions-host-pending',
      deviceId: newId(now),
      label,
      keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
      createdAt: nowIso(now),
    };
    await o.pending.save(p);
  }
  const keys = await deserializeDeviceKeys(p.keys, false);
  const parsed = (await signObject(keys.signing.privateKey, {
    v: PROTOCOL_VERSION,
    type: 'host.enroll-request' as const,
    device_id: p.deviceId,
    label: p.label,
    signing_pub: p.keys.signing_public,
    exchange_pub: p.keys.exchange_public,
    created_at: nowIso(now),
  })) as HostEnrollRequest;
  return {
    request: encodeHostRequest(parsed),
    parsed,
    code: await hostRequestCode(parsed),
    reused,
  };
}

/* ---------- owner side ---------- */

/**
 * Owner side. Verifies the request, issues a `desktop-host` certificate for exactly the requested keys, seals
 * the relay's current epoch key to the Host's exchange key, registers both with the relay, and returns the
 * owner-signed enrollment for the Host.
 */
export async function enrollHost(
  client: RelayClient,
  request: string | HostEnrollRequest,
  opts: { now?: number } = {},
): Promise<{
  response: string;
  enrollment: HostEnrollment;
  deviceId: string;
  label: string;
  code: string;
}> {
  const id = client.identity;
  assertOwner(id, 'enrolling a Host');
  const r =
    typeof request === 'string' ? decodeHostRequest(request) : HostEnrollRequest.parse(request);
  await verifyHostRequest(r, opts.now ?? Date.now());
  if (
    [r.signing_pub, r.exchange_pub].some((k) => k === id.signingPub || k === id.exchangePub) ||
    r.device_id === id.config.deviceId
  ) {
    throw new Error('the requested keys already belong to this owner device');
  }

  const list = await client.devices();
  const ownerRow = list.devices.find((d) => d.device_id === id.config.deviceId);
  if (
    list.owner_device_id !== id.config.deviceId ||
    !ownerRow ||
    ownerRow.cert.role !== 'owner-desktop' ||
    ownerRow.cert.installation_id !== id.config.installationId ||
    ownerRow.cert.signing_pub !== id.signingPub ||
    !(await verifySelfSignedCert(ownerRow.cert))
  ) {
    throw new Error("the relay's owner certificate does not match this device; refusing to enroll");
  }
  for (const d of list.devices) {
    if (d.device_id === r.device_id) {
      // Never re-seal to an id the relay already holds: its revocation flag is not signed, so a lying relay
      // could present a revoked Host as active. A completed-but-lost enrollment is revoked and redone instead.
      throw new Error(
        d.revoked_at
          ? 'this Host was revoked: run `decisions host request --new` on it for a new identity'
          : `a device with this id is already registered; if an earlier enrollment of this Host completed, revoke it (decisions revoke ${d.device_id}) and run \`decisions host request --new\` on the Host`,
      );
    }
    const keys = [d.cert.signing_pub, d.cert.exchange_pub];
    if (keys.includes(r.signing_pub) || keys.includes(r.exchange_pub)) {
      throw new Error('the requested keys already belong to another device');
    }
  }

  const epoch = id.epochs.get(list.key_epoch);
  if (!epoch?.raw) {
    throw new Error(
      `this desktop does not hold the relay's current content key (epoch ${list.key_epoch})`,
    );
  }
  const grant = await createEpochGrant({
    issuerDeviceId: id.config.deviceId,
    issuerSigningKey: id.keys.signing.privateKey,
    installationId: id.config.installationId,
    recipientDeviceId: r.device_id,
    recipientExchangePub: r.exchange_pub,
    epoch: epoch.epoch,
    epochKeyRaw: epoch.raw,
  });
  const cert = await issueDeviceCert({
    issuerDeviceId: id.config.deviceId,
    issuerSigningKey: id.keys.signing.privateKey,
    installationId: id.config.installationId,
    deviceId: r.device_id,
    role: 'desktop-host',
    label: r.label,
    signingPub: r.signing_pub,
    exchangePub: r.exchange_pub,
  });
  try {
    await client.enrollHost(cert, grant);
  } catch (e) {
    // The client retries after a lost reply, and the retry finds the device registered. That is success only
    // if the relay holds exactly the certificate issued (and so the grant sent) by THIS call.
    if (!(e instanceof RelayError) || e.code !== 'invalid_state') throw e;
    const again = (await client.devices()).devices.find((d) => d.device_id === r.device_id);
    if (!again || again.revoked_at !== null || again.cert.signature !== cert.signature) throw e;
  }
  const enrollment = (await signObject(id.keys.signing.privateKey, {
    v: PROTOCOL_VERSION,
    type: 'host.enrollment' as const,
    relay_origin: id.config.relayOrigin,
    installation_id: id.config.installationId,
    owner_cert: ownerRow.cert,
    cert,
    grant,
    issued_at: nowIso(),
  })) as HostEnrollment;
  return {
    response: encodeHostEnrollment(enrollment),
    enrollment,
    deviceId: r.device_id,
    label: cert.label,
    code: await hostRequestCode(r),
  };
}

/* ---------- Host side: accept, load, refresh ---------- */

/** Verifies and opens grants against the pinned owner, returning the stored identity with them merged in. */
async function mergeHostGrants(
  stored: StoredIdentity,
  exchangePrivateKey: CryptoKey,
  ownerKey: CryptoKey,
  grants: EpochGrant[],
): Promise<StoredIdentity> {
  const host = stored.host!;
  const epochs = new Map(stored.epochs.map((e) => [e.epoch, e.raw]));
  const kept = new Map(host.grants.map((g) => [g.key_epoch, g]));
  for (const g of grants) {
    if (g.issuer_device_id !== host.ownerCert.device_id) {
      throw new Error(`epoch ${g.key_epoch} grant was not issued by the pinned owner`);
    }
    let opened;
    try {
      opened = await openEpochGrant({
        grant: g,
        ownerSigningPublicKey: ownerKey,
        exchangePrivateKey,
        expectedInstallationId: stored.config.installationId,
        expectedDeviceId: stored.config.deviceId,
        keepRaw: true,
      });
    } catch (e) {
      throw new Error(`epoch ${g.key_epoch} grant rejected: ${(e as Error).message}`);
    }
    epochs.set(g.key_epoch, bytesToBase64Url(opened.raw!));
    kept.set(g.key_epoch, g);
  }
  const sorted = [...epochs.entries()].sort((a, b) => a[0] - b[0]);
  return {
    ...stored,
    epochs: sorted.map(([epoch, raw]) => ({ epoch, raw })),
    currentEpoch: Math.max(stored.currentEpoch, ...sorted.map(([e]) => e)),
    host: { ...host, grants: [...kept.values()].sort((a, b) => a.key_epoch - b.key_epoch) },
  };
}

export interface AcceptHostEnrollmentOptions {
  response: string;
  pending: PendingHostStore;
  keyStore: KeyStore;
  fetch?: typeof fetch;
  /**
   * Confirm with a signed request that the relay lists this Host under the same owner, and pick up any epoch
   * rotated since. Default true; turn off only to accept while the relay is unreachable.
   */
  verifyWithRelay?: boolean;
}

/**
 * Host side. Checks the owner-signed enrollment against the pending request (same device id and keys), the
 * certificate and grant against the owner it names, then stores the result as this machine's identity and
 * forgets the pending request. Nothing is stored unless every check passes.
 */
export async function acceptHostEnrollment(o: AcceptHostEnrollmentOptions): Promise<Identity> {
  const e = decodeHostEnrollment(o.response);
  const alreadyAccepted = async (): Promise<Identity | null> => {
    const existing = await o.keyStore.load();
    if (!existing) return null;
    if (
      existing.role === 'desktop-host' &&
      existing.host?.cert.device_id === e.cert.device_id &&
      existing.host.ownerCert.signing_pub === e.owner_cert.signing_pub &&
      existing.config.installationId === e.installation_id
    ) {
      return importIdentity(existing); // the same enrollment, accepted before
    }
    throw new Error('this machine already has a Decisions identity; refusing to replace it');
  };
  const before = await alreadyAccepted();
  if (before) return before;
  const p = await o.pending.load();
  if (!p) {
    throw new Error(
      'there is no pending enrollment request on this machine: run `decisions host request` first',
    );
  }

  const oc = e.owner_cert;
  if (
    oc.role !== 'owner-desktop' ||
    oc.installation_id !== e.installation_id ||
    !(await verifySelfSignedCert(oc))
  ) {
    throw new Error('the owner certificate in this enrollment is not a valid owner certificate');
  }
  const ownerKey = await importSigningPublicKey(oc.signing_pub);
  if (!(await verifyObject(ownerKey, e))) {
    throw new Error('the enrollment signature is invalid: it was altered or corrupted');
  }
  const c = e.cert;
  if (c.role !== 'desktop-host') {
    throw new Error(`the enrollment certificate is for a ${c.role}, not a desktop-host`);
  }
  if (
    c.device_id !== p.deviceId ||
    c.signing_pub !== p.keys.signing_public ||
    c.exchange_pub !== p.keys.exchange_public
  ) {
    throw new Error('this enrollment was issued for a different request');
  }
  if (
    c.installation_id !== e.installation_id ||
    c.issuer_device_id !== oc.device_id ||
    !(await verifyDeviceCert(c, ownerKey))
  ) {
    throw new Error('the Host certificate was not issued by the owner named in this enrollment');
  }
  let origin: string;
  try {
    origin = normalizeOrigin(e.relay_origin);
  } catch (err) {
    throw new Error(`the enrollment names an unusable relay: ${(err as Error).message}`);
  }
  if (origin !== e.relay_origin) throw new Error('the enrollment relay origin is not canonical');

  const base: StoredIdentity = {
    v: 1,
    role: 'desktop-host',
    config: {
      relayOrigin: origin,
      installationId: e.installation_id,
      deviceId: p.deviceId,
      label: c.label,
    },
    keys: p.keys,
    epochs: [],
    currentEpoch: e.grant.key_epoch,
    host: { cert: c, ownerCert: oc, grants: [], enrolledAt: nowIso() },
  };
  const keys = await deserializeDeviceKeys(p.keys, false);
  let stored = await mergeHostGrants(base, keys.exchange.privateKey, ownerKey, [e.grant]).catch(
    (err: Error) => {
      throw new Error(`the enrollment grant is unusable: ${err.message}`);
    },
  );

  if (o.verifyWithRelay !== false) {
    const client = new RelayClient({
      identity: await importIdentity(stored),
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    let list;
    try {
      list = await client.devices();
    } catch (err) {
      if (err instanceof RelayError && err.code === 'not_authenticated') {
        throw new Error(
          'the relay does not list this Host as an active device (was the enrollment registered? are the clocks right?)',
        );
      }
      throw err;
    }
    const ownerRow = list.devices.find((d) => d.device_id === oc.device_id);
    if (list.owner_device_id !== oc.device_id || ownerRow?.cert.signing_pub !== oc.signing_pub) {
      throw new Error('the relay names a different owner than this enrollment');
    }
    const me = list.devices.find((d) => d.device_id === p.deviceId);
    if (!me || me.revoked_at !== null || me.cert.signing_pub !== c.signing_pub) {
      throw new Error('the relay does not list this Host as an active device');
    }
    if (list.key_epoch > stored.currentEpoch) {
      // Rotated between enrollment and acceptance: pick up the newer grants now.
      const { grants } = await client.keyGrants();
      stored = await mergeHostGrants(stored, keys.exchange.privateKey, ownerKey, grants);
    }
  }
  const final = stored;
  return lockFor(o.keyStore).run(async () => {
    // Re-check right before writing: never replace an identity that appeared while we were verifying.
    const raced = await alreadyAccepted();
    if (raced) return raced;
    await o.keyStore.save(final);
    await o.pending.clear();
    return importIdentity(final);
  });
}

/**
 * Host side, after a `device.key_rotated` event: fetch this Host's sealed grants, verify each against the
 * pinned owner, store the opened epoch keys, and swap the refreshed identity into the client.
 */
export async function refreshHostGrants(
  client: RelayClient,
  keyStore: KeyStore,
): Promise<Identity> {
  const id = client.identity;
  if (id.role !== 'desktop-host') throw new Error('only an enrolled Host refreshes its grants');
  const { grants } = await client.keyGrants();
  // Merge into what is stored NOW, not into the snapshot taken before the fetch: overlapping refreshes must
  // never drop an epoch another one saved, nor move the current epoch backwards.
  return lockFor(keyStore).run(async () => {
    const latest = await keyStore.load();
    if (
      !latest ||
      latest.role !== 'desktop-host' ||
      latest.config.deviceId !== id.config.deviceId ||
      latest.keys.exchange_public !== id.exchangePub ||
      latest.host?.ownerCert.signing_pub !== id.owner.signingPub
    ) {
      throw new Error('the stored Host identity changed while its grants were being refreshed');
    }
    const known = new Map(latest.host.grants.map((g) => [g.key_epoch, g.signature]));
    const fresh = grants.filter((g) => known.get(g.key_epoch) !== g.signature);
    let stored = latest;
    if (fresh.length > 0) {
      stored = await mergeHostGrants(
        latest,
        id.keys.exchange.privateKey,
        id.owner.signingKey,
        fresh,
      );
      await keyStore.save(stored);
    }
    const next = await importIdentity(stored);
    client.identity = next;
    return next;
  });
}
