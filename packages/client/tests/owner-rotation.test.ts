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

  it('an answer under a committed epoch the key store does not hold yet waits while a rotation could still save it', async () => {
    let clock = Date.now();
    const { identity, keyStore, relay, bridge, phone, sink, store } = await ownerWithKeyStore(
      () => clock,
    );
    const qid = await ask(bridge, 'Ship it?');
    // The relay committed epoch 2 and the phone answers under it, but this store does not hold the key yet (another
    // process is still saving its rotation, say): the answer waits, through many quick retries and through a few slow
    // ones (a laptop asleep) that take longer than the window but are too few to end the wait.
    const raw = generateEpochKeyBytes();
    relay.epoch = 2;
    const ev = await relay.answerEvent({
      questionId: qid,
      phone,
      options: ['ok'],
      epoch: await importEpochKey(raw, 2, true),
    });
    await bridge.catchUp();
    await bridge.pump();
    await bridge.pump();
    clock += 15 * 60_000;
    await bridge.pump();
    expect(sink.typed).toHaveLength(0);
    expect((await store.unprocessedEvents(10)).map((e) => e.seq)).toContain(ev.seq);
    // The key reaches the store: the next pump reloads it and delivers the answer.
    await addEpoch(keyStore, identity, 2, raw, { makeCurrent: false });
    clock += 30_000;
    await bridge.pump();
    expect(sink.typed).toHaveLength(1);
    expect((await store.getQuestion(qid))!.local_status).toBe('human-answered');
  });

  it('a key that never reaches the store is waited for a while, then the events behind it go on', async () => {
    let clock = Date.now();
    const { relay, bridge, phone, sink, store } = await ownerWithKeyStore(() => clock);
    const lost = await ask(bridge, 'Ship it?');
    const other = await ask(bridge, 'And this?');
    // Epoch 2 was erased from this store (a rotation saved from a stale copy of it): no reload brings it back, and
    // waiting for it would hold every later event forever.
    relay.epoch = 2;
    const ev = await relay.answerEvent({
      questionId: lost,
      phone,
      options: ['ok'],
      epoch: await importEpochKey(generateEpochKeyBytes(), 2, true),
    });
    await relay.answerEvent({ questionId: other, phone, options: ['ok'] });
    await bridge.catchUp();
    for (let i = 0; i < 16; i++) {
      clock += 30_000;
      await bridge.pump();
    }
    expect((await store.unprocessedEvents(10)).map((e) => e.seq)).toContain(ev.seq);
    expect(sink.typed).toHaveLength(0);
    for (let i = 0; i < 6; i++) {
      clock += 30_000;
      await bridge.pump();
    }
    expect(await store.unprocessedEvents(10)).toEqual([]);
    expect(sink.typed).toHaveLength(1);
    expect((await store.getQuestion(other))!.local_status).toBe('human-answered');
    expect((await store.getQuestion(lost))!.local_status).toBe('open');
    expect((await store.listAudit(500)).some((a) => a.event === 'event.error')).toBe(true);
  });

  it('a key store that cannot be read holds the answer however long, and it is delivered once it can', async () => {
    let clock = Date.now();
    const { identity, keyStore, relay, bridge, phone, sink, store } = await ownerWithKeyStore(
      () => clock,
    );
    const qid = await ask(bridge, 'Ship it?');
    const raw = generateEpochKeyBytes();
    await addEpoch(keyStore, identity, 2, raw, { makeCurrent: false });
    relay.epoch = 2;
    await relay.answerEvent({
      questionId: qid,
      phone,
      options: ['ok'],
      epoch: await importEpochKey(raw, 2, true),
    });
    // The store holds the key, but reading it fails (a locked keychain, say) for an hour.
    const load = keyStore.load.bind(keyStore);
    let locked = true;
    keyStore.load = async () => {
      if (locked) throw new Error('keychain locked');
      return load();
    };
    await bridge.catchUp();
    for (let i = 0; i < 12; i++) {
      clock += 5 * 60_000;
      await bridge.pump();
    }
    expect(sink.typed).toHaveLength(0);
    expect((await store.unprocessedEvents(10)).length).toBe(1);
    locked = false;
    await bridge.pump();
    expect(sink.typed).toHaveLength(1);
    expect((await store.getQuestion(qid))!.local_status).toBe('human-answered');
  });
});
