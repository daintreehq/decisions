import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decryptEnvelope, newId, verifyRecordAndEnvelope } from '@daintreehq/decisions-crypto';
import { importSigningPublicKey } from '@daintreehq/decisions-crypto';
import {
  DecisionsBridge,
  MCP_BRIDGE_METHODS,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  type Identity,
  type LocalStore,
  type OwnerFollowUpResult,
} from '../src/index.js';
import { SqliteLocalStore } from '../src/store-sqlite.js';
import { FakeRelay, FakeSink, makeHost, makeIdentity, origin, setupBridge, tick } from './helpers.js';

/*
 * Issue #119: a host app publishes the person's follow-up from the owner desktop (`sendFollowUp`), on the owner's own
 * questions and a Remote Host's, signed with the owner's key and sent through the outbox, with a result a UI can show.
 */

const dir = mkdtempSync(join(tmpdir(), 'decisions-send-followup-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FEATURES = ['thread-messages-v1', 'owner-desktop-messages-v1'];

function results(bridge: DecisionsBridge): OwnerFollowUpResult[] {
  const seen: OwnerFollowUpResult[] = [];
  bridge.on('followUp', (r) => seen.push(r));
  return seen;
}

const messagePosts = (relay: FakeRelay) =>
  relay.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages'));

const ownerMessages = async (store: LocalStore) =>
  (await store.dueOutbox(Number.MAX_SAFE_INTEGER, 100)).filter((o) => o.kind === 'owner-message');

/** The owner desktop asks a question of its own and types follow-ups; the relay takes the owner's. */
async function ownQuestion(extra: Parameters<typeof setupBridge>[0] = {}) {
  const env = await setupBridge({ followUps: true, ...extra });
  env.relay.features = [...FEATURES];
  env.relay.postMessageEvents = true;
  const r = await env.bridge.registerQuestion({
    origin: origin(),
    input: { question: 'Ship it?', options: [{ id: 'ship', label: 'Ship' }] },
  });
  await env.bridge.pump();
  return { ...env, qid: r.questionId, alias: r.alias, seen: results(env.bridge) };
}

function bridgeFor(
  identity: Identity,
  relay: FakeRelay,
  o: { store?: LocalStore; now?: () => number; followUps?: boolean } = {},
) {
  const sink = new FakeSink();
  sink.addPane('pane-1');
  const store = o.store ?? new MemoryLocalStore();
  const bridge = new DecisionsBridge({
    identity,
    store,
    sink,
    client: new RelayClient({ identity, fetch: relay.fetch, sleep: async () => {}, maxRetries: 0 }),
    policy: new PolicyRegistry(),
    pumpIntervalMs: 0,
    ...(o.now ? { now: o.now } : {}),
    ...(o.followUps ? { followUps: true } : {}),
  });
  return { bridge, sink, store };
}

/** A Remote Host asks (and types follow-ups); the owner desktop, which keeps no row for it, sends one. */
async function hostQuestion() {
  const owner = await makeIdentity();
  const relay = new FakeRelay(owner);
  await relay.initOwner();
  relay.features = [...FEATURES];
  relay.postMessageEvents = true;
  const host = await makeHost(owner, relay);
  const asking = bridgeFor(host.identity, relay, { followUps: true });
  const r = await asking.bridge.registerQuestion({
    origin: origin({ host_id: 'host-remote' }),
    input: { question: 'Rebuild the cache?' },
  });
  await asking.bridge.pump();
  const ownerSide = bridgeFor(owner, relay);
  return { owner, relay, host, asking, ownerSide, qid: r.questionId };
}

describe('sendFollowUp on the owner’s own question', () => {
  it('signs the person’s message with the owner key, sends it, and the pane gets it as sent from the computer', async () => {
    const { bridge, relay, sink, store, identity, qid, alias, seen } = await ownQuestion();
    const before = (await store.getQuestion(qid))!;
    const r = await bridge.sendFollowUp({ questionId: qid, text: 'Hold on, check the docs.' });
    expect(r).toEqual({ messageId: expect.any(String), questionId: qid, status: 'sent' });
    expect(seen).toEqual([r]);
    expect(await bridge.getFollowUpResult(r.messageId)).toEqual(r);

    expect(relay.messages).toHaveLength(1);
    const { idem, message } = relay.messages[0]!;
    expect(idem).toBe(r.messageId);
    expect(message.record).toMatchObject({
      message_id: r.messageId,
      question_id: qid,
      side: 'human',
      expects_reply: false,
      attachment_ids: [],
      signer_device_id: identity.config.deviceId,
    });
    expect(
      await verifyRecordAndEnvelope(
        message.record,
        message.envelope,
        await importSigningPublicKey(identity.signingPub),
      ),
    ).toBe(true);
    expect(
      await decryptEnvelope(message.envelope, identity.epochs, {
        installationId: identity.config.installationId,
        questionId: qid,
        recordType: 'thread.message',
        revision: 0,
      }),
    ).toEqual({ content_version: 1, side: 'human', text: 'Hold on, check the docs.', images: [] });

    // The relay's commit comes back as an event: this desktop asked, so it types it into the pane.
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.text).toContain(
      `question_id: ${qid} (q-${alias})\nmessage_id: ${r.messageId}\n`,
    );
    expect(sink.typed[0]!.text).toContain('source: human\nsent_from: computer\n');
    const view = await bridge.getDecision(qid);
    expect(view.thread).toEqual([
      expect.objectContaining({ kind: 'message', side: 'human', sentFrom: 'computer' }),
    ]);
    // A follow-up answers nothing.
    const after = (await store.getQuestion(qid))!;
    expect(after.local_status).toBe(before.local_status);
    expect(after.question_revision).toBe(before.question_revision);
    expect(after.answers_json).toBe(before.answers_json);
    // Nothing the person wrote is kept in the clear.
    expect(await store.getMeta(`owner-message:${r.messageId}`)).not.toContain('check the docs');
    expect(JSON.stringify(await store.listAudit(100))).not.toContain('check the docs');
  });

  it('goes to an answered question too: a follow-up after the answer', async () => {
    const { bridge, relay, phone, qid } = await ownQuestion();
    await relay.answerEvent({ questionId: qid, phone, options: ['ship'] });
    relay.answerState.set(qid, { status: 'human-answered', revision: 1 });
    await bridge.catchUp();
    const r = await bridge.sendFollowUp({ questionId: qid, text: 'Also tag the release.' });
    expect(r.status).toBe('sent');
    expect((await bridge.getDecision(qid)).status).toBe('human-answered');
  });

  it('refuses empty text and anything but text before signing', async () => {
    const { bridge, store, relay, qid } = await ownQuestion();
    await expect(bridge.sendFollowUp({ questionId: qid, text: '   ' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      bridge.sendFollowUp({
        questionId: qid,
        text: 'hi',
        expectsReply: true,
      } as unknown as Parameters<DecisionsBridge['sendFollowUp']>[0]),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(await ownerMessages(store)).toEqual([]);
    expect(messagePosts(relay)).toEqual([]);
  });

  it('waits behind its question’s unsent create, then follows it', async () => {
    let t = Date.now();
    const env = await setupBridge({ followUps: true, now: () => t });
    env.relay.features = [...FEATURES];
    env.relay.down = 1; // the create fails and backs off
    const { questionId: qid } = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Ship it?' },
    });
    await env.bridge.pump();
    expect(env.relay.questions.has(qid)).toBe(false);

    const r = await env.bridge.sendFollowUp({ questionId: qid, text: 'One more thing.' });
    expect(r).toEqual({ messageId: r.messageId, questionId: qid, status: 'queued' });
    expect(await env.bridge.getFollowUpResult(r.messageId)).toEqual(r);
    expect(messagePosts(env.relay)).toEqual([]);

    t += 10 * 60_000;
    await env.bridge.pump();
    const posts = env.relay.calls
      .filter((c) => c.method === 'POST' && c.path.startsWith('/api/v1/questions'))
      .map((c) => c.path);
    expect(posts).toEqual(['/api/v1/questions', `/api/v1/questions/${qid}/messages`]);
    expect(await env.bridge.getFollowUpResult(r.messageId)).toMatchObject({ status: 'sent' });
  });

  it('never overtakes a withdrawal already queued, and is then closed', async () => {
    let t = Date.now();
    const { bridge, relay, qid, seen } = await ownQuestion({ now: () => t });
    relay.status5xx = 1; // the cancellation backs off
    await bridge.cancelQuestion(qid);
    await bridge.pump();
    const r = await bridge.sendFollowUp({ questionId: qid, text: 'Wait!' });
    expect(r.status).toBe('queued');
    expect(messagePosts(relay)).toEqual([]);

    t += 10 * 60_000;
    await bridge.pump();
    const posts = relay.calls
      .filter((c) => c.method === 'POST' && /\/(cancel|messages)$/.test(c.path))
      .map((c) => c.path.split('/').at(-1));
    expect(posts).toEqual(['cancel', 'messages']);
    expect(seen).toEqual([{ ...r, status: 'closed', reason: 'cancelled' }]);
  });

  it('keeps the person’s follow-ups on a question in the order they were written', async () => {
    let t = Date.now();
    const { bridge, relay, qid, seen } = await ownQuestion({ now: () => t });
    relay.rejectMessage = { status: 503, code: 'temporarily_unavailable' };
    const first = await bridge.sendFollowUp({ questionId: qid, text: 'first' });
    relay.rejectMessage = null;
    // The same clock for both: their order is the order they were written, not their timestamps.
    const second = await bridge.sendFollowUp({ questionId: qid, text: 'second' });
    expect([first.status, second.status]).toEqual(['queued', 'queued']);
    expect(messagePosts(relay)).toHaveLength(1);

    t += 10 * 60_000;
    await bridge.pump();
    expect(relay.messages.map((m) => m.message.record.message_id)).toEqual([
      first.messageId,
      second.messageId,
    ]);
    expect(seen.map((s) => [s.messageId, s.status])).toEqual([
      [first.messageId, 'sent'],
      [second.messageId, 'sent'],
    ]);
  });
});

describe('sendFollowUp on a Remote Host’s question', () => {
  it('needs no local row: the owner signs and sends it, and the Host types it as sent from the computer', async () => {
    const { relay, asking, ownerSide, qid, owner } = await hostQuestion();
    expect(await ownerSide.store.getQuestion(qid)).toBeNull();
    const r = await ownerSide.bridge.sendFollowUp({ questionId: qid, text: 'Only the dev cache.' });
    expect(r).toMatchObject({ questionId: qid, status: 'sent' });
    expect(relay.messages[0]!.message.record.signer_device_id).toBe(owner.config.deviceId);

    await asking.bridge.catchUp();
    expect(asking.sink.typed).toHaveLength(1);
    expect(asking.sink.typed[0]!.text).toContain('source: human\nsent_from: computer\n');
    expect(asking.sink.typed[0]!.text).toContain('text: Only the dev cache.');
    expect((await asking.bridge.getDecision(qid)).thread[0]).toMatchObject({
      side: 'human',
      sentFrom: 'computer',
    });
  });

  it('reports a Host that has not declared the feature as the asking computer not supporting it', async () => {
    const { relay, host, ownerSide, qid } = await hostQuestion();
    relay.undeclaredMessages.add(host.identity.config.deviceId);
    const seen = results(ownerSide.bridge);
    const r = await ownerSide.bridge.sendFollowUp({ questionId: qid, text: 'Hello?' });
    expect(r).toMatchObject({ status: 'unsupported', by: 'asking-desktop' });
    expect(seen).toEqual([r]);
    expect(relay.messages).toEqual([]);
    expect(await ownerMessages(ownerSide.store)).toEqual([]);
  });

  it('is refused on a Remote Host before anything is signed, queued or sent', async () => {
    const { relay, asking, qid } = await hostQuestion();
    await expect(
      asking.bridge.sendFollowUp({ questionId: qid, text: 'I am the person' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      asking.bridge.publisher.enqueueOwnerMessage({ questionId: qid, text: 'I am the person' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await ownerMessages(asking.store)).toEqual([]);
    expect(messagePosts(relay)).toEqual([]);
  });
});

describe('sendFollowUp results a UI can show', () => {
  const cases: {
    name: string;
    arrange: (e: Awaited<ReturnType<typeof ownQuestion>>) => void | Promise<void>;
    questionId?: (qid: string) => string;
    expected: Record<string, unknown>;
  }[] = [
    {
      name: 'the asking desktop has not declared it',
      arrange: (e) => void e.relay.undeclaredMessages.add(e.identity.config.deviceId),
      expected: { status: 'unsupported', by: 'asking-desktop' },
    },
    {
      name: 'a cancelled question',
      arrange: (e) => void e.relay.answerState.set(e.qid, { status: 'cancelled', revision: 0 }),
      expected: { status: 'closed', reason: 'cancelled' },
    },
    {
      name: 'an expired question',
      arrange: (e) => void e.relay.answerState.set(e.qid, { status: 'expired', revision: 0 }),
      expected: { status: 'closed', reason: 'expired' },
    },
    {
      name: 'a question the relay does not have',
      arrange: () => undefined,
      questionId: () => newId(),
      expected: { status: 'closed', reason: 'not-found' },
    },
    {
      name: 'a thread at its message limit (a bare invalid_state on an open question)',
      arrange: (e) => void (e.relay.rejectMessage = { status: 409, code: 'invalid_state' }),
      expected: { status: 'rejected', code: 'invalid_state' },
    },
    {
      name: 'a bare invalid_state whose question cannot be read now',
      arrange: (e) => {
        e.relay.answerState.set(e.qid, { status: 'cancelled', revision: 0 });
        e.relay.failQuestionReads = 1;
      },
      expected: { status: 'rejected', code: 'invalid_state' },
    },
    {
      name: 'any other refusal',
      arrange: (e) => void (e.relay.rejectMessage = { status: 400, code: 'validation_error' }),
      expected: { status: 'rejected', code: 'validation_error' },
    },
    {
      name: 'a 403 from a relay that still advertises it',
      arrange: (e) => void (e.relay.rejectMessage = { status: 403, code: 'forbidden' }),
      expected: { status: 'rejected', code: 'forbidden' },
    },
  ];
  for (const c of cases) {
    it(`${c.name}: ${JSON.stringify(c.expected)}, settled and never retried`, async () => {
      let t = Date.now();
      const env = await ownQuestion({ now: () => t });
      await c.arrange(env);
      const questionId = c.questionId ? c.questionId(env.qid) : env.qid;
      const r = await env.bridge.sendFollowUp({ questionId, text: 'Are you sure?' });
      expect(r).toEqual({ messageId: r.messageId, questionId, ...c.expected });
      expect(env.seen).toEqual([r]);
      expect(await env.bridge.getFollowUpResult(r.messageId)).toEqual(r);
      const posts = messagePosts(env.relay).length;
      expect(posts).toBe(1);
      t += 10 * 60_000;
      await env.bridge.pump();
      expect(messagePosts(env.relay)).toHaveLength(posts);
      expect(await ownerMessages(env.store)).toEqual([]);
      expect(env.relay.messages).toEqual([]);
    });
  }

  it('a relay that does not advertise the owner desktop’s follow-ups, or threads, is never sent one', async () => {
    for (const features of [['thread-messages-v1'], ['owner-desktop-messages-v1'], undefined]) {
      const env = await ownQuestion();
      env.relay.features = features;
      const r = await env.bridge.sendFollowUp({ questionId: env.qid, text: 'Hello' });
      expect(r).toMatchObject({ status: 'unsupported', by: 'relay' });
      expect(env.seen).toEqual([r]);
      expect(messagePosts(env.relay)).toEqual([]);
    }
  });

  it('a 403 from a relay that stopped advertising it since it was last read is unsupported by the relay', async () => {
    const env = await ownQuestion();
    // Read and cached as supported by a first follow-up.
    expect((await env.bridge.sendFollowUp({ questionId: env.qid, text: 'one' })).status).toBe(
      'sent',
    );
    env.relay.features = ['thread-messages-v1'];
    env.relay.rejectMessage = { status: 403, code: 'forbidden' };
    expect(await env.bridge.sendFollowUp({ questionId: env.qid, text: 'two' })).toMatchObject({
      status: 'unsupported',
      by: 'relay',
    });
  });
});

describe('sendFollowUp is durable and idempotent', () => {
  it('an unreachable relay leaves it queued; the outbox resends the same signed body and reports the outcome', async () => {
    let t = Date.now();
    const { bridge, relay, store, qid, seen, identity } = await ownQuestion({ now: () => t });
    // A client that retries by itself: the follow-up's send must still be one attempt, left to the outbox.
    bridge.ctx.client = new RelayClient({
      identity,
      fetch: relay.fetch,
      sleep: async () => {},
      maxRetries: 3,
    });
    relay.rejectMessage = { status: 503, code: 'temporarily_unavailable' };
    const r = await bridge.sendFollowUp({ questionId: qid, text: 'Still there?' });
    expect(r.status).toBe('queued');
    expect(messagePosts(relay)).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(await ownerMessages(store)).toHaveLength(1);
    relay.rejectMessage = null;

    // Not due yet: the pump leaves it alone.
    await bridge.pump();
    expect(messagePosts(relay)).toHaveLength(1);

    t += 10 * 60_000;
    await bridge.pump();
    const sent = { ...r, status: 'sent' };
    expect(seen).toEqual([sent]);
    expect(await bridge.getFollowUpResult(r.messageId)).toEqual(sent);
    const bodies = messagePosts(relay).map((c) => c.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it('a reply lost after the relay committed it resolves as sent on the retry, committed once', async () => {
    let t = Date.now();
    const { bridge, relay, qid, seen } = await ownQuestion({ now: () => t });
    relay.dropMessageReply = 1;
    const r = await bridge.sendFollowUp({ questionId: qid, text: 'Once only' });
    expect(r.status).toBe('queued');
    t += 10 * 60_000;
    await bridge.pump();
    expect(seen).toEqual([{ ...r, status: 'sent' }]);
    expect(relay.messages).toHaveLength(1);
    expect(relay.events.filter((e) => e.event_type === 'decision.message.posted')).toHaveLength(1);
  });

  it('the same id is the same follow-up: never signed or sent twice, and never reused for another', async () => {
    const { bridge, relay, qid, seen } = await ownQuestion();
    const messageId = newId();
    const input = { questionId: qid, text: 'Just once', messageId };
    const [a, b] = await Promise.all([bridge.sendFollowUp(input), bridge.sendFollowUp(input)]);
    expect(a).toEqual({ messageId, questionId: qid, status: 'sent' });
    expect(b).toEqual(a);
    expect(await bridge.sendFollowUp(input)).toEqual(a);
    expect(relay.messages).toHaveLength(1);
    expect(seen).toEqual([a]);
    await expect(bridge.sendFollowUp({ ...input, text: 'Something else' })).rejects.toMatchObject({
      code: 'validation_error',
      message: /already used/,
    });
    const other = await bridge.registerQuestion({ origin: origin(), input: { question: 'Other?' } });
    await bridge.pump();
    await expect(
      bridge.sendFollowUp({ ...input, questionId: other.questionId }),
    ).rejects.toMatchObject({ code: 'validation_error', message: /already used/ });
  });

  it('an outcome stored before a crash kept its item from being dropped stands: it is not sent again', async () => {
    let t = Date.now();
    const { bridge, relay, store, qid, seen } = await ownQuestion({ now: () => t });
    relay.rejectMessage = { status: 503, code: 'temporarily_unavailable' };
    const r = await bridge.sendFollowUp({ questionId: qid, text: 'Crash test' });
    expect(r.status).toBe('queued');
    relay.rejectMessage = null;
    const key = `owner-message:${r.messageId}`;
    const settled = { ...r, status: 'unsupported' as const, by: 'asking-desktop' as const };
    await store.setMeta(
      key,
      JSON.stringify({ ...JSON.parse((await store.getMeta(key))!), result: settled }),
    );

    t += 10 * 60_000;
    await bridge.pump();
    expect(messagePosts(relay)).toHaveLength(1);
    expect(await ownerMessages(store)).toEqual([]);
    expect(await bridge.getFollowUpResult(r.messageId)).toEqual(settled);
    expect(seen).toEqual([settled]);
  });

  it('an id reserved but never queued (a crash in between) has no result, and repeating it sends the signed message', async () => {
    let t = Date.now();
    const { bridge, relay, store, qid } = await ownQuestion({ now: () => t });
    relay.rejectMessage = { status: 503, code: 'temporarily_unavailable' };
    const messageId = newId();
    const input = { questionId: qid, text: 'After the crash', messageId };
    expect((await bridge.sendFollowUp(input)).status).toBe('queued');
    relay.rejectMessage = null;
    const signedBefore = messagePosts(relay)[0]!.body;
    // The crash: the reservation was written, the item never was.
    for (const o of await ownerMessages(store)) await store.deleteOutbox(o.id);
    expect(await bridge.getFollowUpResult(messageId)).toBeNull();
    t += 10 * 60_000;
    expect(await bridge.sendFollowUp(input)).toMatchObject({ messageId, status: 'sent' });
    // The message signed before the crash, not a second one.
    expect(messagePosts(relay).at(-1)!.body).toEqual(signedBefore);
  });

  it('a follow-up waiting its turn when the bridge stops is not sent', async () => {
    const { bridge, relay, store, qid } = await ownQuestion();
    let release!: () => void;
    relay.holdMessages = new Promise<void>((r) => (release = r));
    const first = bridge.sendFollowUp({ questionId: qid, text: 'first' });
    while (messagePosts(relay).length === 0) await tick(1);
    const second = bridge.sendFollowUp({ questionId: qid, text: 'second' });
    while ((await ownerMessages(store)).length < 2) await tick(1);
    await bridge.stop();
    release();
    expect(await first).toMatchObject({ status: 'sent' });
    expect(await second).toMatchObject({ status: 'queued' });
    expect(messagePosts(relay)).toHaveLength(1);
  });

  it('a bridge stopped while the relay’s features are being read sends nothing', async () => {
    const { bridge, relay, identity, qid } = await ownQuestion();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reading = false;
    // A fresh client, so the features are read for this follow-up, and that read is slow.
    bridge.publisher['features'] = null;
    bridge.ctx.client = new RelayClient({
      identity,
      fetch: async (input, init) => {
        if (String(input).endsWith('/api/v1/info')) {
          reading = true;
          await held;
        }
        return relay.fetch(input, init);
      },
      sleep: async () => {},
      maxRetries: 0,
    });
    const r = bridge.sendFollowUp({ questionId: qid, text: 'Too late' });
    while (!reading) await tick(1);
    await bridge.stop();
    release();
    expect(await r).toMatchObject({ status: 'queued' });
    expect(messagePosts(relay)).toEqual([]);
  });

  it('a queued follow-up survives a restart and is sent by the next bridge on the same store', async () => {
    const path = join(dir, 'restart.db');
    let t = Date.now();
    const store = new SqliteLocalStore(path);
    const { bridge, relay, qid, identity } = await ownQuestion({ store, now: () => t });
    relay.rejectMessage = { status: 503, code: 'temporarily_unavailable' };
    const r = await bridge.sendFollowUp({ questionId: qid, text: 'Across a restart' });
    expect(r.status).toBe('queued');
    relay.rejectMessage = null;
    await bridge.stop();
    store.close();

    const store2 = new SqliteLocalStore(path);
    const next = bridgeFor(identity, relay, { store: store2, now: () => t });
    const seen = results(next.bridge);
    t += 10 * 60_000;
    await next.bridge.publisher.flush();
    expect(seen).toEqual([{ ...r, status: 'sent' }]);
    const bodies = messagePosts(relay).map((c) => c.body);
    expect(bodies.at(-1)).toEqual(bodies[0]);
    expect(await next.bridge.getFollowUpResult(r.messageId)).toMatchObject({ status: 'sent' });
    store2.close();
  });

  it('a revoked desktop refuses, and an unknown id has no result', async () => {
    const { bridge, qid } = await ownQuestion();
    expect(await bridge.getFollowUpResult(newId())).toBeNull();
    bridge.state = 'revoked';
    await expect(bridge.sendFollowUp({ questionId: qid, text: 'hi' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('sendFollowUp is a host API', () => {
  it('is not one of the methods the MCP handler calls or a host forwards for a pane', () => {
    expect(MCP_BRIDGE_METHODS).not.toContain('sendFollowUp');
    expect(MCP_BRIDGE_METHODS).not.toContain('getFollowUpResult');
  });
});
