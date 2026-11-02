import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '@daintreehq/decisions-protocol';
import {
  PolicyRegistry,
  QUESTION_EXPIRY_LIMIT_MS,
  questionExpiryPolicy,
  resolveExpiry,
  type WorkflowGate,
} from '../src/index.js';
import { origin, setupBridge } from './helpers.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A bridge on a fixed clock, so expiries can be compared exactly. */
async function env(policy: PolicyRegistry) {
  const now = Date.now();
  const e = await setupBridge({ policy, now: () => now });
  return { ...e, now };
}

type Env = Awaited<ReturnType<typeof env>>;

/** Asks, publishes, and returns the expiry the stored row and the signed record carry, which must agree. */
async function ask(
  e: Env,
  input: Record<string, unknown>,
  over: Parameters<typeof origin>[0] = {},
): Promise<string | null> {
  const r = await e.bridge.registerQuestion({
    origin: origin(over),
    input: { question: 'q', ...input },
  });
  await e.bridge.pump();
  const stored = (await e.store.getQuestion(r.questionId))!.expires_at;
  const signed = e.relay.questions.get(r.questionId)!.signed.record.expires_at;
  expect(signed).toBe(stored);
  return stored;
}

const at = (e: Env, ms: number) => new Date(e.now + ms).toISOString();
const gate = (gateId: string, extra: Partial<WorkflowGate> = {}): WorkflowGate => ({
  gateId,
  minRequirement: 'human-required',
  policyVersion: 1,
  ...extra,
});

describe('the host default expiry of questions with no origin gate', () => {
  it('stays 7 days when the host sets none', async () => {
    const e = await env(new PolicyRegistry());
    expect(await ask(e, {})).toBe(at(e, DEFAULTS.questionExpiryMs));
  });

  it('a finite host default applies when the agent asks for no expiry', async () => {
    const e = await env(new PolicyRegistry({ defaultQuestionExpiryMs: 2 * DAY }));
    expect(await ask(e, {})).toBe(at(e, 2 * DAY));
  });

  it('a null host default publishes no expiry', async () => {
    const e = await env(new PolicyRegistry({ defaultQuestionExpiryMs: null }));
    expect(await ask(e, {})).toBeNull();
  });

  it('with a null host default an agent may still ask for a finite expiry', async () => {
    const e = await env(new PolicyRegistry({ defaultQuestionExpiryMs: null }));
    expect(await ask(e, { expires_at: at(e, 3 * DAY) })).toBe(at(e, 3 * DAY));
  });

  it('an agent may ask for up to 30 days, or up to a longer host default', async () => {
    const short = await env(new PolicyRegistry({ defaultQuestionExpiryMs: 2 * DAY }));
    expect(await ask(short, { expires_at: at(short, 10 * DAY) })).toBe(at(short, 10 * DAY));
    expect(await ask(short, { expires_at: at(short, 90 * DAY) })).toBe(at(short, 30 * DAY));
    const long = await env(new PolicyRegistry({ defaultQuestionExpiryMs: 45 * DAY }));
    expect(await ask(long, { expires_at: at(long, 40 * DAY) })).toBe(at(long, 40 * DAY));
    expect(await ask(long, { expires_at: at(long, 90 * DAY) })).toBe(at(long, 45 * DAY));
  });

  it('refuses an expiry beyond what the relay accepts, before anything is stored', async () => {
    const policy = new PolicyRegistry({ defaultQuestionExpiryMs: null });
    policy.register(gate('unset'));
    policy.register(gate('hour', { expiryMs: HOUR }));
    const e = await env(policy);
    const tooFar = at(e, QUESTION_EXPIRY_LIMIT_MS + 1);
    for (const input of [{}, { workflow_gate_id: 'unset' }]) {
      await expect(
        e.bridge.registerQuestion({
          origin: origin(),
          input: { question: 'q', expires_at: tooFar, ...input },
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });
    }
    expect(await e.store.listQuestions()).toHaveLength(0);
    // At the limit it is accepted, and a gate that cuts the request short makes it acceptable.
    expect(await ask(e, { expires_at: at(e, QUESTION_EXPIRY_LIMIT_MS) })).toBe(
      at(e, QUESTION_EXPIRY_LIMIT_MS),
    );
    expect(await ask(e, { expires_at: tooFar, workflow_gate_id: 'hour' })).toBe(at(e, HOUR));
  });

  it('the host can change the default while the bridge runs', async () => {
    const policy = new PolicyRegistry();
    const e = await env(policy);
    policy.defaultQuestionExpiryMs = null;
    expect(policy.defaultQuestionExpiryMs).toBeNull();
    expect(await ask(e, {})).toBeNull();
    policy.defaultQuestionExpiryMs = 12 * HOUR;
    expect(await ask(e, {})).toBe(at(e, 12 * HOUR));
  });
});

describe('a gate the agent names only shortens the host default', () => {
  it('a shorter named gate wins over a null host default', async () => {
    const policy = new PolicyRegistry({ defaultQuestionExpiryMs: null });
    policy.register(gate('hour', { expiryMs: HOUR }));
    const e = await env(policy);
    expect(await ask(e, { workflow_gate_id: 'hour' })).toBe(at(e, HOUR));
  });

  it('a shorter named gate wins over a finite host default', async () => {
    const policy = new PolicyRegistry({ defaultQuestionExpiryMs: 2 * DAY });
    policy.register(gate('hour', { expiryMs: HOUR }));
    const e = await env(policy);
    expect(await ask(e, { workflow_gate_id: 'hour' })).toBe(at(e, HOUR));
  });

  it('a named gate with no expiry cannot lengthen a finite host default', async () => {
    const policy = new PolicyRegistry({ defaultQuestionExpiryMs: 2 * DAY });
    policy.register(gate('never', { expiryMs: null }));
    policy.register(gate('unset'));
    const e = await env(policy);
    expect(await ask(e, { workflow_gate_id: 'never' })).toBe(at(e, 2 * DAY));
    expect(await ask(e, { workflow_gate_id: 'unset' })).toBe(at(e, 2 * DAY));
  });

  it('a named gate with no expiry of its own keeps a null host default', async () => {
    const policy = new PolicyRegistry({ defaultQuestionExpiryMs: null });
    policy.register(gate('never', { expiryMs: null }));
    policy.register(gate('unset'));
    const e = await env(policy);
    expect(await ask(e, { workflow_gate_id: 'never' })).toBeNull();
    expect(await ask(e, { workflow_gate_id: 'unset' })).toBeNull();
  });

  it("a named gate caps an agent's request under a null host default", async () => {
    const policy = new PolicyRegistry({ defaultQuestionExpiryMs: null });
    policy.register(gate('hour', { expiryMs: HOUR }));
    const e = await env(policy);
    expect(await ask(e, { workflow_gate_id: 'hour', expires_at: at(e, 3 * DAY) })).toBe(
      at(e, HOUR),
    );
  });
});

describe("an origin gate's expiry still governs its questions", () => {
  it('a finite origin gate expiry overrides a null host default', async () => {
    const policy = new PolicyRegistry({ defaultQuestionExpiryMs: null });
    policy.register(gate('hour', { expiryMs: HOUR }));
    const e = await env(policy);
    expect(await ask(e, {}, { workflow_gate_id: 'hour' })).toBe(at(e, HOUR));
  });

  it('an origin gate with no expiry overrides a finite host default', async () => {
    const policy = new PolicyRegistry({ defaultQuestionExpiryMs: 2 * DAY });
    policy.register(gate('never', { expiryMs: null }));
    const e = await env(policy);
    expect(await ask(e, {}, { workflow_gate_id: 'never' })).toBeNull();
  });

  it('an origin gate that sets no expiry takes the host default', async () => {
    const finite = new PolicyRegistry({ defaultQuestionExpiryMs: 2 * DAY });
    finite.register(gate('unset'));
    const a = await env(finite);
    expect(await ask(a, {}, { workflow_gate_id: 'unset' })).toBe(at(a, 2 * DAY));
    const never = new PolicyRegistry({ defaultQuestionExpiryMs: null });
    never.register(gate('unset'));
    const b = await env(never);
    expect(await ask(b, {}, { workflow_gate_id: 'unset' })).toBeNull();
  });
});

describe('the expiry rule', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const LATEST = new Date(8.64e15).toISOString();

  it('without a host default it is 7 days, and at most 30 when asked', () => {
    expect(resolveExpiry(undefined, undefined, now)).toBe(iso(DEFAULTS.questionExpiryMs));
    expect(resolveExpiry(LATEST, undefined, now)).toBe(iso(30 * DAY));
    expect(questionExpiryPolicy()).toEqual({
      defaultMs: DEFAULTS.questionExpiryMs,
      maxMs: 30 * DAY,
    });
  });

  it('follows the host default, with no limit when it is null', () => {
    expect(questionExpiryPolicy(2 * DAY)).toEqual({ defaultMs: 2 * DAY, maxMs: 30 * DAY });
    expect(questionExpiryPolicy(45 * DAY)).toEqual({ defaultMs: 45 * DAY, maxMs: 45 * DAY });
    expect(questionExpiryPolicy(null)).toEqual({ defaultMs: null, maxMs: null });
    expect(resolveExpiry(undefined, undefined, now, null)).toBeNull();
    expect(resolveExpiry(LATEST, undefined, now, null)).toBe(LATEST);
    expect(resolveExpiry(LATEST, undefined, now, 45 * DAY)).toBe(iso(45 * DAY));
  });

  it("a gate's own expiry governs, and a gate without one takes the host default uncapped", () => {
    expect(questionExpiryPolicy(null, gate('hour', { expiryMs: HOUR }))).toEqual({
      defaultMs: HOUR,
      maxMs: HOUR,
    });
    expect(questionExpiryPolicy(2 * DAY, gate('never', { expiryMs: null }))).toEqual({
      defaultMs: null,
      maxMs: null,
    });
    expect(questionExpiryPolicy(2 * DAY, gate('unset'))).toEqual({
      defaultMs: 2 * DAY,
      maxMs: null,
    });
    expect(questionExpiryPolicy(null, gate('unset'))).toEqual({ defaultMs: null, maxMs: null });
    expect(resolveExpiry(undefined, gate('unset'), now)).toBe(iso(DEFAULTS.questionExpiryMs));
  });

  it('still refuses a requested expiry less than a minute away', () => {
    expect(() => resolveExpiry(iso(60_000), undefined, now, null)).toThrow(/one minute/);
    expect(() => resolveExpiry('not a time', undefined, now, null)).toThrow(/one minute/);
  });
});

describe('the host default expiry setting', () => {
  it('accepts null or whole milliseconds from one minute to the relay limit', () => {
    for (const ms of [null, 60_000, 30 * DAY, QUESTION_EXPIRY_LIMIT_MS]) {
      expect(new PolicyRegistry({ defaultQuestionExpiryMs: ms }).defaultQuestionExpiryMs).toBe(ms);
      const p = new PolicyRegistry();
      p.defaultQuestionExpiryMs = ms;
      expect(p.defaultQuestionExpiryMs).toBe(ms);
    }
    expect(new PolicyRegistry().defaultQuestionExpiryMs).toBe(DEFAULTS.questionExpiryMs);
  });

  it('refuses anything else, and a refused change leaves the setting as it was', () => {
    const bad: unknown[] = [
      -1,
      0,
      59_999,
      1.5 * DAY + 0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      QUESTION_EXPIRY_LIMIT_MS + 1,
      '60000',
    ];
    for (const ms of bad) {
      expect(() => new PolicyRegistry({ defaultQuestionExpiryMs: ms as number })).toThrow(
        RangeError,
      );
      const p = new PolicyRegistry({ defaultQuestionExpiryMs: 2 * DAY });
      expect(() => {
        p.defaultQuestionExpiryMs = ms as number;
      }).toThrow(RangeError);
      expect(p.defaultQuestionExpiryMs).toBe(2 * DAY);
    }
  });
});
