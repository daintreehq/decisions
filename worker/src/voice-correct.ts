import {
  CorrectionResult,
  voiceCleanupTimeoutMs,
  type VoiceCorrectBody,
} from '@daintreehq/decisions-protocol';
import { z } from 'zod';
import type { Env } from './env.js';
import {
  CORRECTION_RESULT_SCHEMA,
  buildSystemPrompt,
  buildUserMessage,
  cleanupReasoningEffortFor,
  type ReasoningEffort,
} from './voice-prompts/build.js';

/**
 * One whole-passage dictation cleanup, sent as Daintree desktop sends it (electron/services/voiceCleanupClaude.ts
 * and VoiceCorrectionService.ts): Anthropic through the Messages API with the schema as `output_config.format`
 * and adaptive thinking at the effort the passage gets, OpenAI through the Responses API with a strict schema at
 * low reasoning. Any failure is `{ ok: false }` and the phone keeps the raw transcript; provider error text is
 * never forwarded or logged.
 */

type Body = z.infer<typeof VoiceCorrectBody>;

const CLAUDE_API_VERSION = '2026-10-21';
// Thinking and reasoning count toward the output cap, so a request that may think gets room on top.
const THINKING_HEADROOM_TOKENS = 4096;
const MIN_OUTPUT_TOKENS = 1024;
const OUTPUT_TOKENS_PER_CHAR = 1.5;
const OUTPUT_TOKENS_OVERHEAD = 256;
// Past this a passage stays raw on purpose rather than risk a cut-off reply.
const MAX_CORRECTION_INPUT_CHARS = 12_000;
// Busy, failing or rate limiting: worth one more try. 529 is Anthropic's overloaded.
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const LEADING_FILLER_RE = /^(?:\s*(?:um|uh)[\s,.;:!-]+)+/i;
const PROMPT_CACHE_KEY = 'decisions-voice-correction-v1';
const MAX_UNSURE = 10;

const ModelReply = z.object({
  action: z.enum(['no_change', 'replace']),
  corrected_text: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  unsure_words: z
    .array(z.object({ text: z.string(), alternative: z.string() }))
    .optional()
    .default([]),
});
type ModelReply = z.infer<typeof ModelReply>;

export type CorrectionOutcome =
  { ok: true; result: CorrectionResult; model: string } | { ok: false };

/** "none" turns thinking off: Haiku takes "disabled", while Sonnet refuses it and only stops between tools. */
function thinkingFor(model: string, effort: ReasoningEffort) {
  if (effort !== 'none') return { thinking: { type: 'adaptive' }, effort };
  const thinking = model.startsWith('claude-sonnet-')
    ? { type: 'between_tools' }
    : { type: 'disabled' };
  return { thinking, effort: 'low' as const };
}

function headroom(effort: ReasoningEffort): number {
  return effort === 'none' ? 0 : THINKING_HEADROOM_TOKENS;
}

function requestFor(
  b: Body,
  env: Env,
  key: string,
  system: string,
  user: string,
  effort: ReasoningEffort,
  maxTokens: number,
): { url: string; init: RequestInit; model: string } {
  if (b.provider === 'anthropic') {
    const model = env.ANTHROPIC_CORRECTION_MODEL;
    const { thinking, effort: requestEffort } = thinkingFor(model, effort);
    return {
      url: 'https://api.anthropic.com/v1/messages',
      model,
      init: {
        method: 'POST',
        // A provider key never follows a redirect anywhere.
        redirect: 'manual',
        headers: {
          'x-api-key': key,
          'anthropic-version': CLAUDE_API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens + headroom(effort),
          thinking,
          output_config: {
            effort: requestEffort,
            format: { type: 'json_schema', schema: CORRECTION_RESULT_SCHEMA },
          },
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: user }],
        }),
      },
    };
  }
  const model = env.OPENAI_CORRECTION_MODEL;
  return {
    url: 'https://api.openai.com/v1/responses',
    model,
    init: {
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        // The rules go as the first developer message, not `instructions`, so their fixed prefix is cacheable.
        input: [
          { role: 'developer', content: system },
          { role: 'user', content: user },
        ],
        prompt_cache_key: PROMPT_CACHE_KEY,
        service_tier: 'auto',
        store: false,
        reasoning: { effort },
        text: {
          format: {
            type: 'json_schema',
            name: 'voice_correction_result',
            strict: true,
            schema: CORRECTION_RESULT_SCHEMA,
          },
        },
        max_output_tokens: maxTokens + headroom(effort),
      }),
    },
  };
}

/** The reply's JSON text, or null when it was cut off, refused or empty. */
function replyText(provider: Body['provider'], data: unknown): string | null {
  if (provider === 'anthropic') {
    const m = data as { content?: { type?: string; text?: string }[]; stop_reason?: string };
    if (m.stop_reason === 'max_tokens' || m.stop_reason === 'refusal') return null;
    return m.content?.find((c) => c.type === 'text' && c.text)?.text ?? null;
  }
  const r = data as {
    status?: string;
    output_text?: string;
    output?: { content?: { type?: string; text?: string }[] }[];
  };
  if (r.status === 'incomplete') return null;
  if (typeof r.output_text === 'string' && r.output_text.trim()) return r.output_text;
  return (
    r.output?.flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text' && c.text)
      ?.text ?? null
  );
}

/** Locates each unsure word in the corrected text, in order, as UTF-16 offsets. */
export function unsureSpans(
  text: string,
  words: ModelReply['unsure_words'],
): CorrectionResult['uncertain_spans'] {
  const spans: CorrectionResult['uncertain_spans'] = [];
  let from = 0;
  for (const w of words) {
    if (spans.length >= MAX_UNSURE) break;
    const word = w.text.trim();
    const alternative = w.alternative.trim();
    if (!word || word.length > 200 || alternative.length > 200) continue;
    let at = text.indexOf(word, from);
    if (at < 0) at = text.indexOf(word);
    if (at < 0 || spans.some((s) => at < s.end && at + word.length > s.start)) continue;
    spans.push({
      start: at,
      end: at + word.length,
      raw: word,
      candidate: alternative && alternative !== word ? alternative : word,
      reason: 'possibly misheard',
    });
    from = at + word.length;
  }
  return spans.sort((a, b) => a.start - b.start);
}

export async function correct(
  env: Env,
  b: Body,
  fetcher: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<CorrectionOutcome> {
  const raw = b.raw_transcript.trim();
  if (!raw || raw.length > MAX_CORRECTION_INPUT_CHARS) return { ok: false };
  const key = b.provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  if (!key) return { ok: false };
  const continuing = !!b.preceding_text?.trim();
  const model =
    b.provider === 'anthropic' ? env.ANTHROPIC_CORRECTION_MODEL : env.OPENAI_CORRECTION_MODEL;
  const effort = cleanupReasoningEffortFor(model, { chars: raw.length, continuing });
  const maxTokens = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.ceil(raw.length * OUTPUT_TOKENS_PER_CHAR) + OUTPUT_TOKENS_OVERHEAD,
  );
  const req = requestFor(
    b,
    env,
    key,
    buildSystemPrompt(b),
    buildUserMessage(b, now),
    effort,
    maxTokens,
  );
  // One deadline covers the retry too, as Daintree's does.
  const deadline = AbortSignal.timeout(voiceCleanupTimeoutMs(raw.length, effort !== 'none'));
  try {
    let res: Response | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        res = await fetcher(req.url, { ...req.init, signal: deadline });
      } catch (e) {
        if (deadline.aborted || attempt > 1 || !(e instanceof TypeError)) return { ok: false };
        continue;
      }
      if (res.ok || attempt > 1 || !RETRY_STATUSES.has(res.status)) break;
      await res.body?.cancel();
    }
    if (!res?.ok) return { ok: false };
    const text = replyText(b.provider, await res.json());
    if (!text) return { ok: false };
    const parsed = ModelReply.safeParse(JSON.parse(text));
    if (!parsed.success) return { ok: false };
    const reply = parsed.data;
    const candidate = reply.corrected_text.replace(LEADING_FILLER_RE, '').trim();
    const corrected = reply.action === 'replace' && candidate ? candidate : raw;
    const result = CorrectionResult.safeParse({
      corrected_text: corrected,
      uncertain_spans: unsureSpans(corrected, reply.unsure_words),
      applied_commands: [],
      warnings: reply.confidence === 'low' && corrected !== raw ? ['low-confidence'] : [],
    });
    return result.success ? { ok: true, result: result.data, model: req.model } : { ok: false };
  } catch {
    return { ok: false };
  }
}
