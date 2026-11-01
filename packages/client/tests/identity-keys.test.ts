import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type PendingPairing } from '@daintreehq/decisions-protocol';
import {
  exportPublicKey,
  generateDeviceKeys,
  generateEpochKeyBytes,
  importEpochKey,
  issueDeviceCert,
  newId,
  openEpochGrant,
} from '@daintreehq/decisions-crypto';
import {
  MemoryKeyStore,
  addEpoch,
  approveCandidate,
  localShortCode,
  revokeAndRotate,
  rotateEpoch,
} from '../src/index.js';
import { makePhone, origin, setupBridge } from './helpers.js';

async function world() {
  const env = await setupBridge();
  const keyStore = new MemoryKeyStore();
  await keyStore.save(env.identity.stored);
  const second = await makePhone(env.identity, 'tablet');
  env.relay.devices.push(second.cert);
  const revokeCall = () =>
    env.relay.calls.find(
      (c) => /\/devices\/[^/]+\/revoke$/.test(c.path) || c.path === '/api/v1/epoch/rotate',
    );
  return { ...env, keyStore, second, revokeCall };
}

describe('C: recipient certificates are verified before any key is sealed', () => {
  it('seals the new epoch only to verified devices, and the grants open on the right devices', async () => {
    const w = await world();
    const next = await revokeAndRotate(w.client, w.keyStore, newId());
    expect(next.currentEpoch).toBe(2);
    const body = w.revokeCall()!.body as {
      new_key_epoch: number;
      grants: Parameters<typeof openEpochGrant>[0]['grant'][];
    };
    expect(body.new_key_epoch).toBe(2);
    expect(body.grants.map((g) => g.device_id).sort()).toEqual(
      [w.phone.deviceId, w.second.deviceId].sort(),
    );
    for (const [dev, g] of [
      [w.phone, body.grants.find((x) => x.device_id === w.phone.deviceId)!],
      [w.second, body.grants.find((x) => x.device_id === w.second.deviceId)!],
    ] as const) {
      const opened = await openEpochGrant({
        grant: g,
        ownerSigningPublicKey: w.identity.keys.signing.publicKey,
        exchangePrivateKey: dev.keys.exchange.privateKey,
        expectedInstallationId: w.identity.config.installationId,
        expectedDeviceId: dev.deviceId,
      });
      expect(opened.epoch).toBe(2);
    }
  });

  it("refuses when the relay swapped a device's exchange key (certificate no longer verifies)", async () => {
    const w = await world();
    const attacker = await generateDeviceKeys(true);
    w.relay.devices[0] = {
      ...w.phone.cert,
      exchange_pub: await exportPublicKey(attacker.exchange.publicKey),
    };
    await expect(revokeAndRotate(w.client, w.keyStore, newId())).rejects.toThrow(
      /refusing to seal/,
    );
    expect(w.revokeCall()).toBeUndefined(); // nothing was uploaded
    await expect(rotateEpoch(w.client, w.keyStore)).rejects.toThrow(/refusing to seal/);
    expect(w.revokeCall()).toBeUndefined();
  });

  it('refuses a certificate issued by anyone but our owner key, or bound to another installation', async () => {
    const w = await world();
    const rogue = await generateDeviceKeys(true);
    const rogueId = newId();
    const forged = await issueDeviceCert({
      issuerDeviceId: w.identity.config.deviceId,
      issuerSigningKey: rogue.signing.privateKey,
      installationId: w.identity.config.installationId,
      deviceId: rogueId,
      role: 'phone',
      label: 'forged',
      signingPub: await exportPublicKey(rogue.signing.publicKey),
      exchangePub: await exportPublicKey(rogue.exchange.publicKey),
    });
    w.relay.devices.push(forged);
    await expect(revokeAndRotate(w.client, w.keyStore, newId())).rejects.toThrow(
      /refusing to seal/,
    );
    w.relay.devices.pop();
    const other = await issueDeviceCert({
      issuerDeviceId: w.identity.config.deviceId,
      issuerSigningKey: w.identity.keys.signing.privateKey,
      installationId: newId(),
      deviceId: rogueId,
      role: 'phone',
      label: 'wrong installation',
      signingPub: await exportPublicKey(rogue.signing.publicKey),
      exchangePub: await exportPublicKey(rogue.exchange.publicKey),
    });
    w.relay.devices.push(other);
    await expect(rotateEpoch(w.client, w.keyStore)).rejects.toThrow(/refusing to seal/);
    expect(w.revokeCall()).toBeUndefined();
  });

  it('approveCandidate refuses a confirmation code that does not match the candidate keys', async () => {
    const w = await world();
    const cand: PendingPairing = {
      pairing_id: newId(),
      device_id: newId(),
      label: 'Phone',
      role: 'phone',
      signing_pub: await exportPublicKey((await generateDeviceKeys(true)).signing.publicKey),
      exchange_pub: await exportPublicKey((await generateDeviceKeys(true)).exchange.publicKey),
      short_code: '000 000',
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
    expect(await localShortCode(cand)).not.toBe('000 000');
    await expect(approveCandidate(w.client, cand)).rejects.toThrow(/confirmation code/);
    expect(w.relay.calls.some((c) => c.path.includes('/approve'))).toBe(false);
  });
});

describe('C: a running listener picks up rotated epoch material', () => {
  it('after another process rotates, new answers decrypt and new questions use the new epoch', async () => {
    const env = await setupBridge();
    const keyStore = new MemoryKeyStore();
    await keyStore.save(env.identity.stored);
    const { DecisionsBridge, RelayClient, PolicyRegistry } = await import('../src/index.js');
    const client = new RelayClient({
      identity: env.identity,
      fetch: env.relay.fetch,
      sleep: async () => {},
      maxRetries: 0,
    });
    const bridge = new DecisionsBridge({
      identity: env.identity,
      keyStore,
      store: env.store,
      sink: env.sink,
      client,
      policy: new PolicyRegistry(),
      pumpIntervalMs: 0,
    });
    const r = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q?', options: [{ id: 'a', label: 'A' }] },
    });
    await bridge.pump();
    // ANOTHER process rotates the key and persists it
    const raw = generateEpochKeyBytes();
    await addEpoch(keyStore, env.identity, 2, raw);
    env.relay.push('device.key_rotated', null, null, { key_epoch: 2 });
    const epoch2 = await importEpochKey(raw, 2, false);
    await env.relay.answerEvent({
      questionId: r.questionId,
      phone: env.phone,
      options: ['a'],
      epoch: epoch2,
    });
    await bridge.catchUp();
    expect(env.sink.typed).toHaveLength(1);
    expect(bridge.ctx.identity.currentEpoch).toBe(2);
    expect(bridge.ctx.client.identity.currentEpoch).toBe(2);
    await bridge.registerQuestion({ origin: origin(), input: { question: 'next?' } });
    await bridge.pump();
    const created = env.relay.calls
      .filter((c) => c.method === 'POST' && c.path === '/api/v1/questions')
      .at(-1)!.body as { question: { record: { key_epoch: number } } };
    expect(created.question.record.key_epoch).toBe(2);
    void PROTOCOL_VERSION;
  });

  it('a rotation event alone switches new publishes to the new epoch', async () => {
    const env = await setupBridge();
    const keyStore = new MemoryKeyStore();
    await keyStore.save(env.identity.stored);
    const { DecisionsBridge, RelayClient } = await import('../src/index.js');
    const client = new RelayClient({
      identity: env.identity,
      fetch: env.relay.fetch,
      sleep: async () => {},
      maxRetries: 0,
    });
    const bridge = new DecisionsBridge({
      identity: env.identity,
      keyStore,
      store: env.store,
      sink: env.sink,
      client,
      pumpIntervalMs: 0,
    });
    await addEpoch(keyStore, env.identity, 2, generateEpochKeyBytes());
    env.relay.push('device.key_rotated', null, null, { key_epoch: 2 });
    await bridge.catchUp();
    await bridge.registerQuestion({ origin: origin(), input: { question: 'after rotation?' } });
    await bridge.pump();
    const created = env.relay.calls
      .filter((c) => c.method === 'POST' && c.path === '/api/v1/questions')
      .at(-1)!.body as { question: { record: { key_epoch: number } } };
    expect(created.question.record.key_epoch).toBe(2);
  });

  it('an answer under an unknown epoch with no rotation event triggers a reload instead of being lost', async () => {
    const env = await setupBridge();
    const keyStore = new MemoryKeyStore();
    await keyStore.save(env.identity.stored);
    const { DecisionsBridge, RelayClient } = await import('../src/index.js');
    const client = new RelayClient({
      identity: env.identity,
      fetch: env.relay.fetch,
      sleep: async () => {},
      maxRetries: 0,
    });
    const bridge = new DecisionsBridge({
      identity: env.identity,
      keyStore,
      store: env.store,
      sink: env.sink,
      client,
      pumpIntervalMs: 0,
    });
    const r = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q?', options: [{ id: 'a', label: 'A' }] },
    });
    await bridge.pump();
    const raw = generateEpochKeyBytes();
    await addEpoch(keyStore, env.identity, 2, raw);
    await env.relay.answerEvent({
      questionId: r.questionId,
      phone: env.phone,
      options: ['a'],
      epoch: await importEpochKey(raw, 2, false),
    });
    await bridge.catchUp();
    expect(env.sink.typed).toHaveLength(1);
  });
});

describe('C: outbox actions replay byte for byte', () => {
  it('a cancel the relay committed but never acknowledged is re-sent unchanged under the same key', async () => {
    const env = await setupBridge();
    const r = await env.bridge.registerQuestion({ origin: origin(), input: { question: 'q?' } });
    await env.bridge.pump();
    env.relay.dropAfterReceive = 1;
    await env.bridge.cancelQuestion(r.questionId);
    await env.bridge.pump();
    const item = (await env.store.outboxFor(r.questionId))[0]!;
    await env.store.putOutbox({ ...item, next_attempt_at: 0 });
    await env.bridge.pump();
    const sends = env.relay.calls.filter(
      (c) => c.path === `/api/v1/questions/${r.questionId}/cancel`,
    );
    expect(sends).toHaveLength(2);
    expect(JSON.stringify(sends[1]!.body)).toBe(JSON.stringify(sends[0]!.body)); // identical signed body
    expect((sends[1]!.body as { idempotency_key: string }).idempotency_key).toBe(
      (sends[0]!.body as { idempotency_key: string }).idempotency_key,
    );
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
  });

  it('the prepared body is on disk before the first send', async () => {
    const env = await setupBridge();
    const r = await env.bridge.registerQuestion({ origin: origin(), input: { question: 'q?' } });
    await env.bridge.pump();
    env.relay.down = 1000;
    await env.bridge.cancelQuestion(r.questionId);
    await env.bridge.pump();
    const item = (await env.store.outboxFor(r.questionId))[0]!;
    expect(
      (item.payload as { prepared?: { signed: unknown; idem: string } }).prepared?.signed,
    ).toBeTruthy();
  });
});
