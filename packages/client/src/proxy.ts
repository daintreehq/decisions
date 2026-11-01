/** Structural contract with the decision model (`packages/decision-model`): no import, so no cycle. */
export interface ProxyQuestionInput {
  questionId: string;
  question: string;
  context?: string;
  options: { id: string; label: string; description?: string }[];
  /** The ENFORCED level (never the agent's request). */
  requirement: 'proxy-ok' | 'proxy-first';
  /** The project tag; the model's guards use it for project-scoped retrieval. */
  projectId: string;
  createdAt: string;
  kind: 'choice' | 'approval' | 'text' | 'mixed';
  /** The TRUSTED workflow gate bound to the origin (registered by the host), never an agent-supplied value. */
  workflowGateId?: string;
  /** Role + plaintext SHA-256 of every attachment the human will see (approvals bind to these). */
  attachments: { role: string; sha256: string }[];
}

export type ProxyOutcome =
  | {
      action: 'answer';
      selected_option_ids: string[];
      answer_text?: string;
      confidence: number;
      model_id: string;
      prompt_template_version: string;
      retrieval_reference_ids: string[];
      rationale?: string;
      risk_flags: string[];
    }
  | { action: 'abstain'; reason: string };

export interface ProxyEngine {
  /**
   * The engine understands `workflowGateId` and applies gate-based hard blocks. A question that carries a
   * trusted gate is NEVER offered to an engine that does not declare this: the bridge abstains instead
   * (fail closed), so the human decides.
   */
  readonly gateAware?: boolean;
  suggest(input: ProxyQuestionInput, signal: AbortSignal): Promise<ProxyOutcome>;
}
