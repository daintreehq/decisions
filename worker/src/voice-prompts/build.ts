import type { VoiceCorrectBody } from '@daintreehq/decisions-protocol';
import type { z } from 'zod';
import { CLAUDE_CORRECTION_PROMPT, CLAUDE_GUARDRAIL_SUFFIX } from './claude.js';
import { CORE_CORRECTION_PROMPT, GUARDRAIL_SUFFIX } from './openai.js';
import { TRANSCRIBER_NOTES } from './transcribers.js';

/**
 * Builds a dictation cleanup request the way Daintree desktop builds one (shared/config/voiceCorrection.ts and
 * electron/services/VoiceCorrectionService.ts): the model's own rules, the transcriber's habits, the project and
 * language blocks, the reply contract last; then a user turn of <confirmed_history>, <job>, <target> and
 * <agent_last_reply>. The question the person is answering stands in for the agent's last reply.
 */

type Body = z.infer<typeof VoiceCorrectBody>;

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/** Haiku cleans up a standalone passage shorter than this without reasoning (Daintree #15504). */
export const CLEANUP_REASONING_MIN_CHARS = 60;

export function cleanupReasoningEffortFor(
  model: string,
  passage: { chars: number; continuing: boolean },
): ReasoningEffort {
  if (model !== 'claude-haiku-5-5') return 'low';
  return !passage.continuing && passage.chars < CLEANUP_REASONING_MIN_CHARS ? 'none' : 'medium';
}

/** Daintree caps the agent's last reply at this many characters, keeping the newest. */
export const MAX_AGENT_REPLY_CHARS = 3000;
const MAX_OPTION_DESCRIPTION_CHARS = 200;

// Decisions' one addition to Daintree's reply contract: Grok and OpenAI flag no unsure words, so the model names
// the ones it left as heard rather than guess, and the phone marks them for the person to check.
export const UNSURE_WORDS_RULE = `- Put in unsure_words each word or short phrase of corrected_text you left as transcribed because changing it would be a guess, written exactly as it appears in corrected_text, with the reading you would have guessed as alternative. Leave it empty when nothing is in doubt.`;

export const CORRECTION_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['no_change', 'replace'] },
    corrected_text: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    unsure_words: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, alternative: { type: 'string' } },
        required: ['text', 'alternative'],
      },
    },
  },
  required: ['action', 'corrected_text', 'confidence', 'unsure_words'],
} as const;

const PROMPT_TAG_OPEN_RE =
  /<(?=\/?(?:recent_prompts|terminal_output|agent_last_reply|code_names|opening_command|target|following_text|job|confirmed_history|uncertain|pause)\b)/gi;

// The client's text goes into the prompt as data: it must not open or close one of the prompt's own blocks.
function neutralize(text: string): string {
  return text.replace(PROMPT_TAG_OPEN_RE, '‹');
}

const LANGUAGE_TAG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

/** The English name of a BCP 47 language tag, or null for anything that isn't one. */
function languageName(code: string): string | null {
  if (!LANGUAGE_TAG_RE.test(code)) return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(b: Body): string {
  const claude = b.provider === 'anthropic';
  const parts = [claude ? CLAUDE_CORRECTION_PROMPT : CORE_CORRECTION_PROMPT];
  if (b.transcriber) parts.push(TRANSCRIBER_NOTES[b.transcriber]);
  const project = neutralize(b.project_label?.replace(/\s+/g, ' ').trim() ?? '');
  if (project) {
    // Both rule sets read context names for spelling (`contextNames: "spelling"` in Daintree).
    parts.push(
      `CURRENT PROJECT:\nProject: ${project}\nWhen the target names this project or its repository and a word of the name was misheard, write it in this form. Keep ordinary words and the names of other things.`,
    );
  }
  const name = b.language ? languageName(b.language) : null;
  if (name) {
    parts.push(
      `LANGUAGE:\nThe speaker dictates in ${name}. Keep the corrected text in ${name}. Never translate it into another language or switch scripts, whatever the history, dictionary, or custom context says. Code, identifiers, paths, and proper names stay as spoken.`,
    );
  }
  parts.push(
    `${(claude ? CLAUDE_GUARDRAIL_SUFFIX : GUARDRAIL_SUFFIX).trim()}\n${UNSURE_WORDS_RULE}`,
  );
  return parts.join('\n\n');
}

// Coarse on purpose, as Daintree's is: roughly how long ago is all the model needs.
function describeAgo(at: number | null, now: number): string {
  if (at === null || Number.isNaN(at)) return 'unknown';
  const elapsed = Math.max(0, now - at);
  if (elapsed < 60_000) return 'under a minute before this request';
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return `about ${plural(minutes, 'minute')} before this request`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${plural(hours, 'hour')} before this request`;
  return `about ${Math.round(hours / 24)} days before this request`;
}

/** The question as the agent put it: its context, the question, then the numbered options. */
export function questionAsReply(b: Body): { text: string; truncated: boolean } | null {
  const parts: string[] = [];
  if (b.context?.trim()) parts.push(b.context.trim());
  if (b.question.trim()) parts.push(b.question.trim());
  const options =
    b.options.length > 0 ? b.options : (b.option_labels ?? []).map((label) => ({ label }));
  if (options.length > 0) {
    const lines = options.map((o: { label: string; description?: string }, i) => {
      const d = o.description?.replace(/\s+/g, ' ').trim() ?? '';
      const short =
        d.length > MAX_OPTION_DESCRIPTION_CHARS
          ? `${d.slice(0, MAX_OPTION_DESCRIPTION_CHARS - 1).trimEnd()}…`
          : d;
      return `${i + 1}. ${o.label}${short ? ` — ${short}` : ''}`;
    });
    parts.push(['Options:', ...lines].join('\n'));
  }
  const whole = parts.join('\n\n');
  if (!whole) return null;
  if (whole.length <= MAX_AGENT_REPLY_CHARS) return { text: whole, truncated: false };
  return { text: whole.slice(-MAX_AGENT_REPLY_CHARS), truncated: true };
}

export function buildUserMessage(b: Body, now: number): string {
  const parts: string[] = [];
  const history = b.preceding_text?.trim() ? neutralize(b.preceding_text) : '';
  if (history) parts.push(`<confirmed_history>\n1. ${history}\n</confirmed_history>`);
  parts.push(`<job>\nreason=stop\nprompt_start=${history ? 'no' : 'yes'}\n</job>`);
  parts.push(`<target>\n${neutralize(b.raw_transcript.trim())}\n</target>`);
  const reply = questionAsReply(b);
  if (reply) {
    const lines = [
      `recorded=${describeAgo(b.asked_at ? Date.parse(b.asked_at) : null, now)}`,
      'newer_transcript_records=no',
    ];
    if (reply.truncated) lines.push('start_cut=yes');
    // One quoted line, so the question can't pass for a label, close its block or open a <target> of its own.
    lines.push(`text=${neutralize(JSON.stringify(reply.text))}`);
    parts.push(`<agent_last_reply>\n${lines.join('\n')}\n</agent_last_reply>`);
  }
  return parts.join('\n\n');
}
