import { enforceRequirement, type Requirement } from '@daintree/decisions-protocol';

export interface WorkflowGate {
  gateId: string;
  /** Minimum strictness; callers can only make it stricter. */
  minRequirement: Requirement;
  policyVersion: number;
  /** Optional protected option ids; when set, only these answers are accepted for the gate. */
  allowedOptionIds?: string[];
  /** Default expiry for this gate, in ms; null = never expires. */
  expiryMs?: number | null;
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
    this.gates.set(gate.gateId, gate);
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
