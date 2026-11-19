import { describe, expect, it } from 'vitest';
import { advisoryRefusal } from '@daintreehq/decisions-protocol';
import { ADVISORY_QUESTION_FIXTURE } from '@daintreehq/decisions-protocol/fixtures';
import { BRIDGE_FEATURES, PolicyRegistry, bridgeFeatures } from '../src/index.js';

/* Host support and policy for advisory questions (protocol section 21): both explicit, both off by default. */

describe('advisory questions in the desktop library', () => {
  it('declares advisory-deadlines-v1 only for a host that opted in', () => {
    expect(BRIDGE_FEATURES).not.toContain('advisory-deadlines-v1');
    expect(bridgeFeatures()).not.toContain('advisory-deadlines-v1');
    expect(bridgeFeatures({ followUps: true, snapshots: {} })).not.toContain(
      'advisory-deadlines-v1',
    );
    expect(bridgeFeatures({ advisoryDeadlines: true })).toContain('advisory-deadlines-v1');
    expect(bridgeFeatures({ advisoryDeadlines: true, followUps: true })).toEqual(
      expect.arrayContaining([...BRIDGE_FEATURES, 'thread-messages-v1', 'advisory-deadlines-v1']),
    );
  });

  it("the host's policy allows advisory questions only when it says so", () => {
    expect(new PolicyRegistry().advisoryQuestions).toBe(false);
    expect(new PolicyRegistry({ proxyAllowlisted: true }).advisoryQuestions).toBe(false);
    const p = new PolicyRegistry({ advisoryQuestions: true });
    expect(p.advisoryQuestions).toBe(true);
    p.advisoryQuestions = false;
    expect(p.advisoryQuestions).toBe(false);
  });

  it('a gate the registry does not know still keeps a question blocking', () => {
    const policy = new PolicyRegistry({ advisoryQuestions: true });
    // The resolver reads an unknown gate id as no policy at all...
    expect(policy.resolve({ gateId: 'no-such-gate' }).gate).toBeUndefined();
    // ...but the advisory rule reads the raw id, so naming any gate keeps the question waiting.
    const ask = {
      relaySupport: true,
      hostSupport: true,
      policyAllows: policy.advisoryQuestions,
      readerSupport: true,
      kind: 'choice' as const,
      expiresAt: ADVISORY_QUESTION_FIXTURE.record.expires_at,
      plannedFallback: ADVISORY_QUESTION_FIXTURE.content.planned_fallback,
    };
    expect(advisoryRefusal(ask)).toBeNull();
    expect(advisoryRefusal({ ...ask, namedGateId: 'no-such-gate' })).toBe('gated');
    expect(advisoryRefusal({ ...ask, originGateId: 'no-such-gate' })).toBe('gated');
    expect(advisoryRefusal({ ...ask, policyAllows: new PolicyRegistry().advisoryQuestions })).toBe(
      'policy-disallowed',
    );
  });
});
