import { z } from 'zod';
import {
  DEFAULTS,
  LIMITS,
  Requirement,
  utf8ByteLength,
  type DecisionContentV1,
} from '@daintreehq/decisions-protocol';
import { gateAllowsText, questionExpiryPolicy, type WorkflowGate } from './policy.js';

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

/**
 * The `send_followup` input contract: an agent message in the thread of a question this pane asked
 * (docs/protocol.md section 16). `expects_reply` is required, so an agent always says whether it waits on the
 * person.
 */
export const PostMessageInput = z.object({
  question_id: z.string().min(1).max(128),
  text: z
    .string()
    .refine((v) => v.trim() !== '', 'text is empty')
    .refine(
      (v) => utf8ByteLength(v) <= LIMITS.messageTextBytes,
      `text exceeds ${LIMITS.messageTextBytes / 1024} KiB (UTF-8)`,
    ),
  expects_reply: z.boolean(),
});
export type PostMessageInput = z.infer<typeof PostMessageInput>;

export class BridgeError extends Error {
  constructor(
    readonly code:
      | 'validation_error'
      | 'too_many_open_questions'
      | 'not_found'
      | 'forbidden'
      | 'attachment_error'
      | 'proxy_forbidden'
      | 'not_configured'
      | 'invalid_state'
      | 'expired'
      | 'not_supported',
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

/** What an approval offers when the agent names no options of its own. */
export const APPROVAL_OPTIONS = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
] as const;

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
  const bindArtifacts = active.some((g) => g.bindArtifacts === true);
  // A yes/no the agent didn't spell out: without options the phone could only offer a text box. Filled in
  // before the gate checks, so the defaults are held to them like any other options.
  if (options.length === 0 && (input.kind === 'approval' || bindArtifacts))
    options = APPROVAL_OPTIONS.map((o) => ({ ...o }));
  // Choices one gate supplies must still be permitted by every other gate's protected option ids.
  for (const g of active) {
    if (!g.allowedOptionIds) continue;
    const bad = options.find((o) => !g.allowedOptionIds!.includes(o.id));
    if (bad)
      throw new BridgeError(
        'validation_error',
        `option "${bad.id}" is not permitted by this workflow gate`,
      );
  }
  const allowText = active.every((g) => gateAllowsText(g));
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
 * Effective expiry, by `questionExpiryPolicy`: the agent may shorten but not extend beyond what the trusted gate
 * allows. With a gate the cap is its `expiryMs` (null or unset = no cap); without one it is 30 days, or the
 * host's default when that is longer, and none when the host's default is null. `hostDefaultMs` is the host's
 * default expiry (`PolicyRegistry.defaultQuestionExpiryMs`), 7 days when omitted.
 */
export function resolveExpiry(
  requested: string | undefined,
  gate: WorkflowGate | undefined,
  now: number,
  hostDefaultMs: number | null = DEFAULTS.questionExpiryMs,
): string | null {
  const { defaultMs, maxMs } = questionExpiryPolicy(hostDefaultMs, gate);
  if (!requested) return defaultMs === null ? null : new Date(now + defaultMs).toISOString();
  const asked = Date.parse(requested);
  if (!Number.isFinite(asked) || asked <= now + 60_000) {
    throw new BridgeError(
      'validation_error',
      'expires_at must be at least one minute in the future',
    );
  }
  const eff = maxMs === null ? asked : Math.min(asked, now + maxMs);
  return new Date(eff).toISOString();
}

export function defaultKind(input: AskHumanInput): DecisionContentV1['kind'] {
  if (input.kind) return input.kind;
  const n = input.options?.length ?? 0;
  if (n === 0) return 'text';
  return 'mixed';
}
