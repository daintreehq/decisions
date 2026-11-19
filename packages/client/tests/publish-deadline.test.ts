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
  currentEpochKey,
  decisionResult,
  decisionText,
  openQuestionContent,
  parseAnswers,
  serializeAnswers,
  withholdPlan,
  type BridgeOptions,
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

  it('keeps a text-only ask sent while offline uncertain until the relay is reachable, then tells the agent no answer was recorded', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    env.relay.createNow = () => now;
    // No network at all. A failed request proves nothing about whether it was sent (fetch can retry one it already
    // sent), so the create is possibly committed.
    env.relay.down = 1_000;
    const deadline = now + 120_000;
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: {
        question: 'Ship it?',
        options: [{ id: 'y', label: 'Yes' }],
        expires_at: iso(deadline),
      },
    });
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      publication: 'possibly-committed',
    });
    now = deadline + 1_000;
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'queued',
      publication: 'possibly-committed',
      closedReason: null,
    });
    expect(env.sink.typed).toHaveLength(0);

    // Online again: the relay shows it never took the create, and the agent is told once.
    env.relay.down = 0;
    for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await env.store.putOutbox({ ...o, next_attempt_at: 0 });
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'publish-failed',
      publication: 'never-published',
      closedReason: 'never-published',
      fallbackDue: false,
      expiresAt: iso(deadline),
      deliveryStatus: 'terminal-delivered',
    });
    expect(env.sink.typed).toHaveLength(1);
    const notice = env.sink.typed[0]!.text;
    expect(notice).toContain('status: never-published');
    expect(notice).toContain('authorised: no');
    expect(notice).toContain(
      "it never reached the person's phone and no answer to it was recorded",
    );
    expect(notice).not.toMatch(/expired without an answer|did not answer|person never saw/);

    // Nothing more is sent for it, the notice is not typed twice, and no delivery is reported to a relay that never
    // held the question.
    await env.bridge.pump();
    expect(creates(env.relay)).toHaveLength(1);
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
    // The relay is asked, and holds no such question.
    expect(
      env.relay.calls.filter(
        (c) => c.method === 'GET' && c.path === `/api/v1/questions/${r.questionId}`,
      ),
    ).toHaveLength(1);
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

  /**
   * A question committed with its reply lost and answered, whose late retry an older relay refuses: one that checks
   * the deadline before the receipt (0.8.0).
   */
  const refusedLateRetry = async () => {
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
    now = deadline + 1_000;
    env.relay.rejectCreate = 400;
    const retry = async () => {
      for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
        await env.store.putOutbox({ ...o, next_attempt_at: 0 });
      await env.bridge.pump();
    };
    const reads = () =>
      env.relay.calls.filter(
        (c) => c.method === 'GET' && c.path === `/api/v1/questions/${r.questionId}`,
      ).length;
    return { env, questionId: r.questionId, retry, reads };
  };

  it('takes a question an older relay refused the late retry of as published once the relay shows it holds it, and delivers its answer', async () => {
    const { env, questionId, retry, reads } = await refusedLateRetry();
    await retry();
    expect(reads()).toBe(1);
    expect(await env.bridge.getDecision(questionId)).toMatchObject({
      status: 'open',
      publication: 'accepted',
      errorCode: null,
    });
    expect(await env.store.outboxFor(questionId)).toHaveLength(0);
    expect((await env.store.getQuestion(questionId))!.remote_event_seq).toBeNull();
    expect((await env.store.listAudit(50)).map((a) => a.event)).toContain('question.published');

    await env.bridge.catchUp();
    expect(await env.bridge.getDecision(questionId)).toMatchObject({
      status: 'human-answered',
      publication: 'accepted',
      provenance: 'human',
      choice: 'a',
    });
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain('choice: a');
  });

  it.each([
    ['cannot reach the relay', (relay: FakeRelay) => void (relay.failDetail = 1)],
    [
      'has its signature refused',
      (relay: FakeRelay) => void (relay.rejectDetail = { status: 401, code: 'not_authenticated' }),
    ],
  ] as const)(
    'keeps a refused create queued, possibly committed, while it %s to ask whether the relay holds it',
    async (_why, fail) => {
      const { env, questionId, retry, reads } = await refusedLateRetry();
      fail(env.relay);
      await retry();
      expect(reads()).toBe(1);
      expect(await env.bridge.getDecision(questionId)).toMatchObject({
        status: 'queued',
        publication: 'possibly-committed',
      });
      const [create] = await env.store.outboxFor(questionId);
      expect(create).toMatchObject({ kind: 'create', attempts: 2 });
      expect((create!.payload as CreatePayload).maybePublished).toBe(true);

      env.relay.rejectDetail = null;
      await retry();
      expect(reads()).toBe(2);
      expect(await env.bridge.getDecision(questionId)).toMatchObject({
        status: 'open',
        publication: 'accepted',
      });
    },
  );

  it('keeps the refusal when the relay holds another question under the id, or will not say', async () => {
    const other = await refusedLateRetry();
    // Another record under this id: not this create's question, whatever the relay says.
    const held = other.env.relay.questions.get(other.questionId)!;
    other.env.relay.questions.set(other.questionId, {
      ...held,
      signed: { ...held.signed, record: { ...held.signed.record, signature: 'x'.repeat(86) } },
    });
    await other.retry();
    expect(other.reads()).toBe(1);
    expect(await other.env.bridge.getDecision(other.questionId)).toMatchObject({
      status: 'publish-failed',
      publication: 'refused',
      errorCode: 'validation_error',
    });

    const silent = await refusedLateRetry();
    silent.env.relay.rejectDetail = { status: 403, code: 'forbidden' };
    await silent.retry();
    expect(silent.reads()).toBe(1);
    expect(await silent.env.bridge.getDecision(silent.questionId)).toMatchObject({
      status: 'publish-failed',
      publication: 'refused',
    });
    expect(await silent.env.store.outboxFor(silent.questionId)).toHaveLength(0);
  });

  it("reopens a question a refusal closed, once the relay's history shows it was taken and answered", async () => {
    const { env, questionId, retry, reads } = await refusedLateRetry();
    // The relay reads as holding no such question when asked, and its history arrives after.
    const held = env.relay.questions.get(questionId)!;
    env.relay.questions.delete(questionId);
    await retry();
    env.relay.questions.set(questionId, held);
    expect(reads()).toBe(1);
    expect(await env.bridge.getDecision(questionId)).toMatchObject({
      status: 'publish-failed',
      publication: 'refused',
    });

    await env.bridge.catchUp();
    expect(await env.bridge.getDecision(questionId)).toMatchObject({
      status: 'human-answered',
      publication: 'accepted',
      provenance: 'human',
      choice: 'a',
    });
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain('choice: a');
  });

  it('closes as withdrawn, with no notice, when a create withdrawn while it may have been sent proves never taken', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    env.relay.createNow = () => now;
    const deadline = now + 120_000;
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q?', options: [{ id: 'a', label: 'A' }], expires_at: iso(deadline) },
    });
    env.relay.down = 1; // the create may have reached the relay
    await env.bridge.pump();
    await env.bridge.publisher.enqueueCancel(r.questionId);
    expect((await env.store.outboxFor(r.questionId)).map((o) => o.kind).sort()).toEqual([
      'cancel',
      'create',
    ]);
    now = deadline + 1_000;
    for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await env.store.putOutbox({ ...o, next_attempt_at: 0 });
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'cancelled',
      publication: 'never-published',
      closedReason: 'withdrawn',
      fallbackDue: false,
    });
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
    expect(env.relay.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
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

  it('never sends a withdrawn create again after a crash in the middle of withdrawing it', async () => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const env = await setupBridge({ now: () => now });
    env.relay.createNow = () => now;
    const deadline = now + 120_000;
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q?', options: [{ id: 'a', label: 'A' }], expires_at: iso(deadline) },
    });
    env.relay.down = 1; // possibly committed
    await env.bridge.pump();
    await env.bridge.publisher.enqueueCancel(r.questionId); // queued behind the create, which may be on the relay
    // Past the deadline the relay shows it never took the create, so the withdrawal wins; the process dies once the
    // row is closed, before its items go.
    now = deadline + 1_000;
    for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await env.store.putOutbox({ ...o, next_attempt_at: 0 });
    const remove = env.store.deleteOutbox.bind(env.store);
    env.store.deleteOutbox = async () => {
      throw new Error('the process died');
    };
    await env.bridge.pump().catch(() => undefined);
    env.store.deleteOutbox = remove;
    expect((await env.store.getQuestion(r.questionId))!.local_status).toBe('cancelled');
    const sent = creates(env.relay).length;

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
    expect(creates(env.relay)).toHaveLength(sent); // the leftover create is dropped, never sent again
    expect(env.relay.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
    expect(await restarted.getDecision(r.questionId)).toMatchObject({
      status: 'cancelled',
      publication: 'never-published',
      closedReason: 'withdrawn',
    });
    expect(env.sink.typed).toHaveLength(0);
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
   * Queue a question, then sign its create as advisory, as `ask_human` does for an advisory ask. With
   * `rowOnly`, only the local copy of the content says advisory; the create stays signed as a blocking question.
   * With `busy`, its pane is busy when the deadline settles it, so nothing is typed yet.
   */
  const advisoryAsk = async (over: {
    advisoryDeadlines: boolean;
    policy: boolean;
    plan?: unknown;
    kind?: string;
    rowOnly?: boolean;
    busy?: boolean;
  }) => {
    let now = Date.parse('2026-11-19T10:00:00Z');
    const policy = new PolicyRegistry({ advisoryQuestions: over.policy });
    const env = await setupBridge({
      now: () => now,
      advisoryDeadlines: over.advisoryDeadlines,
      policy,
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
    if (over.busy) env.sink.panes.get('pane-1')!.idle = false;
    now = deadline;
    await env.bridge.pump();
    /** The same desktop restarted on the same store, with options of its own. */
    const restart = async (o: Partial<BridgeOptions>) => {
      await env.bridge.stop();
      return new DecisionsBridge({
        identity: env.identity,
        store: env.store,
        sink: env.sink,
        client: env.client,
        policy,
        pumpIntervalMs: 0,
        now: () => now,
        ...o,
      });
    };
    return { env, r, policy, restart };
  };
  const unpublishedEntry = async (env: Awaited<ReturnType<typeof setupBridge>>, id: string) =>
    parseAnswers((await env.store.getQuestion(id))!.answers_json).find(
      (e) => e.kind === 'unpublished',
    )!;
  const PLAN_DUE = 'You may carry out the plan you stated';

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

  it('withholds the plan once the policy no longer allows advice before its notice is typed', async () => {
    const { env, r, policy } = await advisoryAsk({
      advisoryDeadlines: true,
      policy: true,
      plan: 'Use the in-memory fixture.',
      busy: true,
    });
    expect(env.sink.typed).toHaveLength(0);
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      closedReason: 'never-published',
      fallbackDue: true,
    });
    policy.advisoryQuestions = false;
    // What get_decision says follows the policy before anything is typed.
    const view = await env.bridge.getDecision(r.questionId);
    expect(view).toMatchObject({ closedReason: 'never-published', fallbackDue: false });
    expect(decisionResult(view)).toMatchObject({ fallback_due: false });
    expect(decisionText(view)).toContain('You are not authorised to continue the gated step');
    expect(decisionText(view)).not.toContain('you may carry out the plan');
    // Reading changes nothing: allowed again before anything is typed, the plan is due again.
    expect((await unpublishedEntry(env, r.questionId)).fallback_due).toBe(true);
    policy.advisoryQuestions = true;
    const allowed = await env.bridge.getDecision(r.questionId);
    expect(allowed).toMatchObject({ fallbackDue: true });
    expect(decisionResult(allowed)).toMatchObject({ fallback_due: true });
    expect(decisionText(allowed)).toContain('you may carry out the plan you stated');
    policy.advisoryQuestions = false;
    env.sink.panes.get('pane-1')!.idle = true;
    await env.bridge.notifyPaneIdle();
    expect(env.sink.typed).toHaveLength(1);
    const notice = env.sink.typed[0]!.text;
    expect(notice).toContain('status: never-published');
    expect(notice).toContain('NOT authorised to continue');
    expect(notice).not.toContain(PLAN_DUE);
    const entry = await unpublishedEntry(env, r.questionId);
    expect(entry.delivered).toBe(true);
    expect(entry.fallback_due).toBeUndefined();
    // Allowing advice again never brings a withheld plan back.
    policy.advisoryQuestions = true;
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({ fallbackDue: false });
  });

  it('withholds the plan the policy turned off while its notice was being admitted', async () => {
    const { env, r, policy } = await advisoryAsk({
      advisoryDeadlines: true,
      policy: true,
      plan: 'Use the in-memory fixture.',
      busy: true,
    });
    const putIntent = env.store.putIntent.bind(env.store);
    const first: { id?: string; due?: boolean } = {};
    // The host turns advice off while delivery writes its intent, after it read the policy.
    env.store.putIntent = async (i) => {
      if (first.id === undefined) {
        first.id = i.injection_id;
        first.due = (await unpublishedEntry(env, r.questionId)).fallback_due;
      }
      policy.advisoryQuestions = false;
      return putIntent(i);
    };
    env.sink.panes.get('pane-1')!.idle = true;
    await env.bridge.notifyPaneIdle();
    // The plan was still due when that write was admitted; its intent was closed unwritten, and another attempt typed.
    expect(first.due).toBe(true);
    expect((await env.store.getIntent(first.id!))?.state).toBe('abandoned');
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.id).not.toBe(first.id);
    expect(env.sink.typed[0]!.text).toContain('NOT authorised to continue');
    expect(env.sink.typed[0]!.text).not.toContain(PLAN_DUE);
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({ fallbackDue: false });
  });

  it('keeps what a typed notice said when the policy changes afterwards', async () => {
    const { env, r, policy, restart } = await advisoryAsk({
      advisoryDeadlines: true,
      policy: true,
      plan: 'Use the in-memory fixture.',
    });
    expect(env.sink.typed[0]!.text).toContain(PLAN_DUE);
    expect(await unpublishedEntry(env, r.questionId)).toMatchObject({
      delivered: true,
      injection_id: env.sink.typed[0]!.id,
    });
    policy.advisoryQuestions = false;
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      closedReason: 'never-published',
      deliveryStatus: 'terminal-delivered',
      fallbackDue: true,
    });
    expect((await unpublishedEntry(env, r.questionId)).fallback_due).toBe(true);
    // Nor does a host that stopped delivering advisory outcomes take back what was typed.
    policy.advisoryQuestions = true;
    const again = await restart({ advisoryDeadlines: false });
    expect(await again.getDecision(r.questionId)).toMatchObject({ fallbackDue: true });
  });

  it('withholds the plan on a host that no longer delivers advisory outcomes, before its notice is typed', async () => {
    const { env, r, restart } = await advisoryAsk({
      advisoryDeadlines: true,
      policy: true,
      plan: 'Use the in-memory fixture.',
      busy: true,
    });
    expect((await unpublishedEntry(env, r.questionId)).fallback_due).toBe(true);
    const again = await restart({ advisoryDeadlines: false });
    expect(await again.getDecision(r.questionId)).toMatchObject({
      closedReason: 'never-published',
      fallbackDue: false,
    });
    env.sink.panes.get('pane-1')!.idle = true;
    await again.notifyPaneIdle();
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain('NOT authorised to continue');
    expect(env.sink.typed[0]!.text).not.toContain(PLAN_DUE);
    expect((await unpublishedEntry(env, r.questionId)).fallback_due).toBeUndefined();
  });

  it('types a notice built before its plan was withheld as withheld, while advice is still allowed', async () => {
    const { env, r } = await advisoryAsk({
      advisoryDeadlines: true,
      policy: true,
      plan: 'Use the in-memory fixture.',
      busy: true,
    });
    const isIdle = env.sink.isIdle.bind(env.sink);
    let withheld = false;
    // Delivery has built the notice with the plan due; the plan is withheld (by another pass) before it is admitted.
    env.sink.isIdle = async (t) => {
      if (!withheld) {
        withheld = true;
        const row = (await env.store.getQuestion(r.questionId))!;
        await env.store.updateQuestion(r.questionId, {
          answers_json: serializeAnswers(
            parseAnswers(row.answers_json).map((e) =>
              e.kind === 'unpublished' ? withholdPlan(e) : e,
            ),
          ),
        });
      }
      return isIdle(t);
    };
    env.sink.panes.get('pane-1')!.idle = true;
    await env.bridge.notifyPaneIdle();
    expect(withheld).toBe(true);
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain('NOT authorised to continue');
    expect(env.sink.typed[0]!.text).not.toContain(PLAN_DUE);
  });

  it('follows the host while a notice that could not be written waits for attention', async () => {
    const { env, r, policy } = await advisoryAsk({
      advisoryDeadlines: true,
      policy: true,
      plan: 'Use the in-memory fixture.',
      busy: true,
    });
    env.sink.injectBehaviour = { unavailable: 'relaunched' };
    env.sink.panes.get('pane-1')!.idle = true;
    await env.bridge.notifyPaneIdle();
    expect(env.sink.typed).toHaveLength(0);
    expect(await env.store.hasUncertainIntent(r.questionId)).toBe(false);
    policy.advisoryQuestions = false;
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      deliveryStatus: 'needs-attention',
      fallbackDue: false,
    });
    expect((await unpublishedEntry(env, r.questionId)).fallback_due).toBe(true);
    env.sink.injectBehaviour = 'ok';
    await env.bridge.retryDelivery(r.questionId);
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain('NOT authorised to continue');
    expect((await unpublishedEntry(env, r.questionId)).fallback_due).toBeUndefined();
  });

  it('keeps what a notice that may have been typed said when the policy changes afterwards', async () => {
    const { env, r, policy } = await advisoryAsk({
      advisoryDeadlines: true,
      policy: true,
      plan: 'Use the in-memory fixture.',
      busy: true,
    });
    env.sink.injectBehaviour = 'ambiguous';
    env.sink.panes.get('pane-1')!.idle = true;
    await env.bridge.notifyPaneIdle();
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain(PLAN_DUE);
    const attempt = env.sink.typed[0]!.id;
    expect((await env.store.getIntent(attempt))?.state).toBe('uncertain');
    policy.advisoryQuestions = false;
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      closedReason: 'never-published',
      deliveryStatus: 'delivery-uncertain',
      fallbackDue: true,
    });
    // A retry clears the question's flag, not the uncertain intent: nothing is typed again, and what may be on the
    // screen still stands.
    await env.bridge.retryDelivery(r.questionId);
    await env.bridge.notifyPaneIdle();
    expect(env.sink.typed).toHaveLength(1);
    expect((await env.store.getIntent(attempt))?.state).toBe('uncertain');
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      closedReason: 'never-published',
      deliveryStatus: 'desktop-received',
      fallbackDue: true,
    });
    expect(await unpublishedEntry(env, r.questionId)).toMatchObject({
      delivered: false,
      fallback_due: true,
    });
  });

  it('keeps the plan of a question flagged as possibly typed, whatever its intents say', async () => {
    const { env, r, policy } = await advisoryAsk({
      advisoryDeadlines: true,
      policy: true,
      plan: 'Use the in-memory fixture.',
      busy: true,
    });
    await env.store.updateQuestion(r.questionId, { delivery_status: 'delivery-uncertain' });
    expect(await env.store.hasUncertainIntent(r.questionId)).toBe(false);
    policy.advisoryQuestions = false;
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      deliveryStatus: 'delivery-uncertain',
      fallbackDue: true,
    });
  });
});
