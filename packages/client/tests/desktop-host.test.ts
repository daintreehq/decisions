import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from '@daintreehq/decisions-protocol';
import {
  buildSignedAction,
  generateEpochKeyBytes,
  importEpochKey,
  issueDeviceCert,
  newId,
} from '@daintreehq/decisions-crypto';
import {
  BridgeError,
  DecisionsBridge,
  MemoryKeyStore,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  createPairingInvite,
  revokeAndRotate,
  rotateEpoch,
  type Identity,
  type LocalStore,
  type ProxyEngine,
} from '../src/index.js';
import {
  FakeRelay,
  FakeSink,
  makeHost,
  makeIdentity,
  makePhone,
  origin,
  sealEpochTo,
  type Host,
  type Phone,
} from './helpers.js';

const OPTIONS = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];

function bridgeFor(
  identity: Identity,
  relay: FakeRelay,
  extra: { keyStore?: MemoryKeyStore; proxy?: ProxyEngine } = {},
) {
  // Proxy-capable levels are allowlisted here so tests can exercise them without a gate.
  const policy = new PolicyRegistry({ proxyAllowlisted: true });
  const sink = new FakeSink();
  sink.addPane('pane-1');
  const store = new MemoryLocalStore();
  const client = new RelayClient({
    identity,
    fetch: relay.fetch,
    sleep: async () => {},
    maxRetries: 0,
  });
  const bridge = new DecisionsBridge({
    identity,
    store,
    sink,
    client,
    policy,
    pumpIntervalMs: 0,
    ...(extra.keyStore ? { keyStore: extra.keyStore } : {}),
    ...(extra.proxy ? { proxy: extra.proxy } : {}),
  });
  return { sink, store, client, bridge };
}

/** An owner, its phone, and an enrolled Host running the bridge, all on one relay. */
async function hostWorld(extra: { proxy?: ProxyEngine } = {}) {
  const owner = await makeIdentity();
  const relay = new FakeRelay(owner);
  await relay.initOwner();
  const phone = await makePhone(owner);
  relay.devices.push(phone.cert);
  const host = await makeHost(owner, relay);
  const b = bridgeFor(host.identity, relay, { keyStore: host.keyStore, ...extra });
  return { owner, relay, phone, host, ...b };
}

async function ask(
  bridge: DecisionsBridge,
  input: Record<string, unknown> = {},
  hostId = 'host-remote',
): Promise<string> {
  const r = await bridge.registerQuestion({
    origin: origin({ host_id: hostId }),
    input: { question: 'Ship it?', options: OPTIONS, ...input },
  });
  await bridge.pump();
  return r.questionId;
}

const rejections = async (store: LocalStore) =>
  (await store.listAudit(200)).filter((a) => a.event === 'event.rejected').map((a) => a.result);

/** Requests a device made, by the device id in its signed Authorization header. */
const callsBy = (relay: FakeRelay, deviceId: string) =>
  relay.calls.filter((c) => (c.headers.authorization ?? '').includes(`d=${deviceId},`));

/** The owner rotates to a new epoch and seals it to `to` (not yet announced in the ledger). */
async function rotate(owner: Identity, relay: FakeRelay, to: Host, epoch = relay.epoch + 1) {
  const raw = generateEpochKeyBytes();
  const grant = await sealEpochTo(
    owner,
    { deviceId: to.identity.config.deviceId, exchangePub: to.identity.exchangePub },
    epoch,
    raw,
  );
  relay.grants.set(to.identity.config.deviceId, [
    ...(relay.grants.get(to.identity.config.deviceId) ?? []),
    grant,
  ]);
  relay.epoch = epoch;
  return { epoch, raw, key: await importEpochKey(raw, epoch, true) };
}

const keyRotated = (relay: FakeRelay, epoch: number): LedgerEvent =>
  relay.push('device.key_rotated', null, null, { key_epoch: epoch });

describe('a desktop-host bridge verifies certificates against the owner pinned at enrollment', () => {
  it('delivers a phone answer to its own question, the phone chaining to the pinned owner', async () => {
    const { relay, phone, host, bridge, sink } = await hostWorld();
    const qid = await ask(bridge);
    // The question is the Host's: created and signed by it, readable by the owner's devices.
    const created = relay.questions.get(qid)!.signed.record;
    expect(created.originating_device_id).toBe(host.identity.config.deviceId);
    expect(created.signer_device_id).toBe(host.identity.config.deviceId);
    expect((await relay.decryptQuestion(qid)).question).toBe('Ship it?');

    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.text).toContain('choice: approve');
    expect(sink.typed[0]!.text).toContain('source: human');
    const acks = callsBy(relay, host.identity.config.deviceId).map((c) => c.path);
    expect(acks).toContain('/api/v1/deliveries/received');
    expect(acks).toContain('/api/v1/deliveries/terminal');
    expect((await bridge.getDecision(qid)).status).toBe('human-answered');
  });

  it('rejects a device certificate the Host issued itself', async () => {
    const { relay, host, bridge, sink, store } = await hostWorld();
    const qid = await ask(bridge);
    // A "phone" whose certificate is signed by the Host's key: only the owner may introduce devices.
    const rogue = await makePhone(host.identity);
    relay.devices.push(rogue.cert);
    await relay.answerEvent({ questionId: qid, phone: rogue, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect(await rejections(store)).toContain('unknown-signer');
  });

  it('rejects devices chaining to another owner key, even when the relay swaps the owner certificate', async () => {
    const { relay, owner, bridge, sink, store } = await hostWorld();
    const qid = await ask(bridge);
    // An impostor owner with the real owner's ids but its own key, and a phone it certified.
    const impostor = await makeIdentity();
    const fake: Identity = {
      ...impostor,
      config: {
        ...impostor.config,
        deviceId: owner.config.deviceId,
        installationId: owner.config.installationId,
      },
    };
    relay.ownerCertCache = await issueDeviceCert({
      issuerDeviceId: owner.config.deviceId,
      issuerSigningKey: impostor.keys.signing.privateKey,
      installationId: owner.config.installationId,
      deviceId: owner.config.deviceId,
      role: 'owner-desktop',
      label: 'Impostor',
      signingPub: impostor.signingPub,
      exchangePub: impostor.exchangePub,
    });
    const rogue = await makePhone(fake);
    relay.devices.push(rogue.cert);
    await relay.answerEvent({ questionId: qid, phone: rogue, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect(await rejections(store)).toContain('unknown-signer');
  });

  it('accepts exactly one owner-desktop: the pinned one', async () => {
    const { relay, owner, bridge, sink, store } = await hostWorld();
    const qid = await ask(bridge, { requested_requirement: 'proxy-ok' });
    // Even a certificate the owner key signed cannot make a second owner-desktop.
    const second = await makePhone(owner, 'owner-desktop');
    relay.devices.push(second.cert);
    await relay.answerEvent({
      questionId: qid,
      phone: second,
      action: 'proxy-answer',
      options: ['approve'],
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect(await rejections(store)).toContain('unknown-signer');
  });

  it('accepts cancels the pinned owner signs for a Host question', async () => {
    const { relay, owner, bridge, store } = await hostWorld();
    const qid = await ask(bridge);
    await relay.plainActionEvent({
      questionId: qid,
      signer: { deviceId: owner.config.deviceId, keys: owner.keys },
      action: 'cancel',
    });
    await bridge.catchUp();
    expect((await store.getQuestion(qid))!.local_status).toBe('cancelled');
  });
});

describe('a desktop-host bridge after a key rotation', () => {
  it('fetches its sealed grant on device.key_rotated and keeps decrypting, for old and new questions', async () => {
    const { relay, owner, phone, host, bridge, sink } = await hostWorld();
    const before = await ask(bridge);
    const r = await rotate(owner, relay, host);
    keyRotated(relay, r.epoch);
    await bridge.catchUp();
    expect(bridge.ctx.identity.currentEpoch).toBe(2);
    expect((await host.keyStore.load())!.epochs.map((e) => e.epoch)).toEqual([1, 2]);

    // The phone answers the earlier question under the new key: decrypted and delivered.
    await relay.answerEvent({ questionId: before, phone, options: ['approve'], epoch: r.key });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);

    // A question asked now is sealed under the new epoch, and its answer is delivered too.
    const after = await ask(bridge, { question: 'And this?' });
    expect(relay.questions.get(after)!.signed.envelope.key_epoch).toBe(2);
    await relay.answerEvent({ questionId: after, phone, options: ['reject'], epoch: r.key });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(2);
    expect(sink.typed[1]!.text).toContain('choice: reject');
  });

  it('picks up a rotation it never saw announced when an answer arrives under the unknown epoch', async () => {
    const { relay, owner, phone, host, bridge, sink } = await hostWorld();
    const qid = await ask(bridge);
    const r = await rotate(owner, relay, host);
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'], epoch: r.key });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(bridge.ctx.identity.epochs.has(2)).toBe(true);
  });

  it('works without a persistent key store: the epochs it fetches live in memory', async () => {
    const owner = await makeIdentity();
    const relay = new FakeRelay(owner);
    await relay.initOwner();
    const phone = await makePhone(owner);
    relay.devices.push(phone.cert);
    const host = await makeHost(owner, relay);
    const { bridge, sink } = bridgeFor(host.identity, relay);
    const qid = await ask(bridge);
    const r = await rotate(owner, relay, host);
    keyRotated(relay, r.epoch);
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'], epoch: r.key });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
  });

  it('defers the rotation while the relay is unreachable and later events wait for it', async () => {
    const { relay, owner, phone, host, bridge, sink, store } = await hostWorld();
    const qid = await ask(bridge);
    const r = await rotate(owner, relay, host);
    keyRotated(relay, r.epoch);
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'], epoch: r.key });
    relay.failGrants = 1;
    await bridge.catchUp();
    // The grant fetch failed: the rotation is deferred and the answer behind it waits, undelivered.
    expect((await store.listAudit(100)).some((a) => a.event === 'event.deferred')).toBe(true);
    expect(sink.typed).toHaveLength(0);
    await bridge.pump();
    expect(sink.typed).toHaveLength(1);
  });

  it('refuses a grant that is not sealed by the pinned owner and delivers nothing under that epoch', async () => {
    const { relay, owner, phone, host, bridge, sink } = await hostWorld();
    const qid = await ask(bridge);
    const impostor = await makeIdentity();
    const forged: Identity = {
      ...impostor,
      config: {
        ...impostor.config,
        deviceId: owner.config.deviceId,
        installationId: owner.config.installationId,
      },
    };
    const raw = generateEpochKeyBytes();
    relay.grants.set(host.identity.config.deviceId, [
      ...relay.grants.get(host.identity.config.deviceId)!,
      await sealEpochTo(
        forged,
        { deviceId: host.identity.config.deviceId, exchangePub: host.identity.exchangePub },
        2,
        raw,
      ),
    ]);
    relay.epoch = 2;
    keyRotated(relay, 2);
    await relay.answerEvent({
      questionId: qid,
      phone,
      options: ['approve'],
      epoch: await importEpochKey(raw, 2, true),
    });
    for (let i = 0; i < 6; i++) await bridge.pump().catch(() => undefined);
    await bridge.catchUp().catch(() => undefined);
    expect(sink.typed).toHaveLength(0);
    expect(bridge.ctx.identity.epochs.has(2)).toBe(false);
    expect((await host.keyStore.load())!.epochs.map((e) => e.epoch)).toEqual([1]);
  });
});

describe('a desktop-host never attempts owner-only operations', () => {
  it('its relay client refuses every owner-only route without sending anything', async () => {
    const { relay, host, client } = await hostWorld();
    const before = relay.calls.length;
    const refused = [
      () =>
        client.createInvitation({
          pairing_id: newId(),
          invite_digest: 'x',
          expires_at: '',
          role: 'phone',
        }),
      () => client.pendingPairings(),
      () => client.approvePairing(newId(), host.cert, host.identity.stored.host!.grants[0]!),
      () => client.rejectPairing(newId()),
      () => client.revokeDevice(newId(), 2, []),
      () => client.enrollHost(host.cert, host.identity.stored.host!.grants[0]!),
      () => client.rotateEpoch(2, []),
      () => client.deleteQuestion(newId()),
      () => client.diagnostics(),
      () => client.deleteData('questions'),
    ];
    for (const call of refused) {
      await expect(Promise.resolve().then(call)).rejects.toThrow(/owner desktop/);
    }
    // Reopening is the owner's; a desktop never signs a human answer, override or confirmation.
    const qid = newId();
    const reopen = await buildSignedAction({
      installationId: host.identity.config.installationId,
      questionId: qid,
      action: 'reopen',
      signerDeviceId: host.identity.config.deviceId,
      signingKey: host.identity.keys.signing.privateKey,
      expectedRevision: 0,
    });
    await expect(client.postAction('reopen', qid, newId(), reopen)).rejects.toThrow(
      /owner desktop/,
    );
    for (const kind of ['answer', 'override', 'confirm-proxy'] as const) {
      await expect(client.postAction(kind, qid, newId(), reopen)).rejects.toThrow(
        /only a phone or tablet/,
      );
    }
    await expect(createPairingInvite(client)).rejects.toThrow(/owner desktop/);
    await expect(rotateEpoch(client, host.keyStore)).rejects.toThrow(/owner desktop/);
    await expect(revokeAndRotate(client, host.keyStore, newId())).rejects.toThrow(/owner desktop/);
    expect(relay.calls.length).toBe(before);
  });

  it('the owner desktop never signs human actions either', async () => {
    const owner = await makeIdentity();
    const relay = new FakeRelay(owner);
    await relay.initOwner();
    const client = new RelayClient({ identity: owner, fetch: relay.fetch, maxRetries: 0 });
    const qid = newId();
    const signed = await buildSignedAction({
      installationId: owner.config.installationId,
      questionId: qid,
      action: 'answer',
      signerDeviceId: owner.config.deviceId,
      signingKey: owner.keys.signing.privateKey,
      expectedRevision: 0,
    });
    for (const kind of ['answer', 'override', 'confirm-proxy'] as const) {
      await expect(client.postAction(kind, qid, newId(), signed)).rejects.toThrow(
        /only a phone or tablet/,
      );
    }
    expect(relay.calls).toHaveLength(0);
  });

  it('creates, proxy-answers, cancels and acknowledges, and touches only the routes a Host may use', async () => {
    const proxy: ProxyEngine = {
      async suggest() {
        return {
          action: 'answer',
          selected_option_ids: ['approve'],
          confidence: 0.9,
          model_id: 'm',
          prompt_template_version: '1',
          retrieval_reference_ids: [],
          risk_flags: [],
        };
      },
    };
    const { relay, phone, host, bridge, sink } = await hostWorld({ proxy });
    const proxied = await ask(bridge, { requested_requirement: 'proxy-ok' });
    expect(
      relay.calls.some((c) => c.method === 'POST' && c.path.endsWith(`/${proxied}/proxy-answer`)),
    ).toBe(true);
    const cancelled = await ask(bridge, { question: 'Cancel me' });
    await bridge.cancelQuestion(cancelled);
    await bridge.pump();
    const answered = await ask(bridge, { question: 'Answer me' });
    await relay.answerEvent({ questionId: answered, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed.some((t) => t.text.includes(answered))).toBe(true);

    const allowed = [
      /^GET \/api\/v1\/devices$/,
      /^GET \/api\/v1\/devices\/[^/]+\/key-grants$/,
      /^GET \/api\/v1\/events$/,
      /^POST \/api\/v1\/questions$/,
      /^POST \/api\/v1\/questions\/[^/]+\/(cancel|proxy-answer|proxy-abstain)$/,
      /^POST \/api\/v1\/deliveries\/(received|terminal|failed)$/,
    ];
    const mine = callsBy(relay, host.identity.config.deviceId).map((c) => `${c.method} ${c.path}`);
    expect(mine.some((c) => c.endsWith('/cancel'))).toBe(true);
    expect(mine.filter((c) => !allowed.some((re) => re.test(c)))).toEqual([]);
  });
});

describe('a desktop-host acts only on questions it created', () => {
  async function shared() {
    const owner = await makeIdentity();
    const relay = new FakeRelay(owner);
    await relay.initOwner();
    const phone: Phone = await makePhone(owner);
    relay.devices.push(phone.cert);
    const host = await makeHost(owner, relay);
    const o = bridgeFor(owner, relay);
    const h = bridgeFor(host.identity, relay, { keyStore: host.keyStore });
    return { owner, relay, phone, host, o, h };
  }

  it("stores the other device's events for sync but never delivers them, in both directions", async () => {
    const { relay, phone, host, owner, o, h } = await shared();
    const ownerQ = await ask(o.bridge, { question: 'Owner asks' }, 'host-local');
    const hostQ = await ask(h.bridge, { question: 'Host asks' }, 'host-remote');
    await relay.answerEvent({ questionId: ownerQ, phone, options: ['approve'] });
    await relay.answerEvent({ questionId: hostQ, phone, options: ['reject'] });
    await o.bridge.catchUp();
    await h.bridge.catchUp();

    expect(o.sink.typed.map((t) => t.text.includes(ownerQ))).toEqual([true]);
    expect(h.sink.typed.map((t) => t.text.includes(hostQ))).toEqual([true]);
    // Every event is stored (and the cursor covers it) on both devices.
    for (const b of [o, h]) {
      expect(await b.store.getCursor()).toBe(relay.events.at(-1)!.seq);
      for (const ev of relay.events) {
        expect(
          await b.store.insertEvent({
            seq: ev.seq,
            event_id: ev.event_id,
            event_type: ev.event_type,
            json: JSON.stringify(ev),
            received_at: 0,
            processed_at: null,
          }),
        ).toBe(false);
      }
    }
    // Neither acted on the other's question: no local row, and no delivery report for it.
    expect(await h.store.getQuestion(ownerQ)).toBeNull();
    expect(await o.store.getQuestion(hostQ)).toBeNull();
    const reports = (id: string) =>
      callsBy(relay, id)
        .filter(
          (c) =>
            c.path.startsWith('/api/v1/deliveries/') && c.path !== '/api/v1/deliveries/received',
        )
        .map((c) => (c.body as { question_id: string }).question_id);
    expect(reports(host.identity.config.deviceId)).toEqual([hostQ]);
    expect(reports(owner.config.deviceId)).toEqual([ownerQ]);
  });

  it("cannot see, cancel or proxy-answer the owner's question", async () => {
    const { o, h } = await shared();
    const ownerQ = await ask(o.bridge, { requested_requirement: 'proxy-ok' }, 'host-local');
    await h.bridge.catchUp();
    await expect(h.bridge.getDecision(ownerQ)).rejects.toBeInstanceOf(BridgeError);
    await expect(h.bridge.cancelQuestion(ownerQ)).rejects.toBeInstanceOf(BridgeError);
    await expect(h.bridge.runProxy(ownerQ)).rejects.toBeInstanceOf(BridgeError);
    expect((await h.bridge.listPending()).map((v) => v.questionId)).toEqual([]);
  });

  it('refuses a creation event that names another device as the creator of one of its question ids', async () => {
    const { relay, owner, h } = await shared();
    const hostQ = await ask(h.bridge, {}, 'host-remote');
    // Local row exists; a decision.created for the same id but a record the owner originated is not ours.
    const original = relay.questions.get(hostQ)!.signed;
    relay.push('decision.created', hostQ, 0, {
      record: { ...original.record, originating_device_id: owner.config.deviceId },
      envelope: original.envelope,
      requirement: original.record.requirement,
      target_host_id: original.record.target_host_id,
      expires_at: original.record.expires_at,
    });
    await h.bridge.catchUp();
    expect(await rejections(h.store)).toContain('created-by-another-device');
  });
});
