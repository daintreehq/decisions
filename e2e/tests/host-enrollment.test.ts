import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptEnvelope, encryptEnvelope, newId } from '@daintreehq/decisions-crypto';
import {
  FileKeyStore,
  RelayClient,
  RelayError,
  loadIdentity,
  refreshHostGrants,
} from '@daintreehq/decisions-client';
// The CLI has no library entry point: drive its commands directly, the way its own tests do.
import { hostAccept, hostEnroll, hostRequest } from '../../packages/cli/src/commands/host.js';
import { devices, revoke, rotate, setup } from '../../packages/cli/src/commands/setup.js';
import type { Ctx } from '../../packages/cli/src/runtime.js';
import { CLAIM_SECRET, ROOT, startRelay, type RunningRelay } from './harness.js';

const PORT = 8803;
const built = existsSync(join(ROOT, 'app/dist/index.html'));

function cli(home: string, env: Record<string, string> = {}) {
  const out: string[] = [];
  const ctx: Ctx = {
    home,
    json: true,
    fetch: globalThis.fetch,
    out: (l) => void out.push(l),
    err: () => {},
    prompt: async () => 'y',
    env,
    now: Date.now,
    readStdin: async () => '',
  };
  /** The JSON printed by the last command. */
  const last = () => {
    const v = JSON.parse(out.join('\n'));
    out.length = 0;
    return v;
  };
  return { ctx, last };
}

// Needs the built PWA (wrangler serves it as assets): skipped in the unit-test job, run in the e2e job.
describe.skipIf(!built)('Host enrollment against the real Worker, driven through the CLI', () => {
  let relay: RunningRelay;
  const tmp = mkdtempSync(join(tmpdir(), 'decisions-e2e-host-'));
  const owner = cli(join(tmp, 'owner'), { DECISIONS_CLAIM_SECRET: CLAIM_SECRET });
  const host = cli(join(tmp, 'host'));

  beforeAll(async () => {
    relay = await startRelay(PORT);
  });
  afterAll(async () => {
    await relay?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('enrolls a Host, which then works as its own device until it is revoked', async () => {
    await setup(owner.ctx, {}, { url: relay.origin, label: 'Owner Mac' });
    owner.last();

    // Host: keys and a request. Owner: enroll. Host: accept.
    await hostRequest(host.ctx, {}, { label: 'Build box' });
    const req = host.last();
    await hostEnroll(owner.ctx, {}, { request: req.request });
    const enrolled = owner.last();
    expect(enrolled).toMatchObject({
      device_id: req.device_id,
      label: 'Build box',
      code: req.code,
    });
    await hostAccept(host.ctx, {}, { response: enrolled.response });
    const accepted = host.last();
    expect(accepted).toMatchObject({
      role: 'desktop-host',
      device_id: req.device_id,
      relay: relay.origin,
      owner_fingerprint: enrolled.owner_fingerprint,
      key_epoch: 1,
    });

    // The Host loads it as its identity and authenticates as itself.
    const ownerId = await loadIdentity(new FileKeyStore(owner.ctx.home));
    const hostStore = new FileKeyStore(host.ctx.home);
    const hostId = await loadIdentity(hostStore);
    expect(hostId.role).toBe('desktop-host');
    expect(hostId.owner.signingPub).toBe(ownerId.signingPub);
    expect(accepted.owner_device_id).toBe(ownerId.config.deviceId);
    await devices(host.ctx, {});
    const seen = host.last().devices.map((d: { device_id: string; role: string }) => d.role);
    expect(seen.sort()).toEqual(['desktop-host', 'owner-desktop']);

    // Content the owner encrypts under the current epoch is readable on the Host.
    const env = await encryptEnvelope({
      epochKey: ownerId.epochs.get(1)!,
      installationId: ownerId.config.installationId,
      questionId: newId(),
      recordId: newId(),
      recordType: 'question',
      revision: 0,
      senderDeviceId: ownerId.config.deviceId,
      purpose: 'question-content',
      plaintext: { q: 'hello host' },
    });
    expect(await decryptEnvelope(env, hostId.epochs)).toEqual({ q: 'hello host' });

    // A rotation seals the new key to the Host, which fetches it with its own signed request.
    await rotate(owner.ctx, {});
    expect(owner.last().key_epoch).toBe(2);
    const hostClient = new RelayClient({ identity: hostId, maxRetries: 0 });
    const refreshed = await refreshHostGrants(hostClient, hostStore);
    expect(refreshed.currentEpoch).toBe(2);
    const ownerNow = await loadIdentity(new FileKeyStore(owner.ctx.home));
    expect(refreshed.epochs.get(2)!.raw).toEqual(ownerNow.epochs.get(2)!.raw);

    // Revoking it is the normal device revoke: locked out at once, and the next key is not sealed to it.
    await revoke(owner.ctx, {}, req.device_id, { yes: true });
    expect(owner.last().key_epoch).toBe(3);
    const denied = await hostClient.keyGrants().catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(RelayError);
    expect((denied as RelayError).code).toBe('not_authenticated');
    await devices(owner.ctx, {});
    const list = owner.last().devices as { device_id: string; revoked_at: string | null }[];
    expect(list.find((d) => d.device_id === req.device_id)!.revoked_at).toBeTruthy();

    // The same request cannot be enrolled again: the revoked id stays registered.
    await expect(hostEnroll(owner.ctx, {}, { request: req.request })).rejects.toThrow(/revoked/);
  });
});
