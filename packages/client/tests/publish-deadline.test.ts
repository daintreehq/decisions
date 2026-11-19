import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildSignedQuestion, encryptEnvelope } from '@daintreehq/decisions-crypto';
import {
  DecisionsBridge,
  FileSpool,
  PolicyRegistry,
  RelayClient,
  RelayError,
  currentEpochKey,
  isUnsentError,
  openQuestionContent,
  type CreatePayload,
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
    await env.bridge.pump();
    // Many failures in, the next attempt backs off far past the deadline, unless the deadline caps it.
    now = deadline - 5_000;
    const [create] = (await env.store.outboxFor(r.questionId)).filter((o) => o.kind === 'create');
    await env.store.putOutbox({ ...create!, attempts: 10, next_attempt_at: 0 });
    const jitter = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      await env.bridge.pump();
    } finally {
      jitter.mockRestore();
    }
    const [backedOff] = (await env.store.outboxFor(r.questionId)).filter(
      (o) => o.kind === 'create',
    );
    expect(backedOff!.next_attempt_at).toBe(deadline);
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

  it('settles a text-only ask whose every send failed while connecting, and tells the waiting agent no answer was recorded', async () => {
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
    expect(notice).toContain(
      "it never reached the person's phone and no answer to it was recorded",
    );
    expect(notice).not.toMatch(/expired without an answer|did not answer|person never saw/);
    expect(await bridge.getDecision(r.questionId)).toMatchObject({
      closedReason: 'never-published',
      deliveryStatus: 'terminal-delivered',
    });

    // Online again: nothing is sent for it, the notice is not typed twice, and no delivery is reported to a relay
    // that never held the question.
    offline.on = false;
    await bridge.pump();
    expect(creates(env.relay)).toHaveLength(0);
    expect(env.sink.typed).toHaveLength(1);
    expect(env.relay.calls.filter((c) => c.path.startsWith('/api/v1/deliveries'))).toHaveLength(0);
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

  it.each([
    ['a create refused before its deadline', false],
    [
      'a possibly-committed create refused past its deadline without the relay showing it never took it',
      true,
    ],
  ] as const)('keeps %s as an ordinary refusal, with no notice', async (_why, late) => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    const deadline = now + 120_000;
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q?', options: [{ id: 'a', label: 'A' }], expires_at: iso(deadline) },
    });
    if (late) {
      env.relay.down = 1; // possibly committed
      await env.bridge.pump();
      now = deadline + 1_000;
      for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
        await env.store.putOutbox({ ...o, next_attempt_at: 0 });
    }
    env.relay.rejectCreate = 400; // a plain refusal, as from a relay older than the never-committed reason
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'publish-failed',
      publication: 'refused',
      closedReason: null,
      fallbackDue: false,
    });
    expect(env.sink.typed).toHaveLength(0);
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
  });

  it('keeps the relay history when a leftover create is refused after its answer was applied', async () => {
    const env = await setupBridge();
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q?', options: [{ id: 'a', label: 'A' }] },
    });
    env.relay.dropCreateReply = 1;
    await env.bridge.pump();
    await env.relay.answerEvent({ questionId: r.questionId, phone: env.phone, options: ['a'] });
    await env.bridge.catchUp();
    expect((await env.store.getQuestion(r.questionId))!.local_status).toBe('human-answered');
    env.relay.rejectCreate = 403;
    for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await env.store.putOutbox({ ...o, next_attempt_at: 0 });
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'human-answered',
      publication: 'accepted',
      choice: 'a',
    });
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
  });

  it("reopens a question an older relay's plain refusal closed, once the relay's history shows it was taken and answered", async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    const deadline = now + 120_000;
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q?', options: [{ id: 'a', label: 'A' }], expires_at: iso(deadline) },
    });
    env.relay.dropCreateReply = 1; // committed; the reply is lost
    await env.bridge.pump();
    await env.relay.answerEvent({ questionId: r.questionId, phone: env.phone, options: ['a'] });
    // A relay that checks the deadline before the receipt refuses the retry, before any history arrives.
    now = deadline + 1_000;
    env.relay.rejectCreate = 400;
    for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await env.store.putOutbox({ ...o, next_attempt_at: 0 });
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({ publication: 'refused' });

    await env.bridge.catchUp();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'human-answered',
      publication: 'accepted',
      provenance: 'human',
      choice: 'a',
    });
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain('choice: a');
  });

  it('closes as withdrawn, with nothing sent and no notice, when a create withdrawn while it was claimed proves never sent', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    const r = await env.bridge.publisher.register(origin(), {
      question: 'q?',
      options: [{ id: 'a', label: 'A' }],
      expires_at: iso(now + 120_000),
    });
    env.client.createQuestion = async () => {
      // The agent withdraws it while the create is on its way; the create then could not even connect.
      await env.bridge.cancelQuestion(r.questionId);
      expect((await env.store.outboxFor(r.questionId)).map((o) => o.kind).sort()).toEqual([
        'cancel',
        'create',
      ]);
      throw new RelayError('network_error', 'connect ECONNREFUSED', 0, { notSent: true });
    };
    await env.bridge.pump();
    // Before the deadline nothing is sent for it; past the deadline it is still withdrawn, never an unpublished notice.
    now += 1_000;
    for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await env.store.putOutbox({ ...o, next_attempt_at: 0 });
    env.client.createQuestion = RelayClient.prototype.createQuestion.bind(env.client);
    await env.bridge.pump();
    expect(env.relay.calls.filter((c) => c.path.includes('/questions'))).toHaveLength(0);
    now += 300_000;
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'cancelled',
      publication: 'never-published',
      closedReason: 'withdrawn',
      fallbackDue: false,
    });
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
    expect(env.relay.calls.filter((c) => c.path.includes('/questions'))).toHaveLength(0);
    expect(env.sink.typed).toHaveLength(0);
  });

  it('uploads no image once a reservation answers after the deadline', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({
      now: () => now,
      resolver: { resolve: async () => ({ bytes: png }) },
    });
    const deadline = now + 120_000;
    const r = await env.bridge.publisher.register(origin(), {
      question: 'q?',
      expires_at: iso(deadline),
      attachments: [{ local_resource_id: 'one' }],
    });
    const reserve = env.client.reserveAttachment.bind(env.client);
    env.client.reserveAttachment = async (...args) => {
      const res = await reserve(...args);
      now = deadline; // the reservation took until the deadline to answer
      return res;
    };
    await env.bridge.pump();
    expect(env.relay.uploads).toHaveLength(0);
    expect(creates(env.relay)).toHaveLength(0);
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      publication: 'never-published',
      closedReason: 'never-published',
    });
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
  it("closes the person's answer from this computer on a question that never reached the relay, with no network", async () => {
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

  it('drops a withdrawal a crash left behind on a never-published question, with no network', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    env.relay.down = 1_000;
    const deadline = now + 120_000;
    const r = await env.bridge.publisher.register(origin(), {
      question: 'q?',
      options: [{ id: 'a', label: 'A' }],
      expires_at: iso(deadline),
    });
    now = deadline;
    await env.bridge.pump();
    expect((await env.store.getQuestion(r.questionId))!.local_status).toBe('publish-failed');
    // The settlement wrote its row, then the process died before its queued withdrawal went.
    await env.store.putOutbox({
      id: 'leftover-cancel',
      kind: 'cancel',
      question_id: r.questionId,
      payload: {},
      attempts: 0,
      next_attempt_at: 0,
      created_at: now,
      last_error: null,
    });
    const { answerId } = await env.bridge.publisher.enqueueOwnerAnswer({
      questionId: r.questionId,
      expectedRevision: 0,
      selectedOptionIds: ['a'],
      reviewedAttachmentDigests: [],
    });
    await env.bridge.pump();
    await env.bridge.pump();
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
    expect(await env.bridge.publisher.ownerAnswerResult(answerId)).toMatchObject({
      status: 'closed',
      reason: 'not-found',
    });
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
      body: JSON.stringify({
        idempotency_key: item!.id,
        question: (item!.payload as { signed: unknown }).signed,
      }),
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

  it("keeps another sender's claim when this send provably never left the computer", async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    env.relay.createNow = () => now;
    const deadline = now + 120_000;
    const r = await env.bridge.publisher.register(origin(), {
      question: 'q?',
      options: [{ id: 'a', label: 'A' }],
      expires_at: iso(deadline),
    });
    // A second process on the same store (a CLI `ask` beside `listen`), with its own locks and its own network.
    const other = new DecisionsBridge({
      identity: env.identity,
      store: env.store,
      sink: env.sink,
      pumpIntervalMs: 0,
      now: () => now,
      client: new RelayClient({
        identity: env.identity,
        fetch: env.relay.fetch,
        sleep: async () => {},
        maxRetries: 0,
      }),
    });
    env.client.createQuestion = async () => {
      // While this send is out, the other process sends the claimed create too: the relay commits it and the reply is
      // lost. Then this send turns out never to have connected.
      env.relay.dropCreateReply = 1;
      await other.publisher.flush();
      expect(env.relay.questions.has(r.questionId)).toBe(true);
      throw new RelayError('network_error', 'connect ECONNREFUSED', 0, { notSent: true });
    };
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      publication: 'possibly-committed',
    });
    // Offline through the deadline: the claim the other send made stands, so nothing is concluded.
    env.client.createQuestion = RelayClient.prototype.createQuestion.bind(env.client);
    env.relay.down = 1_000;
    now = deadline;
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'queued',
      publication: 'possibly-committed',
      closedReason: null,
    });
    expect(env.sink.typed).toHaveLength(0);
    // Back online, the retry finds the question the other send published.
    env.relay.down = 0;
    for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await env.store.putOutbox({ ...o, next_attempt_at: 0 });
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'open',
      publication: 'accepted',
    });
  });

  it('never sends a withdrawn create again after a crash in the middle of withdrawing it', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    const r = await env.bridge.publisher.register(origin(), {
      question: 'q?',
      options: [{ id: 'a', label: 'A' }],
      expires_at: iso(now + 120_000),
    });
    const remove = env.store.deleteOutbox.bind(env.store);
    env.client.createQuestion = async () => {
      await env.bridge.cancelQuestion(r.questionId);
      // The process dies once the withdrawal has closed the row, before its items go.
      env.store.deleteOutbox = async () => {
        throw new Error('the process died');
      };
      throw new RelayError('network_error', 'connect ECONNREFUSED', 0, { notSent: true });
    };
    await env.bridge.pump().catch(() => undefined);
    expect((await env.store.getQuestion(r.questionId))!.local_status).toBe('cancelled');
    env.store.deleteOutbox = remove;

    // A new process, before the deadline: the leftover create and withdrawal go, and nothing reaches the relay.
    now += 1_000;
    const restarted = new DecisionsBridge({
      identity: env.identity,
      store: env.store,
      sink: env.sink,
      pumpIntervalMs: 0,
      now: () => now,
      client: new RelayClient({
        identity: env.identity,
        fetch: env.relay.fetch,
        sleep: async () => {},
        maxRetries: 0,
      }),
    });
    for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await env.store.putOutbox({ ...o, next_attempt_at: 0 });
    await restarted.pump();
    expect(env.relay.calls.filter((c) => c.path.includes('/questions'))).toHaveLength(0);
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
    expect(await restarted.getDecision(r.questionId)).toMatchObject({
      status: 'cancelled',
      publication: 'never-published',
      closedReason: 'withdrawn',
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
    // As the relay does, an image already uploaded takes no second upload.
    const uploaded = new Set<string>();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (cut.allow <= 0) throw new TypeError('fetch failed');
      cut.allow--;
      const url = String(input instanceof Request ? input.url : input);
      if (init?.method === 'PUT') {
        if (uploaded.has(url))
          return Response.json(
            { code: 'invalid_state', message: 'attachment is not awaiting upload' },
            { status: 409 },
          );
        uploaded.add(url);
      }
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

  it('a restart after an image reached the relay but before it was recorded completes it and publishes', async () => {
    const t = await setup('restart-after-put');
    const deadline = t.clock.now + 120_000;
    const a = t.open();
    t.cut.allow = 2; // reserve and upload the image, then die before completing and recording it
    const r = await a.bridge.registerQuestion({
      origin: origin(),
      input: {
        question: 'Which screenshot?',
        expires_at: iso(deadline),
        attachments: [{ local_resource_id: 'one' }],
      },
    });
    await a.bridge.pump();
    expect(t.relay.uploads).toHaveLength(1);
    await a.store.close();

    t.clock.now += 10_000;
    t.cut.allow = Infinity;
    const b = t.open();
    for (const o of await b.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await b.store.putOutbox({ ...o, next_attempt_at: 0 });
    await b.bridge.pump();

    expect(t.relay.uploads).toHaveLength(1);
    // The relay refused a second upload; completing the one it holds is what lets the question go out.
    expect(t.relay.calls.filter((c) => c.path.endsWith('/complete'))).toHaveLength(1);
    expect(creates(t.relay)).toHaveLength(1);
    expect(await b.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'open',
      publication: 'accepted',
    });
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
    // The agent withdraws the question once its image has reached the relay, before the upload is recorded.
    const upload = env.client.uploadAttachment.bind(env.client);
    env.client.uploadAttachment = async (...args) => {
      const res = await upload(...args);
      await env.bridge.cancelQuestion(r.questionId);
      return res;
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
  /**
   * Queue a question, then sign its create as advisory, as `ask_human` will once it signs advisory asks (#154). With
   * `rowOnly`, only the local copy of the content says advisory; the create stays signed as a blocking question.
   */
  const advisoryAsk = async (over: {
    advisoryDeadlines: boolean;
    policy: boolean;
    plan?: unknown;
    kind?: string;
    rowOnly?: boolean;
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
        ...(over.kind ? { kind: over.kind } : {}),
        ...(over.plan !== undefined ? { planned_fallback: over.plan } : {}),
      },
    });
    await env.store.updateQuestion(r.questionId, { content_sealed: JSON.stringify(envelope) });
    if (!over.rowOnly) {
      const item = (await env.store.outboxFor(r.questionId)).find((o) => o.kind === 'create')!;
      const was = (item.payload as CreatePayload).signed.record;
      const signed = await buildSignedQuestion({
        installationId: env.identity.config.installationId,
        questionId: r.questionId,
        signerDeviceId: env.identity.config.deviceId,
        signingKey: env.identity.keys.signing.privateKey,
        targetHostId: was.target_host_id,
        originRef: was.origin_ref,
        requirement: was.requirement,
        workflowGateIdHash: was.workflow_gate_id_hash,
        policyVersion: was.policy_version,
        expiresAt: was.expires_at,
        attachmentIds: was.attachment_ids,
        envelope,
        createdAt: was.created_at,
      });
      await env.store.putOutbox({
        ...item,
        payload: { ...(item.payload as CreatePayload), signed },
      });
    }
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
    expect(notice).toContain('no answer to it was recorded');
    expect(notice).toContain('You may carry out the plan you stated');
    expect(notice).not.toContain('NOT authorised to continue');
  });

  it.each([
    [
      'the host policy does not allow advisory questions',
      { advisoryDeadlines: true, policy: false, plan: 'Go.' },
    ],
    [
      'the host does not deliver advisory outcomes',
      { advisoryDeadlines: false, policy: true, plan: 'Go.' },
    ],
    ['the content states no plan', { advisoryDeadlines: true, policy: true }],
    ['the plan is blank', { advisoryDeadlines: true, policy: true, plan: '   ' }],
    ['the plan is not text', { advisoryDeadlines: true, policy: true, plan: 42 }],
    [
      'it asks for an approval',
      { advisoryDeadlines: true, policy: true, plan: 'Go.', kind: 'approval' },
    ],
    [
      'only the local copy says advisory, not the create that was signed',
      { advisoryDeadlines: true, policy: true, plan: 'Go.', rowOnly: true },
    ],
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

describe('telling a request that never left this computer', () => {
  const coded = (code: string) => Object.assign(new Error(code), { code });
  const failed = (cause: unknown) => new TypeError('fetch failed', { cause });

  it('counts only a direct connect failure, on every address tried', () => {
    expect(isUnsentError(failed(coded('ENOTFOUND')))).toBe(true);
    expect(isUnsentError(failed(coded('ECONNREFUSED')))).toBe(true);
    expect(isUnsentError(failed(coded('UND_ERR_CONNECT_TIMEOUT')))).toBe(true);
    expect(
      isUnsentError(failed(new AggregateError([coded('ECONNREFUSED'), coded('ENETUNREACH')]))),
    ).toBe(true);
    // A reset or closed socket may come after the request was written; so may anything mixed or nested deeper.
    expect(isUnsentError(failed(coded('ECONNRESET')))).toBe(false);
    expect(isUnsentError(failed(coded('UND_ERR_SOCKET')))).toBe(false);
    expect(
      isUnsentError(failed(new AggregateError([coded('ECONNREFUSED'), coded('ECONNRESET')]))),
    ).toBe(false);
    expect(isUnsentError(failed(new AggregateError([])))).toBe(false);
    expect(isUnsentError(failed(new Error('x', { cause: coded('ENOTFOUND') })))).toBe(false);
    expect(isUnsentError(new TypeError('fetch failed'))).toBe(false);
    expect(
      isUnsentError(new AggregateError([coded('ECONNRESET')], 'x', { cause: coded('ENOTFOUND') })),
    ).toBe(false);
  });

  it('sends a create with redirects refused, and reports it unsent only when every attempt failed to connect', async () => {
    const identity = await makeIdentity();
    const seen: (RequestRedirect | undefined)[] = [];
    let outcome: 'refused' | 'reset-then-refused' | 'answered-then-refused' = 'refused';
    let calls = 0;
    const client = new RelayClient({
      identity,
      sleep: async () => {},
      maxRetries: 1,
      fetch: async (_input, init) => {
        seen.push(init?.redirect);
        calls++;
        if (outcome === 'reset-then-refused' && calls === 1) throw failed(coded('ECONNRESET'));
        if (outcome === 'answered-then-refused' && calls === 1)
          return Response.json(
            { code: 'temporarily_unavailable', message: 'busy' },
            { status: 503 },
          );
        throw failed(coded('ECONNREFUSED'));
      },
    });
    const question = { record: {}, envelope: {} } as never;
    await expect(client.createQuestion('k', question)).rejects.toMatchObject({ notSent: true });
    expect(seen).toEqual(['error', 'error']);
    outcome = 'reset-then-refused';
    calls = 0;
    await expect(client.createQuestion('k', question)).rejects.toMatchObject({ notSent: false });
    // An attempt the relay answered reached it, whatever the next one does.
    outcome = 'answered-then-refused';
    calls = 0;
    await expect(client.createQuestion('k', question)).rejects.toMatchObject({ notSent: false });
    // A request that may follow a redirect never claims it was not sent.
    await expect(client.info()).rejects.toBeDefined();
    await expect(client.request('POST', '/api/v1/anything', { body: {} })).rejects.toMatchObject({
      notSent: false,
    });
  });
});
