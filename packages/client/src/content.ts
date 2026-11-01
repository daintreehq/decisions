import { z } from 'zod';
import {
  DEFAULTS,
  LIMITS,
  Requirement,
  utf8ByteLength,
  type DecisionContentV1,
} from '@daintreehq/decisions-protocol';
import { gateAllowsText, type WorkflowGate } from './policy.js';

/** The `ask_human` input contract (spec 6.2), validated identically for MCP and direct callers. */
export const AskHumanInput = z.object({
  question: z.string().min(1).max(LIMITS.questionChars),
  context: z
    .string()
    .refine((v) => utf8ByteLength(v) <= LIMITS.contextBytes, 'context exceeds 32 KiB')
    .optional(),
  kind: z.enum(['choice', 'approval', 'text', 'mixed']).optional(),
  options: z
    .array(
      z.object({
        id: z.string().min(1).max(LIMITS.optionIdChars),
        label: z.string().min(1).max(LIMITS.optionLabelChars),
        description: z.string().max(LIMITS.optionDescriptionChars).optional(),
      }),
    )
    .max(LIMITS.maxOptions)
    .optional(),
  attachments: z
    .array(
      z.object({
        local_resource_id: z.string().min(1).max(200),
        role: z.enum(['before', 'after', 'reference', 'other']).optional(),
        alt: z.string().max(500).optional(),
      }),
    )
    .max(LIMITS.attachmentsPerQuestion)
    .optional(),
  requested_requirement: Requirement.optional(),
  workflow_gate_id: z.string().min(1).max(200).optional(),
  expires_at: z.iso.datetime({ offset: true }).optional(),
  correlation_id: z.string().min(1).max(64).optional(),
});
export type AskHumanInput = z.infer<typeof AskHumanInput>;

export class BridgeError extends Error {
  constructor(
    readonly code:
      | 'validation_error'
      | 'too_many_open_questions'
      | 'not_found'
      | 'forbidden'
      | 'attachment_error'
      | 'proxy_forbidden'
      | 'not_configured',
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** Option ids must be unique and, for protected gates, drawn from the gate's allowed set. */
export function validateOptions(input: AskHumanInput, gate: WorkflowGate | undefined): void {
  const ids = new Set<string>();
  for (const o of input.options ?? []) {
    if (ids.has(o.id)) throw new BridgeError('validation_error', `duplicate option id "${o.id}"`);
    ids.add(o.id);
  }
  if (gate?.allowedOptionIds) {
    const allowed = new Set(gate.allowedOptionIds);
    for (const id of ids) {
      if (!allowed.has(id))
        throw new BridgeError(
          'validation_error',
          `option "${id}" is not permitted by this workflow gate`,
        );
    }
  }
}

/** The options and answer rules a question is published with, once its trusted gates are applied. */
export interface GatedShape {
  options: NonNullable<AskHumanInput['options']>;
  kind: DecisionContentV1['kind'];
  allowText: boolean;
  bindArtifacts: boolean;
}

/**
 * Applies trusted workflow gates (the origin's gate first, then any other registered gate the agent named)
 * to the agent's input. Gates can only make a question stricter: a gate's `choices` replace the agent's
 * options (which, if sent, must be exactly those choices with the same labels), free text is accepted only if
 * every gate allows it, and any gate that binds artifacts requires attachments and makes the question an
 * approval the phone can only send once every image has loaded.
 */
export function shapeForGates(
  input: AskHumanInput,
  gates: (WorkflowGate | undefined)[],
  attachmentCount: number,
): GatedShape {
  const active = gates.filter((g): g is WorkflowGate => !!g);
  let options = input.options ?? [];
  let fromGate: WorkflowGate | undefined;
  for (const g of active) {
    if (!g.choices) continue;
    const want = new Map(g.choices.map((c) => [c.id, c]));
    const sent = fromGate ? (fromGate.choices ?? []) : options;
    for (const o of sent) {
      const c = want.get(o.id);
      if (!c)
        throw new BridgeError(
          'validation_error',
          `option "${o.id}" is not permitted by this workflow gate`,
        );
      if (c.label !== o.label)
        throw new BridgeError(
          'validation_error',
          `option "${o.id}" must use the workflow gate's label "${c.label}"`,
        );
    }
    if (sent.length > 0 && sent.length !== want.size) {
      throw new BridgeError(
        'validation_error',
        `options must be exactly the workflow gate's choices (${[...want.keys()].join(', ')})`,
      );
    }
    if (!fromGate) {
      fromGate = g;
      options = g.choices.map((c) => ({ ...c }));
    }
  }
  const allowText = active.every((g) => gateAllowsText(g));
  const bindArtifacts = active.some((g) => g.bindArtifacts === true);
  if (!allowText && options.length === 0) {
    throw new BridgeError(
      'validation_error',
      'this workflow gate accepts only a choice: offer options for the human to pick from',
    );
  }
  if (bindArtifacts && attachmentCount === 0) {
    throw new BridgeError(
      'validation_error',
      'this workflow gate binds the answer to attachments: attach the images to be reviewed',
    );
  }
  let kind = defaultKind({ ...input, options });
  if (bindArtifacts) kind = 'approval';
  else if (fromGate && kind === 'text') kind = allowText ? 'mixed' : 'choice';
  else if (!allowText && (kind === 'mixed' || kind === 'text')) kind = 'choice';
  return { options, kind, allowText, bindArtifacts };
}

/**
 * Effective expiry. The agent may shorten but not extend beyond what the trusted gate allows:
 * with a gate the cap is its `expiryMs` (null = no expiry allowed); without one it is 30 days.
 */
export function resolveExpiry(
  requested: string | undefined,
  gate: WorkflowGate | undefined,
  now: number,
): string | null {
  const defaultMs = gate?.expiryMs === undefined ? DEFAULTS.questionExpiryMs : gate.expiryMs;
  const capMs = gate ? gate.expiryMs : 30 * 24 * 60 * 60 * 1000;
  const base = defaultMs === null ? null : now + defaultMs;
  if (!requested) return base === null ? null : new Date(base).toISOString();
  const asked = Date.parse(requested);
  if (!Number.isFinite(asked) || asked <= now + 60_000) {
    throw new BridgeError(
      'validation_error',
      'expires_at must be at least one minute in the future',
    );
  }
  const cap = capMs === null || capMs === undefined ? null : now + capMs;
  const eff = cap === null ? asked : Math.min(asked, cap);
  return new Date(eff).toISOString();
}

export function defaultKind(input: AskHumanInput): DecisionContentV1['kind'] {
  if (input.kind) return input.kind;
  const n = input.options?.length ?? 0;
  if (n === 0) return 'text';
  return 'mixed';
}
