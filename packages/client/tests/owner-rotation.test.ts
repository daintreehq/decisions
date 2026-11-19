import { describe, expect, it } from 'vitest';
import { generateEpochKeyBytes, importEpochKey } from '@daintreehq/decisions-crypto';
import {
  DecisionsBridge,
  MemoryKeyStore,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  addEpoch,
  loadIdentity,
} from '../src/index.js';
import { FakeRelay, FakeSink, makeIdentity, makePhone, origin } from './helpers.js';

/**
 * The owner desktop with a persistent key store, as `decisions mcp` runs it and Daintree will: another process
 * (`decisions revoke`, `decisions rotate`, or Daintree's own settings action) rotates the content key while
 * this bridge keeps running.
 */
async function ownerWithKeyStore(now?: () => number) {
  const identity = await makeIdentity();
  const keyStore = new MemoryKeyStore();
  await keyStore.save(identity.stored);
  const relay = new FakeRelay(identity);
  await relay.initOwner();
  const phone = await makePhone(identity);
  relay.devices.push(phone.cert);
  const sink = new FakeSink();
  sink.addPane('pane-1');
  const client = new RelayClient({
    identity,
    fetch: relay.fetch,
    sleep: async () => {},
    maxRetries: 0,
  });
  const store = new MemoryLocalStore();
  const bridge = new DecisionsBridge({
    identity,
    keyStore,
    store,
    sink,
    client,
    policy: new PolicyRegistry(),
    pumpIntervalMs: 0,
    ...(now ? { now } : {}),
  });
  return { identity, keyStore, relay, bridge, phone, sink, store };
}

async function ask(bridge: DecisionsBridge, question: string) {
  const r = await bridge.registerQuestion({
    origin: origin(),
    input: { question, options: [{ id: 'ok', label: 'OK' }] },
  });
  await bridge.pump();
  return r.questionId;
}

const epochOf = (relay: FakeRelay, qid: string) =>
  relay.questions.get(qid)!.signed.envelope.key_epoch;

describe('the owner bridge after a key rotation made by another process', () => {
  it('seals new questions under the new epoch even when the relay announces it before the rotating process makes it current', async () => {
    const { identity, keyStore, relay, bridge } = await ownerWithKeyStore();
    expect(epochOf(relay, await ask(bridge, 'Before?'))).toBe(1);

    // `revokeAndRotate` stages epoch 2 in the key store, then the relay commits the rotation and announces
    // it over the socket; the rotating process marks the epoch current only after the relay's reply.
    // The bridge reacts to the announcement in between.
    await addEpoch(keyStore, identity, 2, generateEpochKeyBytes(), { makeCurrent: false });
    relay.push('device.key_rotated', null, null, { key_epoch: 2 });
    await bridge.catchUp();

    // A newly paired phone holds only the new epoch: a question sealed under the old one is unreadable to it.
    expect(epochOf(relay, await ask(bridge, 'After?'))).toBe(2);
    // and the promotion is durable, so a restart (or a rotating process that died before saving) keeps it
    expect((await loadIdentity(keyStore)).currentEpoch).toBe(2);
  });

  it('does the same for a revocation, which announces the new epoch with device.revoked', async () => {
    const { identity, keyStore, relay, bridge } = await ownerWithKeyStore();
    const other = await makePhone(identity);
    relay.devices.push(other.cert);
    await addEpoch(keyStore, identity, 2, generateEpochKeyBytes(), { makeCurrent: false });
    relay.push('device.revoked', null, null, { device_id: other.deviceId, key_epoch: 2 });
    await bridge.catchUp();
    expect(epochOf(relay, await ask(bridge, 'After revoke?'))).toBe(2);
  });

  it('never makes current an epoch it does not hold, whatever the relay announces', async () => {
    const { keyStore, relay, bridge } = await ownerWithKeyStore();
    relay.push('device.key_rotated', null, null, { key_epoch: 7 });
    await bridge.catchUp();
    expect(epochOf(relay, await ask(bridge, 'Still?'))).toBe(1);
    expect((await loadIdentity(keyStore)).currentEpoch).toBe(1);
  });

  it('an answer under a committed epoch the key store does not hold yet waits for the key, however long', async () => {
    let clock = Date.now();
    const { identity, keyStore, relay, bridge, phone, sink, store } = await ownerWithKeyStore(
      () => clock,
    );
    const qid = await ask(bridge, 'Ship it?');
    // The relay committed epoch 2 and the phone answers under it, but this store does not hold the key yet (a
    // concurrent rotation's save overwritten by another process, say): the answer waits, far past ten minutes.
    const raw = generateEpochKeyBytes();
    relay.epoch = 2;
    const ev = await relay.answerEvent({
      questionId: qid,
      phone,
      options: ['ok'],
      epoch: await importEpochKey(raw, 2, true),
    });
    await bridge.catchUp();
    for (let i = 0; i < 40; i++) {
      clock += 30_000;
      await bridge.pump();
    }
    expect(sink.typed).toHaveLength(0);
    expect((await store.unprocessedEvents(10)).map((e) => e.seq)).toContain(ev.seq);
    // The key reaches the store: the next pump reloads it and delivers the answer.
    await addEpoch(keyStore, identity, 2, raw, { makeCurrent: false });
    clock += 30_000;
    await bridge.pump();
    expect(sink.typed).toHaveLength(1);
    expect((await store.getQuestion(qid))!.local_status).toBe('human-answered');
  });
});
