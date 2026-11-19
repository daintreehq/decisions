import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encryptEnvelope } from '@daintreehq/decisions-crypto';
import {
  DecisionsBridge,
  FileSpool,
  PolicyRegistry,
  RelayClient,
  RelayError,
  currentEpochKey,
  openQuestionContent,
} from '../src/index.js';
import { SqliteLocalStore } from '../src/store-sqlite.js';
import { FakeRelay, FakeSink, makeIdentity, origin, setupBridge } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'decisions-deadline-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);
const iso = (t: number) => new Date(t).toISOString();
const creates = (relay: FakeRelay) =>
  relay.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/questions');
const attachmentCalls = (relay: FakeRelay) =>
  relay.calls.filter((c) => c.path.startsWith('/api/v1/attachments'));

describe('a question whose deadline passes before it reaches the relay', () => {
  it('settles a fully offline ask at its deadline as never published, without uploading or sending anything', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const spoolDir = join(tmp, 'offline-spool');
    const env = await setupBridge({
      now: () => now,
      spool: new FileSpool(spoolDir),
      resolver: { resolve: async () => ({ bytes: png }) },
    });
    env.relay.createNow = () => now;
    const deadline = now + 120_000;
    env.relay.down = 1_000; // offline for the whole reply window
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: {
        question: 'Which fixture?',
        options: [{ id: 'a', label: 'A' }],
        expires_at: iso(deadline),
        attachments: [{ local_resource_id: 'shot' }],
      },
    });
    await env.bridge.publisher.enqueueMessage(r.questionId, {
      question_id: r.questionId,
      text: 'One more detail',
      expects_reply: false,
    });
    // Each failed attempt backs off further, past the deadline if nothing caps it.
    for (let i = 0; i < 8; i++) {
      await env.bridge.pump();
      now += 5_000;
    }
    const before = await env.bridge.getDecision(r.questionId);
    expect(before).toMatchObject({ status: 'queued', publication: 'not-sent', closedReason: null });

    now = deadline;
    await env.bridge.pump();

    const row = (await env.store.getQuestion(r.questionId))!;
    expect(row.local_status).toBe('publish-failed');
    expect(row.expires_at).toBe(iso(deadline)); // never extended
    const view = await env.bridge.getDecision(r.questionId);
    expect(view).toMatchObject({
      status: 'publish-failed',
      publication: 'never-published',
      closedReason: 'never-published',
      provenance: null,
      choice: null,
      expiresAt: iso(deadline),
    });
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0); // the follow-up went with it
    expect(await env.store.countOpenForPane('host-local', 'pane-1')).toBe(0);
    expect(readdirSync(spoolDir)).toEqual([]);

    // The relay comes back: nothing stale is uploaded or sent.
    env.relay.down = 0;
    await env.bridge.pump();
    expect(creates(env.relay)).toHaveLength(0);
    expect(attachmentCalls(env.relay)).toHaveLength(0);
    expect((await env.store.getQuestion(r.questionId))!.local_status).toBe('publish-failed');
  });

  it('settles a text-only ask whose every send failed while connecting, and tells the waiting agent the person never saw it', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    // No network at all: name resolution fails, so no request ever leaves this computer.
    const offline = { on: true };
    const relayFetch = env.relay.fetch;
    env.relay.fetch = async (input, init) => {
      if (offline.on) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND relay.test'), {
            code: 'ENOTFOUND',
          }),
        });
      }
      return relayFetch(input, init);
    };
    const client = new RelayClient({
      identity: env.identity,
      fetch: (input, init) => env.relay.fetch(input, init),
      sleep: async () => {},
      maxRetries: 2,
    });
    const bridge = new DecisionsBridge({
      identity: env.identity,
      store: env.store,
      sink: env.sink,
      client,
      pumpIntervalMs: 0,
      now: () => now,
    });
    const deadline = now + 120_000;
    const r = await bridge.registerQuestion({
      origin: origin(),
      input: {
        question: 'Ship it?',
        options: [{ id: 'y', label: 'Yes' }],
        expires_at: iso(deadline),
      },
    });
    await bridge.pump();
    expect(await bridge.getDecision(r.questionId)).toMatchObject({ publication: 'not-sent' });

    now = deadline;
    await bridge.pump();
    expect(await bridge.getDecision(r.questionId)).toMatchObject({
      status: 'publish-failed',
      publication: 'never-published',
      closedReason: 'never-published',
      fallbackDue: false,
    });
    expect(env.sink.typed).toHaveLength(1);
    const notice = env.sink.typed[0]!.text;
    expect(notice).toContain('status: never-published');
    expect(notice).toContain('authorised: no');
    expect(notice).toContain('the person never saw it');
    expect(notice).not.toMatch(/expired without an answer|did not answer/);
    expect(await bridge.getDecision(r.questionId)).toMatchObject({
      closedReason: 'never-published',
      deliveryStatus: 'terminal-delivered',
    });

    // Online again: nothing is sent for it, and the notice is not typed twice.
    offline.on = false;
    await bridge.pump();
    expect(creates(env.relay)).toHaveLength(0);
    expect(env.sink.typed).toHaveLength(1);
  });

  it('shows a create whose reply was lost as uncertain while the relay is unreachable, then takes the relay history', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    env.relay.createNow = () => now;
    const deadline = now + 120_000;
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q?', options: [{ id: 'a', label: 'A' }], expires_at: iso(deadline) },
    });
    env.relay.dropCreateReply = 1; // committed on the relay; the reply never arrives
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'queued',
      publication: 'possibly-committed',
    });

    // Offline across the deadline: nothing is concluded locally.
    env.relay.down = 1_000;
    now = deadline + 1_000;
    for (let i = 0; i < 3; i++) {
      await env.bridge.pump();
      now += 30_000;
    }
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'queued',
      publication: 'possibly-committed',
      closedReason: null,
    });
    expect(env.sink.typed).toHaveLength(0);

    // Back online: the relay expired it, and that is the outcome.
    env.relay.down = 0;
    env.relay.expiryEvent({ questionId: r.questionId, at: iso(deadline) });
    for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await env.store.putOutbox({ ...o, next_attempt_at: 0 });
    await env.bridge.pump();
    await env.bridge.catchUp();
    expect(creates(env.relay)).toHaveLength(2);
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'expired',
      publication: 'accepted',
      closedReason: 'expired',
    });
  });

  it('settles a create the relay never committed as never published once the relay refuses its retry past the deadline', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    env.relay.createNow = () => now;
    const deadline = now + 120_000;
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q?', options: [{ id: 'a', label: 'A' }], expires_at: iso(deadline) },
    });
    env.relay.down = 1; // the create itself is lost on the way out: possibly committed, as far as we know
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'queued',
      publication: 'possibly-committed',
    });
    now = deadline + 1_000;
    for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await env.store.putOutbox({ ...o, next_attempt_at: 0 });
    await env.bridge.pump();

    expect(creates(env.relay)).toHaveLength(1); // the retry, answered 400: the relay holds no such question
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'publish-failed',
      publication: 'never-published',
      closedReason: 'never-published',
    });
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
  });

  it('delivers an answer committed while the host slept, never a timeout, whatever order reconnection runs in', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    env.relay.createNow = () => now;
    const deadline = now + 120_000;
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q?', options: [{ id: 'a', label: 'A' }], expires_at: iso(deadline) },
    });
    env.relay.dropCreateReply = 1;
    await env.bridge.pump();
    // The host sleeps; the person answers in time; the deadline passes before the host wakes.
    await env.relay.answerEvent({ questionId: r.questionId, phone: env.phone, options: ['a'] });
    now = deadline + 5 * 60_000;
    for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await env.store.putOutbox({ ...o, next_attempt_at: 0 });

    await env.bridge.pump(); // the outbox retries the create before any history arrives
    await env.bridge.catchUp();

    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'human-answered',
      publication: 'accepted',
      provenance: 'human',
      choice: 'a',
      closedReason: null,
    });
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain('choice: a');
    expect(env.sink.typed[0]!.text).not.toContain('expired');
  });
});

describe('several senders and the person on one queued create', () => {
  it('closes the person\'s answer from this computer on a question that never reached the relay, with no network', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    env.relay.down = 1_000; // offline through the deadline: even `/info` cannot be read
    const deadline = now + 120_000;
    const r = await env.bridge.publisher.register(origin(), {
      question: 'q?',
      options: [{ id: 'a', label: 'A' }],
      expires_at: iso(deadline),
    });
    const { answerId } = await env.bridge.publisher.enqueueOwnerAnswer({
      questionId: r.questionId,
      expectedRevision: 0,
      selectedOptionIds: ['a'],
      reviewedAttachmentDigests: [],
    });
    now = deadline;
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      closedReason: 'never-published',
    });
    await env.bridge.pump(); // the person's answer takes its turn once the create has gone
    expect(await env.bridge.publisher.ownerAnswerResult(answerId)).toMatchObject({
      status: 'closed',
      reason: 'not-found',
    });
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
  });

  it('never settles a create another sender claimed after this flush read it', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    env.relay.createNow = () => now;
    const deadline = now + 120_000;
    const r = await env.bridge.publisher.register(origin(), {
      question: 'q?',
      options: [{ id: 'a', label: 'A' }],
      expires_at: iso(deadline),
    });
    // Another process (a CLI `ask` beside `listen`) sends it just before the deadline, and its reply is lost.
    const [item] = await env.store.outboxFor(r.questionId);
    await env.relay.fetch('https://relay.test/api/v1/questions', {
      method: 'POST',
      body: JSON.stringify({ idempotency_key: item!.id, question: (item!.payload as { signed: unknown }).signed }),
    });
    now = deadline + 1_000;
    // This flush read the item unclaimed; the other sender's claim lands before it decides.
    const due = env.store.dueOutbox.bind(env.store);
    env.store.dueOutbox = async (...args) => {
      const items = await due(...args);
      const live = (await env.store.outboxFor(r.questionId))[0]!;
      await env.store.putOutbox({
        ...live,
        payload: { ...(live.payload as object), maybePublished: true, claim: 'other-sender' },
      });
      env.store.dueOutbox = due;
      return items;
    };
    await env.bridge.pump();

    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'open',
      publication: 'accepted',
      closedReason: null,
    });
    expect(env.sink.typed).toHaveLength(0);
  });

  it('keeps another sender\'s claim when this send provably never left the computer', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    const deadline = now + 120_000;
    const r = await env.bridge.publisher.register(origin(), {
      question: 'q?',
      options: [{ id: 'a', label: 'A' }],
      expires_at: iso(deadline),
    });
    env.client.createQuestion = async () => {
      // Another process claims and sends it meanwhile; this one could not even connect.
      const live = (await env.store.outboxFor(r.questionId))[0]!;
      await env.store.putOutbox({
        ...live,
        payload: { ...(live.payload as object), maybePublished: true, claim: 'other-sender' },
      });
      throw new RelayError('network_error', 'connect ECONNREFUSED', 0, { notSent: true });
    };
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      publication: 'possibly-committed',
    });
    now = deadline;
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'queued',
      publication: 'possibly-committed',
      closedReason: null,
    });
  });
});

describe('a restart during an attachment upload', () => {
  const setup = async (name: string) => {
    const identity = await makeIdentity();
    const relay = new FakeRelay(identity);
    await relay.initOwner();
    const clock = { now: Date.parse('2026-11-19T10:00:00Z') };
    relay.createNow = () => clock.now;
    const dbPath = join(tmp, `${name}.db`);
    const spoolDir = join(tmp, `${name}-spool`);
    /** Fail every request after the first `allow` with a network error (the process dies mid-upload). */
    const cut = { allow: Infinity };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (cut.allow <= 0) throw new TypeError('fetch failed');
      cut.allow--;
      return relay.fetch(input, init);
    };
    const open = () => {
      const store = new SqliteLocalStore(dbPath);
      const sink = new FakeSink();
      sink.addPane('pane-1');
      const bridge = new DecisionsBridge({
        identity,
        store,
        sink,
        spool: new FileSpool(spoolDir),
        pumpIntervalMs: 0,
        now: () => clock.now,
        resolver: { resolve: async () => ({ bytes: png }) },
        client: new RelayClient({ identity, fetch, sleep: async () => {}, maxRetries: 0 }),
      });
      return { store, bridge };
    };
    return { relay, clock, cut, spoolDir, open };
  };
  const ask = (bridge: DecisionsBridge, deadline: number) =>
    bridge.registerQuestion({
      origin: origin(),
      input: {
        question: 'Which screenshot?',
        expires_at: iso(deadline),
        attachments: [{ local_resource_id: 'one' }, { local_resource_id: 'two' }],
      },
    });

  it('a restart past the deadline uploads nothing more and settles the question as never published', async () => {
    const t = await setup('restart-late');
    const deadline = t.clock.now + 120_000;
    const a = t.open();
    t.cut.allow = 4; // reserve, upload and complete the first image, reserve the second, then die
    const r = await ask(a.bridge, deadline);
    await a.bridge.pump();
    expect(t.relay.uploads).toHaveLength(1);
    await a.store.close();

    t.clock.now = deadline + 1_000;
    t.cut.allow = Infinity;
    const b = t.open();
    await b.bridge.start({ socket: false });
    await b.bridge.pump();
    await b.bridge.stop();

    expect(t.relay.uploads).toHaveLength(1);
    expect(creates(t.relay)).toHaveLength(0);
    expect(await b.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'publish-failed',
      publication: 'never-published',
      closedReason: 'never-published',
    });
    expect(readdirSync(t.spoolDir)).toEqual([]);
    await b.store.close();
  });

  it('a restart before the deadline finishes the upload and publishes once, keeping the original deadline', async () => {
    const t = await setup('restart-early');
    const deadline = t.clock.now + 120_000;
    const a = t.open();
    t.cut.allow = 4;
    const r = await ask(a.bridge, deadline);
    await a.bridge.pump();
    await a.store.close();

    t.clock.now += 10_000;
    t.cut.allow = Infinity;
    const b = t.open();
    for (const o of await b.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await b.store.putOutbox({ ...o, next_attempt_at: 0 });
    await b.bridge.pump();

    expect(t.relay.uploads).toHaveLength(2);
    expect(creates(t.relay)).toHaveLength(1);
    expect(t.relay.questions.get(r.questionId)!.signed.record.expires_at).toBe(iso(deadline));
    expect(await b.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'open',
      publication: 'accepted',
      expiresAt: iso(deadline),
    });
    expect(readdirSync(t.spoolDir)).toEqual([]);
    await b.store.close();
  });

  it('removes spool files no queued create refers to when the bridge starts', async () => {
    const t = await setup('orphans');
    const a = t.open();
    t.cut.allow = 0; // offline: the create and its image stay queued
    const r = await ask(a.bridge, t.clock.now + 120_000);
    await a.bridge.pump();
    // A crash between spooling an image and committing its question, and one mid-write, leave strays.
    writeFileSync(join(t.spoolDir, 'stray01'), new Uint8Array([1, 2, 3]));
    writeFileSync(join(t.spoolDir, 'stray02.tmp'), new Uint8Array([4]));
    const longAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    for (const f of readdirSync(t.spoolDir)) utimesSync(join(t.spoolDir, f), longAgo, longAgo);
    // Another process has just spooled an image for a question it has not committed yet.
    writeFileSync(join(t.spoolDir, 'fresh03'), new Uint8Array([5]));
    await a.store.close();

    const b = t.open();
    await b.bridge.start({ socket: false });
    await b.bridge.stop();
    const kept = readdirSync(t.spoolDir).sort();
    const row = (await b.store.getQuestion(r.questionId))!;
    expect(row.local_status).toBe('queued');
    const needed = (await b.store.outboxFor(r.questionId))
      .flatMap(
        (o) => (o.payload as { attachments?: { attachment_id: string }[] }).attachments ?? [],
      )
      .map((x) => x.attachment_id);
    expect(needed).toHaveLength(2);
    expect(kept).toEqual([...needed, 'fresh03'].sort());
    await b.store.close();
  });

  it('a cancel while an image uploads stops the create: it is never written back or published', async () => {
    const env = await setupBridge({ resolver: { resolve: async () => ({ bytes: png }) } });
    const r = await env.bridge.publisher.register(origin(), {
      question: 'q?',
      attachments: [{ local_resource_id: 'one' }],
    });
    // The agent withdraws the question while its image is on the wire.
    const upload = env.client.uploadAttachment.bind(env.client);
    env.client.uploadAttachment = async (...args) => {
      await env.bridge.cancelQuestion(r.questionId);
      return upload(...args);
    };
    await env.bridge.pump();
    await env.bridge.pump();

    expect(creates(env.relay)).toHaveLength(0);
    expect(env.relay.uploads).toHaveLength(1); // the one already on the wire
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'cancelled',
      publication: 'never-published',
      closedReason: 'withdrawn',
    });
  });
});

describe('an advisory question that never reached the relay', () => {
  /** Queue a question, then make its stored content advisory, as `ask_human` will once it signs advisory asks (#154). */
  const advisoryAsk = async (over: {
    advisoryDeadlines: boolean;
    policy: boolean;
    plan?: string;
  }) => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({
      now: () => now,
      advisoryDeadlines: over.advisoryDeadlines,
      policy: new PolicyRegistry({ advisoryQuestions: over.policy }),
    });
    env.relay.down = 1_000;
    const deadline = now + 120_000;
    const r = await env.bridge.publisher.register(origin(), {
      question: 'Which fixture should I use?',
      options: [{ id: 'mem', label: 'In-memory' }],
      expires_at: iso(deadline),
    });
    const row = (await env.store.getQuestion(r.questionId))!;
    const content = (await openQuestionContent(env.bridge.ctx, row))!;
    const envelope = await encryptEnvelope({
      epochKey: currentEpochKey(env.identity),
      installationId: env.identity.config.installationId,
      questionId: r.questionId,
      recordId: r.questionId,
      recordType: 'question',
      revision: 0,
      senderDeviceId: env.identity.config.deviceId,
      purpose: 'question-content',
      replyMode: 'advisory',
      plaintext: {
        ...content,
        ...(over.plan !== undefined ? { planned_fallback: over.plan } : {}),
      },
    });
    await env.store.updateQuestion(r.questionId, { content_sealed: JSON.stringify(envelope) });
    now = deadline;
    await env.bridge.pump();
    return { env, r };
  };

  it('tells its agent the stated plan may go ahead when the host delivers advisory outcomes and its policy allows them', async () => {
    const { env, r } = await advisoryAsk({
      advisoryDeadlines: true,
      policy: true,
      plan: 'Use the in-memory fixture.',
    });
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'publish-failed',
      closedReason: 'never-published',
      fallbackDue: true,
      provenance: null,
      choice: null,
    });
    const notice = env.sink.typed[0]!.text;
    expect(notice).toContain('status: never-published');
    expect(notice).toContain('the person never saw it');
    expect(notice).toContain('You may carry out the plan you stated');
    expect(notice).not.toContain('NOT authorised to continue');
  });

  it.each([
    [
      'the host policy no longer allows advisory questions',
      { advisoryDeadlines: true, policy: false, plan: 'Go.' },
    ],
    [
      'the host does not deliver advisory outcomes',
      { advisoryDeadlines: false, policy: true, plan: 'Go.' },
    ],
    ['the content states no plan', { advisoryDeadlines: true, policy: true }],
  ] as const)('authorises nothing when %s', async (_why, over) => {
    const { env, r } = await advisoryAsk(over);
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      closedReason: 'never-published',
      fallbackDue: false,
    });
    const notice = env.sink.typed[0]!.text;
    expect(notice).toContain('NOT authorised to continue');
    expect(notice).not.toContain('plan you stated');
  });
});
