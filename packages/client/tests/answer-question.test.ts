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
} from '../src/index.js';
import { SqliteLocalStore } from '../src/store-sqlite.js';
import { FakeRelay, FakeSink, makeHost, makeIdentity, origin, setupBridge } from './helpers.js';

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
      bridge.answerQuestion({ questionId: qid, expectedRevision: -1, selectedOptionIds: ['approve'] }),
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
    await expect(asking.bridge.publisher.enqueueOwnerAnswer({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
      reviewedAttachmentDigests: [],
    })).rejects.toMatchObject({ code: 'forbidden' });
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
        details: { reason: 'creator-missing-feature', required_feature: 'owner-desktop-answers-v1' },
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
      expect(r).toEqual({ answerId: expect.any(String), questionId: qid, expectedRevision: 0, ...c.expected });
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
    relay.holdAnswers = Promise.resolve().then(() => {
      relay.features = ['thread-messages-v1'];
    });
    const r = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(r).toMatchObject({ status: 'unsupported', by: 'relay' });
  });

  it('an unreachable relay leaves it queued; the outbox resends the same signed body and reports the outcome', async () => {
    let t = Date.now();
    const { bridge, relay, store, qid, seen } = await ownQuestion({ now: () => t });
    relay.rejectAnswer = [{ status: 503, code: 'temporarily_unavailable' }];
    const r = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(r.status).toBe('queued');
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
    const { bridge, relay, qid, seen } = await ownQuestion({ now: () => t });
    relay.dropAnswerReply = 1;
    const r = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(r.status).toBe('queued');
    // The committed answer arrives before the retry; it changes nothing about the outcome.
    await bridge.catchUp();
    expect((await bridge.getDecision(qid)).status).toBe('human-answered');
    t += 10 * 60_000;
    await bridge.pump();
    expect(seen).toEqual([{ ...r, status: 'sent' }]);
    expect(relay.events.filter((e) => e.event_type === 'decision.answer.committed')).toHaveLength(1);
  });

  it('the same answer id is the same answer: never signed or sent twice, and never reused for another', async () => {
    const { bridge, relay, qid, seen } = await ownQuestion();
    const answerId = newId();
    const input = { questionId: qid, expectedRevision: 0, selectedOptionIds: ['approve'], answerId };
    const [a, b] = await Promise.all([bridge.answerQuestion(input), bridge.answerQuestion(input)]);
    expect(a).toEqual({ answerId, questionId: qid, expectedRevision: 0, status: 'sent' });
    expect(b).toEqual(a);
    expect(await bridge.answerQuestion(input)).toEqual(a);
    expect(relay.answers).toHaveLength(1);
    expect(seen).toEqual([a]);
    await expect(
      bridge.answerQuestion({ ...input, selectedOptionIds: ['reject'] }),
    ).rejects.toMatchObject({ code: 'validation_error', message: /already used/ });
    await expect(
      bridge.answerQuestion({ ...input, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'validation_error', message: /already used/ });
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
      bridge.answerQuestion({ questionId: qid, expectedRevision: 0, selectedOptionIds: ['approve'] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('answerQuestion is a host API', () => {
  it('is not one of the methods the MCP handler calls or a host forwards for a pane', () => {
    expect(MCP_BRIDGE_METHODS).not.toContain('answerQuestion');
    expect(MCP_BRIDGE_METHODS).not.toContain('getAnswerResult');
  });
});
