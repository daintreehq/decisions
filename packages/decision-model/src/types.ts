/**
 * Structural interface between the decision model and `DecisionsBridge` (packages/client).
 * It is intentionally re-declared here rather than imported so the two packages never depend on each other.
 */
export interface ProxyQuestionInput {
  question_id: string;
  question: string;
  context?: string;
  options: { id: string; label: string; description?: string }[];
  kind: 'choice' | 'approval' | 'text' | 'mixed';
  requirement: 'proxy-ok' | 'proxy-first' | 'human-required';
  project_tags?: string[];
  attachments?: { role: string; sha256: string }[];
  workflow_gate_id?: string;
  created_at: string;
}

/** A model-drafted answer shown to the human (or, if authorised, used as a labelled proxy answer). */
export interface ProxySuggestion {
  selected_option_ids: string[];
  answer_text?: string;
  /** The model's self-reported estimate. It is NOT a calibrated probability. */
  confidence: number;
  model_id: string;
  prompt_template_version: string;
  retrieval_reference_ids: string[];
  rationale?: string;
  risk_flags: string[];
  /** Why this suggestion may not be used as an automatic proxy answer (empty when authorised). */
  auto_answer_blocked_reasons: string[];
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
  | {
      action: 'abstain';
      reason: string;
      /** Present when the model drafted something that policy does not allow to be sent automatically. */
      suggestion?: ProxySuggestion;
    };

export interface ProxyEngine {
  suggest(input: ProxyQuestionInput, signal?: AbortSignal): Promise<ProxyOutcome>;
}

export type SuggestOutcome =
  { action: 'suggest'; suggestion: ProxySuggestion } | { action: 'abstain'; reason: string };

export type PolicyLevel = 'human-required' | 'proxy-ok' | 'proxy-first';

/** One recorded human decision: the only ground truth the model ever learns from. */
export interface DecisionExample {
  question_id: string;
  question: string;
  context_summary?: string;
  options?: { id: string; label: string }[];
  selected_option_ids?: string[];
  human_reasoning?: string;
  project_tags?: string[];
  kind?: 'choice' | 'approval' | 'text' | 'mixed';
  created_at: string;
  chosen_at: string;
  outcome?: 'accepted' | 'reversed' | 'unknown';
  policy_level: PolicyLevel;
  /** Proxy output is never ground truth; anything other than 'human' is rejected on insert. */
  source: 'human';
  /** Incremented every time a later human correction replaces the label. */
  revision?: number;
  /** Earlier labels that a later human correction superseded, kept for provenance. */
  label_history?: {
    selected_option_ids?: string[];
    human_reasoning?: string;
    chosen_at: string;
    superseded_by_revision: number;
  }[];
  superseded_by_revision?: number;
}
