import { describe, expect, it } from 'vitest';
import {
  BRIDGE_FEATURES,
  DecisionsBridge,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  bridgeFeatures,
  parseAnswers,
  type Identity,
  type LocalStore,
} from '../src/index.js';
import {
  FakeRelay,
  FakeSink,
  makeHost,
  makeIdentity,
  makePhone,
  origin,
  setupBridge,
} from './helpers.js';

/*
 * Issue #121: the owner desktop declines a question for the person with a signed `decline: true` on its cancel
 * (protocol section 6.1). Every desktop files it as the person's decline, exactly as it files a phone's, and an owner
 * cancel without the flag stays a withdrawal.
 */

const OPTIONS = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];

/** The lines a decline notice carries whoever declined: the same for a phone's decline and the owner desktop's. */
const DECLINED_LINES =
  'source: human\nstatus: declined\nauthorised: no\nnote: The person declined to answer this question. Nothing was decided or approved; stop waiting for it and do not continue the gated step.\n';

const signerOf = (identity: Identity) => ({
  deviceId: identity.config.deviceId,
  keys: identity.keys,
});

const rejections = async (store: LocalStore) =>
  (await store.listAudit(200)).filter((a) => a.event === 'event.rejected').map((a) => a.result);

/** The owner desktop asks a question of its own. */
async function ownQuestion() {
  const env = await setupBridge();
  const r = await env.bridge.registerQuestion({
    origin: origin(),
    input: { question: 'Ship it?', options: OPTIONS },
  });
  await env.bridge.pump();
  return { ...env, owner: signerOf(env.identity), qid: r.questionId };
}

function bridgeFor(
  identity: Identity,
  relay: FakeRelay,
  store: LocalStore = new MemoryLocalStore(),
) {
  const sink = new FakeSink();
  sink.addPane('pane-1');
  const bridge = new DecisionsBridge({
    identity,
    store,
    sink,
    client: new RelayClient({ identity, fetch: relay.fetch, sleep: async () => {}, maxRetries: 0 }),
    policy: new PolicyRegistry(),
    pumpIntervalMs: 0,
  });
  return { bridge, sink, store };
}

/** A Remote Host asks a question of its own. */
async function hostQuestion() {
  const owner = await makeIdentity();
  const relay = new FakeRelay(owner);
  await relay.initOwner();
  const host = await makeHost(owner, relay);
  const asking = bridgeFor(host.identity, relay);
  const r = await asking.bridge.registerQuestion({
    origin: origin({ host_id: 'host-remote' }),
    input: { question: 'Ship it?', options: OPTIONS },
  });
  await asking.bridge.pump();
  return { owner, relay, host, asking, qid: r.questionId };
}

describe('every bridge declares owner-desktop-declines-v1', () => {
  it('so the relay commits the owner desktop’s decline of its questions', () => {
    expect(BRIDGE_FEATURES).toContain('owner-desktop-declines-v1');
    for (const o of [
      {},
      { followUps: true },
      { snapshots: {} },
      { followUps: true, snapshots: {} },
    ])
      expect(bridgeFeatures(o)).toContain('owner-desktop-declines-v1');
  });
});

describe('a desktop classifies the owner desktop’s decline', () => {
  it('as the person declining: the agent gets the same notice a phone’s decline types', async () => {
    const { bridge, relay, sink, store, owner, qid } = await ownQuestion();
    await relay.plainActionEvent({
      questionId: qid,
      signer: owner,
      action: 'cancel',
      decline: true,
    });
    await bridge.catchUp();

    expect(await rejections(store)).toEqual([]);
    const row = (await store.getQuestion(qid))!;
    expect(row.local_status).toBe('cancelled');
    expect(parseAnswers(row.answers_json)).toMatchObject([
      { kind: 'declined', action: 'cancel', source: 'human', sealed: null },
    ]);
    expect(sink.typed).toHaveLength(1);
    const notice = sink.typed[0]!.text;
    expect(notice).toContain(DECLINED_LINES);
    expect(notice).not.toContain('answered_on');
    expect(notice).not.toContain('choice:');
    expect(await bridge.getDecision(qid)).toMatchObject({
      status: 'cancelled',
      closedReason: 'declined',
      provenance: null,
      choice: null,
      text: '',
      answers: [],
    });
    const audit = await store.listAudit(100);
    expect(audit.find((a) => a.event === 'question.cancelled')).toMatchObject({
      result: 'declined',
    });

    // Typed once: another pass types nothing more.
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
  });

  it('and reads the same notice as a phone’s decline', async () => {
    const byPhone = await ownQuestion();
    await byPhone.relay.plainActionEvent({
      questionId: byPhone.qid,
      signer: byPhone.phone,
      action: 'cancel',
    });
    await byPhone.bridge.catchUp();
    const byOwner = await ownQuestion();
    await byOwner.relay.plainActionEvent({
      questionId: byOwner.qid,
      signer: byOwner.owner,
      action: 'cancel',
      decline: true,
    });
    await byOwner.bridge.catchUp();

    const strip = (t: string, qid: string) =>
      t.replace(qid, 'QID').replace(/injection_id: .*\n/, '');
    expect(byPhone.sink.typed).toHaveLength(1);
    expect(byOwner.sink.typed).toHaveLength(1);
    expect(strip(byOwner.sink.typed[0]!.text, byOwner.qid)).toBe(
      strip(byPhone.sink.typed[0]!.text, byPhone.qid),
    );
  });

  it('while an owner cancel without the flag stays a silent withdrawal', async () => {
    const { bridge, relay, sink, store, owner, qid } = await ownQuestion();
    await relay.plainActionEvent({ questionId: qid, signer: owner, action: 'cancel' });
    await bridge.catchUp();

    expect(await rejections(store)).toEqual([]);
    expect(sink.typed).toHaveLength(0);
    expect(parseAnswers((await store.getQuestion(qid))!.answers_json)).toEqual([]);
    expect(await bridge.getDecision(qid)).toMatchObject({
      status: 'cancelled',
      closedReason: 'withdrawn',
    });
  });

  it('on a Remote Host’s question: the Host types the declined notice', async () => {
    const { owner, relay, asking, qid } = await hostQuestion();
    await relay.plainActionEvent({
      questionId: qid,
      signer: signerOf(owner),
      action: 'cancel',
      decline: true,
    });
    await asking.bridge.catchUp();

    expect(await rejections(asking.store)).toEqual([]);
    expect(asking.sink.typed).toHaveLength(1);
    expect(asking.sink.typed[0]!.text).toContain(DECLINED_LINES);
    expect(await asking.bridge.getDecision(qid)).toMatchObject({
      status: 'cancelled',
      closedReason: 'declined',
    });
  });

  it('and on a Remote Host’s question an owner withdrawal is still a withdrawal', async () => {
    const { owner, relay, asking, qid } = await hostQuestion();
    await relay.plainActionEvent({ questionId: qid, signer: signerOf(owner), action: 'cancel' });
    await asking.bridge.catchUp();
    expect(asking.sink.typed).toHaveLength(0);
    expect((await asking.bridge.getDecision(qid)).closedReason).toBe('withdrawn');
  });

  it('never from a Host: a desktop-host’s signed decline is rejected and the question stays open', async () => {
    const { relay, host, asking, qid } = await hostQuestion();
    await relay.plainActionEvent({
      questionId: qid,
      signer: { deviceId: host.identity.config.deviceId, keys: host.identity.keys },
      action: 'cancel',
      decline: true,
    });
    await asking.bridge.catchUp();
    expect(await rejections(asking.store)).toEqual(['decline-by-non-owner-desktop']);
    expect(asking.sink.typed).toHaveLength(0);
    expect((await asking.store.getQuestion(qid))!.local_status).toBe('open');
  });

  it('never from a phone signing the flag, which declines by its role alone', async () => {
    const { bridge, relay, sink, store, qid, identity } = await ownQuestion();
    const phone = await makePhone(identity);
    relay.devices.push(phone.cert);
    await relay.plainActionEvent({
      questionId: qid,
      signer: phone,
      action: 'cancel',
      decline: true,
    });
    await bridge.catchUp();
    expect(await rejections(store)).toEqual(['decline-by-non-owner-desktop']);
    expect(sink.typed).toHaveLength(0);
    expect((await store.getQuestion(qid))!.local_status).toBe('open');
  });

  it('only on an open question: a decline of a proxy-answered question is refused, a withdrawal is not', async () => {
    const a = await ownQuestion();
    await a.store.updateQuestion(a.qid, { local_status: 'proxy-answered' });
    await a.relay.plainActionEvent({
      questionId: a.qid,
      signer: a.owner,
      action: 'cancel',
      decline: true,
    });
    await a.bridge.catchUp();
    expect(await rejections(a.store)).toEqual(['transition:invalid_state']);
    expect((await a.store.getQuestion(a.qid))!.local_status).toBe('proxy-answered');

    const b = await ownQuestion();
    await b.store.updateQuestion(b.qid, { local_status: 'proxy-answered' });
    await b.relay.plainActionEvent({ questionId: b.qid, signer: b.owner, action: 'cancel' });
    await b.bridge.catchUp();
    expect(await rejections(b.store)).toEqual([]);
    expect((await b.bridge.getDecision(b.qid)).closedReason).toBe('withdrawn');
  });

  it('first close wins: a withdrawal after the decline never relabels it', async () => {
    const { bridge, relay, sink, store, owner, qid } = await ownQuestion();
    await relay.plainActionEvent({
      questionId: qid,
      signer: owner,
      action: 'cancel',
      decline: true,
    });
    await relay.plainActionEvent({ questionId: qid, signer: owner, action: 'cancel' });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect((await bridge.getDecision(qid)).closedReason).toBe('declined');
    expect(parseAnswers((await store.getQuestion(qid))!.answers_json)).toHaveLength(1);
  });
});
