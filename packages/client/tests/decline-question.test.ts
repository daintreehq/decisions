import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSignedAction, newId } from '@daintreehq/decisions-crypto';
import {
  BridgeError,
  DecisionsBridge,
  MCP_BRIDGE_METHODS,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  ownerDeclineFromDetail,
  type Identity,
  type LocalStore,
  type OwnerDeclineResult,
} from '../src/index.js';
import { SqliteLocalStore } from '../src/store-sqlite.js';
import { FakeRelay, FakeSink, makeHost, makeIdentity, origin, setupBridge } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'decisions-decline-question-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/*
 * Issue #121: a host app declines a question for the person from the owner desktop (`declineQuestion`), for the owner's
 * own questions and a Remote Host's: a `cancel` signed with the owner's key that carries `decline: true` (protocol
 * section 6.1), sent through the outbox, with a result a UI can show. Withdrawing stays `cancelQuestion`.
 */

const OPTIONS = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];
const FEATURES = ['thread-messages-v1', 'owner-desktop-declines-v1'];
const DECLINED_LINES = 'source: human\nstatus: declined\nauthorised: no\n';

function results(bridge: DecisionsBridge): OwnerDeclineResult[] {
  const seen: OwnerDeclineResult[] = [];
  bridge.on('decline', (r) => seen.push(r));
  return seen;
}

const declinePosts = (relay: FakeRelay) =>
  relay.calls.filter(
    (c) =>
      c.method === 'POST' &&
      c.path.endsWith('/cancel') &&
      (c.body as { action: { record: { decline?: true } } }).action.record.decline === true,
  );

const detailReads = (relay: FakeRelay, qid: string) =>
  relay.calls.filter((c) => c.method === 'GET' && c.path === `/api/v1/questions/${qid}`).length;

const ownerDeclines = async (store: LocalStore) =>
  (await store.dueOutbox(Number.MAX_SAFE_INTEGER, 100)).filter((o) => o.kind === 'owner-decline');

/** The owner desktop asks a question of its own; the relay takes owner-desktop declines. */
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

/** A Remote Host asks; the owner desktop, which keeps no row for the Host's question, declines it. */
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

describe('declineQuestion on the owner’s own question', () => {
  it('signs a decline at the revision the person saw, and the agent is told it was declined', async () => {
    const { bridge, relay, sink, store, identity, qid, seen } = await ownQuestion();
    const r = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    expect(r).toEqual({
      declineId: expect.any(String),
      questionId: qid,
      expectedRevision: 0,
      status: 'declined',
    });

    expect(relay.declines).toHaveLength(1);
    const { idem, action } = relay.declines[0]!;
    expect(idem).toBe(r.declineId);
    expect(action.record).toMatchObject({
      action: 'cancel',
      action_id: r.declineId,
      question_id: qid,
      expected_revision: 0,
      decline: true,
      signer_device_id: identity.config.deviceId,
    });
    expect(action.envelope).toBeNull();
    expect(await ownerDeclines(store)).toEqual([]);
    expect(seen).toEqual([r]);
    expect(await bridge.getDeclineResult(r.declineId)).toEqual(r);

    // The desktop that asked files it as the person's decline, from the ledger, as it would a phone's.
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.text).toContain(DECLINED_LINES);
    expect(await bridge.getDecision(qid)).toMatchObject({
      status: 'cancelled',
      closedReason: 'declined',
      provenance: null,
    });
    const audit = await store.listAudit(100);
    expect(audit.find((a) => a.event === 'question.owner-decline')).toMatchObject({
      question_id: qid,
      result: 'declined',
    });
  });

  it('is never a withdrawal: cancelQuestion still withdraws, and the agent is told nothing', async () => {
    const { bridge, relay, sink, qid } = await ownQuestion();
    await bridge.cancelQuestion(qid);
    await bridge.pump();
    expect(relay.declines).toEqual([]);
    const cancels = relay.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cancel'));
    expect(cancels).toHaveLength(1);
    expect(
      (cancels[0]!.body as { action: { record: Record<string, unknown> } }).action.record,
    ).not.toHaveProperty('decline');
    expect(sink.typed).toEqual([]);
  });

  it('waits behind its question’s unsent create, then declines it', async () => {
    const { bridge, relay, store } = await setupBridge();
    relay.features = [...FEATURES];
    relay.down = 1;
    const asked = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Ship it?', options: OPTIONS },
    });
    await bridge.pump();
    expect((await store.getQuestion(asked.questionId))!.local_status).toBe('queued');

    const r = await bridge.declineQuestion({ questionId: asked.questionId, expectedRevision: 0 });
    expect(r.status).toBe('queued');
    expect(relay.declines).toEqual([]);

    for (const o of await store.dueOutbox(Number.MAX_SAFE_INTEGER, 100))
      await store.putOutbox({ ...o, next_attempt_at: 0 });
    await bridge.pump();
    expect(relay.questions.has(asked.questionId)).toBe(true);
    expect(await bridge.getDeclineResult(r.declineId)).toMatchObject({ status: 'declined' });
  });
});

describe('declineQuestion on a Remote Host’s question', () => {
  it('needs no local row: the owner signs and sends it, and the Host tells its agent it was declined', async () => {
    const { owner, relay, asking, ownerSide, qid } = await hostQuestion();
    expect(await ownerSide.store.getQuestion(qid)).toBeNull();

    const r = await ownerSide.bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    expect(r).toMatchObject({ questionId: qid, status: 'declined' });
    expect(relay.declines[0]!.action.record.signer_device_id).toBe(owner.config.deviceId);
    expect(await ownerSide.store.getQuestion(qid)).toBeNull();

    await asking.bridge.catchUp();
    expect(asking.sink.typed).toHaveLength(1);
    expect(asking.sink.typed[0]!.text).toContain(DECLINED_LINES);
    expect(await asking.bridge.getDecision(qid)).toMatchObject({
      status: 'cancelled',
      closedReason: 'declined',
    });
  });

  it('reports a Host that has not declared owner declines as the asking computer not supporting them', async () => {
    const { relay, host, ownerSide, qid } = await hostQuestion();
    relay.undeclaredDeclines.add(host.identity.config.deviceId);
    const r = await ownerSide.bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    expect(r).toMatchObject({ status: 'unsupported', by: 'asking-desktop' });
    expect(declinePosts(relay)).toHaveLength(1);
    expect(detailReads(relay, qid)).toBe(0);
  });

  it('is refused on a Remote Host before anything is signed, queued or sent', async () => {
    const { relay, host, asking, qid } = await hostQuestion();
    const before = relay.calls.length;
    await expect(
      asking.bridge.declineQuestion({ questionId: qid, expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'forbidden', message: /only the owner desktop/ });
    // Refused for what it is, before its input is even read.
    await expect(asking.bridge.declineQuestion({} as never)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      asking.bridge.publisher.enqueueOwnerDecline({ questionId: qid, expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await ownerDeclines(asking.store)).toEqual([]);
    expect(relay.calls.length).toBe(before);

    // Nor does the Host's relay client send one it signed by hand.
    const signed = await buildSignedAction({
      installationId: host.identity.config.installationId,
      questionId: qid,
      action: 'cancel',
      signerDeviceId: host.identity.config.deviceId,
      signingKey: host.identity.keys.signing.privateKey,
      expectedRevision: 0,
      decline: true,
    });
    await expect(
      asking.bridge.ctx.client.postAction('cancel', qid, signed.record.action_id, signed),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(relay.calls.length).toBe(before);
  });
});

describe('declineQuestion results a UI can show', () => {
  it('reports a relay that does not advertise owner declines, and sends nothing', async () => {
    const { bridge, relay, qid, seen } = await ownQuestion();
    relay.features = ['thread-messages-v1'];
    const r = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    expect(r).toMatchObject({ status: 'unsupported', by: 'relay' });
    expect(relay.declines).toEqual([]);
    expect(seen).toEqual([r]);
  });

  it('reports a relay that refuses the flag and stopped advertising it as unsupported by the relay', async () => {
    const { bridge, relay, qid } = await ownQuestion();
    // Read while the relay still advertised the feature, so the decline goes out and is refused.
    const first = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'And this?', options: OPTIONS },
    });
    await bridge.pump();
    expect(
      await bridge.declineQuestion({ questionId: first.questionId, expectedRevision: 0 }),
    ).toMatchObject({ status: 'declined' });

    relay.features = ['thread-messages-v1'];
    relay.rejectDecline.push({ status: 403, code: 'forbidden' });
    expect(await bridge.declineQuestion({ questionId: qid, expectedRevision: 0 })).toMatchObject({
      status: 'unsupported',
      by: 'relay',
    });
    expect(declinePosts(relay)).toHaveLength(2);

    // A 403 from a relay that still advertises it is a plain refusal.
    const b = await ownQuestion();
    b.relay.rejectDecline.push({ status: 403, code: 'forbidden' });
    expect(
      await b.bridge.declineQuestion({ questionId: b.qid, expectedRevision: 0 }),
    ).toMatchObject({ status: 'rejected', code: 'forbidden' });
  });

  it('an answer that came first is already answered, at a later revision or the same one', async () => {
    const a = await ownQuestion();
    a.relay.answerState.set(a.qid, { status: 'human-answered', revision: 1 });
    expect(
      await a.bridge.declineQuestion({ questionId: a.qid, expectedRevision: 0 }),
    ).toMatchObject({ status: 'already-answered' });
    expect(detailReads(a.relay, a.qid)).toBe(0);

    // A proxy answer at the revision the person saw: only the question's state says why it was refused.
    const b = await ownQuestion();
    b.relay.answerState.set(b.qid, { status: 'proxy-answered', revision: 1 });
    expect(
      await b.bridge.declineQuestion({ questionId: b.qid, expectedRevision: 1 }),
    ).toMatchObject({ status: 'already-answered' });
    expect(detailReads(b.relay, b.qid)).toBe(1);
  });

  it('a reopened question has changed, and an expired one is closed', async () => {
    const a = await ownQuestion();
    a.relay.answerState.set(a.qid, { status: 'open', revision: 1 });
    expect(
      await a.bridge.declineQuestion({ questionId: a.qid, expectedRevision: 0 }),
    ).toMatchObject({ status: 'changed' });

    const b = await ownQuestion();
    b.relay.answerState.set(b.qid, { status: 'expired', revision: 0 });
    expect(
      await b.bridge.declineQuestion({ questionId: b.qid, expectedRevision: 0 }),
    ).toMatchObject({ status: 'closed', reason: 'expired' });

    const c = await ownQuestion();
    c.relay.rejectDecline.push({ status: 410, code: 'expired' });
    expect(
      await c.bridge.declineQuestion({ questionId: c.qid, expectedRevision: 0 }),
    ).toMatchObject({ status: 'closed', reason: 'expired' });
  });

  it('a withdrawal that won first is closed, never declined, though the relay answers it alike', async () => {
    const { bridge, relay, sink, qid } = await ownQuestion();
    await bridge.cancelQuestion(qid);
    await bridge.pump();
    const r = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    expect(r).toMatchObject({ status: 'closed', reason: 'cancelled' });
    // The relay took the post as a no-op; only the question's action log tells it apart.
    expect(declinePosts(relay)).toHaveLength(1);
    expect(detailReads(relay, qid)).toBe(1);
    expect(sink.typed).toEqual([]);
  });

  it('a question the relay does not have is closed, and any other refusal is rejected with its code', async () => {
    const { bridge, relay } = await ownQuestion();
    expect(
      await bridge.declineQuestion({ questionId: newId(), expectedRevision: 0 }),
    ).toMatchObject({ status: 'closed', reason: 'not-found' });

    const b = await ownQuestion();
    b.relay.rejectDecline.push({ status: 400, code: 'validation_error' });
    expect(
      await b.bridge.declineQuestion({ questionId: b.qid, expectedRevision: 0 }),
    ).toMatchObject({ status: 'rejected', code: 'validation_error' });
    expect(relay.declines).toHaveLength(1);
  });

  it('refuses bad input, a reused id for another revision, and a revoked bridge', async () => {
    const { bridge, qid } = await ownQuestion();
    await expect(
      bridge.declineQuestion({ questionId: qid, expectedRevision: -1 }),
    ).rejects.toBeInstanceOf(BridgeError);
    await expect(
      bridge.declineQuestion({ questionId: qid, expectedRevision: 0, extra: 1 } as never),
    ).rejects.toMatchObject({ code: 'validation_error' });

    const declineId = newId();
    const first = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0, declineId });
    expect(first.status).toBe('declined');
    await expect(
      bridge.declineQuestion({ questionId: qid, expectedRevision: 1, declineId }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    bridge.state = 'revoked';
    await expect(
      bridge.declineQuestion({ questionId: qid, expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('is not an MCP method', () => {
    expect(MCP_BRIDGE_METHODS).not.toContain('declineQuestion' as never);
    expect(MCP_BRIDGE_METHODS).not.toContain('getDeclineResult' as never);
  });
});

describe('a decline is sent once and settled once', () => {
  it('the same decline id is the same decline: one post, one outcome', async () => {
    const { bridge, relay, qid, seen } = await ownQuestion();
    const declineId = newId();
    const a = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0, declineId });
    const b = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0, declineId });
    expect(a).toEqual(b);
    expect(a.status).toBe('declined');
    expect(relay.declines).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('a lost reply is queued, then the same signed body is replayed and confirmed as declined', async () => {
    const { bridge, relay, store, qid, seen } = await ownQuestion();
    relay.dropDeclineReply = 1;
    const r = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    expect(r.status).toBe('queued');
    expect(seen).toEqual([]);
    expect(await bridge.getDeclineResult(r.declineId)).toMatchObject({ status: 'queued' });

    for (const o of await ownerDeclines(store)) await store.putOutbox({ ...o, next_attempt_at: 0 });
    await bridge.pump();
    expect(relay.declines).toHaveLength(2);
    expect(relay.declines[1]!.action).toEqual(relay.declines[0]!.action);
    expect(relay.declines[1]!.idem).toBe(relay.declines[0]!.idem);
    const settled = await bridge.getDeclineResult(r.declineId);
    expect(settled).toMatchObject({ status: 'declined' });
    expect(seen).toEqual([settled]);
    expect(await ownerDeclines(store)).toEqual([]);
  });

  it('a confirmation that cannot be read is retried without posting the decline again', async () => {
    const { bridge, relay, store, qid } = await ownQuestion();
    relay.failDetail = 1;
    const r = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    expect(r.status).toBe('queued');
    const [item] = await ownerDeclines(store);
    expect(item!.payload).toMatchObject({ confirming: true });

    // Even a relay that stopped advertising the feature since: the decline was taken, and is only confirmed now.
    relay.features = ['thread-messages-v1'];
    await store.putOutbox({ ...item!, next_attempt_at: 0 });
    await bridge.pump();
    expect(relay.declines).toHaveLength(1);
    expect(await bridge.getDeclineResult(r.declineId)).toMatchObject({ status: 'declined' });
  });

  it('a decline that was taken stays declined once the question is reopened', async () => {
    const { bridge, relay, store, qid } = await ownQuestion();
    relay.failDetail = 1;
    const r = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    expect(r.status).toBe('queued');
    relay.answerState.set(qid, { status: 'open', revision: 1 });
    for (const o of await ownerDeclines(store)) await store.putOutbox({ ...o, next_attempt_at: 0 });
    await bridge.pump();
    expect(await bridge.getDeclineResult(r.declineId)).toMatchObject({ status: 'declined' });
  });

  it('an outcome stored before a crash removed its item is reported, never sent again', async () => {
    const { bridge, relay, store, qid, seen } = await ownQuestion();
    relay.dropDeclineReply = 1;
    const r = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    const [item] = await ownerDeclines(store);
    const stored: OwnerDeclineResult = { ...r, status: 'changed' };
    await store.setMeta(
      `owner-decline:${r.declineId}`,
      JSON.stringify({ question_id: qid, expected_revision: 0, result: stored }),
    );
    await store.putOutbox({ ...item!, next_attempt_at: 0 });
    await bridge.pump();
    expect(relay.declines).toHaveLength(1);
    expect(seen).toEqual([stored]);
    expect(await ownerDeclines(store)).toEqual([]);
  });
});

describe('a decline across ordering, collisions and restarts', () => {
  it('waits behind a queued withdrawal, which wins: closed, never declined', async () => {
    const { bridge, relay, store, sink, qid } = await ownQuestion();
    relay.down = 1;
    await bridge.cancelQuestion(qid);
    await bridge.pump();
    expect((await store.dueOutbox(Number.MAX_SAFE_INTEGER, 100)).map((o) => o.kind)).toEqual([
      'cancel',
    ]);

    const r = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    expect(r.status).toBe('queued');
    expect(declinePosts(relay)).toEqual([]);

    for (const o of await store.dueOutbox(Number.MAX_SAFE_INTEGER, 100))
      await store.putOutbox({ ...o, next_attempt_at: 0 });
    await bridge.pump();
    const cancels = relay.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cancel'));
    expect(
      cancels.map(
        (c) => (c.body as { action: { record: { decline?: true } } }).action.record.decline,
      ),
    ).toEqual([undefined, true]);
    expect(await bridge.getDeclineResult(r.declineId)).toMatchObject({
      status: 'closed',
      reason: 'cancelled',
    });
    expect(sink.typed).toEqual([]);
  });

  it('a decline id an answer already used is refused by the relay, never read as that answer', async () => {
    const { bridge, relay, qid } = await ownQuestion();
    relay.features = [...FEATURES, 'owner-desktop-answers-v1'];
    const answered = await bridge.answerQuestion({
      questionId: qid,
      expectedRevision: 0,
      selectedOptionIds: ['approve'],
    });
    expect(answered.status).toBe('sent');
    expect(
      await bridge.declineQuestion({
        questionId: qid,
        expectedRevision: 0,
        declineId: answered.answerId,
      }),
    ).toMatchObject({ status: 'rejected', code: 'idempotency_collision' });
  });

  it('a decline being confirmed is settled by the next process from the question alone', async () => {
    const path = join(dir, 'confirming.db');
    let t = Date.now();
    const store = new SqliteLocalStore(path);
    const { bridge, relay, qid, identity } = await ownQuestion({ store, now: () => t });
    relay.failDetail = 1;
    const r = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    expect(r.status).toBe('queued');
    await bridge.stop();
    store.close();

    // The relay has stopped advertising declines since; the new process has never read what it advertises.
    relay.features = ['thread-messages-v1'];
    const store2 = new SqliteLocalStore(path);
    const next = bridgeFor(identity, relay, store2, () => t);
    const seen = results(next.bridge);
    t += 10 * 60_000;
    await next.bridge.publisher.flush();
    expect(relay.declines).toHaveLength(1);
    expect(seen).toEqual([{ ...r, status: 'declined' }]);
    store2.close();

    const store3 = new SqliteLocalStore(path);
    const third = bridgeFor(identity, relay, store3, () => t);
    expect(await third.bridge.getDeclineResult(r.declineId)).toEqual({ ...r, status: 'declined' });
    store3.close();
  });

  it('a decline whose answer was lost is looked for before it is called unsupported', async () => {
    const path = join(dir, 'lost.db');
    let t = Date.now();
    const store = new SqliteLocalStore(path);
    const { bridge, relay, qid, identity } = await ownQuestion({ store, now: () => t });
    relay.dropDeclineReply = 1;
    const taken = await bridge.declineQuestion({ questionId: qid, expectedRevision: 0 });
    expect(taken.status).toBe('queued');

    // A second decline that never reached the relay at all.
    const other = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'And this?', options: OPTIONS },
    });
    await bridge.pump();
    relay.down = 1;
    const lost = await bridge.declineQuestion({
      questionId: other.questionId,
      expectedRevision: 0,
    });
    expect(lost.status).toBe('queued');
    await bridge.stop();
    store.close();

    relay.features = ['thread-messages-v1'];
    const store2 = new SqliteLocalStore(path);
    const next = bridgeFor(identity, relay, store2, () => t);
    t += 10 * 60_000;
    await next.bridge.publisher.flush();
    // Neither is posted again: the one the relay took is found on its question, the other one is unsupported.
    expect(relay.declines).toHaveLength(1);
    expect(await next.bridge.getDeclineResult(taken.declineId)).toMatchObject({
      status: 'declined',
    });
    expect(await next.bridge.getDeclineResult(lost.declineId)).toMatchObject({
      status: 'unsupported',
      by: 'relay',
    });
    store2.close();
  });
});

describe('ownerDeclineFromDetail', () => {
  it('finds this very decline by its id and signature, and reads anything else from the state', async () => {
    const owner = await makeIdentity();
    const signed = await buildSignedAction({
      installationId: owner.config.installationId,
      questionId: newId(),
      action: 'cancel',
      signerDeviceId: owner.config.deviceId,
      signingKey: owner.keys.signing.privateKey,
      expectedRevision: 2,
      decline: true,
    });
    const own = { action_id: signed.record.action_id, record: signed.record };
    expect(ownerDeclineFromDetail({ status: 'open', revision: 3, actions: [own] }, signed)).toEqual(
      { status: 'declined' },
    );
    // The same id under another signature is not this decline.
    const forged = { ...own, record: { ...signed.record, signature: 'x'.repeat(86) } };
    expect(
      ownerDeclineFromDetail({ status: 'cancelled', revision: 2, actions: [forged] }, signed),
    ).toEqual({ status: 'closed', reason: 'cancelled' });
    expect(ownerDeclineFromDetail({ status: 'open', revision: 2, actions: [] }, signed)).toEqual({
      status: 'rejected',
      code: 'not_committed',
    });
    expect(ownerDeclineFromDetail({ nope: true }, signed)).toBeNull();
  });
});
