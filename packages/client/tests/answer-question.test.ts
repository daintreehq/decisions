import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decryptEnvelope, newId } from '@daintreehq/decisions-crypto';
import {
  BridgeError,
  DecisionsBridge,
  MCP_BRIDGE_METHODS,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  type Identity,
  type LocalStore,
  type OwnerAnswerResult,
  type WorkflowGate,
} from '../src/index.js';
import { SqliteLocalStore } from '../src/store-sqlite.js';
import {
  FakeRelay,
  FakeSink,
  makeHost,
  makeIdentity,
  origin,
  setupBridge,
  tick,
} from './helpers.js';

/*
 * Issue #99: a host app publishes the person's answer from the owner desktop (`answerQuestion`), for the owner's own
 * questions and a Remote Host's, signed with the owner's key and sent through the outbox, with a result a UI can show.
 */

const dir = mkdtempSync(join(tmpdir(), 'decisions-answer-question-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const OPTIONS = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];
const FEATURES = ['thread-messages-v1', 'owner-desktop-answers-v1'];
const COMPUTER_LINES =
  "source: human\nanswered_on: computer\nnote: This is the person's own answer, made on their computer rather than a phone. It is not a proxy answer.\n";

function results(bridge: DecisionsBridge): OwnerAnswerResult[] {
  const seen: OwnerAnswerResult[] = [];
  bridge.on('answer', (r) => seen.push(r));
  return seen;
}

const answerPosts = (relay: FakeRelay) =>
  relay.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/answer'));

const infoReads = (relay: FakeRelay) =>
  relay.calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/info').length;

/** A relay client that retries transient failures itself, as a default `RelayClient` does. */
const retryingClient = (identity: Identity, relay: FakeRelay) =>
  new RelayClient({ identity, fetch: relay.fetch, sleep: async () => {}, maxRetries: 3 });

const ownerAnswers = async (store: LocalStore) =>
  (await store.dueOutbox(Number.MAX_SAFE_INTEGER, 100)).filter((o) => o.kind === 'owner-answer');

/** The owner desktop asks a question of its own; the relay takes owner-desktop answers. */
async function ownQuestion(extra: Parameters<typeof setupBridge>[0] = {}) {
  const env = await setupBridge(extra);
  env.relay.features = [...FEATURES];
  const r = await env.bridge.registerQuestion({
    origin: origin(),
    input: { question: 'Ship it?', options: OPTIONS },
  });
  await env.bridge.pump();
  return { ...env, qid: r.questionId, seen: results(env.bridge) };
}

function bridgeFor(
  identity: Identity,
  relay: FakeRelay,
  store: LocalStore = new MemoryLocalStore(),
  now?: () => number,
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
    ...(now ? { now } : {}),
  });
  return { bridge, sink, store };
}

/** A Remote Host asks; the owner desktop, which keeps no row for the Host's question, answers it. */
async function hostQuestion() {
  const owner = await makeIdentity();
  const relay = new FakeRelay(owner);
  await relay.initOwner();
  relay.features = [...FEATURES];
  const host = await makeHost(owner, relay);
  const asking = bridgeFor(host.identity, relay);
  const r = await asking.bridge.registerQuestion({
    origin: origin({ host_id: 'host-remote' }),
    input: { question: 'Ship it?', options: OPTIONS },
  });
  await asking.bridge.pump();
  const ownerSide = bridgeFor(owner, relay);
  return { owner, relay, host, asking, ownerSide, qid: r.questionId };
}

describe('answerQuestion on the owner’s own question', () => {
  it('signs the reviewed revision with the owner key, sends it, and the question is answered on the computer', async () => {
    const { bridge, relay, sink, store, identity, qid, seen } = await ownQuestion();
    const digest = 'a'.repeat(64);
    const r = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
      text: 'Looks right',
      explicitApproval: true,
      reason: 'Checked both screens',
      reviewedAttachmentDigests: [digest],
    });
    expect(r).toEqual({
      answerId: expect.any(String),
      questionId: qid,
      expectedRevision: 0,
      status: 'sent',
    });

    expect(relay.answers).toHaveLength(1);
    const { idem, action } = relay.answers[0]!;
    expect(idem).toBe(r.answerId);
    expect(action.record).toMatchObject({
      action: 'answer',
      action_id: r.answerId,
      question_id: qid,
      signer_device_id: identity.config.deviceId,
      expected_revision: 0,
    });
    expect(action.record.attachment_ids ?? []).toEqual([]);
    const content = await decryptEnvelope(action.envelope!, identity.epochs, {
      questionId: qid,
      recordType: 'answer',
      revision: 1,
    });
    expect(content).toEqual({
      content_version: 1,
      selected_option_ids: ['approve'],
      text: 'Looks right',
      reviewed_attachment_digests: [digest],
      explicit_approval: true,
      reason: 'Checked both screens',
    });

    // Settled: nothing left to send, the outcome kept and reported once.
    expect(await ownerAnswers(store)).toEqual([]);
    expect(await bridge.getAnswerResult(r.answerId)).toEqual(r);
    expect(seen).toEqual([r]);

    // The committed answer comes back like any other: verified, typed and reported as made on the computer.
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.text).toContain(COMPUTER_LINES + 'choice: approve\n');
    expect(await bridge.getDecision(qid)).toMatchObject({
      status: 'human-answered',
      provenance: 'human',
      answeredOn: 'computer',
      choice: 'approve',
      text: 'Looks right',
    });
  });

  it('refuses an answer the question’s rules forbid before anything is queued or sent', async () => {
    const { bridge, relay, store, qid } = await ownQuestion();
    await expect(
      bridge.answerQuestion({ questionId: qid, expectedRevision: 0, selectedOptionIds: ['maybe'] }),
    ).rejects.toMatchObject({ code: 'validation_error', message: /unknown option/ });
    await expect(
      bridge.answerQuestion({ questionId: qid, expectedRevision: 0, text: '  ' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      bridge.answerQuestion({
        questionId: qid,
        expectedRevision: -1,
        selectedOptionIds: ['approve'],
      }),
    ).rejects.toBeInstanceOf(BridgeError);
    await expect(
      bridge.answerQuestion({
        questionId: qid,
        expectedRevision: 0,
        selectedOptionIds: ['approve'],
        reviewedAttachmentDigests: ['not-a-digest'],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(await ownerAnswers(store)).toEqual([]);
    expect(answerPosts(relay)).toEqual([]);
  });

  it('holds the answer to the question’s gate: its choices, one at most, no text, and its allowed options', async () => {
    const SHIP: WorkflowGate = {
      gateId: 'ship/final',
      minRequirement: 'human-required',
      policyVersion: 1,
      choices: OPTIONS,
    };
    const LIMITED: WorkflowGate = {
      gateId: 'ship/limited',
      minRequirement: 'human-required',
      policyVersion: 1,
    };
    const policy = new PolicyRegistry();
    policy.register(SHIP);
    policy.register(LIMITED);
    const env = await setupBridge({ policy });
    env.relay.features = [...FEATURES];
    const ask = async (gate: string) =>
      (
        await env.bridge.registerQuestion({
          origin: origin({ workflow_gate_id: gate }),
          input: { question: 'Ship it?', options: OPTIONS },
        })
      ).questionId;
    const ship = await ask(SHIP.gateId);
    const limited = await ask(LIMITED.gateId);
    await env.bridge.pump();
    // Tightened after the question was asked: its desktop checks the answer against the gate as it is now.
    policy.register({ ...LIMITED, policyVersion: 2, allowedOptionIds: ['approve'] });
    const refused: [{ questionId: string; selectedOptionIds: string[]; text?: string }, RegExp][] =
      [
        [
          { questionId: ship, selectedOptionIds: ['approve'], text: 'and a note' },
          /text not allowed/,
        ],
        [{ questionId: ship, selectedOptionIds: ['approve', 'reject'] }, /too many choices/],
        [{ questionId: limited, selectedOptionIds: ['reject'] }, /unknown option/],
      ];
    for (const [input, message] of refused) {
      await expect(
        env.bridge.answerQuestion({ ...input, expectedRevision: 0 }),
      ).rejects.toMatchObject({ code: 'validation_error', message });
    }
    expect(await ownerAnswers(env.store)).toEqual([]);
    expect(answerPosts(env.relay)).toEqual([]);
    // What the gates do allow goes through.
    expect(
      await env.bridge.answerQuestion({
        questionId: limited,
        expectedRevision: 0,
        selectedOptionIds: ['approve'],
        text: 'Fine',
      }),
    ).toMatchObject({ status: 'sent' });
  });

  it('keeps an explicit approval of false and takes a text-only answer', async () => {
    const { bridge, relay, identity, qid } = await ownQuestion();
    const r = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      text: 'Neither: hold it until Monday',
      explicitApproval: false,
    });
    expect(r.status).toBe('sent');
    const content = await decryptEnvelope(relay.answers[0]!.action.envelope!, identity.epochs);
    expect(content).toMatchObject({
      selected_option_ids: [],
      text: 'Neither: hold it until Monday',
      explicit_approval: false,
    });
  });

  it('refuses when the question’s own content cannot be opened, which its desktop would refuse too', async () => {
    const { bridge, relay, store, qid } = await ownQuestion();
    await store.updateQuestion(qid, { content_sealed: '{"not":"an envelope"}' });
    await expect(
      bridge.answerQuestion({
        questionId: qid,
        expectedRevision: 0,
        selectedOptionIds: ['approve'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(await ownerAnswers(store)).toEqual([]);
    expect(answerPosts(relay)).toEqual([]);
  });

  it('never overtakes a withdrawal already queued for the question', async () => {
    let t = Date.now();
    const { bridge, relay, qid, seen } = await ownQuestion({ now: () => t });
    relay.status5xx = 1; // the cancellation backs off
    await bridge.cancelQuestion(qid);
    await bridge.pump();
    const r = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(r.status).toBe('queued');
    expect(answerPosts(relay)).toEqual([]);

    t += 10 * 60_000;
    await bridge.pump();
    const posts = relay.calls
      .filter((c) => c.method === 'POST' && /\/(cancel|answer)$/.test(c.path))
      .map((c) => c.path.split('/').at(-1));
    expect(posts).toEqual(['cancel', 'answer']);
    expect(seen).toEqual([{ ...r, status: 'closed', reason: 'cancelled' }]);
  });

  it('waits behind its question’s unsent create, then follows it', async () => {
    let t = Date.now();
    const env = await setupBridge({ now: () => t });
    env.relay.features = [...FEATURES];
    env.relay.down = 1; // the create fails and backs off
    const { questionId: qid } = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Ship it?', options: OPTIONS },
    });
    await env.bridge.pump();
    expect(env.relay.questions.has(qid)).toBe(false);

    const r = await env.bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['reject'],
    });
    expect(r.status).toBe('queued');
    expect(answerPosts(env.relay)).toEqual([]);
    expect(await env.bridge.getAnswerResult(r.answerId)).toEqual(r);

    t += 10 * 60_000;
    await env.bridge.pump();
    const posts = env.relay.calls
      .filter((c) => c.method === 'POST' && c.path.startsWith('/api/v1/questions'))
      .map((c) => c.path);
    expect(posts).toEqual(['/api/v1/questions', `/api/v1/questions/${qid}/answer`]);
    expect(await env.bridge.getAnswerResult(r.answerId)).toMatchObject({ status: 'sent' });
  });
});

describe('answerQuestion on a Remote Host’s question', () => {
  it('needs no local row: the owner signs and sends it, and the Host types it as made on the computer', async () => {
    const { owner, relay, host, asking, ownerSide, qid } = await hostQuestion();
    expect(await ownerSide.store.getQuestion(qid)).toBeNull();
    expect(relay.questions.get(qid)!.signed.record.originating_device_id).toBe(
      host.identity.config.deviceId,
    );

    const r = await ownerSide.bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(r).toMatchObject({ questionId: qid, status: 'sent' });
    expect(relay.answers[0]!.action.record.signer_device_id).toBe(owner.config.deviceId);
    expect(await ownerSide.store.getQuestion(qid)).toBeNull();

    await asking.bridge.catchUp();
    expect(asking.sink.typed).toHaveLength(1);
    expect(asking.sink.typed[0]!.text).toContain(COMPUTER_LINES + 'choice: approve\n');
    expect(await asking.bridge.getDecision(qid)).toMatchObject({
      status: 'human-answered',
      provenance: 'human',
      answeredOn: 'computer',
    });
  });

  it('reports a Host that has not declared desktop answers as the asking computer not supporting them', async () => {
    const { relay, host, ownerSide, qid } = await hostQuestion();
    relay.undeclared.add(host.identity.config.deviceId);
    const r = await ownerSide.bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(r).toMatchObject({ status: 'unsupported', by: 'asking-desktop' });
    expect(answerPosts(relay)).toHaveLength(1);
  });

  it('is refused on a Remote Host before anything is signed, queued or sent', async () => {
    const { relay, asking, qid } = await hostQuestion();
    const before = relay.calls.length;
    await expect(
      asking.bridge.answerQuestion({
        questionId: qid,
        expectedRevision: 0,
        selectedOptionIds: ['approve'],
      }),
    ).rejects.toMatchObject({ code: 'forbidden', message: /only the owner desktop/ });
    // Refused for what it is, before its input is even read.
    await expect(asking.bridge.answerQuestion({} as never)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      asking.bridge.publisher.enqueueOwnerAnswer({
        questionId: qid,
        expectedRevision: 0,
        selectedOptionIds: ['approve'],
        reviewedAttachmentDigests: [],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await ownerAnswers(asking.store)).toEqual([]);
    expect(relay.calls.length).toBe(before);
  });
});

describe('answerQuestion results a UI can show', () => {
  const refusals: {
    name: string;
    reply: { status: number; code: string; details?: Record<string, unknown> };
    expected: Record<string, unknown>;
  }[] = [
    {
      name: 'the asking desktop does not take desktop answers yet',
      reply: {
        status: 409,
        code: 'invalid_state',
        details: {
          reason: 'creator-missing-feature',
          required_feature: 'owner-desktop-answers-v1',
        },
      },
      expected: { status: 'unsupported', by: 'asking-desktop' },
    },
    {
      name: 'a phone answered first',
      reply: {
        status: 409,
        code: 'revision_conflict',
        details: { latest_revision: 1, status: 'human-answered' },
      },
      expected: { status: 'already-answered' },
    },
    {
      name: 'the decision model answered first',
      reply: {
        status: 409,
        code: 'revision_conflict',
        details: { latest_revision: 1, status: 'proxy-answered' },
      },
      expected: { status: 'already-answered' },
    },
    {
      name: 'the question was reopened after the person reviewed it',
      reply: {
        status: 409,
        code: 'revision_conflict',
        details: { latest_revision: 2, status: 'open' },
      },
      expected: { status: 'changed' },
    },
    {
      name: 'the question expired',
      reply: { status: 410, code: 'expired' },
      expected: { status: 'closed', reason: 'expired' },
    },
    {
      name: 'the question was cancelled or declined',
      reply: { status: 409, code: 'invalid_state' },
      expected: { status: 'closed', reason: 'cancelled' },
    },
    {
      name: 'the relay has no such question',
      reply: { status: 404, code: 'not_found' },
      expected: { status: 'closed', reason: 'not-found' },
    },
    {
      name: 'the relay refuses the role while still advertising support',
      reply: { status: 403, code: 'forbidden' },
      expected: { status: 'rejected', code: 'forbidden' },
    },
  ];
  for (const c of refusals) {
    it(`${c.name}: ${JSON.stringify(c.expected)}, settled and never retried`, async () => {
      const { bridge, relay, store, qid, seen } = await ownQuestion();
      relay.rejectAnswer = [c.reply];
      const r = await bridge.answerQuestion({
        questionId: qid,
        expectedRevision: 0,
        selectedOptionIds: ['approve'],
      });
      expect(r).toEqual({
        answerId: expect.any(String),
        questionId: qid,
        expectedRevision: 0,
        ...c.expected,
      });
      expect(seen).toEqual([r]);
      expect(await bridge.getAnswerResult(r.answerId)).toEqual(r);
      expect(await ownerAnswers(store)).toEqual([]);
      await bridge.pump();
      expect(answerPosts(relay)).toHaveLength(1);
    });
  }

  it('a relay that does not advertise owner-desktop answers is never sent one', async () => {
    for (const features of [undefined, [], ['thread-messages-v1']]) {
      const { bridge, relay, store, qid, seen } = await ownQuestion();
      relay.features = features;
      const r = await bridge.answerQuestion({
        questionId: qid,
        expectedRevision: 0,
        selectedOptionIds: ['approve'],
      });
      expect(r).toMatchObject({ status: 'unsupported', by: 'relay' });
      expect(seen).toEqual([r]);
      expect(answerPosts(relay)).toEqual([]);
      expect(await ownerAnswers(store)).toEqual([]);
    }
  });

  it('a relay that stopped advertising them since it was last read refuses as unsupported', async () => {
    const { bridge, relay, qid } = await ownQuestion();
    relay.rejectAnswer = [{ status: 403, code: 'forbidden' }];
    // Withdrawn once the answer is on its way, after the feature was read.
    relay.onAnswer = () => {
      relay.features = ['thread-messages-v1'];
    };
    const r = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(r).toMatchObject({ status: 'unsupported', by: 'relay' });
    expect(answerPosts(relay)).toHaveLength(1);
    expect(relay.rejectAnswer).toEqual([]);
    expect(infoReads(relay)).toBe(2);
  });

  it('settles by the question’s state: a second answer finds it answered, a stale revision finds it changed', async () => {
    const { bridge, relay, identity, qid } = await ownQuestion();
    expect(
      await bridge.answerQuestion({
        questionId: qid,
        expectedRevision: 0,
        selectedOptionIds: ['approve'],
      }),
    ).toMatchObject({ status: 'sent' });
    expect(
      await bridge.answerQuestion({
        questionId: qid,
        expectedRevision: 0,
        selectedOptionIds: ['reject'],
      }),
    ).toMatchObject({ status: 'already-answered' });

    // Reopened at revision 2: the answer to revision 0 is not moved onto it; one to revision 2 is taken.
    relay.answerState.set(qid, { status: 'open', revision: 2 });
    expect(
      await bridge.answerQuestion({
        questionId: qid,
        expectedRevision: 0,
        selectedOptionIds: ['reject'],
      }),
    ).toMatchObject({ status: 'changed' });
    expect(
      await bridge.answerQuestion({
        questionId: qid,
        expectedRevision: 2,
        selectedOptionIds: ['reject'],
      }),
    ).toMatchObject({ status: 'sent', expectedRevision: 2 });
    const last = relay.answers.at(-1)!.action;
    expect(last.record.expected_revision).toBe(2);
    expect(last.envelope!.aad.revision).toBe(3);
    expect(
      await decryptEnvelope(last.envelope!, identity.epochs, { questionId: qid, revision: 3 }),
    ).toMatchObject({ selected_option_ids: ['reject'] });
  });

  it('an unreachable relay leaves it queued; the outbox resends the same signed body and reports the outcome', async () => {
    let t = Date.now();
    const { bridge, relay, store, qid, seen, identity } = await ownQuestion({ now: () => t });
    // A client that retries by itself: the answer's send must still be one attempt, left to the outbox.
    bridge.ctx.client = retryingClient(identity, relay);
    relay.rejectAnswer = [{ status: 503, code: 'temporarily_unavailable' }];
    const r = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(r.status).toBe('queued');
    expect(answerPosts(relay)).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(await ownerAnswers(store)).toHaveLength(1);

    // Not due yet: the pump leaves it alone.
    await bridge.pump();
    expect(answerPosts(relay)).toHaveLength(1);

    t += 10 * 60_000;
    await bridge.pump();
    const sent = { ...r, status: 'sent' };
    expect(seen).toEqual([sent]);
    expect(await bridge.getAnswerResult(r.answerId)).toEqual(sent);
    expect(relay.answers).toHaveLength(2);
    expect(relay.answers[1]).toEqual(relay.answers[0]);
  });

  it('a reply lost after the relay committed it resolves as sent on the retry', async () => {
    let t = Date.now();
    const { bridge, relay, qid, seen, identity } = await ownQuestion({ now: () => t });
    bridge.ctx.client = retryingClient(identity, relay);
    relay.dropAnswerReply = 1;
    const r = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(r.status).toBe('queued');
    expect(answerPosts(relay)).toHaveLength(1);
    // The committed answer arrives before the retry; it changes nothing about the outcome.
    await bridge.catchUp();
    expect((await bridge.getDecision(qid)).status).toBe('human-answered');
    t += 10 * 60_000;
    await bridge.pump();
    expect(seen).toEqual([{ ...r, status: 'sent' }]);
    expect(relay.events.filter((e) => e.event_type === 'decision.answer.committed')).toHaveLength(
      1,
    );
  });

  it('the same answer id is the same answer: never signed or sent twice, and never reused for another', async () => {
    const { bridge, relay, qid, seen } = await ownQuestion();
    const answerId = newId();
    const input = {
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
      answerId,
    };
    const [a, b] = await Promise.all([bridge.answerQuestion(input), bridge.answerQuestion(input)]);
    expect(a).toEqual({ answerId, questionId: qid, expectedRevision: 0, status: 'sent' });
    expect(b).toEqual(a);
    expect(await bridge.answerQuestion(input)).toEqual(a);
    expect(relay.answers).toHaveLength(1);
    expect(seen).toEqual([a]);
    await expect(
      bridge.answerQuestion({ ...input, selectedOptionIds: ['reject'] }),
    ).rejects.toMatchObject({ code: 'validation_error', message: /already used/ });
    await expect(bridge.answerQuestion({ ...input, expectedRevision: 1 })).rejects.toMatchObject({
      code: 'validation_error',
      message: /already used/,
    });
  });

  it('an outcome stored before a crash kept its item from being dropped stands: the answer is not sent again', async () => {
    let t = Date.now();
    const { bridge, relay, store, qid, seen } = await ownQuestion({ now: () => t });
    relay.rejectAnswer = [{ status: 503, code: 'temporarily_unavailable' }];
    const r = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(r.status).toBe('queued');
    // The crash: the outcome was stored, the item never deleted.
    const key = `owner-answer:${r.answerId}`;
    const settled = { ...r, status: 'unsupported' as const, by: 'asking-desktop' as const };
    await store.setMeta(
      key,
      JSON.stringify({ ...JSON.parse((await store.getMeta(key))!), result: settled }),
    );

    t += 10 * 60_000;
    await bridge.pump();
    expect(answerPosts(relay)).toHaveLength(1);
    expect(await ownerAnswers(store)).toEqual([]);
    expect(await bridge.getAnswerResult(r.answerId)).toEqual(settled);
    expect(seen).toEqual([settled]);
  });

  it('an id reserved but never queued (a crash in between) has no result, and repeating it sends the answer', async () => {
    let t = Date.now();
    const { bridge, relay, store, qid } = await ownQuestion({ now: () => t });
    relay.rejectAnswer = [{ status: 503, code: 'temporarily_unavailable' }];
    const answerId = newId();
    const input = {
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
      answerId,
    };
    expect((await bridge.answerQuestion(input)).status).toBe('queued');
    // The crash: the reservation was written, the item never was.
    for (const o of await ownerAnswers(store)) await store.deleteOutbox(o.id);
    expect(await bridge.getAnswerResult(answerId)).toBeNull();
    t += 10 * 60_000;
    expect(await bridge.answerQuestion(input)).toMatchObject({ answerId, status: 'sent' });
  });

  it('an answer waiting its turn when the bridge stops is not sent', async () => {
    const { bridge, relay, store, qid } = await ownQuestion();
    let release!: () => void;
    relay.holdAnswers = new Promise<void>((r) => (release = r));
    const first = bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    while (answerPosts(relay).length === 0) await tick(1);
    const second = bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['reject'],
    });
    while ((await ownerAnswers(store)).length < 2) await tick(1);
    // A pump waiting behind the same flush is called off too.
    const pumped = bridge.pump();
    await bridge.stop();
    release();
    await pumped;
    expect(await first).toMatchObject({ status: 'sent' });
    expect(await second).toMatchObject({ status: 'queued' });
    expect(answerPosts(relay)).toHaveLength(1);
  });

  it('a queued answer survives a restart and is sent by the next bridge on the same store', async () => {
    const path = join(dir, 'restart.db');
    let t = Date.now();
    const store = new SqliteLocalStore(path);
    const { bridge, relay, qid, identity } = await ownQuestion({ store, now: () => t });
    relay.rejectAnswer = [{ status: 503, code: 'temporarily_unavailable' }];
    const r = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(r.status).toBe('queued');
    await bridge.stop();
    store.close();

    const store2 = new SqliteLocalStore(path);
    const next = bridgeFor(identity, relay, store2, () => t);
    const seen = results(next.bridge);
    t += 10 * 60_000;
    // The new process sends what the old one signed, byte for byte.
    await next.bridge.publisher.flush();
    expect(seen).toEqual([{ ...r, status: 'sent' }]);
    expect(relay.answers.at(-1)).toEqual(relay.answers[0]);
    expect(await next.bridge.getAnswerResult(r.answerId)).toMatchObject({ status: 'sent' });
    store2.close();
  });

  it('a revoked desktop refuses, and an unknown answer id has no result', async () => {
    const { bridge, qid } = await ownQuestion();
    expect(await bridge.getAnswerResult(newId())).toBeNull();
    bridge.state = 'revoked';
    await expect(
      bridge.answerQuestion({
        questionId: qid,
        expectedRevision: 0,
        selectedOptionIds: ['approve'],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('answerQuestion is a host API', () => {
  it('is not one of the methods the MCP handler calls or a host forwards for a pane', () => {
    expect(MCP_BRIDGE_METHODS).not.toContain('answerQuestion');
    expect(MCP_BRIDGE_METHODS).not.toContain('getAnswerResult');
  });
});
