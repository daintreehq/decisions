import { describe, expect, it } from 'vitest';
import { newId } from '@daintreehq/decisions-crypto';
import {
  BRIDGE_FEATURES,
  DecisionsBridge,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  answeredOn,
  bridgeFeatures,
  formatAnswerNotice,
  parseAnswers,
  serializeAnswers,
  type DecisionLearner,
  type Identity,
  type LearnedDecision,
  type LocalStore,
} from '../src/index.js';
import {
  FakeRelay,
  FakeSink,
  FakeSocket,
  makeHost,
  makeIdentity,
  makePhone,
  origin,
  setupBridge,
  tick,
} from './helpers.js';

/*
 * Issue #98: the person's answer signed by the owner desktop (protocol section 2, `human-desktop` provenance) is
 * accepted by the computer that asked, kept with its signer, and typed and reported as the person's answer made on
 * the computer. Phone answers and proxy answers read exactly as before.
 */

const OPTIONS = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];

const COMPUTER_LINES =
  "source: human\nanswered_on: computer\nnote: This is the person's own answer, made on their computer rather than a phone. It is not a proxy answer.\n";

const signerOf = (identity: Identity) => ({
  deviceId: identity.config.deviceId,
  keys: identity.keys,
});

const rejections = async (store: LocalStore) =>
  (await store.listAudit(200)).filter((a) => a.event === 'event.rejected').map((a) => a.result);

function learner() {
  const seen: LearnedDecision[] = [];
  const l: DecisionLearner = {
    learn(d) {
      seen.push(d);
    },
  };
  return { l, seen };
}

async function asked(extra: Parameters<typeof setupBridge>[0] = {}) {
  const env = await setupBridge(extra);
  const r = await env.bridge.registerQuestion({
    origin: origin(),
    input: { question: 'Ship it?', options: OPTIONS },
  });
  await env.bridge.pump();
  return { ...env, owner: signerOf(env.identity), qid: r.questionId };
}

describe('the owner desktop answers its own question', () => {
  it("applies, types and reports the answer as the person's, made on the computer", async () => {
    const { l, seen } = learner();
    const { bridge, relay, sink, store, owner, qid, identity } = await asked({ learner: l });
    expect((await store.getQuestion(qid))!.requirement).toBe('human-required');

    await relay.answerEvent({
      questionId: qid,
      phone: owner,
      options: ['approve'],
      text: 'Fine by me',
      provenance: 'human-desktop',
    });
    await bridge.catchUp();

    expect(sink.typed).toHaveLength(1);
    const text = sink.typed[0]!.text;
    expect(text).toContain(COMPUTER_LINES + 'choice: approve\n');
    expect(text).toContain('comment: Fine by me');
    expect(text).not.toContain('source: proxy');
    expect(text).not.toContain('decision model');

    const row = (await store.getQuestion(qid))!;
    expect(row.local_status).toBe('human-answered');
    expect(row.delivery_status).toBe('terminal-delivered');
    // The stored answer keeps who signed it.
    expect(parseAnswers(row.answers_json)[0]).toMatchObject({
      source: 'human',
      signer_device_id: identity.config.deviceId,
      signer_role: 'owner-desktop',
      delivered: true,
    });
    const audit = await store.listAudit(50);
    expect(audit.find((a) => a.event === 'answer.received')).toMatchObject({
      provenance: 'human-desktop',
      result: 'verified',
    });
    expect(await rejections(store)).toEqual([]);

    const v = await bridge.getDecision(qid);
    expect(v).toMatchObject({
      status: 'human-answered',
      provenance: 'human',
      answeredOn: 'computer',
      choice: 'approve',
      text: 'Fine by me',
    });
    expect(v.answers).toEqual([
      expect.objectContaining({ source: 'human', answeredOn: 'computer' }),
    ]);
    expect(v.thread).toEqual([
      expect.objectContaining({ kind: 'answer', source: 'human', answeredOn: 'computer' }),
    ]);

    // The decision model learns from it like any of the person's answers.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ questionId: qid, selectedOptionIds: ['approve'] });
  });

  it('a phone answer reads exactly as before, and keeps its signer too', async () => {
    const { bridge, relay, sink, store, phone, qid } = await asked();
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.text).toContain('source: human\nchoice: approve\n');
    expect(sink.typed[0]!.text).not.toContain('answered_on');
    expect(sink.typed[0]!.text).not.toContain('computer');
    const row = (await store.getQuestion(qid))!;
    expect(parseAnswers(row.answers_json)[0]).toMatchObject({
      source: 'human',
      signer_device_id: phone.deviceId,
      signer_role: 'phone',
    });
    expect(await bridge.getDecision(qid)).toMatchObject({
      provenance: 'human',
      answeredOn: 'phone',
    });
  });

  it("an answer stored before signers were kept reads as a phone's", async () => {
    const { bridge, relay, store, phone, qid } = await asked();
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    const row = (await store.getQuestion(qid))!;
    const legacy = parseAnswers(row.answers_json).map((e) => {
      const { signer_device_id: _id, signer_role: _role, ...rest } = e;
      void _id;
      void _role;
      return rest;
    });
    await store.updateQuestion(qid, { answers_json: serializeAnswers(legacy) });
    const v = await bridge.getDecision(qid);
    expect(v).toMatchObject({ provenance: 'human', answeredOn: 'phone' });
    expect(v.answers[0]!.answeredOn).toBe('phone');
  });

  it('a phone can still correct it, and the correction is the phone’s', async () => {
    const { bridge, relay, sink, phone, owner, qid } = await asked();
    await relay.answerEvent({
      questionId: qid,
      phone: owner,
      options: ['approve'],
      provenance: 'human-desktop',
    });
    await bridge.catchUp();
    await relay.answerEvent({
      questionId: qid,
      phone,
      action: 'override',
      expectedRevision: 1,
      options: ['reject'],
      extra: { reason: 'Changed my mind' },
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(2);
    expect(sink.typed[1]!.text).toContain('source: human\nnote: This CORRECTS');
    expect(sink.typed[1]!.text).not.toContain('answered_on');
    const v = await bridge.getDecision(qid);
    expect(v).toMatchObject({ provenance: 'human', answeredOn: 'phone', choice: 'reject' });
    expect(v.answers.map((a) => a.answeredOn)).toEqual(['computer', 'phone']);
  });
});

describe('what the computer that asked still refuses', () => {
  const cases: {
    name: string;
    reason: string;
    event: (e: Awaited<ReturnType<typeof asked>>) => Promise<unknown>;
  }[] = [
    {
      name: "the owner's answer claimed as a phone's",
      reason: 'provenance-mismatch',
      event: (e) =>
        e.relay.answerEvent({
          questionId: e.qid,
          phone: e.owner,
          options: ['approve'],
          provenance: 'human',
        }),
    },
    {
      name: "a phone's answer claimed as made on the computer",
      reason: 'provenance-mismatch',
      event: (e) =>
        e.relay.answerEvent({
          questionId: e.qid,
          phone: e.phone,
          options: ['approve'],
          provenance: 'human-desktop',
        }),
    },
    {
      name: "the owner's answer claimed as a proxy's",
      reason: 'provenance-mismatch',
      event: (e) =>
        e.relay.answerEvent({
          questionId: e.qid,
          phone: e.owner,
          options: ['approve'],
          provenance: 'proxy',
          status: 'human-answered',
        }),
    },
    {
      name: 'an owner-desktop override',
      reason: 'human-action-by-non-human-device',
      event: (e) =>
        e.relay.answerEvent({
          questionId: e.qid,
          phone: e.owner,
          action: 'override',
          options: ['approve'],
          provenance: 'human-desktop',
        }),
    },
    {
      name: 'an owner-desktop confirmation of a proxy answer',
      reason: 'human-action-by-non-human-device',
      event: (e) =>
        e.relay.answerEvent({
          questionId: e.qid,
          phone: e.owner,
          action: 'confirm-proxy',
          confirmsActionId: newId(),
          provenance: 'human-desktop',
        }),
    },
    {
      name: 'an owner-desktop answer listing phone images',
      reason: 'images-on-desktop-answer',
      event: (e) =>
        e.relay.answerEvent({
          questionId: e.qid,
          phone: e.owner,
          options: ['approve'],
          provenance: 'human-desktop',
          attachmentIds: [newId()],
        }),
    },
  ];

  for (const c of cases) {
    it(`${c.name} is rejected as ${c.reason}, and changes nothing`, async () => {
      const env = await asked();
      await c.event(env);
      await env.bridge.catchUp();
      expect(env.sink.typed).toHaveLength(0);
      const row = (await env.store.getQuestion(env.qid))!;
      expect(row.local_status).toBe('open');
      expect(parseAnswers(row.answers_json)).toEqual([]);
      expect(await rejections(env.store)).toContain(c.reason);
      expect(await env.bridge.getDecision(env.qid)).toMatchObject({
        provenance: null,
        answeredOn: null,
      });
    });
  }
});

describe('a Remote Host takes the owner desktop’s answer to its own question', () => {
  async function hostWorld() {
    const owner = await makeIdentity();
    const relay = new FakeRelay(owner);
    await relay.initOwner();
    const phone = await makePhone(owner);
    relay.devices.push(phone.cert);
    const host = await makeHost(owner, relay);
    const sink = new FakeSink();
    sink.addPane('pane-1');
    const store = new MemoryLocalStore();
    const bridge = new DecisionsBridge({
      identity: host.identity,
      keyStore: host.keyStore,
      store,
      sink,
      client: new RelayClient({
        identity: host.identity,
        fetch: relay.fetch,
        sleep: async () => {},
        maxRetries: 0,
      }),
      policy: new PolicyRegistry(),
      pumpIntervalMs: 0,
    });
    const r = await bridge.registerQuestion({
      origin: origin({ host_id: 'host-remote' }),
      input: { question: 'Ship it?', options: OPTIONS },
    });
    await bridge.pump();
    return { owner, relay, host, sink, store, bridge, qid: r.questionId };
  }

  it("types it as the person's answer, made on the computer", async () => {
    const { owner, relay, host, sink, store, bridge, qid } = await hostWorld();
    expect(relay.questions.get(qid)!.signed.record.originating_device_id).toBe(
      host.identity.config.deviceId,
    );
    await relay.answerEvent({
      questionId: qid,
      phone: signerOf(owner),
      options: ['approve'],
      provenance: 'human-desktop',
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.text).toContain(COMPUTER_LINES + 'choice: approve\n');
    expect(parseAnswers((await store.getQuestion(qid))!.answers_json)[0]).toMatchObject({
      signer_device_id: owner.config.deviceId,
      signer_role: 'owner-desktop',
    });
    expect(await bridge.getDecision(qid)).toMatchObject({
      status: 'human-answered',
      provenance: 'human',
      answeredOn: 'computer',
    });
  });

  it('still rejects an answer the Host signed itself, whatever provenance the relay claims', async () => {
    for (const provenance of ['human-desktop', 'human'] as const) {
      const { relay, host, sink, store, bridge, qid } = await hostWorld();
      await relay.answerEvent({
        questionId: qid,
        phone: signerOf(host.identity),
        options: ['approve'],
        provenance,
      });
      await bridge.catchUp();
      expect(sink.typed).toHaveLength(0);
      expect((await store.getQuestion(qid))!.local_status).toBe('open');
      expect(await rejections(store)).toContain('human-action-by-non-human-device');
    }
  });
});

describe('declaring owner-desktop-answers-v1', () => {
  it('every bridge declares it, whatever else it declares', () => {
    expect(BRIDGE_FEATURES).toContain('owner-desktop-answers-v1');
    expect(bridgeFeatures()).toContain('owner-desktop-answers-v1');
    expect(bridgeFeatures({ followUps: true })).toContain('owner-desktop-answers-v1');
  });

  it('on its socket ticket, which the relay checks before committing such an answer', async () => {
    FakeSocket.instances = [];
    const env = await setupBridge({ webSocket: (u) => new FakeSocket(u) });
    await env.bridge.start();
    await tick(10);
    const ticket = env.relay.calls.find((c) => c.path === '/api/v1/socket-ticket');
    expect((ticket!.body as { features?: string[] }).features).toContain(
      'owner-desktop-answers-v1',
    );
    await env.bridge.stop();
  });
});

describe('the terminal block and answeredOn', () => {
  it('labels an answer made on the computer, and nothing else', () => {
    const base = { kind: 'answer' as const, questionId: 'q1', revision: 1 };
    const onComputer = formatAnswerNotice({
      ...base,
      source: 'human',
      onComputer: true,
      choices: [{ id: 'approve', label: 'Approve' }],
    });
    expect(onComputer).toBe(
      [
        '[DAINTREE DECISION ANSWER]',
        'question_id: q1',
        'revision: 1',
        'source: human',
        'answered_on: computer',
        "note: This is the person's own answer, made on their computer rather than a phone. It is not a proxy answer.",
        'choice: approve',
        'choice_label: Approve',
        '[END DAINTREE DECISION ANSWER]',
      ].join('\n'),
    );
    // A phone's answer is unchanged, and a proxy answer never takes the label.
    expect(formatAnswerNotice({ ...base, source: 'human' })).toBe(
      formatAnswerNotice({ ...base, source: 'human', onComputer: false }),
    );
    const proxy = formatAnswerNotice({ ...base, source: 'proxy', onComputer: true });
    expect(proxy).not.toContain('answered_on');
    expect(proxy).toContain('source: proxy');
  });

  it('answeredOn follows the signer of a human answer only', () => {
    expect(answeredOn({ source: 'human', signer_role: 'owner-desktop' })).toBe('computer');
    expect(answeredOn({ source: 'human', signer_role: 'phone' })).toBe('phone');
    expect(answeredOn({ source: 'human', signer_role: 'tablet' })).toBe('phone');
    expect(answeredOn({ source: 'human' })).toBe('phone');
    expect(answeredOn({ source: 'proxy', signer_role: 'owner-desktop' })).toBeNull();
    expect(answeredOn({ source: 'system' })).toBeNull();
  });
});
