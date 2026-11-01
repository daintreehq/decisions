import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { verifySelfSignedCert } from '@daintreehq/decisions-crypto';
import {
  FileKeyStore,
  MemoryKeyStore,
  claimRelay,
  currentEpochKey,
  exportRecoveryKit,
  importIdentity,
  importRecoveryKit,
  loadIdentity,
  normalizeOrigin,
  verifyRecoveryKit,
} from '../src/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'decisions-id-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function claimFetch(
  captured: { body?: Record<string, unknown>; url?: string },
  status = 201,
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (!String(url).endsWith('/api/v1/setup/claim')) {
      return new Response(JSON.stringify({ code: 'not_authenticated', message: 'not our key' }), {
        status: 401,
      });
    }
    captured.url = String(url);
    captured.body = JSON.parse(String(init?.body));
    return status === 201
      ? new Response(
          JSON.stringify({
            installation_id: captured.body!.installation_id,
            vapid_public_key: 'V'.repeat(87),
            server_time: new Date().toISOString(),
          }),
          { status },
        )
      : new Response(JSON.stringify({ code: 'already_claimed', message: 'claimed' }), { status });
  }) as typeof fetch;
}

describe('claimRelay', () => {
  it('generates owner keys + epoch 1, self-signs the cert and stores everything', async () => {
    const store = new MemoryKeyStore();
    const cap: { body?: Record<string, unknown>; url?: string } = {};
    const { identity, claim } = await claimRelay({
      origin: 'https://decisions.example.workers.dev/',
      claimSecret: 'c'.repeat(32),
      label: 'Greg’s Mac',
      store,
      fetch: claimFetch(cap),
    });
    expect(cap.url).toBe('https://decisions.example.workers.dev/api/v1/setup/claim');
    const body = cap.body as {
      cert: Parameters<typeof verifySelfSignedCert>[0];
      claim_secret: string;
      protocol_version: number;
    };
    expect(body.protocol_version).toBe(1);
    expect(body.claim_secret).toBe('c'.repeat(32));
    expect(body.cert.role).toBe('owner-desktop');
    expect(await verifySelfSignedCert(body.cert)).toBe(true);
    expect(claim.vapid_public_key).toHaveLength(87);
    expect(identity.currentEpoch).toBe(1);
    expect(currentEpochKey(identity).raw).toHaveLength(32);
    // the epoch key never goes to the relay
    expect(JSON.stringify(cap.body)).not.toContain((await store.load())!.epochs[0]!.raw);
    expect((await loadIdentity(store)).config.installationId).toBe(identity.config.installationId);
  });
  it('refuses to overwrite a claimed identity; a claim someone else won leaves no stale keys behind', async () => {
    const store = new MemoryKeyStore();
    await expect(
      claimRelay({
        origin: 'https://x.example',
        claimSecret: 'c'.repeat(32),
        store,
        fetch: claimFetch({}, 409),
      }),
    ).rejects.toMatchObject({ code: 'already_claimed' });
    expect(await store.load()).toBeNull(); // proved foreign (our signed probe was refused): staged keys discarded
    await claimRelay({
      origin: 'https://x.example',
      claimSecret: 'c'.repeat(32),
      store,
      fetch: claimFetch({}),
    });
    await expect(
      claimRelay({
        origin: 'https://x.example',
        claimSecret: 'c'.repeat(32),
        store,
        fetch: claimFetch({}),
      }),
    ).rejects.toThrow(/already exists/);
  });
  it('only allows http for localhost', () => {
    expect(normalizeOrigin('http://localhost:8787/x')).toBe('http://localhost:8787');
    expect(() => normalizeOrigin('http://evil.example')).toThrow(/https/);
  });
});

describe('claim staging: owner keys are never stranded', () => {
  it('stages the identity durably BEFORE the relay can see it, and reuses it on retry', async () => {
    const store = new MemoryKeyStore();
    let stagedAtClaim: string | undefined;
    const drop: typeof fetch = (async (url: unknown) => {
      stagedAtClaim = JSON.stringify((await store.load())?.config);
      throw new TypeError(`connection dropped ${String(url)}`);
    }) as typeof fetch;
    await expect(
      claimRelay({ origin: 'https://x.example', claimSecret: 'c'.repeat(32), store, fetch: drop }),
    ).rejects.toMatchObject({ code: 'network_error' });
    const staged = (await store.load())!;
    expect(staged.claimed).toBe(false);
    expect(stagedAtClaim).toBe(JSON.stringify(staged.config)); // it was already on disk when the request went out
    const cap: { body?: Record<string, unknown> } = {};
    const { identity } = await claimRelay({
      origin: 'https://x.example',
      claimSecret: 'c'.repeat(32),
      store,
      fetch: claimFetch(cap),
    });
    expect(identity.config.deviceId).toBe(staged.config.deviceId);
    expect(identity.config.installationId).toBe(staged.config.installationId);
    expect(identity.signingPub).toBe(staged.keys.signing_public);
    expect((cap.body as { installation_id: string }).installation_id).toBe(
      staged.config.installationId,
    );
    expect((await store.load())!.claimed).toBeUndefined();
  });
  it('recovers when the relay accepted the claim but the response was lost', async () => {
    const store = new MemoryKeyStore();
    let claimed = false;
    const relay: typeof fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/api/v1/setup/claim')) {
        if (claimed)
          return new Response(JSON.stringify({ code: 'already_claimed', message: 'x' }), {
            status: 409,
          });
        claimed = true;
        throw new TypeError('response lost'); // accepted server-side, never seen by us
      }
      if (u.endsWith('/api/v1/devices'))
        return new Response(JSON.stringify({ key_epoch: 1, owner_device_id: 'x', devices: [] }));
      if (u.endsWith('/api/v1/push/config'))
        return new Response(JSON.stringify({ vapid_public_key: 'V'.repeat(87) }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    await expect(
      claimRelay({ origin: 'https://x.example', claimSecret: 'c'.repeat(32), store, fetch: relay }),
    ).rejects.toBeTruthy();
    const staged = (await store.load())!;
    const { identity } = await claimRelay({
      origin: 'https://x.example',
      claimSecret: 'c'.repeat(32),
      store,
      fetch: relay,
    });
    expect(identity.signingPub).toBe(staged.keys.signing_public); // same keys, claim finished
    expect(identity.stored.vapidPublicKey).toHaveLength(87);
    expect((await loadIdentity(store)).config.deviceId).toBe(staged.config.deviceId);
  });
  it('an unfinished setup is not usable and cannot be silently retargeted', async () => {
    const store = new MemoryKeyStore();
    const drop: typeof fetch = (async () => {
      throw new TypeError('down');
    }) as typeof fetch;
    await expect(
      claimRelay({
        origin: 'https://one.example',
        claimSecret: 'c'.repeat(32),
        store,
        fetch: drop,
      }),
    ).rejects.toBeTruthy();
    await expect(loadIdentity(store)).rejects.toThrow(/interrupted/);
    await expect(
      claimRelay({
        origin: 'https://two.example',
        claimSecret: 'c'.repeat(32),
        store,
        fetch: drop,
      }),
    ).rejects.toThrow(/unfinished setup/);
  });
});

describe('FileKeyStore', () => {
  it('writes 0700 dir / 0600 file and round-trips', async () => {
    const dir = join(tmp, 'plain');
    const store = new FileKeyStore(dir);
    const { identity } = await claimRelay({
      origin: 'https://x.example',
      claimSecret: 'c'.repeat(32),
      store,
      fetch: claimFetch({}),
    });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'identity.json')).mode & 0o777).toBe(0o600);
    expect((await loadIdentity(store)).config.deviceId).toBe(identity.config.deviceId);
  });
  it('passphrase mode never writes key material in the clear', async () => {
    const dir = join(tmp, 'enc');
    const store = new FileKeyStore(dir, 'a long passphrase here');
    const { identity } = await claimRelay({
      origin: 'https://x.example',
      claimSecret: 'c'.repeat(32),
      store,
      fetch: claimFetch({}),
    });
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(join(dir, 'identity.enc.json'), 'utf8');
    expect(text).not.toContain(identity.stored.keys.signing_private_pkcs8);
    expect((await new FileKeyStore(dir, 'a long passphrase here').load())!.config.deviceId).toBe(
      identity.config.deviceId,
    );
    await expect(new FileKeyStore(dir, 'wrong passphrase!!!!').load()).rejects.toThrow();
  });
  it('returns null when nothing is set up', async () => {
    expect(await new FileKeyStore(join(tmp, 'missing')).load()).toBeNull();
    await expect(loadIdentity(new FileKeyStore(join(tmp, 'missing')))).rejects.toThrow(
      /not set up/,
    );
  });
});

describe('recovery kit', () => {
  it('exports, verifies without installing, and restores on a fresh machine', async () => {
    const a = new MemoryKeyStore();
    const { identity } = await claimRelay({
      origin: 'https://x.example',
      claimSecret: 'c'.repeat(32),
      store: a,
      fetch: claimFetch({}),
    });
    const kit = await exportRecoveryKit(a, 'correct horse battery staple');
    expect(JSON.stringify(kit)).not.toContain(identity.stored.keys.signing_private_pkcs8);
    const v = await verifyRecoveryKit(kit, 'correct horse battery staple');
    expect(v).toMatchObject({ ok: true, deviceId: identity.config.deviceId, epochs: [1] });
    await expect(verifyRecoveryKit(kit, 'not the passphrase!!')).rejects.toThrow();
    const b = new MemoryKeyStore();
    const restored = await importRecoveryKit(b, kit, 'correct horse battery staple');
    expect(restored.signingPub).toBe(identity.signingPub);
    await expect(importRecoveryKit(b, kit, 'correct horse battery staple')).rejects.toThrow(
      /already exists/,
    );
    expect(
      (await importRecoveryKit(b, kit, 'correct horse battery staple', { overwrite: true })).config
        .deviceId,
    ).toBe(identity.config.deviceId);
  });
  it('rejects short passphrases and non-kit bundles', async () => {
    const s = new MemoryKeyStore();
    await claimRelay({
      origin: 'https://x.example',
      claimSecret: 'c'.repeat(32),
      store: s,
      fetch: claimFetch({}),
    });
    await expect(exportRecoveryKit(s, 'short')).rejects.toThrow(/12/);
    const { encryptRecoveryBundle } = await import('@daintreehq/decisions-crypto');
    const notKit = await encryptRecoveryBundle(
      { kind: 'something-else' },
      'long enough passphrase',
    );
    await expect(verifyRecoveryKit(notKit, 'long enough passphrase')).rejects.toThrow(
      /not a Decisions recovery kit/,
    );
    void importIdentity;
  });
});
