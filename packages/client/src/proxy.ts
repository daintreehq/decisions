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

/**
 * One human decision, offered to the decision model's history (`asBridgeLearner` in packages/decision-model).
 * This is the ONLY path by which question or answer plaintext leaves the bridge for storage: the local store
 * keeps it sealed. The learner applies its own consent (learning is off until the user opts in) and its
 * secrets filter before anything is written.
 */
export interface LearnedDecision {
  questionId: string;
  question: string;
  context?: string;
  options: { id: string; label: string }[];
  kind: 'choice' | 'approval' | 'text' | 'mixed';
  /** The ENFORCED level the question was asked with. */
  requirement: 'human-required' | 'proxy-ok' | 'proxy-first';
  projectId: string;
  /** When the question was asked. */
  createdAt: string;
  /** When the human answered (the signed action's timestamp). */
  chosenAt: string;
  selectedOptionIds: string[];
  /** The human's free text ('' when none). */
  text: string;
  /** The question's ledger revision after this answer: later corrections win. */
  revision: number;
  /** True for an override that replaces an earlier answer. */
  correction: boolean;
}

/** Receives human answers and overrides (never proxy answers or confirmations of them). */
export interface DecisionLearner {
  /** May return a value or a promise (for example the history store's record result); it is awaited and ignored. */
  learn(decision: LearnedDecision): unknown;
}
