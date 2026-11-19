import { z } from 'zod';
import { PlannedFallback, type QuestionKind, type Requirement } from './schema.js';

const STRICTNESS: Record<Requirement, number> = {
  'human-required': 3,
  'proxy-first': 2,
  'proxy-ok': 1,
};

export function stricter(a: Requirement, b: Requirement): Requirement {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/**
 * Resolve the enforced requirement level. The agent's `requested` value can only make a
 * question *stricter*; it can never downgrade a trusted workflow's level (invariant I4).
 *
 * - No trusted policy and no allowlist: `human-required` (safe default).
 * - Trusted policy `workflowMin` present: result is at least that strict.
 * - Proxy-capable levels without a policy need the user's explicit desktop allowlist.
 */
export function enforceRequirement(input: {
  workflowMin?: Requirement | undefined;
  requested?: Requirement | undefined;
  proxyAllowlisted?: boolean | undefined;
}): Requirement {
  const { workflowMin, requested, proxyAllowlisted } = input;
  if (!workflowMin) {
    if (!proxyAllowlisted) return 'human-required';
    return requested ?? 'human-required';
  }
  return requested ? stricter(workflowMin, requested) : workflowMin;
}

/** A proxy may never answer or auto-satisfy `human-required`. */
export function proxyMayAnswer(level: Requirement): boolean {
  return level !== 'human-required';
}

/* ---------- advisory questions (docs/protocol.md section 21) ---------- */

/**
 * Why a host must not sign an advisory question, in the order `advisoryRefusal` checks:
 * - `relay-unsupported`: the relay does not advertise `advisory-deadlines-v1` in `GET /info`, so it would refuse
 *   the create (an older relay's strict `EnvelopeAad` rejects `reply_mode`);
 * - `host-unsupported`: the host application has not said it delivers an advisory outcome to its agents;
 * - `policy-disallowed`: the host's trusted policy does not allow advisory questions (off by default);
 * - `no-capable-reader`: no active phone or tablet declared `advisory-deadlines-v1`, so no device the person holds
 *   can show the deadline and the plan (an older one cannot read the question at all);
 * - `gated`: the question names a workflow gate, from its origin or from the agent, registered or not: a gated
 *   question always waits for a decision;
 * - `approval`: an approval always waits for a decision;
 * - `no-deadline`: the deadline is not finite;
 * - `invalid-plan`: the plan is missing, blank or longer than `LIMITS.plannedFallbackChars`.
 */
export const AdvisoryRefusal = z.enum([
  'relay-unsupported',
  'host-unsupported',
  'policy-disallowed',
  'no-capable-reader',
  'gated',
  'approval',
  'no-deadline',
  'invalid-plan',
]);
export type AdvisoryRefusal = z.infer<typeof AdvisoryRefusal>;

/**
 * Whether a host may sign an advisory question, checked before it signs anything; null means it may. Every permission
 * is explicit and none defaults to true, so the default stays the blocking ask. A refusal never turns the question
 * into a blocking one: the caller asks again without `advisory` if it wants the person to decide.
 */
export function advisoryRefusal(i: {
  /** `GET /info` lists `advisory-deadlines-v1`. */
  relaySupport: boolean;
  /** The host application delivers advisory outcomes (it opted in). */
  hostSupport: boolean;
  /** The host's trusted policy allows advisory questions. Never set by an agent. */
  policyAllows: boolean;
  /** At least one active phone or tablet declared `advisory-deadlines-v1` on its latest socket ticket. */
  readerSupport: boolean;
  /** The authenticated origin's workflow gate id, if the host bound one. */
  originGateId?: string | null | undefined;
  /** A workflow gate id the agent named, if any. */
  namedGateId?: string | null | undefined;
  /** The question's kind after every gate shaped it. */
  kind: QuestionKind;
  /** The finite deadline the host will sign, or null. */
  expiresAt: string | null;
  plannedFallback: string | null | undefined;
}): AdvisoryRefusal | null {
  if (i.relaySupport !== true) return 'relay-unsupported';
  if (i.hostSupport !== true) return 'host-unsupported';
  if (i.policyAllows !== true) return 'policy-disallowed';
  if (i.readerSupport !== true) return 'no-capable-reader';
  // Any id at all, even one no gate is registered under: the resolver reads an unknown id as no policy, and an
  // advisory question must never be how a gate's question stops waiting.
  if ((i.originGateId ?? '') !== '' || (i.namedGateId ?? '') !== '') return 'gated';
  if (i.kind === 'approval') return 'approval';
  if (i.expiresAt === null) return 'no-deadline';
  if (!PlannedFallback.safeParse(i.plannedFallback).success) return 'invalid-plan';
  return null;
}
