import { LIMITS, utf8ByteLength, type DecisionContentV1 } from '@daintreehq/decisions-protocol';

/**
 * What an answer or a correction to one question needs, and whether the draft in hand can be sent. Pure: the dock,
 * the editor and the moment of Send all read the same verdict, so the button and the final check never disagree.
 */

export type ComposeMode = 'answer' | 'correction';
/** The draft's text fields. `text` is the answer or note; `reason` exists only in a correction. */
export type FieldId = 'text' | 'reason';

export const REASON_MAX_CHARS = 2_000;

export interface ComposeShape {
  /** Options are offered as a single choice. */
  hasOptions: boolean;
  /** A text field is offered in this mode (the answer itself, or a note beside a choice). */
  textAllowed: boolean;
  /** Text is the answer itself (no options), not a note beside a choice. */
  textIsAnswer: boolean;
  mixed: boolean;
  approval: boolean;
  /** The text fields in the order they appear; the first is the dock's own field. */
  fields: FieldId[];
  sendLabel: 'Send answer' | 'Send decision' | 'Send correction';
}

export function composeShape(c: DecisionContentV1, mode: ComposeMode): ComposeShape {
  const hasOptions = c.options.length > 0 && c.kind !== 'text';
  const mixed = c.kind === 'mixed' && hasOptions;
  // A correction to a choice is a different choice plus the reason; a separate note would compete with it.
  const textAllowed =
    mode === 'correction' ? !hasOptions || mixed : !hasOptions || c.allow_text !== false;
  const fields: FieldId[] = [];
  if (textAllowed) fields.push('text');
  if (mode === 'correction') fields.push('reason');
  return {
    hasOptions,
    textAllowed,
    textIsAnswer: !hasOptions,
    mixed,
    approval: c.kind === 'approval',
    fields,
    sendLabel:
      mode === 'correction'
        ? 'Send correction'
        : c.kind === 'approval'
          ? 'Send decision'
          : 'Send answer',
  };
}

/** Evidence state for approvals, as the file gallery reports it (`presented` once files are tracked as shown). */
export interface EvidenceState {
  total: number;
  loaded: number;
  presented?: number;
  expired: number;
  failed: number;
}

export interface ComposeInput {
  shape: ComposeShape;
  mode: ComposeMode;
  selected: readonly string[];
  text: string;
  reason: string;
  /** The answer in force, when correcting it. */
  current?: { selected: readonly string[]; text: string } | null;
  attachments: number;
  evidence: EvidenceState;
  /** The question moved past the revision this draft was reviewed against. */
  stale: boolean;
  /** Dictation is starting, recording, finishing, or its cleanup has not been applied or bypassed. */
  capturing: false | 'capturing' | 'cleaning';
  /** The question can no longer take this action (expired, withdrawn, answered elsewhere). */
  closed?: boolean;
}

export interface ComposeVerdict {
  canSend: boolean;
  /** One short reason, shown next to Send, when it helps. */
  hint: string | null;
  /** Anything worth sending exists (drives whether the summary row and Send appear). */
  hasContent: boolean;
  textBytes: number;
  /** Bytes over the protocol's answer limit (0 when within it). */
  textOver: number;
  reasonOver: number;
  /** Files still to be presented before an approval can be sent. */
  remainingFiles: number;
}

export const textBytes = (s: string): number => utf8ByteLength(s);

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Presented counts once the gallery tracks it; until then a verified (loaded) file stands in. */
export function evidenceSeen(e: EvidenceState): number {
  return e.presented ?? e.loaded;
}

export function verdict(i: ComposeInput): ComposeVerdict {
  const { shape } = i;
  const text = i.text.trim();
  const bytes = textBytes(i.text);
  const textOver = Math.max(0, bytes - LIMITS.answerTextBytes);
  // The protocol's reason limit counts UTF-16 units (a zod string max), exactly as `length` does.
  const reasonOver = Math.max(0, i.reason.length - REASON_MAX_CHARS);
  const hasChoice = shape.hasOptions && i.selected.length > 0;
  const hasText = shape.textAllowed && text.length > 0;
  const hasAnswer = shape.hasOptions ? hasChoice || (shape.mixed && hasText) : hasText;
  const hasContent = hasChoice || hasText || (i.mode === 'correction' && !!i.reason.trim());
  // A correction to an approval is a decision on the same files, so it needs the same evidence.
  const needsEvidence = shape.approval && i.attachments > 0;
  const seen = evidenceSeen(i.evidence);
  const remainingFiles = needsEvidence ? Math.max(0, i.evidence.total - seen) : 0;
  const evidenceOk = !needsEvidence || (i.evidence.total > 0 && seen >= i.evidence.total);
  const unchanged =
    i.mode === 'correction' &&
    !!i.current &&
    sameSet(shape.hasOptions ? i.selected : [], i.current.selected) &&
    (shape.textAllowed ? text : '') === i.current.text.trim();
  const reasonOk = i.mode === 'answer' || i.reason.trim().length > 0;

  let hint: string | null = null;
  if (i.closed) hint = null;
  else if (i.stale) hint = 'Review the updated question';
  else if (i.capturing === 'capturing') hint = null;
  else if (i.capturing === 'cleaning') hint = null;
  else if (!hasAnswer)
    hint = shape.mixed
      ? 'Choose an option or write an answer'
      : shape.hasOptions
        ? 'Choose an option'
        : 'Write an answer';
  else if (textOver > 0) hint = `Shorten your answer by ${formatBytes(textOver)}`;
  else if (unchanged) hint = 'Change the answer to send a correction';
  else if (!reasonOk) hint = 'Add a reason for the change';
  else if (reasonOver > 0) hint = `Shorten the reason by ${reasonOver} characters`;
  else if (!evidenceOk)
    hint =
      i.evidence.expired > 0
        ? 'A file expired, so this cannot be approved here'
        : i.evidence.failed > 0 && seen + i.evidence.failed >= i.evidence.total
          ? 'A file could not be verified'
          : remainingFiles === 1
            ? 'Review the remaining file'
            : `Review the remaining ${remainingFiles} files`;

  const canSend =
    !i.closed &&
    !i.stale &&
    !i.capturing &&
    hasAnswer &&
    textOver === 0 &&
    !unchanged &&
    reasonOk &&
    reasonOver === 0 &&
    evidenceOk;
  return { canSend, hint, hasContent, textBytes: bytes, textOver, reasonOver, remainingFiles };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  return `${(n / 1024).toFixed(1)} KB`;
}

/** The first line of a draft, for the dock's one-line previews. */
export function firstLine(s: string, max = 120): string {
  const line = s.trim().split('\n')[0] ?? '';
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}
