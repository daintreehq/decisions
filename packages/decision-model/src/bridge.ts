import type { ProxyEngine, ProxyOutcome, ProxyQuestionInput } from './types.js';

/**
 * The request shape `DecisionsBridge` (packages/client) hands to its `proxy` hook. Field names are the bridge's
 * camelCase ones. `workflowGateId`, `kind` and `attachments` are optional additions: the bridge does not send them
 * today, so integrators should either extend the call or supply `resolveGateId` below. Without a gate id the
 * workflow-gate hard block cannot run, which is why `requireGateId` exists.
 */
export interface BridgeProxyQuestionInput {
  questionId: string;
  question: string;
  context?: string;
  options: { id: string; label: string; description?: string }[];
  requirement: 'proxy-ok' | 'proxy-first';
  projectId: string;
  createdAt: string;
  workflowGateId?: string;
  kind?: ProxyQuestionInput['kind'];
  attachments?: { role: string; sha256: string }[];
}

/** The bridge's `ProxyEngine` hook: identical to the client's declaration, with a required `AbortSignal`. */
export interface BridgeProxyEngine {
  suggest(input: BridgeProxyQuestionInput, signal: AbortSignal): Promise<ProxyOutcome>;
}

export interface BridgeAdapterOptions {
  /** Looks up the workflow gate id when the bridge does not pass `workflowGateId` (for example by question id). */
  resolveGateId?: (input: BridgeProxyQuestionInput) => string | undefined;
  /**
   * Fail closed: abstain with `missing-workflow-gate` when no gate id is available. Recommended whenever the
   * deployment relies on gate-based blocks (design review and similar), because a missing id skips them silently.
   */
  requireGateId?: boolean;
}

/** Choice questions are treated as `choice` (exactly one option), free-text ones as `text`. */
function inferKind(options: BridgeProxyQuestionInput['options']): ProxyQuestionInput['kind'] {
  return options.length === 0 ? 'text' : 'choice';
}

/** Maps the bridge's field names to the model's input and carries every field the guards read. */
export function toModelInput(
  b: BridgeProxyQuestionInput,
  o: BridgeAdapterOptions = {},
): ProxyQuestionInput {
  const gate = b.workflowGateId ?? o.resolveGateId?.(b);
  const out: ProxyQuestionInput = {
    question_id: b.questionId,
    question: b.question,
    options: b.options.map((x) => ({
      id: x.id,
      label: x.label,
      ...(x.description ? { description: x.description } : {}),
    })),
    kind: b.kind ?? inferKind(b.options),
    requirement: b.requirement,
    created_at: b.createdAt,
  };
  if (b.context) out.context = b.context;
  if (b.projectId) out.project_tags = [b.projectId];
  if (gate) out.workflow_gate_id = gate;
  if (b.attachments) out.attachments = b.attachments;
  return out;
}

function wellFormed(b: unknown): b is BridgeProxyQuestionInput {
  const x = b as Partial<BridgeProxyQuestionInput> | null;
  return (
    !!x &&
    typeof x.questionId === 'string' &&
    x.questionId.length > 0 &&
    typeof x.question === 'string' &&
    x.question.length > 0 &&
    Array.isArray(x.options) &&
    typeof x.requirement === 'string' &&
    typeof x.createdAt === 'string'
  );
}

/** Wrap a decision model (or any `ProxyEngine`) so it can be passed straight to `DecisionsBridge`'s `proxy` option. */
export function asBridgeEngine(
  model: ProxyEngine,
  o: BridgeAdapterOptions = {},
): BridgeProxyEngine {
  return {
    async suggest(input, signal) {
      if (!wellFormed(input)) return { action: 'abstain', reason: 'invalid-input' };
      const mapped = toModelInput(input, o);
      if (o.requireGateId && !mapped.workflow_gate_id)
        return { action: 'abstain', reason: 'missing-workflow-gate' };
      return model.suggest(mapped, signal);
    },
  };
}
