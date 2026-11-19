import { afterEach, describe, expect, it } from 'vitest';
import { PolicyRegistry } from '../src/index.js';
import { origin, setupBridge } from './helpers.js';

/*
 * An advisory question's deadline passing unanswered (issue #155): the asking agent is told once, in its own notice,
 * that the plan it stated is now its own to carry out, and get_decision says the same after a restart.
 */

const T0 = Date.parse('2026-11-19T10:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const ADVISORY = 'advisory-deadlines-v1';
const PLAN = 'I will use the in-memory fixture.';

let stopAll: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stopAll) await s();
  stopAll = [];
});

async function advisoryEnv() {
  let now = T0;
  const policy = new PolicyRegistry({ advisoryQuestions: true });
  const e = await setupBridge({ policy, now: () => now, advisoryDeadlines: true });
  e.relay.features = ['thread-messages-v1', ADVISORY];
  e.relay.deviceFeatures.set(e.phone.deviceId, [ADVISORY]);
  await e.bridge.pump();
  stopAll.push(() => e.bridge.stop());
  return {
    ...e,
    policy,
    setNow: (t: number) => void (now = t),
    ask: (input: Record<string, unknown> = {}) =>
      e.bridge.registerQuestion({
        origin: origin(),
        input: { question: 'Which fixture?', expires_in: '15m', planned_fallback: PLAN, ...input },
      }),
  };
}

describe('an advisory deadline that passes unanswered', () => {
  it('types its own notice, with the deadline and the plan due, never the blocking expiry', async () => {
    const e = await advisoryEnv();
    const r = await e.ask();
    expect(r.replyMode).toBe('advisory');
    await e.bridge.pump();
    e.relay.expiryEvent({ questionId: r.questionId });
    e.setNow(T0 + 16 * MIN);
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    const typed = e.sink.typed[0]!.text;
    expect(typed).toContain(`question_id: ${r.questionId} (q-1)`);
    expect(typed).toContain(`deadline: ${at(15 * MIN)}`);
    expect(typed).toContain('status: advisory-unanswered');
    expect(typed).toContain('disposition: fallback-due');
    expect(typed).not.toContain('You are NOT authorised to continue the gated step');
    const v = await e.bridge.getDecision(r.questionId);
    expect(v).toMatchObject({ status: 'expired', closedReason: 'expired', fallbackDue: true });
  });
});
