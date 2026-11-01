import type { Requirement } from './schema.js';

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
