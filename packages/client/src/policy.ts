import {
  DEFAULTS,
  enforceRequirement,
  LIMITS,
  type Requirement,
} from '@daintreehq/decisions-protocol';

/** One answer a gate offers. The phone shows exactly these; answers are accepted only for these ids. */
export interface GateChoice {
  id: string;
  label: string;
  description?: string;
}

export interface WorkflowGate {
  gateId: string;
  /** Minimum strictness; callers can only make it stricter. */
  minRequirement: Requirement;
  policyVersion: number;
  /**
   * The exact choices a question under this gate offers. When set they replace whatever options the agent
   * sends (an agent may repeat them, but only with the same ids and labels), and an answer must pick at most
   * one of them.
   */
  choices?: GateChoice[];
  /**
   * Whether a free-text answer or note is accepted. Defaults to true, except for a gate with `choices`,
   * where it defaults to false: an answer is then exactly one of the choices.
   */
  allowText?: boolean;
  /**
   * Answers bind to the question's attachments: a question under this gate must carry at least one, the
   * phone must load every image before an approval can be sent, and `get_decision` reports whether the
   * digests the phone reviewed equal the attached ones.
   */
  bindArtifacts?: boolean;
  /** Optional protected option ids; when set, only these answers are accepted for the gate. */
  allowedOptionIds?: string[];
  /**
   * Expiry for this gate, in ms: both the default and the latest an agent may ask for; null = never expires.
   * Unset, the gate's questions take the host's default expiry, and an agent may ask for any expiry.
   */
  expiryMs?: number | null;
}

/** The latest an agent may ask a question with no gate to expire, unless the host's default is later. */
const GATELESS_EXPIRY_CAP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The furthest ahead, in ms, a question's finite expiry may be: the relay refuses one more than
 * `LIMITS.maxQuestionExpiryMs` past its own clock, and the margin absorbs the clock skew it tolerates.
 */
export const QUESTION_EXPIRY_LIMIT_MS = LIMITS.maxQuestionExpiryMs - LIMITS.requestSkewMs;

/** The shortest default expiry a host may set, in ms. */
const MIN_DEFAULT_EXPIRY_MS = 60_000;

/** The expiry rule for a question under `gate` (or none), given the host's default expiry. */
export interface ExpiryPolicy {
  /** How long the question waits when its agent asks for no expiry, in ms; null = it never expires. */
  defaultMs: number | null;
  /**
   * The latest expiry its agent may ask for, in ms after asking; null = no policy limit (a finite expiry is
   * still at most `QUESTION_EXPIRY_LIMIT_MS` away).
   */
  maxMs: number | null;
}

/**
 * The expiry rule for a question. A gate's own `expiryMs` governs its questions. A gate without one takes the
 * host's default and lets the agent ask for any expiry. With no gate the host's default applies, and an agent
 * may ask for up to 30 days, or up to the default when it is longer; a host default of null lifts the limit.
 */
export function questionExpiryPolicy(
  hostDefaultMs: number | null = DEFAULTS.questionExpiryMs,
  gate?: WorkflowGate,
): ExpiryPolicy {
  if (gate?.expiryMs !== undefined) return { defaultMs: gate.expiryMs, maxMs: gate.expiryMs };
  if (gate) return { defaultMs: hostDefaultMs, maxMs: null };
  return {
    defaultMs: hostDefaultMs,
    maxMs: hostDefaultMs === null ? null : Math.max(GATELESS_EXPIRY_CAP_MS, hostDefaultMs),
  };
}

function checkDefaultExpiry(ms: unknown): number | null {
  if (ms === null) return null;
  if (
    typeof ms !== 'number' ||
    !Number.isSafeInteger(ms) ||
    ms < MIN_DEFAULT_EXPIRY_MS ||
    ms > QUESTION_EXPIRY_LIMIT_MS
  ) {
    throw new RangeError(
      `defaultQuestionExpiryMs must be null or whole milliseconds from ${MIN_DEFAULT_EXPIRY_MS} to ${QUESTION_EXPIRY_LIMIT_MS}`,
    );
  }
  return ms;
}

/** Whether free text is accepted under `gate` (no gate: always). */
export function gateAllowsText(gate: WorkflowGate | undefined): boolean {
  if (!gate) return true;
  return gate.allowText ?? !gate.choices;
}

function validateGate(gate: WorkflowGate): void {
  const bad = (why: string) => new Error(`workflow gate "${gate.gateId}": ${why}`);
  if (!gate.gateId) throw new Error('workflow gate: gateId is required');
  if (gate.choices === undefined) return;
  if (gate.choices.length === 0) throw bad('declare at least one choice, or omit choices');
  if (gate.choices.length > LIMITS.maxOptions)
    throw bad(`at most ${LIMITS.maxOptions} choices are allowed`);
  const ids = new Set<string>();
  for (const c of gate.choices) {
    if (!c.id || c.id.length > LIMITS.optionIdChars) throw bad(`invalid choice id "${c.id}"`);
    if (!c.label || c.label.length > LIMITS.optionLabelChars)
      throw bad(`invalid label for choice "${c.id}"`);
    if (c.description !== undefined && c.description.length > LIMITS.optionDescriptionChars)
      throw bad(`description for choice "${c.id}" is too long`);
    if (ids.has(c.id)) throw bad(`duplicate choice id "${c.id}"`);
    ids.add(c.id);
  }
}

export interface PolicyRegistryOptions {
  /** Whether a question with no gate may take a proxy answer when its agent allows one. Default false. */
  proxyAllowlisted?: boolean;
  /**
   * How long a question with no origin gate waits when its agent asks for no expiry, in ms; null = it never
   * expires. Default 7 days (`DEFAULTS.questionExpiryMs`).
   */
  defaultQuestionExpiryMs?: number | null;
}

/**
 * Trusted workflow policy, registered by the host application (never by an agent). The enforced level
 * is the stricter of the gate level and the caller's request; with no gate the default is human-required
 * unless the user explicitly allowlisted proxy levels in desktop settings.
 */
export class PolicyRegistry {
  private gates = new Map<string, WorkflowGate>();
  private proxy: boolean;
  private expiryMs: number | null;
  constructor(opts: PolicyRegistryOptions = {}) {
    this.proxy = opts.proxyAllowlisted === true;
    this.expiryMs =
      opts.defaultQuestionExpiryMs === undefined
        ? DEFAULTS.questionExpiryMs
        : checkDefaultExpiry(opts.defaultQuestionExpiryMs);
  }

  register(gate: WorkflowGate): void {
    validateGate(gate);
    this.gates.set(gate.gateId, {
      ...gate,
      ...(gate.choices ? { choices: gate.choices.map((c) => ({ ...c })) } : {}),
    });
  }
  get(gateId: string | null | undefined): WorkflowGate | undefined {
    return gateId ? this.gates.get(gateId) : undefined;
  }
  set proxyAllowlisted(v: boolean) {
    this.proxy = v;
  }
  /**
   * How long a question with no origin gate waits when its agent asks for no expiry, in ms; null = it never
   * expires. Setting it applies to questions asked from then on; a value out of range throws a RangeError
   * and leaves the setting as it was.
   */
  get defaultQuestionExpiryMs(): number | null {
    return this.expiryMs;
  }
  set defaultQuestionExpiryMs(ms: number | null) {
    this.expiryMs = checkDefaultExpiry(ms);
  }
  resolve(input: { gateId?: string | null; requested?: Requirement | undefined }): {
    requirement: Requirement;
    gate: WorkflowGate | undefined;
  } {
    const gate = this.get(input.gateId);
    // An unknown gate id is treated as no policy at all (safest default), never as permission.
    const requirement = enforceRequirement({
      workflowMin: gate?.minRequirement,
      requested: input.requested,
      proxyAllowlisted: this.proxy === true,
    });
    return { requirement, gate };
  }
}
