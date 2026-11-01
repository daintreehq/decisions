/** Structural contract with the decision model (`packages/decision-model`): no import, so no cycle. */
export interface ProxyQuestionInput {
  questionId: string;
  question: string;
  context?: string;
  options: { id: string; label: string; description?: string }[];
  requirement: 'proxy-ok' | 'proxy-first';
  projectId: string;
  createdAt: string;
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
  suggest(input: ProxyQuestionInput, signal: AbortSignal): Promise<ProxyOutcome>;
}
