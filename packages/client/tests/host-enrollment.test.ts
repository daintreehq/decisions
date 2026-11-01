import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  utf8ToBytes,
  type DeviceCert,
  type EpochGrant,
} from '@daintreehq/decisions-protocol';
import {
  createEpochGrant,
  generateEpochKeyBytes,
  issueDeviceCert,
  newId,
  signObject,
  verifyDeviceCert,
  verifyObject,
} from '@daintreehq/decisions-crypto';
import {
  FilePendingHostStore,
  HOST_ENROLLMENT_PREFIX,
  HOST_REQUEST_PREFIX,
  MemoryKeyStore,
  MemoryPendingHostStore,
  RelayClient,
  acceptHostEnrollment,
  createHostRequest,
  createPairingInvite,
  decodeHostEnrollment,
  decodeHostRequest,
  encodeHostEnrollment,
  enrollHost,
  hostRequestCode,
  loadIdentity,
  refreshHostGrants,
  revokeAndRotate,
  rotateEpoch,
  verifiedDevices,
  verifyHostRequest,
  type Identity,
} from '../src/index.js';
import { makeIdentity } from './helpers.js';

const root = mkdtempSync(join(tmpdir(), 'decisions-host-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A small in-memory relay with just the device routes enrollment touches. Signatures are not checked here. */
class DeviceRelay {
  epoch = 1;
  rows: { cert: DeviceCert; revoked_at: string | null }[] = [];
  grants = new Map<string, EpochGrant[]>();
  calls: { method: string; path: string; body: unknown; auth: string }[] = [];
  /** Upcoming enroll-host requests that the relay commits but whose reply is lost. */
  dropEnrollReply = 0;

  constructor(readonly ownerCert: DeviceCert) {
    this.rows.push({ cert: ownerCert, revoked_at: null });
  }

  static async for(owner: Identity): Promise<DeviceRelay> {
    const cert = await issueDeviceCert({
      issuerDeviceId: owner.config.deviceId,
      issuerSigningKey: owner.keys.signing.privateKey,
      installationId: owner.config.installationId,
      deviceId: owner.config.deviceId,
      role: 'owner-desktop',
      label: owner.config.label,
      signingPub: owner.signingPub,
      exchangePub: owner.exchangePub,
    });
    return new DeviceRelay(cert);
  }

  private storeGrants(gs: EpochGrant[]) {
    for (const g of gs) this.grants.set(g.device_id, [...(this.grants.get(g.device_id) ?? []), g]);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const p = url.pathname;
    this.calls.push({ method, path: p, body, auth });
    let m: RegExpMatchArray | null;
    if (method === 'GET' && p === '/api/v1/devices') {
      return json(200, {
        key_epoch: this.epoch,
        owner_device_id: this.ownerCert.device_id,
        devices: this.rows.map((r) => ({
          device_id: r.cert.device_id,
          role: r.cert.role,
          label: r.cert.label,
          created_at: r.cert.issued_at,
          revoked_at: r.revoked_at,
          last_seen_at: null,
          last_ack_seq: 0,
          cert: r.cert,
          push_enabled: false,
        })),
      });
    }
    if (method === 'POST' && p === '/api/v1/devices/enroll-host') {
      const { cert, grant } = body as { cert: DeviceCert; grant: EpochGrant };
      if (grant.key_epoch !== this.epoch)
        return json(409, { code: 'revision_conflict', message: 'key epoch changed' });
      if (this.rows.some((r) => r.cert.device_id === cert.device_id))
        return json(409, { code: 'invalid_state', message: 'device id already registered' });
      this.rows.push({ cert, revoked_at: null });
      this.storeGrants([grant]);
      if (this.dropEnrollReply > 0) {
        this.dropEnrollReply--;
        throw new TypeError('connection reset after the relay committed');
      }
      return json(201, { device_id: cert.device_id });
    }
    if (method === 'GET' && (m = p.match(/^\/api\/v1\/devices\/([^/]+)\/key-grants$/))) {
      return json(200, { current_epoch: this.epoch, grants: this.grants.get(m[1]!) ?? [] });
    }
    if (method === 'POST' && p === '/api/v1/epoch/rotate') {
      const b = body as { new_key_epoch: number; grants: EpochGrant[] };
      this.epoch = b.new_key_epoch;
      this.storeGrants(b.grants);
      return json(200, { key_epoch: this.epoch });
    }
    if (method === 'POST' && (m = p.match(/^\/api\/v1\/devices\/([^/]+)\/revoke$/))) {
      const b = body as { new_key_epoch: number; grants: EpochGrant[] };
      this.rows.find((r) => r.cert.device_id === m![1])!.revoked_at = new Date().toISOString();
      this.epoch = b.new_key_epoch;
      this.storeGrants(b.grants);
      return json(200, { device_id: m[1], key_epoch: this.epoch });
    }
    return json(404, { code: 'not_found', message: `${method} ${p}` });
  };
}

async function world() {
  const owner = await makeIdentity();
  const ownerStore = new MemoryKeyStore();
  await ownerStore.save(owner.stored);
  const relay = await DeviceRelay.for(owner);
  const ownerClient = new RelayClient({
    identity: owner,
    fetch: relay.fetch,
    maxRetries: 2,
    sleep: async () => {},
  });
  const pending = new MemoryPendingHostStore();
  const hostStore = new MemoryKeyStore();
  return { owner, ownerStore, relay, ownerClient, pending, hostStore };
}

/** Run the Host → owner → Host round trip and return the Host's loaded identity. */
async function enrolled() {
  const w = await world();
  const req = await createHostRequest({
    pending: w.pending,
    keyStore: w.hostStore,
    label: 'Build box',
  });
  const out = await enrollHost(w.ownerClient, req.request);
  const host = await acceptHostEnrollment({
    response: out.response,
    pending: w.pending,
    keyStore: w.hostStore,
    fetch: w.relay.fetch,
  });
  return { ...w, req, out, host };
}

function payload(encoded: string, prefix: string): Record<string, unknown> {
  expect(encoded.startsWith(prefix)).toBe(true);
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded.slice(prefix.length))));
}

function reencode(prefix: string, obj: unknown): string {
  return prefix + bytesToBase64Url(utf8ToBytes(JSON.stringify(obj)));
}

describe('Host side: the enrollment request', () => {
  it('carries only public keys, is signed by the Host, and keeps the private keys in the pending store', async () => {
    const w = await world();
    const r = await createHostRequest({
      pending: w.pending,
      keyStore: w.hostStore,
      label: 'Build box',
    });
    const obj = payload(r.request, HOST_REQUEST_PREFIX);
    expect(Object.keys(obj).sort()).toEqual(
      [
        'created_at',
        'device_id',
        'exchange_pub',
        'label',
        'signature',
        'signing_pub',
        'type',
        'v',
      ].sort(),
    );
    expect(r.request).not.toMatch(/pkcs8|private/i);
    const stored = await w.pending.load();
    expect(stored!.deviceId).toBe(obj.device_id);
    expect(stored!.keys.signing_public).toBe(obj.signing_pub);
    expect(stored!.keys.exchange_public).toBe(obj.exchange_pub);
    // no private key material appears in the request, in any encoding
    expect(r.request).not.toContain(stored!.keys.signing_private_pkcs8.slice(0, 40));
    expect(JSON.stringify(obj)).not.toContain(stored!.keys.exchange_private_pkcs8.slice(0, 40));
    const decoded = decodeHostRequest(r.request);
    await expect(verifyHostRequest(decoded)).resolves.toBeUndefined();
    expect(r.code).toBe(await hostRequestCode(decoded));
    expect(r.code).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  });

  it('re-running reuses the same keys and device id (re-signed), unless a fresh request is asked for', async () => {
    const w = await world();
    const a = await createHostRequest({ pending: w.pending, keyStore: w.hostStore, label: 'Box' });
    const b = await createHostRequest({ pending: w.pending, keyStore: w.hostStore, label: 'Box' });
    expect(b.reused).toBe(true);
    expect(decodeHostRequest(b.request).device_id).toBe(decodeHostRequest(a.request).device_id);
    expect(b.code).toBe(a.code);
    const c = await createHostRequest({
      pending: w.pending,
      keyStore: w.hostStore,
      label: 'Box',
      fresh: true,
    });
    expect(c.reused).toBe(false);
    expect(decodeHostRequest(c.request).device_id).not.toBe(decodeHostRequest(a.request).device_id);
  });

  it('refuses to start when this machine already has an identity', async () => {
    const w = await world();
    await expect(
      createHostRequest({ pending: w.pending, keyStore: w.ownerStore, label: 'Box' }),
    ).rejects.toThrow(/already has a Decisions identity/);
  });

  it('decoding tolerates line wraps but rejects other formats, oversize input and unknown fields', async () => {
    const w = await world();
    const r = await createHostRequest({ pending: w.pending, keyStore: w.hostStore, label: 'Box' });
    const wrapped = r.request.replace(/(.{60})/g, '$1\n  ');
    expect(decodeHostRequest(wrapped).device_id).toBe(decodeHostRequest(r.request).device_id);
    expect(() => decodeHostRequest('hello')).toThrow(/not a Decisions Host enrollment request/);
    expect(() => decodeHostRequest(HOST_REQUEST_PREFIX + 'A'.repeat(70_000))).toThrow(/too long/);
    expect(() => decodeHostRequest(HOST_REQUEST_PREFIX + '!!!')).toThrow();
    const obj = payload(r.request, HOST_REQUEST_PREFIX);
    expect(() => decodeHostRequest(reencode(HOST_REQUEST_PREFIX, { ...obj, extra: 1 }))).toThrow();
    // a response is not a request
    expect(() => decodeHostRequest(reencode(HOST_ENROLLMENT_PREFIX, obj))).toThrow();
  });

  it('verification catches tampering, a stale request and a request from the future', async () => {
    const w = await world();
    const now = Date.parse('2026-11-01T00:00:00.000Z');
    const r = await createHostRequest({
      pending: w.pending,
      keyStore: w.hostStore,
      label: 'Box',
      now,
    });
    const obj = payload(r.request, HOST_REQUEST_PREFIX);
    const relabelled = decodeHostRequest(reencode(HOST_REQUEST_PREFIX, { ...obj, label: 'Evil' }));
    await expect(verifyHostRequest(relabelled, now)).rejects.toThrow(/signature/);
    const other = await createHostRequest({
      pending: new MemoryPendingHostStore(),
      keyStore: new MemoryKeyStore(),
      label: 'Box',
      now,
    });
    const swapped = decodeHostRequest(
      reencode(HOST_REQUEST_PREFIX, {
        ...obj,
        exchange_pub: decodeHostRequest(other.request).exchange_pub,
      }),
    );
    await expect(verifyHostRequest(swapped, now)).rejects.toThrow(/signature/);
    const d = decodeHostRequest(r.request);
    await expect(verifyHostRequest(d, now + 25 * 3600_000)).rejects.toThrow(/expired/);
    await expect(verifyHostRequest(d, now - 3600_000)).rejects.toThrow(/future/);
  });

  it('the file pending store keeps the private keys at mode 0600 and can be encrypted', async () => {
    const dir = join(root, 'pending');
    const store = new FilePendingHostStore(dir);
    await createHostRequest({ pending: store, keyStore: new MemoryKeyStore(), label: 'Box' });
    const file = join(dir, 'host-request.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await store.load())!.keys.signing_private_pkcs8).toBeTruthy();
    const enc = new FilePendingHostStore(join(root, 'pending-enc'), 'correct horse');
    await createHostRequest({ pending: enc, keyStore: new MemoryKeyStore(), label: 'Box' });
    const text = readFileSync(join(root, 'pending-enc', 'host-request.enc.json'), 'utf8');
    expect(text).not.toContain('signing_private_pkcs8');
    expect((await enc.load())!.keys.signing_private_pkcs8).toBeTruthy();
    await enc.clear();
    expect(await enc.load()).toBeNull();
  });
});

describe('owner side: checking the request and enrolling the Host', () => {
  it('issues a desktop-host certificate for exactly the requested keys and seals the current epoch to it', async () => {
    const w = await world();
    const req = await createHostRequest({
      pending: w.pending,
      keyStore: w.hostStore,
      label: 'Build box',
    });
    const out = await enrollHost(w.ownerClient, req.request);
    const call = w.relay.calls.find((c) => c.path === '/api/v1/devices/enroll-host')!;
    const { cert, grant } = call.body as { cert: DeviceCert; grant: EpochGrant };
    const r = decodeHostRequest(req.request);
    expect(cert).toMatchObject({
      role: 'desktop-host',
      device_id: r.device_id,
      label: 'Build box',
      signing_pub: r.signing_pub,
      exchange_pub: r.exchange_pub,
      installation_id: w.owner.config.installationId,
      issuer_device_id: w.owner.config.deviceId,
    });
    expect(await verifyDeviceCert(cert, w.owner.keys.signing.publicKey)).toBe(true);
    expect(grant).toMatchObject({ device_id: r.device_id, key_epoch: 1 });
    expect(out.deviceId).toBe(r.device_id);
    expect(out.code).toBe(req.code);
    // the response is the owner's signed statement of the enrollment
    const e = decodeHostEnrollment(out.response);
    expect(e.relay_origin).toBe('https://relay.test');
    expect(e.owner_cert).toEqual(w.relay.ownerCert);
    expect(await verifyObject(w.owner.keys.signing.publicKey, e)).toBe(true);
  });

  it('refuses a tampered or stale request before contacting the relay', async () => {
    const w = await world();
    const now = Date.now();
    const req = await createHostRequest({
      pending: w.pending,
      keyStore: w.hostStore,
      label: 'Box',
      now,
    });
    const obj = payload(req.request, HOST_REQUEST_PREFIX);
    await expect(
      enrollHost(w.ownerClient, reencode(HOST_REQUEST_PREFIX, { ...obj, label: 'Evil' })),
    ).rejects.toThrow(/signature/);
    await expect(
      enrollHost(w.ownerClient, req.request, { now: now + 2 * 86400_000 }),
    ).rejects.toThrow(/expired/);
    expect(w.relay.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('refuses requests that reuse the owner keys or an existing device id', async () => {
    const w = await world();
    const forged = await signObject(w.owner.keys.signing.privateKey, {
      v: 1 as const,
      type: 'host.enroll-request' as const,
      device_id: newId(),
      label: 'Mirror',
      signing_pub: w.owner.signingPub,
      exchange_pub: w.owner.exchangePub,
      created_at: new Date().toISOString(),
    });
    await expect(enrollHost(w.ownerClient, reencode(HOST_REQUEST_PREFIX, forged))).rejects.toThrow(
      /already belong/,
    );
    const dup = await signObject(w.owner.keys.signing.privateKey, {
      ...forged,
      device_id: w.owner.config.deviceId,
      signing_pub: w.owner.signingPub,
    });
    await expect(enrollHost(w.ownerClient, reencode(HOST_REQUEST_PREFIX, dup))).rejects.toThrow();
  });

  it('recovers when the relay committed the enrollment but the reply was lost', async () => {
    const w = await world();
    w.relay.dropEnrollReply = 1;
    const req = await createHostRequest({
      pending: w.pending,
      keyStore: w.hostStore,
      label: 'Box',
    });
    const out = await enrollHost(w.ownerClient, req.request);
    expect(w.relay.rows.filter((r) => r.cert.role === 'desktop-host')).toHaveLength(1);
    const host = await acceptHostEnrollment({
      response: out.response,
      pending: w.pending,
      keyStore: w.hostStore,
      fetch: w.relay.fetch,
    });
    // the Host holds the certificate the relay actually stored
    expect(host.stored.host!.cert).toEqual(w.relay.rows[1]!.cert);
  });

  it('cannot be run from an enrolled Host, and neither can the other owner-only operations', async () => {
    const e = await enrolled();
    const hostClient = new RelayClient({ identity: e.host, fetch: e.relay.fetch, maxRetries: 0 });
    const req = await createHostRequest({
      pending: new MemoryPendingHostStore(),
      keyStore: new MemoryKeyStore(),
      label: 'X',
    });
    await expect(enrollHost(hostClient, req.request)).rejects.toThrow(
      /only possible on the owner desktop/,
    );
    await expect(revokeAndRotate(hostClient, e.hostStore, e.owner.config.deviceId)).rejects.toThrow(
      /owner desktop/,
    );
    await expect(rotateEpoch(hostClient, e.hostStore)).rejects.toThrow(/owner desktop/);
    await expect(createPairingInvite(hostClient)).rejects.toThrow(/owner desktop/);
    expect(
      e.relay.calls.filter((c) => c.auth.includes(e.host.config.deviceId) && c.method === 'POST'),
    ).toHaveLength(0);
  });
});

describe('Host side: accepting the enrollment and loading it as the identity', () => {
  it('stores the certificate, pins the owner, opens the epoch grant and clears the pending request', async () => {
    const e = await enrolled();
    expect(await e.pending.load()).toBeNull();
    const id = await loadIdentity(e.hostStore);
    expect(id.role).toBe('desktop-host');
    expect(id.config).toEqual({
      relayOrigin: 'https://relay.test',
      installationId: e.owner.config.installationId,
      deviceId: e.out.deviceId,
      label: 'Build box',
    });
    expect(id.owner.deviceId).toBe(e.owner.config.deviceId);
    expect(id.owner.signingPub).toBe(e.owner.signingPub);
    expect(id.stored.host!.ownerCert).toEqual(e.relay.ownerCert);
    expect(id.stored.host!.grants.map((g) => g.key_epoch)).toEqual([1]);
    expect(id.currentEpoch).toBe(1);
    expect(id.epochs.get(1)!.raw).toEqual(e.owner.epochs.get(1)!.raw);
    // the owner desktop pins itself
    expect(e.owner.role).toBe('owner-desktop');
    expect(e.owner.owner.signingPub).toBe(e.owner.signingPub);
    // the Host verifies the device list against the pinned owner, not against itself
    const hostClient = new RelayClient({ identity: id, fetch: e.relay.fetch });
    expect((await verifiedDevices(hostClient)).map((d) => d.device_id).sort()).toEqual(
      [e.owner.config.deviceId, id.config.deviceId].sort(),
    );
  });

  it('accepting the same response twice is harmless; a different enrollment is refused', async () => {
    const e = await enrolled();
    const again = await acceptHostEnrollment({
      response: e.out.response,
      pending: e.pending,
      keyStore: e.hostStore,
      fetch: e.relay.fetch,
    });
    expect(again.config.deviceId).toBe(e.host.config.deviceId);
    const other = await enrolled();
    await expect(
      acceptHostEnrollment({
        response: other.out.response,
        pending: e.pending,
        keyStore: e.hostStore,
        fetch: e.relay.fetch,
      }),
    ).rejects.toThrow(/already enrolled|already has/);
  });

  it('refuses an enrollment issued for a different request', async () => {
    const a = await world();
    const b = await world();
    await createHostRequest({ pending: a.pending, keyStore: a.hostStore, label: 'A' });
    const rb = await createHostRequest({ pending: b.pending, keyStore: b.hostStore, label: 'B' });
    const out = await enrollHost(b.ownerClient, rb.request);
    await expect(
      acceptHostEnrollment({
        response: out.response,
        pending: a.pending,
        keyStore: a.hostStore,
        fetch: b.relay.fetch,
      }),
    ).rejects.toThrow(/different request/);
    await expect(
      acceptHostEnrollment({
        response: out.response,
        pending: new MemoryPendingHostStore(),
        keyStore: new MemoryKeyStore(),
        fetch: b.relay.fetch,
      }),
    ).rejects.toThrow(/no pending/);
    expect(await a.hostStore.load()).toBeNull();
  });

  it('refuses a response whose signed parts do not chain to the owner it names', async () => {
    const w = await world();
    const req = await createHostRequest({
      pending: w.pending,
      keyStore: w.hostStore,
      label: 'Box',
    });
    const out = await enrollHost(w.ownerClient, req.request);
    const e = decodeHostEnrollment(out.response);
    const reject = async (resp: string, re: RegExp) =>
      expect(
        acceptHostEnrollment({
          response: resp,
          pending: w.pending,
          keyStore: w.hostStore,
          fetch: w.relay.fetch,
        }),
      ).rejects.toThrow(re);
    // relay origin swapped after signing
    await reject(
      reencode(HOST_ENROLLMENT_PREFIX, { ...e, relay_origin: 'https://evil.example' }),
      /signature/,
    );
    // a re-signed response whose certificate was issued by someone other than the named owner
    const mallory = await makeIdentity();
    const malloryCert = await issueDeviceCert({
      issuerDeviceId: mallory.config.deviceId,
      issuerSigningKey: mallory.keys.signing.privateKey,
      installationId: e.installation_id,
      deviceId: e.cert.device_id,
      role: 'desktop-host',
      label: 'Box',
      signingPub: e.cert.signing_pub,
      exchangePub: e.cert.exchange_pub,
    });
    const { signature: _s, ...unsigned } = e;
    void _s;
    await reject(
      encodeHostEnrollment(
        await signObject(w.owner.keys.signing.privateKey, { ...unsigned, cert: malloryCert }),
      ),
      /certificate/,
    );
    // a grant sealed to another device
    const g = await createEpochGrant({
      issuerDeviceId: w.owner.config.deviceId,
      issuerSigningKey: w.owner.keys.signing.privateKey,
      installationId: e.installation_id,
      recipientDeviceId: newId(),
      recipientExchangePub: e.cert.exchange_pub,
      epoch: 1,
      epochKeyRaw: generateEpochKeyBytes(),
    });
    await reject(
      encodeHostEnrollment(
        await signObject(w.owner.keys.signing.privateKey, { ...unsigned, grant: g }),
      ),
      /grant/,
    );
    // a certificate for a different role
    const phoneCert = await issueDeviceCert({
      issuerDeviceId: w.owner.config.deviceId,
      issuerSigningKey: w.owner.keys.signing.privateKey,
      installationId: e.installation_id,
      deviceId: e.cert.device_id,
      role: 'phone',
      label: 'Box',
      signingPub: e.cert.signing_pub,
      exchangePub: e.cert.exchange_pub,
    });
    await reject(
      encodeHostEnrollment(
        await signObject(w.owner.keys.signing.privateKey, { ...unsigned, cert: phoneCert }),
      ),
      /desktop-host/,
    );
    expect(await w.hostStore.load()).toBeNull();
    expect(await w.pending.load()).not.toBeNull(); // still there for a correct response
  });

  it('refuses when the relay does not know the Host or names a different owner', async () => {
    const w = await world();
    const req = await createHostRequest({
      pending: w.pending,
      keyStore: w.hostStore,
      label: 'Box',
    });
    const out = await enrollHost(w.ownerClient, req.request);
    // the relay lost (or never had) the device
    w.relay.rows = w.relay.rows.filter((r) => r.cert.role !== 'desktop-host');
    await expect(
      acceptHostEnrollment({
        response: out.response,
        pending: w.pending,
        keyStore: w.hostStore,
        fetch: w.relay.fetch,
      }),
    ).rejects.toThrow(/relay does not list this Host/);
    expect(await w.hostStore.load()).toBeNull();
    // offline acceptance is possible when explicitly asked for
    const id = await acceptHostEnrollment({
      response: out.response,
      pending: w.pending,
      keyStore: w.hostStore,
      verifyWithRelay: false,
    });
    expect(id.role).toBe('desktop-host');
  });
});

describe('after enrollment: rotation and revocation use the normal owner operations', () => {
  it('a rotation seals the new epoch to the Host, which picks it up from its grants', async () => {
    const e = await enrolled();
    const owner2 = await rotateEpoch(e.ownerClient, e.ownerStore);
    expect(owner2.currentEpoch).toBe(2);
    const hostClient = new RelayClient({ identity: e.host, fetch: e.relay.fetch });
    const refreshed = await refreshHostGrants(hostClient, e.hostStore);
    expect(refreshed.currentEpoch).toBe(2);
    expect(refreshed.epochs.get(2)!.raw).toEqual(owner2.epochs.get(2)!.raw);
    expect((await loadIdentity(e.hostStore)).stored.host!.grants.map((g) => g.key_epoch)).toEqual([
      1, 2,
    ]);
    expect(hostClient.identity.currentEpoch).toBe(2);
  });

  it('refreshing refuses grants that are not signed by the pinned owner', async () => {
    const e = await enrolled();
    const mallory = await makeIdentity();
    e.relay.grants.set(e.host.config.deviceId, [
      ...(e.relay.grants.get(e.host.config.deviceId) ?? []),
      await createEpochGrant({
        issuerDeviceId: e.owner.config.deviceId,
        issuerSigningKey: mallory.keys.signing.privateKey,
        installationId: e.owner.config.installationId,
        recipientDeviceId: e.host.config.deviceId,
        recipientExchangePub: e.host.exchangePub,
        epoch: 2,
        epochKeyRaw: generateEpochKeyBytes(),
      }),
    ]);
    e.relay.epoch = 2;
    const hostClient = new RelayClient({ identity: e.host, fetch: e.relay.fetch });
    await expect(refreshHostGrants(hostClient, e.hostStore)).rejects.toThrow(/signature/);
    expect((await loadIdentity(e.hostStore)).currentEpoch).toBe(1);
  });

  it('revoking the Host rotates the key without sealing it to the Host', async () => {
    const e = await enrolled();
    const next = await revokeAndRotate(e.ownerClient, e.ownerStore, e.host.config.deviceId);
    expect(next.currentEpoch).toBe(2);
    const call = e.relay.calls.find((c) => c.path.endsWith('/revoke'))!;
    expect((call.body as { grants: EpochGrant[] }).grants.map((g) => g.device_id)).not.toContain(
      e.host.config.deviceId,
    );
  });
});
