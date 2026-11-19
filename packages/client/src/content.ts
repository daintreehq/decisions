import { z } from 'zod';
import {
  DEFAULTS,
  LIMITS,
  PlannedFallback,
  PreparationReport,
  Requirement,
  utf8ByteLength,
  type DecisionContentV1,
} from '@daintreehq/decisions-protocol';
import {
  QUESTION_EXPIRY_LIMIT_MS,
  gateAllowsText,
  questionExpiryPolicy,
  type WorkflowGate,
} from './policy.js';

/** Milliseconds in one unit of an `expires_in` duration. */
const DURATION_UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const DURATION = /^([1-9][0-9]{0,8})([smhd])$/;

/** The shortest `expires_in`: more than one minute, as for `expires_at`. */
export const MIN_EXPIRES_IN_MS = 61_000;

/**
 * An `expires_in` duration in milliseconds: a whole number and one unit, `s`, `m`, `h` or `d` (a day is 24 hours),
 * such as `90s`, `15m`, `2h` or `7d`. Null for anything else, or for a duration outside 61 seconds to
 * `QUESTION_EXPIRY_LIMIT_MS` (366 days, less two minutes).
 */
export function parseExpiresIn(v: string): number | null {
  const m = DURATION.exec(v);
  if (!m) return null;
  const ms = Number(m[1]) * DURATION_UNITS[m[2] as keyof typeof DURATION_UNITS];
  return ms >= MIN_EXPIRES_IN_MS && ms <= QUESTION_EXPIRY_LIMIT_MS ? ms : null;
}

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
  /**
   * A reply window relative to when the host takes the question (`parseExpiresIn`), converted once on the host's
   * clock. Never together with `expires_at`.
   */
  expires_in: z
    .string()
    .refine(
      (v) => parseExpiresIn(v) !== null,
      'expires_in must be a whole number and one unit (s, m, h or d), from 61s to 365d, such as 15m',
    )
    .optional(),
  correlation_id: z.string().min(1).max(64).optional(),
  /**
   * The agent's own account of how it prepared the question under the person's involvement preference
   * (protocol section 20.1). Shown to the person as the agent's account; it never changes the requirement.
   */
  preparation: PreparationReport.optional(),
  /**
   * What the agent will do if no answer arrives by the deadline. Sending it asks for advice rather than a decision
   * (protocol section 21): the question is advisory, or refused, never quietly made blocking.
   */
  planned_fallback: PlannedFallback.optional(),
}).refine((v) => v.expires_at === undefined || v.expires_in === undefined, {
  message: 'supply only one of expires_at and expires_in',
  path: ['expires_in'],
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
  return expiryOutcome(requested, gate, now, hostDefaultMs).expiresAt;
}

/** `resolveExpiry`, and whether the policy's cap made a requested expiry earlier. */
export function expiryOutcome(
  requested: string | undefined,
  gate: WorkflowGate | undefined,
  now: number,
  hostDefaultMs: number | null = DEFAULTS.questionExpiryMs,
): { expiresAt: string | null; capped: boolean } {
  const { defaultMs, maxMs } = questionExpiryPolicy(hostDefaultMs, gate);
  if (!requested)
    return {
      expiresAt: defaultMs === null ? null : new Date(now + defaultMs).toISOString(),
      capped: false,
    };
  const asked = Date.parse(requested);
  if (!Number.isFinite(asked) || asked <= now + 60_000) {
    throw new BridgeError(
      'validation_error',
      'expires_at must be at least one minute in the future',
    );
  }
  const eff = maxMs === null ? asked : Math.min(asked, now + maxMs);
  return { expiresAt: new Date(eff).toISOString(), capped: eff < asked };
}

export function defaultKind(input: AskHumanInput): DecisionContentV1['kind'] {
  if (input.kind) return input.kind;
  const n = input.options?.length ?? 0;
  if (n === 0) return 'text';
  return 'mixed';
}
