import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { decryptEnvelope } from '@daintreehq/decisions-crypto';
import { EventData, SignedQuestion } from '@daintreehq/decisions-protocol';
import {
  DecisionsBridge,
  FileSpool,
  PolicyRegistry,
  RelayClient,
  TOOLS,
  TokenMapAuthenticator,
  askedInstruction,
  parseExpiresIn,
  startDecisionsMcpServer,
  type RunningMcp,
  type WorkflowGate,
} from '../src/index.js';
import { SqliteLocalStore } from '../src/store-sqlite.js';
import { FakeRelay, FakeSink, makeIdentity, origin, setupBridge } from './helpers.js';

/*
 * ask_human's reply window and the plan it returns (issue #154): a relative deadline worked out once on the host
 * clock, advice with a stated plan where the host may sign it, a receipt that says what applies, and retries that
 * return the original question only when nothing about the request changed.
 */

const T0 = Date.parse('2026-11-19T10:00:00.000Z');
const MIN = 60_000;
const DAY = 86_400_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const ADVISORY = 'advisory-deadlines-v1';
const PLAN = 'I will use the in-memory fixture.';

const tmp = mkdtempSync(join(tmpdir(), 'decisions-ask-plan-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const gate = (gateId: string, extra: Partial<WorkflowGate> = {}): WorkflowGate => ({
  gateId,
  minRequirement: 'human-required',
  policyVersion: 1,
  ...extra,
});

/** A bridge on a clock the test moves. `advisory` turns on every host-side permission for advice. */
async function env(o: { policy?: PolicyRegistry; advisory?: boolean } = {}) {
  let now = T0;
  const policy = o.policy ?? new PolicyRegistry({ advisoryQuestions: o.advisory === true });
  const e = await setupBridge({
    policy,
    now: () => now,
    ...(o.advisory ? { advisoryDeadlines: true } : {}),
  });
  return {
    ...e,
    policy,
    setNow: (t: number) => void (now = t),
    ask: (input: Record<string, unknown>, over: Parameters<typeof origin>[0] = {}) =>
      e.bridge.registerQuestion({ origin: origin(over), input: { question: 'q', ...input } }),
    /** As `ask`, without the background publish `registerQuestion` starts: the question stays queued. */
    askQueued: (input: Record<string, unknown>) =>
      e.bridge.publisher.register(origin(), { question: 'q', ...input }),
  };
}

/** A relay and a phone that both support advisory questions, read once by the pump. */
async function advisoryEnv() {
  const e = await env({ advisory: true });
  e.relay.features = ['thread-messages-v1', ADVISORY];
  e.relay.deviceFeatures.set(e.phone.deviceId, [ADVISORY]);
  await e.bridge.pump();
  return e;
}

describe('expires_in: a relative reply window', () => {
  it('accepts a whole number and one unit, from 61 seconds to 365 days', () => {
    expect(parseExpiresIn('15m')).toBe(15 * MIN);
    expect(parseExpiresIn('90s')).toBe(90_000);
    expect(parseExpiresIn('61s')).toBe(61_000);
    expect(parseExpiresIn('2h')).toBe(2 * 3_600_000);
    expect(parseExpiresIn('7d')).toBe(7 * DAY);
    expect(parseExpiresIn('365d')).toBe(365 * DAY);
    for (const bad of [
      '60s',
      '1m',
      '366d',
      '0m',
      '015m',
      '1.5h',
      '-5m',
      '+5m',
      '15',
      'm',
      '15 m',
      ' 15m',
      '15M',
      '1h30m',
      '15min',
      '9999999999s',
    ])
      expect(parseExpiresIn(bad), bad).toBeNull();
  });

  it('a 15-minute request is due exactly 15 minutes after the host took it, in the receipt, the row and the signature', async () => {
    const e = await env();
    const r = await e.ask({ expires_in: '15m' });
    expect(r).toMatchObject({
      expiresAt: at(15 * MIN),
      requestedExpiresAt: at(15 * MIN),
      replyMode: 'blocking',
      plannedFallback: null,
      adjustments: [],
      duplicate: false,
    });
    await e.bridge.pump();
    expect((await e.store.getQuestion(r.questionId))!.expires_at).toBe(at(15 * MIN));
    expect(e.relay.questions.get(r.questionId)!.signed.record.expires_at).toBe(at(15 * MIN));
  });

  it('a workflow gate caps it, and the receipt says which gate and what was asked', async () => {
    const policy = new PolicyRegistry();
    policy.register(gate('review', { expiryMs: 5 * MIN }));
    const e = await env({ policy });
    const fromOrigin = await e.ask({ expires_in: '15m' }, { workflow_gate_id: 'review' });
    expect(fromOrigin.expiresAt).toBe(at(5 * MIN));
    expect(fromOrigin.adjustments).toEqual([
      {
        field: 'expires_at',
        requested: at(15 * MIN),
        effective: at(5 * MIN),
        source: 'gate',
        gateId: 'review',
      },
    ]);
    const named = await e.ask({ expires_in: '15m', workflow_gate_id: 'review' });
    expect(named.expiresAt).toBe(at(5 * MIN));
    expect(named.adjustments[0]).toMatchObject({ source: 'gate', gateId: 'review' });
    // A request inside the cap is left alone.
    expect((await e.ask({ expires_in: '2m' }, { workflow_gate_id: 'review' })).adjustments).toEqual(
      [],
    );
  });

  it('the host caps it too, and its default fills in when nothing is asked', async () => {
    const e = await env({ policy: new PolicyRegistry({ defaultQuestionExpiryMs: DAY }) });
    const far = await e.ask({ expires_in: '60d' });
    expect(far.expiresAt).toBe(at(30 * DAY));
    expect(far.adjustments).toEqual([
      {
        field: 'expires_at',
        requested: at(60 * DAY),
        effective: at(30 * DAY),
        source: 'host',
        gateId: null,
      },
    ]);
    const none = await e.ask({});
    expect(none).toMatchObject({ expiresAt: at(DAY), requestedExpiresAt: null });
    expect(none.adjustments).toEqual([
      { field: 'expires_at', requested: null, effective: at(DAY), source: 'host', gateId: null },
    ]);
  });

  it('under a host default of never, nothing asked never expires, and a requested window still applies', async () => {
    const e = await env({ policy: new PolicyRegistry({ defaultQuestionExpiryMs: null }) });
    const never = await e.ask({});
    expect(never).toMatchObject({ expiresAt: null, requestedExpiresAt: null, adjustments: [] });
    const windowed = await e.ask({ expires_in: '15m' });
    expect(windowed).toMatchObject({ expiresAt: at(15 * MIN), adjustments: [] });
  });

  it('refuses both deadlines at once, and every malformed window, before anything is stored', async () => {
    const e = await env();
    await expect(e.ask({ expires_in: '15m', expires_at: at(DAY) })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'expires_in: supply only one of expires_at and expires_in',
    });
    for (const bad of ['1m', '15 minutes', '1.5h', '366d', 15])
      await expect(e.ask({ expires_in: bad }), String(bad)).rejects.toMatchObject({
        code: 'validation_error',
        message: expect.stringContaining('expires_in'),
      });
    expect(await e.store.listQuestions()).toHaveLength(0);
  });

  it('an older caller that sends expires_at, or no deadline at all, is answered as before plus the plan', async () => {
    const e = await env();
    const r = await e.ask({ expires_at: '2026-11-19T12:15:00+02:00' });
    expect(r).toMatchObject({
      expiresAt: at(15 * MIN),
      requestedExpiresAt: at(15 * MIN),
      adjustments: [],
    });
    await expect(e.ask({ expires_at: at(MIN) })).rejects.toMatchObject({
      message: 'expires_at must be at least one minute in the future',
    });
  });
});

describe('planned_fallback: asking for advice', () => {
  it('signs an advisory question with its plan and a finite deadline when every permission holds', async () => {
    const e = await advisoryEnv();
    const r = await e.ask({
      question: 'Which fixture?',
      expires_in: '15m',
      planned_fallback: PLAN,
    });
    expect(r).toMatchObject({
      replyMode: 'advisory',
      plannedFallback: PLAN,
      expiresAt: at(15 * MIN),
    });
    await e.bridge.pump();
    const signed = e.relay.questions.get(r.questionId)!.signed;
    expect(SignedQuestion.safeParse(signed).success).toBe(true);
    expect(signed.envelope.aad).toMatchObject({ reply_mode: 'advisory', revision: 0 });
    expect(signed.record.workflow_gate_id_hash).toBeNull();
    expect(signed.record.expires_at).toBe(at(15 * MIN));
    const content = await decryptEnvelope<{ planned_fallback?: string }>(
      signed.envelope,
      e.identity.epochs,
    );
    expect(content.planned_fallback).toBe(PLAN);
    // The bridge reads its own create back from the ledger as a valid advisory question.
    expect(
      EventData.created.safeParse(
        e.relay.events.find((ev) => ev.question_id === r.questionId)!.data,
      ).success,
    ).toBe(true);
    expect(await e.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'open',
      replyMode: 'advisory',
      plannedFallback: PLAN,
    });
  });

  it('a blocking question signs exactly as before: no mode, no plan', async () => {
    const e = await advisoryEnv();
    const r = await e.ask({ expires_in: '15m' });
    await e.bridge.pump();
    const signed = e.relay.questions.get(r.questionId)!.signed;
    expect('reply_mode' in signed.envelope.aad).toBe(false);
    const content = await decryptEnvelope<Record<string, unknown>>(
      signed.envelope,
      e.identity.epochs,
    );
    expect('planned_fallback' in content).toBe(false);
    expect((await e.bridge.getDecision(r.questionId)).replyMode).toBe('blocking');
  });

  it('a host default deadline is enough for advice; never is not', async () => {
    const e = await advisoryEnv();
    expect((await e.ask({ planned_fallback: PLAN })).expiresAt).toBe(at(7 * DAY));
    e.policy.defaultQuestionExpiryMs = null;
    await expect(e.ask({ planned_fallback: PLAN })).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(/^no-deadline: /),
    });
  });

  it('refuses advice that may never stand, with a reason, and never asks a blocking question instead', async () => {
    const policy = new PolicyRegistry({ advisoryQuestions: true });
    policy.register(gate('review'));
    const e = await env({ policy, advisory: true });
    e.relay.features = ['thread-messages-v1', ADVISORY];
    e.relay.deviceFeatures.set(e.phone.deviceId, [ADVISORY]);
    await e.bridge.pump();
    const cases: [Record<string, unknown>, Parameters<typeof origin>[0], string, string][] = [
      [{ kind: 'approval' }, {}, 'validation_error', 'approval'],
      [{ workflow_gate_id: 'no-such-gate' }, {}, 'validation_error', 'gated'],
      [{ workflow_gate_id: 'review' }, {}, 'validation_error', 'gated'],
      [{}, { workflow_gate_id: 'review' }, 'validation_error', 'gated'],
      [{}, { workflow_gate_id: 'unregistered' }, 'validation_error', 'gated'],
    ];
    for (const [input, over, code, reason] of cases) {
      const err = await e
        .ask({ expires_in: '15m', planned_fallback: PLAN, ...input }, over)
        .catch((x: unknown) => x);
      expect(err, reason).toMatchObject({ code, message: expect.stringMatching(`^${reason}: `) });
      expect((err as Error).message).toContain('ask again without planned_fallback');
    }
    for (const plan of ['', '   ', 'x'.repeat(1001), 42])
      await expect(e.ask({ expires_in: '15m', planned_fallback: plan })).rejects.toMatchObject({
        code: 'validation_error',
        message: expect.stringContaining('planned_fallback'),
      });
    expect(await e.store.listQuestions()).toHaveLength(0);
    expect(e.relay.questions.size).toBe(0);
  });

  it('refuses advice on a host that did not opt in, or whose policy does not allow it, without reading the relay', async () => {
    for (const [o, code, reason] of [
      [
        { policy: new PolicyRegistry({ advisoryQuestions: true }) },
        'not_supported',
        'host-unsupported',
      ],
      [{ policy: new PolicyRegistry(), advisory: true }, 'forbidden', 'policy-disallowed'],
    ] as const) {
      const e = await env(o);
      e.relay.features = ['thread-messages-v1', ADVISORY];
      await e.bridge.pump();
      await expect(e.ask({ expires_in: '15m', planned_fallback: PLAN })).rejects.toMatchObject({
        code,
        message: expect.stringMatching(`^${reason}: `),
      });
      expect(e.relay.calls.filter((c) => c.path === '/api/v1/devices')).toHaveLength(0);
      expect(await e.store.listQuestions()).toHaveLength(0);
    }
  });

  it('an old relay: refused at once, nothing stored or sent, and a blocking ask still publishes there', async () => {
    const e = await env({ advisory: true });
    e.relay.features = ['thread-messages-v1'];
    await e.bridge.pump();
    await expect(e.ask({ expires_in: '15m', planned_fallback: PLAN })).rejects.toMatchObject({
      code: 'not_supported',
      message: expect.stringMatching(/^relay-unsupported: /),
    });
    expect(await e.store.listQuestions()).toHaveLength(0);
    // A 0.3.0 relay that lists no features at all is the same.
    e.relay.features = undefined;
    e.setNow(T0 + 2 * MIN);
    await e.bridge.pump();
    await expect(e.ask({ expires_in: '15m', planned_fallback: PLAN })).rejects.toMatchObject({
      message: expect.stringMatching(/^relay-unsupported: /),
    });
    const blocking = await e.ask({ expires_in: '15m' });
    await e.bridge.pump();
    expect(e.relay.questions.size).toBe(1);
    expect(e.relay.questions.has(blocking.questionId)).toBe(true);
  });

  it('needs an active phone or tablet that can show it', async () => {
    const e = await env({ advisory: true });
    e.relay.features = ['thread-messages-v1', ADVISORY];
    await e.bridge.pump();
    const refused = () =>
      expect(e.ask({ expires_in: '15m', planned_fallback: PLAN })).rejects.toMatchObject({
        code: 'not_supported',
        message: expect.stringMatching(/^no-capable-reader: /),
      });
    await refused(); // the phone declared nothing
    // The owner desktop declaring it does not count: it is not a device the person reads questions on.
    e.relay.deviceFeatures.set(e.identity.config.deviceId, [ADVISORY]);
    e.setNow(T0 + 2 * MIN);
    await e.bridge.pump();
    await refused();
    e.relay.deviceFeatures.set(e.phone.deviceId, [ADVISORY]);
    e.relay.revokedAt.set(e.phone.deviceId, at(MIN));
    e.setNow(T0 + 4 * MIN);
    await e.bridge.pump();
    await refused(); // revoked
    e.relay.revokedAt.delete(e.phone.deviceId);
    e.setNow(T0 + 6 * MIN);
    await e.bridge.pump();
    expect((await e.ask({ expires_in: '15m', planned_fallback: PLAN })).replyMode).toBe('advisory');
    // A revocation seen in the ledger counts at once, before the directory is read again.
    e.relay.push('device.revoked', null, null, { device_id: e.phone.deviceId, key_epoch: 1 });
    await e.bridge.catchUp();
    await refused();
  });

  it('when support is not known yet it refuses without waiting, reads in the background, and a retry is decided', async () => {
    const e = await env({ advisory: true });
    e.relay.features = ['thread-messages-v1', ADVISORY];
    e.relay.deviceFeatures.set(e.phone.deviceId, [ADVISORY]);
    let release!: () => void;
    e.relay.holdInfo = new Promise<void>((r) => (release = r));
    // Nothing read yet: the ask returns at once, refused, while the relay has not answered.
    await expect(e.ask({ expires_in: '15m', planned_fallback: PLAN })).rejects.toMatchObject({
      code: 'invalid_state',
      message: expect.stringMatching(/^support-unknown: /),
    });
    release();
    e.relay.holdInfo = null;
    await e.bridge.pump();
    expect((await e.ask({ expires_in: '15m', planned_fallback: PLAN })).replyMode).toBe('advisory');
    // What was read is believed for five minutes, then no longer.
    e.setNow(T0 + 5 * MIN);
    await expect(e.ask({ expires_in: '15m', planned_fallback: PLAN })).rejects.toMatchObject({
      message: expect.stringMatching(/^support-unknown: /),
    });
  });

  it('a stopped bridge forgets what it read, and a read that finishes after the stop restores nothing', async () => {
    const e = await env({ advisory: true });
    e.relay.features = ['thread-messages-v1', ADVISORY];
    e.relay.deviceFeatures.set(e.phone.deviceId, [ADVISORY]);
    let release!: () => void;
    e.relay.holdDevices = new Promise<void>((r) => (release = r));
    const pumping = e.bridge.pump();
    await new Promise((r) => setTimeout(r, 10));
    await e.bridge.stop();
    release();
    await pumping;
    await expect(e.ask({ expires_in: '15m', planned_fallback: PLAN })).rejects.toMatchObject({
      message: expect.stringMatching(/^support-unknown: /),
    });
  });
});

describe('correlation_id: retries and collisions', () => {
  it('an unchanged retry returns the original question and its original deadline, however late', async () => {
    const e = await env();
    const first = await e.ask({
      question: 'Which fixture?',
      expires_in: '15m',
      correlation_id: 'c1',
    });
    e.setNow(T0 + 10 * MIN);
    const again = await e.ask({
      question: 'Which fixture?',
      expires_in: '900s',
      correlation_id: 'c1',
    });
    expect(again).toEqual({ ...first, duplicate: true });
    expect(again.expiresAt).toBe(at(15 * MIN));
    expect(await e.store.listQuestions()).toHaveLength(1);
  });

  it('a material change under the same id asks a new question, and the id moves to it', async () => {
    const e = await env({
      policy: new PolicyRegistry({ advisoryQuestions: true }),
      advisory: true,
    });
    e.relay.features = ['thread-messages-v1', ADVISORY];
    e.relay.deviceFeatures.set(e.phone.deviceId, [ADVISORY]);
    await e.bridge.pump();
    const base = {
      question: 'Which fixture?',
      context: 'The suite needs one.',
      options: [
        { id: 'mem', label: 'In memory' },
        { id: 'disk', label: 'On disk' },
      ],
      expires_in: '15m',
      planned_fallback: PLAN,
      correlation_id: 'c1',
    };
    const first = await e.askQueued(base);
    const changes: Record<string, unknown>[] = [
      { question: 'Which fixture now?' },
      { context: 'Changed context.' },
      { options: [base.options[1], base.options[0]] },
      { options: [{ id: 'mem', label: 'Memory' }, base.options[1]] },
      { expires_in: '20m' },
      { expires_in: undefined, expires_at: at(15 * MIN) },
      { planned_fallback: 'I will use the on-disk fixture.' },
      { planned_fallback: undefined },
      { kind: 'choice' },
      { requested_requirement: 'human-required' },
    ];
    const seen = new Set([first.questionId]);
    // Withdrawn as they go, so the pane stays under its open-question limit; a closed question still counts.
    await e.bridge.cancelQuestion(first.questionId);
    for (const change of changes) {
      const r = await e.askQueued({ ...base, ...change });
      expect(r.duplicate, JSON.stringify(change)).toBe(false);
      expect(seen.has(r.questionId), JSON.stringify(change)).toBe(false);
      seen.add(r.questionId);
      // The id now points at the new question: repeating it is a duplicate of that one.
      expect((await e.askQueued({ ...base, ...change })).questionId).toBe(r.questionId);
      await e.bridge.cancelQuestion(r.questionId);
    }
    // And the original request, asked again, is a new question too: the id moved on from it.
    const back = await e.askQueued(base);
    expect(seen.has(back.questionId)).toBe(false);
  });

  it('a pane is never handed another pane’s question under the same id', async () => {
    const e = await env();
    const a = await e.ask({ correlation_id: 'c1' });
    const b = await e.ask({ correlation_id: 'c1' }, { pane_id: 'pane-2' });
    expect(b.questionId).not.toBe(a.questionId);
    expect(b.duplicate).toBe(false);
  });

  it('a changed request that fails leaves the id on the original question', async () => {
    const e = await env();
    const first = await e.ask({ question: 'A', expires_in: '15m', correlation_id: 'c1' });
    // No attachment resolver is configured, so this collision fails before anything is committed.
    await expect(
      e.ask({
        question: 'B',
        correlation_id: 'c1',
        attachments: [{ local_resource_id: 'missing.png' }],
      }),
    ).rejects.toMatchObject({ code: 'attachment_error' });
    const again = await e.ask({ question: 'A', expires_in: '15m', correlation_id: 'c1' });
    expect(again).toMatchObject({ questionId: first.questionId, duplicate: true });
  });

  it('identical asks at the same moment make one question', async () => {
    const e = await env();
    const [a, b] = await Promise.all([
      e.ask({ question: 'Same?', correlation_id: 'c1' }),
      e.ask({ question: 'Same?', correlation_id: 'c1' }),
    ]);
    expect(b.questionId).toBe(a.questionId);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(await e.store.listQuestions()).toHaveLength(1);
  });

  it('a retry after a restart returns the original deadline and plan, not a new reckoning', async () => {
    const identity = await makeIdentity();
    const relay = new FakeRelay(identity);
    await relay.initOwner();
    const dbPath = join(tmp, 'restart.db');
    let now = T0;
    const mk = (store: SqliteLocalStore, policy: PolicyRegistry) =>
      new DecisionsBridge({
        identity,
        store,
        sink: new FakeSink(),
        spool: new FileSpool(join(tmp, 'restart-spool')),
        pumpIntervalMs: 0,
        policy,
        now: () => now,
        client: new RelayClient({
          identity,
          fetch: relay.fetch,
          sleep: async () => {},
          maxRetries: 0,
        }),
      });
    const input = { question: 'Which fixture?', expires_in: '15m', correlation_id: 'c1' };
    const s1 = new SqliteLocalStore(dbPath);
    const b1 = mk(s1, new PolicyRegistry());
    const first = await b1.registerQuestion({ origin: origin(), input });
    // A changed request that fails before the "process exits" moves nothing.
    await expect(
      b1.registerQuestion({
        origin: origin(),
        input: { ...input, question: 'B', attachments: [{ local_resource_id: 'gone.png' }] },
      }),
    ).rejects.toMatchObject({ code: 'attachment_error' });
    await s1.close();

    // Later, a new process, and the host's default changed to never: none of it changes the first answer.
    now = T0 + 20 * MIN;
    const s2 = new SqliteLocalStore(dbPath);
    const b2 = mk(s2, new PolicyRegistry({ defaultQuestionExpiryMs: null }));
    const again = await b2.registerQuestion({ origin: origin(), input });
    expect(again).toEqual({ ...first, duplicate: true });
    expect(again.expiresAt).toBe(at(15 * MIN));
    expect(await s2.listQuestions()).toHaveLength(1);
    // A changed request after the restart is a new question, reckoned now.
    const changed = await b2.registerQuestion({
      origin: origin(),
      input: { ...input, question: 'Which fixture, really?' },
    });
    expect(changed.questionId).not.toBe(first.questionId);
    expect(changed.expiresAt).toBe(at(35 * MIN));
    await s2.close();
  });

  it('a process that stopped between the commit and moving the id finds the committed question', async () => {
    const e = await env();
    const first = await e.ask({ question: 'A', correlation_id: 'c1' });
    const key = [...(e.store as unknown as { meta: Map<string, string> }).meta.keys()].find((k) =>
      k.startsWith('corr:'),
    )!;
    const second = await e.ask({ question: 'B', correlation_id: 'c1' });
    // As if the process had stopped right after committing B: the id still names A, with B staged.
    await e.store.setMeta(key, JSON.stringify({ q: first.questionId, p: second.questionId }));
    expect(await e.ask({ question: 'B', correlation_id: 'c1' })).toMatchObject({
      questionId: second.questionId,
      duplicate: true,
    });
    // Staged but never committed: the id still names the committed question.
    await e.store.setMeta(key, JSON.stringify({ q: second.questionId, p: 'never-committed' }));
    expect((await e.ask({ question: 'B', correlation_id: 'c1' })).questionId).toBe(
      second.questionId,
    );
  });

  it('a question asked before this change, without a registration, is asked afresh once', async () => {
    const e = await env();
    const old = await e.ask({ question: 'A', correlation_id: 'c1' });
    const meta = (e.store as unknown as { meta: Map<string, string> }).meta;
    const key = [...meta.keys()].find((k) => k.startsWith('corr:'))!;
    // As stored before #154: the bare question id, and no registration record.
    meta.set(key, old.questionId);
    meta.delete(`reg:${old.questionId}`);
    const fresh = await e.ask({ question: 'A', correlation_id: 'c1' });
    expect(fresh.questionId).not.toBe(old.questionId);
    expect((await e.ask({ question: 'A', correlation_id: 'c1' })).questionId).toBe(
      fresh.questionId,
    );
  });

  it('an advisory retry that now names a gate is not the advisory question', async () => {
    const e = await advisoryEnv();
    const input = { expires_in: '15m', planned_fallback: PLAN, correlation_id: 'c1' };
    const first = await e.ask(input);
    await expect(e.ask({ ...input, workflow_gate_id: 'unknown' })).rejects.toMatchObject({
      message: expect.stringMatching(/^gated: /),
    });
    expect((await e.ask(input)).questionId).toBe(first.questionId);
  });
});

/* ---------------- over MCP ---------------- */

const TOKEN = 'pane-token-AAAAAAAAAAAAAAAAAAAAAAAA';
let running: RunningMcp | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function mcpFor(e: Awaited<ReturnType<typeof env>>) {
  const auth = new TokenMapAuthenticator();
  auth.register(TOKEN, origin());
  running = await startDecisionsMcpServer({ bridge: e.bridge, authenticator: auth });
  const mcp = running;
  return (name: string, args: unknown) =>
    new Promise<{
      content: { text: string }[];
      structuredContent: Record<string, unknown>;
      isError?: boolean;
    }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: mcp.port,
          path: '/mcp',
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(JSON.parse(b).result));
        },
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      );
    });
}

describe('over MCP', () => {
  it('ask_human lists both deadlines and the plan, and keeps every older field', () => {
    const [ask] = TOOLS;
    expect(ask.name).toBe('ask_human');
    const props = ask.inputSchema.properties;
    expect(props.expires_in).toMatchObject({ type: 'string', pattern: '^[1-9][0-9]{0,8}[smhd]$' });
    expect(props.expires_in.description).toContain('Not with expires_at');
    expect(props.planned_fallback).toMatchObject({ type: 'string', minLength: 1, maxLength: 1000 });
    expect(props.planned_fallback.description).toContain('Never for an approval');
    expect(props.correlation_id.description).toContain('same request returns the original');
    expect(ask.inputSchema.required).toEqual(['question']);
    expect(Buffer.byteLength(ask.description)).toBeLessThan(400);
  });

  it('a 15-minute advisory ask: the receipt gives the deadline, the mode, the plan, the notice to expect and how to recover', async () => {
    const e = await advisoryEnv();
    const call = await mcpFor(e);
    const res = await call('ask_human', {
      question: 'Which fixture should I use?',
      expires_in: '15m',
      planned_fallback: PLAN,
      correlation_id: 'fixture-choice',
    });
    expect(res.isError).toBeUndefined();
    const id = res.structuredContent.question_id as string;
    expect(res.structuredContent).toEqual({
      question_id: id,
      status: 'queued',
      duplicate: false,
      enforced_requirement: 'human-required',
      reply_mode: 'advisory',
      expires_at: at(15 * MIN),
      requested_expires_at: at(15 * MIN),
      planned_fallback: PLAN,
      policy_adjustments: [],
      instruction: res.content[0].text,
    });
    const text = res.content[0].text;
    expect(text.startsWith(askedInstruction(1))).toBe(true);
    expect(text).toContain(`Asked for advice, due ${at(15 * MIN)} (UTC).`);
    expect(text).toContain('a notice arrives here that the deadline passed unanswered');
    expect(text).toContain('The deadline decides and approves nothing.');
    expect(text).toContain(`call get_decision with question_id ${id}`);

    const again = await call('ask_human', {
      question: 'Which fixture should I use?',
      expires_in: '15m',
      planned_fallback: PLAN,
      correlation_id: 'fixture-choice',
    });
    expect(again.structuredContent).toMatchObject({ question_id: id, duplicate: true });
    expect(again.content[0].text).toMatch(/^Already asked as q-1: /);
  });

  it('a capped approval: the receipt says blocking, names the gate and what it changed', async () => {
    const policy = new PolicyRegistry({ proxyAllowlisted: true });
    policy.register(gate('release', { expiryMs: 5 * MIN }));
    const e = await env({ policy });
    const call = await mcpFor(e);
    const res = await call('ask_human', {
      question: 'Approve publishing the release notes?',
      kind: 'approval',
      requested_requirement: 'proxy-ok',
      workflow_gate_id: 'release',
      expires_in: '15m',
    });
    expect(res.structuredContent).toMatchObject({
      reply_mode: 'blocking',
      enforced_requirement: 'human-required',
      expires_at: at(5 * MIN),
      requested_expires_at: at(15 * MIN),
      planned_fallback: null,
      policy_adjustments: [
        {
          field: 'expires_at',
          requested: at(15 * MIN),
          effective: at(5 * MIN),
          source: 'gate',
          gate_id: 'release',
        },
        {
          field: 'requirement',
          requested: 'proxy-ok',
          effective: 'human-required',
          source: 'gate',
          gate_id: 'release',
        },
      ],
    });
    expect(res.content[0].text).toContain(
      `Policy: the workflow gate release moved the deadline you asked for (${at(15 * MIN)}) to ${at(5 * MIN)}; the workflow gate release raised the requirement from proxy-ok to human-required.`,
    );
    expect(res.content[0].text).toContain(
      'unanswered by then, it expires, and expiry authorises nothing',
    );
  });

  it('a refused ask is a tool error that says why and what to do', async () => {
    const e = await env({ advisory: true });
    e.relay.features = ['thread-messages-v1'];
    await e.bridge.pump();
    const call = await mcpFor(e);
    const res = await call('ask_human', {
      question: 'q',
      expires_in: '15m',
      planned_fallback: PLAN,
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toEqual({ error: 'not_supported' });
    expect(res.content[0].text).toMatch(/^not_supported: relay-unsupported: /);
    const both = await call('ask_human', { question: 'q', expires_in: '15m', expires_at: at(DAY) });
    expect(both.content[0].text).toBe(
      'validation_error: expires_in: supply only one of expires_at and expires_in',
    );
  });

  it('get_decision reports every final outcome in structured form', async () => {
    const policy = new PolicyRegistry({ proxyAllowlisted: true, advisoryQuestions: true });
    const e = await env({ policy, advisory: true });
    e.relay.features = ['thread-messages-v1', ADVISORY];
    e.relay.deviceFeatures.set(e.phone.deviceId, [ADVISORY]);
    await e.bridge.pump();
    const call = await mcpFor(e);
    const options = [
      { id: 'mem', label: 'In memory' },
      { id: 'disk', label: 'On disk' },
    ];
    const ask = async (input: Record<string, unknown>) =>
      (
        await call('ask_human', {
          question: 'Which fixture?',
          options,
          expires_in: '15m',
          ...input,
        })
      ).structuredContent.question_id as string;
    const human = await ask({});
    const proxy = await ask({ requested_requirement: 'proxy-ok' });
    const declined = await ask({});
    const withdrawn = await ask({});
    const expired = await ask({});
    const advised = await ask({ planned_fallback: PLAN });
    await e.bridge.pump();
    e.relay.rejectCreate = 400;
    const failed = await ask({});
    await e.bridge.pump();
    e.relay.rejectCreate = null;

    const desktop = { deviceId: e.identity.config.deviceId, keys: e.identity.keys };
    await e.relay.answerEvent({
      questionId: human,
      phone: e.phone,
      options: ['mem'],
      text: 'Use it',
    });
    await e.relay.answerEvent({
      questionId: proxy,
      phone: desktop,
      action: 'proxy-answer',
      options: ['disk'],
    });
    await e.relay.plainActionEvent({ questionId: declined, signer: e.phone, action: 'cancel' });
    await e.relay.plainActionEvent({ questionId: withdrawn, signer: desktop, action: 'cancel' });
    // The relay expires a question at its signed deadline, and the bridge believes it only once that has passed.
    e.relay.expiryEvent({ questionId: expired });
    e.relay.expiryEvent({ questionId: advised });
    e.setNow(T0 + 16 * MIN);
    await e.bridge.catchUp();

    const get = (id: string) => call('get_decision', { question_id: id });
    const common = { expires_at: at(15 * MIN), revision: expect.any(Number) };
    const blocking = { reply_mode: 'blocking', planned_fallback: null, error_code: null };
    const h = await get(human);
    expect(h.structuredContent).toMatchObject({
      ...common,
      ...blocking,
      status: 'human-answered',
      provenance: 'human',
      answered_on: 'phone',
      closed_reason: null,
      choice: 'mem',
      text: 'Use it',
    });
    const p = await get(proxy);
    expect(p.structuredContent).toMatchObject({
      ...blocking,
      status: 'proxy-answered',
      provenance: 'proxy',
      answered_on: null,
      closed_reason: null,
      choice: 'disk',
      reviewed_digests_match: false,
    });
    expect((await get(declined)).structuredContent).toMatchObject({
      ...blocking,
      status: 'cancelled',
      closed_reason: 'declined',
      provenance: null,
      choice: null,
      text: '',
    });
    expect((await get(withdrawn)).structuredContent).toMatchObject({
      ...blocking,
      status: 'cancelled',
      closed_reason: 'withdrawn',
      provenance: null,
      choice: null,
    });
    const x = await get(expired);
    expect(x.structuredContent).toMatchObject({
      ...blocking,
      status: 'expired',
      closed_reason: 'expired',
      provenance: null,
      choice: null,
      text: '',
    });
    expect(x.content[0].text).toContain('you are not authorised to continue');
    const a = await get(advised);
    expect(a.structuredContent).toMatchObject({
      status: 'expired',
      closed_reason: 'expired',
      provenance: null,
      choice: null,
      text: '',
      revision: 0,
      reply_mode: 'advisory',
      planned_fallback: PLAN,
      error_code: null,
    });
    expect(a.content[0].text).toContain('nothing was decided or approved');
    expect(a.content[0].text).toContain(
      'the plan you stated (planned_fallback) is yours to carry out',
    );
    const f = await get(failed);
    expect(f.structuredContent).toMatchObject({
      ...blocking,
      error_code: 'validation_error',
      status: 'publish-failed',
      provenance: null,
      closed_reason: null,
    });
    expect(f.content[0].text).toContain('could not be published (validation_error)');
  });
});
