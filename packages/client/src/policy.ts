import { enforceRequirement, LIMITS, type Requirement } from '@daintreehq/decisions-protocol';

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
  /** Default expiry for this gate, in ms; null = never expires. */
  expiryMs?: number | null;
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

/**
 * Trusted workflow policy, registered by the host application (never by an agent). The enforced level
 * is the stricter of the gate level and the caller's request; with no gate the default is human-required
 * unless the user explicitly allowlisted proxy levels in desktop settings.
 */
export class PolicyRegistry {
  private gates = new Map<string, WorkflowGate>();
  constructor(private readonly opts: { proxyAllowlisted?: boolean } = {}) {}

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
    (this.opts as { proxyAllowlisted?: boolean }).proxyAllowlisted = v;
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
      proxyAllowlisted: this.opts.proxyAllowlisted === true,
    });
    return { requirement, gate };
  }
}
