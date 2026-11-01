import { LIMITS, utf8ByteLength } from '@daintree/decisions-protocol';
import { z } from 'zod';
import { redactSecrets, stripControlChars } from './redact.js';
import { normalizeLabel } from './text.js';
import type { ProxyQuestionInput } from './types.js';

/** Gates whose whole point is a human sign-off. The proxy never answers these automatically. */
export const DEFAULT_BLOCKED_GATES: (string | RegExp)[] = [
  /design[-_. ]?review/i,
  /final[-_. ]?(design[-_. ]?)?approval/i,
  /approv\w*[-_. ]?final/i,
  /release[-_. ]?sign[-_. ]?off/i,
];

/** Subjects where a wrong automatic answer is unacceptable. Matched against the question, option labels and gate id. */
export const DEFAULT_BLOCKED_KEYWORDS =
  /\b(legal|lawsuit|licen[sc]e|licen[sc]ing|compliance|gdpr|hipaa|pci|sox|payments?|billing|invoices?|refunds?|chargebacks?|credit cards?|security|vulnerabilit\w*|exploits?|cve|secrets?|credentials?|passwords?|passphrases?|api[-_ ]?keys?|access tokens?|auth tokens?|api tokens?|bearer tokens?|private keys?|destructive|irreversibl\w*|permanent(?:ly)?|delete all|drop (?:table|database|schema)|force[- ]push|rm -rf|wipe|purge)\b/i;

const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules?|guidelines?|constraints?)\b/i,
  /\b(?:new|updated|real) (?:instructions?|system prompt|rules)\b/i,
  /\bsystem (?:prompt|message|override)\b/i,
  /<\/?\s*(?:system|assistant|developer|instructions?)\s*>/i,
  /\b(?:you are|act as|pretend to be|behave as) (?:now )?(?:the )?(?:human|owner|user|operator|admin)\b/i,
  /\b(?:respond|reply|answer|output|return) (?:only )?(?:with )?(?:["']?)(?:approve|yes|accept|reject)\b[^.\n]{0,20}(?:regardless|always|no matter)/i,
  /\b(?:always|just) (?:approve|accept|answer yes)\b/i,
  /\bdo not (?:abstain|refuse|decline|flag)\b/i,
  /\b(?:set|report|give) (?:your )?confidence (?:to |as |of |at )?(?:0?\.9\d*|1(?:\.0+)?|100%?)\b/i,
  /\bjailbreak\b/i,
  /\bprompt injection\b/i,
];

export function injectionHit(input: ProxyQuestionInput): string | null {
  const texts = [
    input.question,
    input.context ?? '',
    ...input.options.flatMap((o) => [o.label, o.description ?? '']),
  ];
  for (const t of texts) {
    for (const p of INJECTION_PATTERNS) if (p.test(t)) return p.source.slice(0, 40);
  }
  return null;
}

export function matchesGate(gateId: string | undefined, gates: (string | RegExp)[]): boolean {
  if (!gateId) return false;
  const g = gateId.toLowerCase();
  return gates.some((p) => (typeof p === 'string' ? g.includes(p.toLowerCase()) : p.test(gateId)));
}

export function keywordHit(input: ProxyQuestionInput, re: RegExp): string | null {
  const texts = [
    input.question,
    input.workflow_gate_id ?? '',
    ...input.options.map((o) => o.label),
  ];
  for (const t of texts) {
    const m = re.exec(t);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

/** Returns a reason when the offered options cannot support a trustworthy automatic choice. */
export function optionProblem(input: ProxyQuestionInput): string | null {
  const { kind, options } = input;
  if ((kind === 'choice' || kind === 'approval') && options.length < 2) return 'ambiguous-options';
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const o of options) {
    const label = normalizeLabel(o.label);
    if (ids.has(o.id) || (label && labels.has(label))) return 'ambiguous-options';
    ids.add(o.id);
    if (label) labels.add(label);
    if (!o.id.trim()) return 'ambiguous-options';
  }
  return null;
}

/** Risk flags that forbid automatic answering (a suggestion may still be shown to the human). */
export const BLOCKING_RISK_FLAG =
  /inject|novel|high[-_ ]?impact|irreversib|destruct|security|legal|payment|compliance|secret|credential|contradict|ambiguous|business[-_ ]?critical|unclear|insufficient/i;

export const ModelOutputSchema = z
  .object({
    action: z.enum(['answer', 'abstain']),
    selected_option_ids: z.array(z.string()).default([]),
    answer_text: z.string().nullish(),
    confidence_estimate: z.number().nullish(),
    supporting_decision_ids: z.array(z.string()).default([]),
    risk_flags: z.array(z.string()).default([]),
    rationale: z.string().nullish(),
    reason: z.string().nullish(),
  })
  .strict();

export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!.trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('no JSON object');
  }
}

export interface ValidatedDecision {
  abstain: boolean;
  reason?: string;
  selected_option_ids: string[];
  answer_text?: string;
  confidence: number;
  supporting_decision_ids: string[];
  risk_flags: string[];
  rationale?: string;
}

const cleanText = (s: string): string => stripControlChars(redactSecrets(s)).trim();

/** Strict validation of a model reply. Any violation yields `{ok:false}`, which the engine turns into an abstention. */
export function validateModelReply(
  text: string,
  input: ProxyQuestionInput,
  retrievedIds: string[],
): { ok: true; decision: ValidatedDecision } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return { ok: false, reason: 'invalid-model-output' };
  }
  const parsed = ModelOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid-model-output' };
  const m = parsed.data;

  if (m.risk_flags.length > 10 || m.risk_flags.some((f) => f.length === 0 || f.length > 40)) {
    return { ok: false, reason: 'invalid-model-output' };
  }
  const risk_flags = [
    ...new Set(m.risk_flags.map((f) => stripControlChars(f).trim().toLowerCase())),
  ];

  if (m.action === 'abstain') {
    const reason = cleanText(m.reason ?? '').slice(0, 200) || 'model-abstained';
    return {
      ok: true,
      decision: {
        abstain: true,
        reason,
        selected_option_ids: [],
        confidence: 0,
        supporting_decision_ids: [],
        risk_flags,
      },
    };
  }

  const conf = m.confidence_estimate;
  if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
    return { ok: false, reason: 'invalid-model-output' };
  }

  const offered = new Set(input.options.map((o) => o.id));
  const sel = m.selected_option_ids;
  if (new Set(sel).size !== sel.length || sel.some((id) => !offered.has(id))) {
    return { ok: false, reason: 'invalid-model-output' };
  }
  const text_ = m.answer_text == null ? undefined : cleanText(m.answer_text);
  if (text_ !== undefined && utf8ByteLength(text_) > LIMITS.answerTextBytes) {
    return { ok: false, reason: 'invalid-model-output' };
  }
  if (input.options.length === 0) {
    if (sel.length !== 0 || !text_) return { ok: false, reason: 'invalid-model-output' };
  } else if (input.kind === 'choice' || input.kind === 'approval') {
    if (sel.length !== 1) return { ok: false, reason: 'invalid-model-output' };
  } else if (sel.length > 1 || (sel.length === 0 && !text_)) {
    return { ok: false, reason: 'invalid-model-output' };
  }

  const known = new Set(retrievedIds);
  const support = [...new Set(m.supporting_decision_ids)];
  if (support.length === 0 || support.some((id) => !known.has(id))) {
    return { ok: false, reason: 'invalid-model-output' };
  }

  const decision: ValidatedDecision = {
    abstain: false,
    selected_option_ids: sel,
    confidence: conf,
    supporting_decision_ids: support,
    risk_flags,
  };
  if (text_) decision.answer_text = text_;
  if (m.rationale != null) {
    const r = cleanText(m.rationale).slice(0, 2000);
    if (r) decision.rationale = r;
  }
  return { ok: true, decision };
}
