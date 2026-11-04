import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AgentMessageContentV1,
  LIMITS,
  SignedMessage,
  type SignedMessage as SignedMessageT,
} from '@daintreehq/decisions-protocol';
import { decryptEnvelope, verifyRecordAndEnvelope } from '@daintreehq/decisions-crypto';
import {
  BridgeError,
  DecisionsBridge,
  RelayClient,
  paneIdentityOf,
  type LocalStore,
} from '../src/index.js';
import { SqliteLocalStore } from '../src/store-sqlite.js';
import { FakeRelay, FakeSink, makeIdentity, origin, setupBridge, tick } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'decisions-thread-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const pane = paneIdentityOf(origin());
type Env = Awaited<ReturnType<typeof setupBridge>>;

/** Make every outbox item due now, as if its backoff had passed. */
async function due(store: LocalStore): Promise<void> {
  for (const o of await store.dueOutbox(Number.MAX_SAFE_INTEGER, 1000))
    await store.putOutbox({ ...o, next_attempt_at: 0 });
}

/** Ask a question and publish it. */
async function asked(env: Env, question = 'Which colour?'): Promise<string> {
  const r = await env.bridge.registerQuestion({ origin: origin(), input: { question } });
  await env.bridge.pump();
  expect((await env.store.getQuestion(r.questionId))!.local_status).toBe('open');
  return r.questionId;
}

const post = (env: Env, questionId: string, text: string, expectsReply = false) =>
  env.bridge.postMessage({ question_id: questionId, text, expects_reply: expectsReply }, pane);

/** Settle the background pumps the calls started, then flush whatever is left. */
async function settle(env: Env): Promise<void> {
  await tick();
  await env.bridge.pump();
  await env.bridge.pump();
}

const messagePosts = (env: Env) =>
  env.relay.calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.path));

async function refused(p: Promise<unknown>): Promise<BridgeError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(BridgeError);
  return e as BridgeError;
}

describe('thread messages: what is published', () => {
  it('an agent message is encrypted, signed by this desktop, and carries expects_reply in the record', async () => {
    const env = await setupBridge();
    const qid = await asked(env);
    const r = await post(env, qid, 'Did you mean the dark red?', true);
    expect(r).toMatchObject({ questionId: qid, status: 'queued', expectsReply: true, alias: 1 });
    await settle(env);

    expect(env.relay.messages).toHaveLength(1);
    const sent = env.relay.messages[0]!.message;
    expect(SignedMessage.safeParse(sent).success).toBe(true);
    expect(sent.record).toMatchObject({
      question_id: qid,
      message_id: r.messageId,
      side: 'agent',
      expects_reply: true,
      attachment_ids: [],
      signer_device_id: env.identity.config.deviceId,
    });
    expect(
      await verifyRecordAndEnvelope(sent.record, sent.envelope, env.identity.keys.signing.publicKey),
    ).toBe(true);
    const plain = await decryptEnvelope(sent.envelope, env.identity.epochs, {
      questionId: qid,
      revision: 0,
    });
    expect(AgentMessageContentV1.parse(plain)).toEqual({
      content_version: 1,
      side: 'agent',
      text: 'Did you mean the dark red?',
    });
    // the ciphertext is the only copy of the text: nothing in clear went over the wire
    expect(JSON.stringify(messagePosts(env)[0]!.body)).not.toContain('dark red');
    expect(await env.store.outboxFor(qid)).toHaveLength(0);
  });

  it('expects_reply false reaches the record as false', async () => {
    const env = await setupBridge();
    const qid = await asked(env);
    await post(env, qid, 'Going with red unless you say otherwise.', false);
    await settle(env);
    expect(env.relay.messages[0]!.message.record.expects_reply).toBe(false);
  });

  it('a message never changes the decision: status, revision, answers and gate stay as they were', async () => {
    const env = await setupBridge();
    const qid = await asked(env);
    await env.relay.answerEvent({ questionId: qid, phone: env.phone, text: 'red' });
    await env.bridge.catchUp();
    const before = await env.bridge.getDecision(qid, pane);
    expect(before.status).toBe('human-answered');
    await post(env, qid, 'Thanks. Should the hover state be darker too?', true);
    await settle(env);
    expect(env.relay.messages).toHaveLength(1);
    expect(await env.bridge.getDecision(qid, pane)).toEqual(before);
    expect(env.relay.calls.some((c) => /\/(answer|override|confirm-proxy)$/.test(c.path))).toBe(
      false,
    );
  });
});

describe('thread messages: who may post', () => {
  it('another pane, a relaunched pane and an unknown id are refused alike', async () => {
    const env = await setupBridge();
    const qid = await asked(env);
    const unknown = await refused(
      env.bridge.postMessage({ question_id: 'q_nope', text: 'hi', expects_reply: false }, pane),
    );
    expect([unknown.code, unknown.message]).toEqual(['not_found', 'unknown question']);
    const strangers = [
      { host_id: 'host-2' },
      { pane_id: 'pane-2' },
      { terminal_generation: 2 },
      { ownership_principal: 'principal-2' },
      { agent_incarnation: 'inc-2' },
      { agent_session_id: 'sess-2' },
      { worktree_id: 'wt-2' },
    ];
    for (const over of strangers) {
      const e = await refused(
        env.bridge.postMessage(
          { question_id: qid, text: 'hi', expects_reply: false },
          paneIdentityOf(origin(over)),
        ),
      );
      expect([e.code, e.message]).toEqual([unknown.code, unknown.message]);
    }
    // no unscoped form, whatever a caller passes
    const unscoped = await refused(
      env.bridge.postMessage(
        { question_id: qid, text: 'hi', expects_reply: false },
        undefined as never,
      ),
    );
    expect(unscoped.code).toBe('not_found');
    expect(await env.store.outboxFor(qid)).toHaveLength(0);
  });

  it('imported history is not this pane’s to post on', async () => {
    const env = await setupBridge();
    const qid = await asked(env);
    await env.store.updateQuestion(qid, { history_only: true });
    expect((await refused(post(env, qid, 'hi'))).code).toBe('not_found');
  });
});

describe('thread messages: limits and closed threads', () => {
  it('text must be non-blank and at most 16 KiB of UTF-8; expects_reply must be a boolean', async () => {
    const env = await setupBridge();
    const qid = await asked(env);
    const big = await refused(post(env, qid, 'é'.repeat(LIMITS.messageTextBytes / 2 + 1)));
    expect(big.code).toBe('validation_error');
    expect(big.message).toContain('16 KiB');
    expect((await refused(post(env, qid, '  \n '))).message).toContain('text is empty');
    const flag = await refused(
      env.bridge.postMessage({ question_id: qid, text: 'hi', expects_reply: 'yes' }, pane),
    );
    expect(flag.message).toContain('expects_reply');
    const missing = await refused(env.bridge.postMessage({ question_id: qid, text: 'hi' }, pane));
    expect(missing.message).toContain('expects_reply');
    // exactly at the limit is fine
    await post(env, qid, 'é'.repeat(LIMITS.messageTextBytes / 2));
    expect(await env.store.outboxFor(qid)).toHaveLength(1);
  });

  it('cancelled, expired, never-published and cancelling questions take no messages', async () => {
    const env = await setupBridge();
    const cases: [Parameters<LocalStore['updateQuestion']>[1], string][] = [
      [{ local_status: 'cancelled' }, 'invalid_state'],
      [{ local_status: 'expired' }, 'expired'],
      [{ local_status: 'publish-failed' }, 'invalid_state'],
    ];
    for (const [patch, code] of cases) {
      const qid = await asked(env);
      await env.store.updateQuestion(qid, patch);
      expect((await refused(post(env, qid, 'hi'))).code).toBe(code);
    }
    // a cancel still on its way to the relay
    const qid = await asked(env);
    env.relay.down = 1000;
    await env.bridge.cancelQuestion(qid, pane);
    await tick();
    const e = await refused(post(env, qid, 'hi'));
    expect([e.code, e.message]).toEqual([
      'invalid_state',
      'q-4 is being cancelled, so its thread takes no more messages',
    ]);
  });

  it('a question accepts at most its lifetime budget of messages from this desktop', async () => {
    const env = await setupBridge();
    const qid = await asked(env);
    env.relay.down = 1_000_000; // stay offline: queued messages count too
    for (let i = 0; i < LIMITS.messagesPerQuestion; i++) await post(env, qid, `note ${i}`);
    const e = await refused(post(env, qid, 'one more'));
    expect(e.code).toBe('invalid_state');
    expect(e.message).toContain(`limit of ${LIMITS.messagesPerQuestion} messages`);
    // sending them does not free the budget
    env.relay.down = 0;
    await due(env.store);
    for (let i = 0; i < 20 && (await env.store.outboxFor(qid)).length > 0; i++) {
      await env.bridge.pump();
      await due(env.store);
    }
    expect(env.relay.messages).toHaveLength(LIMITS.messagesPerQuestion);
    expect((await refused(post(env, qid, 'still no'))).code).toBe('invalid_state');
  });
});

describe('thread messages: the durable outbox', () => {
  it('offline: the call returns at once, and the message follows its question when the relay comes back', async () => {
    const env = await setupBridge();
    env.relay.down = 1000;
    const q = await env.bridge.registerQuestion({ origin: origin(), input: { question: 'q' } });
    const r = await post(env, q.questionId, 'More context: the button is on the settings page.');
    expect(r.status).toBe('queued');
    await settle(env);
    expect(env.relay.messages).toHaveLength(0);
    env.relay.down = 0;
    await due(env.store);
    await env.bridge.pump();
    await due(env.store);
    await env.bridge.pump();
    const paths = env.relay.calls
      .filter((c) => c.method === 'POST')
      .map((c) => c.path.replace(q.questionId, '{id}'));
    expect(paths.indexOf('/api/v1/questions')).toBeLessThan(
      paths.indexOf('/api/v1/questions/{id}/messages'),
    );
    expect(env.relay.messages.map((m) => m.message.record.message_id)).toEqual([r.messageId]);
  });

  it("one thread's messages go out in order, even when the first is backing off", async () => {
    const env = await setupBridge();
    const qid = await asked(env);
    env.relay.down = 1000;
    const first = await post(env, qid, 'first', true);
    await settle(env); // the first attempt fails and backs off
    env.relay.down = 0;
    const second = await post(env, qid, 'second', false);
    await settle(env); // the second is due, the first is not: the second must wait
    expect(env.relay.messages).toHaveLength(0);
    await due(env.store);
    await env.bridge.pump();
    expect(env.relay.messages.map((m) => m.message.record.message_id)).toEqual([
      first.messageId,
      second.messageId,
    ]);
  });

  it('a lost reply is retried with the same signed body, so the relay keeps one message', async () => {
    const env = await setupBridge();
    const qid = await asked(env);
    env.relay.dropMessageReply = 1;
    await post(env, qid, 'Once only.', true);
    await settle(env);
    expect(await env.store.outboxFor(qid)).toHaveLength(1); // the relay committed it, we do not know
    await due(env.store);
    await env.bridge.pump();
    const posts = messagePosts(env);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    expect(env.relay.messages).toHaveLength(1);
    expect(await env.store.outboxFor(qid)).toHaveLength(0);
  });

  it('a queued message survives a restart (SQLite) and is posted by the next process', async () => {
    const identity = await makeIdentity();
    const relay = new FakeRelay(identity);
    await relay.initOwner();
    const dbPath = join(tmp, 'restart.db');
    const mk = (store: SqliteLocalStore) =>
      new DecisionsBridge({
        identity,
        store,
        sink: new FakeSink(),
        pumpIntervalMs: 0,
        client: new RelayClient({ identity, fetch: relay.fetch, sleep: async () => {}, maxRetries: 0 }),
      });
    const s1 = new SqliteLocalStore(dbPath);
    const b1 = mk(s1);
    relay.down = 1000;
    const q = await b1.registerQuestion({ origin: origin(), input: { question: 'q' } });
    const m = await b1.postMessage(
      { question_id: q.questionId, text: 'Written while offline.', expects_reply: true },
      pane,
    );
    await tick();
    await b1.pump();
    await s1.close();

    relay.down = 0;
    const s2 = new SqliteLocalStore(dbPath);
    const b2 = mk(s2);
    await due(s2);
    await b2.pump();
    await due(s2);
    await b2.pump();
    expect(relay.messages.map((x) => x.message.record.message_id)).toEqual([m.messageId]);
    expect(relay.messages[0]!.message.record.expects_reply).toBe(true);
    expect(await s2.outboxFor(q.questionId)).toHaveLength(0);
    await s2.close();
  });

  it('a question that is never published takes its queued messages with it', async () => {
    const env = await setupBridge();
    // cancelled before it was ever sent
    const a = await env.bridge.publisher.register(origin(), { question: 'a' });
    await env.bridge.publisher.enqueueMessage(a.questionId, {
      question_id: a.questionId,
      text: 'note',
      expects_reply: false,
    });
    await env.bridge.cancelQuestion(a.questionId, pane);
    expect(await env.store.outboxFor(a.questionId)).toHaveLength(0);
    // refused by the relay
    env.relay.rejectCreate = 400;
    const b = await env.bridge.publisher.register(origin(), { question: 'b' });
    await env.bridge.publisher.enqueueMessage(b.questionId, {
      question_id: b.questionId,
      text: 'note',
      expects_reply: false,
    });
    await env.bridge.pump();
    expect((await env.store.getQuestion(b.questionId))!.local_status).toBe('publish-failed');
    expect(await env.store.outboxFor(b.questionId)).toHaveLength(0);
    expect(messagePosts(env)).toHaveLength(0);
    const audit = await env.store.listAudit(50);
    expect(audit.filter((x) => x.event === 'outbox.message.dropped')).toHaveLength(2);
  });

  it('a refused message is dropped and audited without touching its question', async () => {
    const env = await setupBridge();
    const qid = await asked(env);
    env.relay.rejectMessage = { status: 409, code: 'invalid_state' };
    await post(env, qid, 'too late');
    await settle(env);
    expect(await env.store.outboxFor(qid)).toHaveLength(0);
    expect((await env.store.getQuestion(qid))!.local_status).toBe('open');
    const audit = await env.store.listAudit(50);
    expect(audit.some((x) => x.event === 'outbox.message.rejected' && x.result === 'invalid_state')).toBe(true);
  });
});

describe('thread messages: relay features', () => {
  it('a relay that does not advertise threads is never sent one, and later calls are refused at once', async () => {
    const env = await setupBridge();
    env.relay.features = undefined; // a 0.3.0 relay
    const qid = await asked(env);
    await post(env, qid, 'hello?');
    await settle(env);
    expect(messagePosts(env)).toHaveLength(0);
    expect(await env.store.outboxFor(qid)).toHaveLength(0);
    const audit = await env.store.listAudit(50);
    expect(audit.some((x) => x.event === 'outbox.message.rejected' && x.result === 'not_supported')).toBe(true);
    const e = await refused(post(env, qid, 'again?'));
    expect(e.code).toBe('not_supported');
    expect(await env.store.outboxFor(qid)).toHaveLength(0);
  });

  it('an upgraded relay is picked up once what it advertised has gone stale', async () => {
    let now = Date.now();
    const env = await setupBridge({ now: () => now });
    env.relay.features = [];
    const qid = await asked(env);
    await post(env, qid, 'hello?');
    await settle(env);
    expect((await refused(post(env, qid, 'again?'))).code).toBe('not_supported');
    env.relay.features = ['thread-messages-v1'];
    now += 61_000;
    // the first call after the cache went stale is still refused, but reads /info again
    expect((await refused(post(env, qid, 'again?'))).code).toBe('not_supported');
    await tick();
    const ok = await post(env, qid, 'third time');
    await settle(env);
    expect(env.relay.messages.map((m) => m.message.record.message_id)).toEqual([ok.messageId]);
  });

  it('failing to read /info backs off the message alone; other questions still publish', async () => {
    const env = await setupBridge();
    const qid = await asked(env);
    env.relay.failInfo = 1;
    await env.bridge.publisher.enqueueMessage(qid, {
      question_id: qid,
      text: 'note',
      expects_reply: false,
    });
    const other = await env.bridge.publisher.register(origin(), { question: 'another' });
    await env.bridge.pump();
    expect((await env.store.getQuestion(other.questionId))!.local_status).toBe('open');
    const [held] = await env.store.outboxFor(qid);
    expect(held).toMatchObject({ kind: 'message', attempts: 1, last_error: 'network_error' });
    await due(env.store);
    await env.bridge.pump();
    expect(env.relay.messages).toHaveLength(1);
  });

  it('postMessage on the relay client refuses a human-side message', async () => {
    const env = await setupBridge();
    const fake = { record: { side: 'human' } } as unknown as SignedMessageT;
    await expect(env.client.postMessage('q', 'idem', fake)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(messagePosts(env)).toHaveLength(0);
  });
});

