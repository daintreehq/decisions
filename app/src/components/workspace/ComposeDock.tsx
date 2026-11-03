import { useState, type ReactNode } from 'react';
import type { ComposeShape, ComposeVerdict, FieldId } from '../../domain/compose.js';
import { firstLine } from '../../domain/compose.js';
import { drafts, fieldValue, type DraftModel } from '../../features/compose/draftStore.js';
import { dictation, type DictState, type Review } from '../../features/voice/dictation.js';
import { CloseIcon, KeyboardIcon, UndoIcon } from '../Icons.js';
import { LiveTranscript, MOD, RecordingClock } from './AnswerDock.js';

export interface ComposeDockInput {
  shape: ComposeShape;
  draft: DraftModel;
  verdict: ComposeVerdict;
  field: FieldId;
  fieldNoun: string;
  /** Dictation state when it belongs to this draft; null otherwise. */
  dict: DictState | null;
  stale: boolean;
  error: string | null;
  sending: boolean;
  selectionLabel: string | null;
  canUseOriginal: boolean;
  onSend: () => void;
  onChoose: () => void;
  onReviewUpdate: () => void;
  onShowRemaining: () => void;
  onReviewWords: () => void;
  onOpenEditor: () => void;
  onToggleTranscript: () => void;
  onDictate: () => void;
  onDismissError: () => void;
}

/** The status line's one message, in priority order, with at most two small actions. */
function StatusLine(i: ComposeDockInput): ReactNode {
  const { dict, draft, verdict } = i;
  const p = dict?.phase ?? 'idle';
  const link = (label: string, onClick: () => void, icon?: ReactNode) => (
    <button type="button" className="status-action" onClick={onClick}>
      {icon}
      {label}
    </button>
  );
  if (dict && p === 'recording' && dict.micLive)
    return (
      <span className="status rec" role="status">
        <span className="rec-dot" aria-hidden="true" />
        Recording · <RecordingClock since={dict.startedAt} />
        {i.field === 'reason' && <span className="status-quiet"> · Dictating your reason</span>}
        {dict.capWarning && <span className="status-warn"> · Stopping in 15 s</span>}
        {dict.escArmed && <span className="status-quiet"> · Press Escape again to discard</span>}
      </span>
    );
  if (dict && (p === 'starting' || p === 'recording'))
    return (
      <span className="status" role="status">
        {i.field === 'reason' ? 'Dictating your reason' : `Dictating your ${i.fieldNoun}`}
        {dict.escArmed && <span className="status-quiet"> · Press Escape again to discard</span>}
      </span>
    );
  if (p === 'finishing')
    return (
      <span className="status" role="status">
        <span className="spinner small" aria-hidden="true" /> Finishing your words…
      </span>
    );
  if (p === 'cleaning')
    return (
      <span className="status" role="status">
        <span className="spinner small" aria-hidden="true" /> Tidying wording…
        {link('Use original wording', () => dictation.useOriginal(draft.key))}
      </span>
    );
  if (i.error)
    return (
      <span className="status error" role="alert">
        {i.error}
        <button type="button" className="status-x" aria-label="Dismiss" onClick={i.onDismissError}>
          <CloseIcon size={14} />
        </button>
      </span>
    );
  if (draft.undo)
    return (
      <span className="status" role="status">
        {draft.undo.message}
        {link('Undo', draft.undo.restore, <UndoIcon size={14} />)}
      </span>
    );
  if (dict?.message)
    return (
      <span className={`status${dict.message.tone === 'error' ? ' error' : ''}`} role="status">
        {dict.message.text}
        {dict.message.retry && link('Try again', i.onDictate)}
        <button
          type="button"
          className="status-x"
          aria-label="Dismiss"
          onClick={() => dictation.dismissMessage()}
        >
          <CloseIcon size={14} />
        </button>
      </span>
    );
  if (i.stale)
    return (
      <span className="status warn" role="status">
        This question changed
        {link('Review update', i.onReviewUpdate)}
      </span>
    );
  if (dict?.review) return <ReviewMarks review={dict.review} draft={draft} />;
  if (verdict.hasContent && verdict.hint) {
    if (verdict.remainingFiles > 0)
      return (
        <span className="status" id="ws-send-hint">
          <button type="button" className="status-action strong" onClick={i.onShowRemaining}>
            {verdict.hint}
          </button>
        </span>
      );
    return (
      <span className="status" id="ws-send-hint">
        {verdict.hint}
      </span>
    );
  }
  const unsure = dict?.unsure && fieldValue(draft, dict.unsure.field) === dict.unsure.text;
  if (i.canUseOriginal || unsure)
    return (
      <span className="status">
        {i.canUseOriginal && link('Use original wording', () => dictation.useOriginal(draft.key))}
        {unsure &&
          link(
            `Review ${dict!.unsure!.spans.length} ${dict!.unsure!.spans.length === 1 ? 'word' : 'words'}`,
            i.onReviewWords,
          )}
      </span>
    );
  if (draft.save === 'error')
    return (
      <span className="status error" role="alert">
        Couldn’t save on this device
        {link('Retry', () => void drafts.flush(draft.key).catch(() => undefined))}
        {link('Copy', () => void navigator.clipboard?.writeText(fieldValue(draft, i.field)))}
      </span>
    );
  if (draft.notice === 'earlier')
    return <span className="status warn">Draft from an earlier version of this question</span>;
  if (draft.notice === 'restored') return <span className="status quiet">Draft restored</span>;
  if (!verdict.hasContent) return null;
  if (draft.save === 'saving') return <span className="status quiet">Saving…</span>;
  if (draft.save === 'saved') return <span className="status quiet">Saved on this device</span>;
  return null;
}

/** After a cleanup lands: its changed words underlined for a few seconds; tapping one says what was heard. */
function ReviewMarks({ review, draft }: { review: Review; draft: DraftModel }) {
  const [heard, setHeard] = useState<string | null>(null);
  const text = fieldValue(draft, review.field);
  if (text.slice(review.start, review.start + review.cleaned.length) !== review.cleaned)
    return null;
  const parts: ReactNode[] = [];
  let at = review.start;
  review.marks.forEach((m, k) => {
    if (m.from > at) parts.push(text.slice(at, m.from));
    parts.push(
      <button
        key={k}
        type="button"
        className="mark"
        aria-label={`${text.slice(m.from, m.to)}, changed${m.heard ? `, heard ${m.heard}` : ''}`}
        onClick={() => setHeard(m.heard ? `Heard “${m.heard}”` : 'Added by the tidy-up')}
      >
        {text.slice(m.from, m.to)}
      </button>,
    );
    at = m.to;
  });
  parts.push(text.slice(at, review.start + review.cleaned.length));
  return (
    <span className="status review">
      <span className="review-text">{heard ?? parts}</span>
      <button
        type="button"
        className="status-action"
        onClick={() => dictation.useOriginal(draft.key)}
      >
        Use original wording
      </button>
    </span>
  );
}

/** The summary row's content: selection (line one), status (line two), Send at the right. */
export function composeSummary(i: ComposeDockInput): ReactNode | null {
  const { shape, draft, verdict, dict } = i;
  const capturing = !!dict && dict.phase !== 'idle' && dict.phase !== 'consent';
  const status = StatusLine(i);
  let selection: ReactNode = null;
  if (shape.hasOptions) {
    if (i.selectionLabel)
      selection = (
        <span className="selection">
          <span className="selection-key">Selected</span>
          <span className="selection-value">{i.selectionLabel}</span>
          {shape.mixed && draft.text.trim() && (
            <button
              type="button"
              className="status-action"
              onClick={() => drafts.edit(draft.key, { selected: [] })}
            >
              Clear choice
            </button>
          )}
        </span>
      );
    else if (!draft.text.trim() && !capturing)
      selection = (
        <button type="button" className="selection choose" onClick={i.onChoose}>
          Choose an option
        </button>
      );
  }
  const showSend = verdict.hasContent || capturing;
  if (!selection && !status && !showSend) return null;
  return (
    <>
      <div className="dock-status">
        {selection}
        {status}
      </div>
      {showSend && (
        <button
          type="button"
          className="btn primary dock-send"
          aria-disabled={!verdict.canSend || i.sending || undefined}
          aria-describedby={verdict.hint && verdict.hasContent ? 'ws-send-hint' : undefined}
          title={`${shape.sendLabel} (${MOD}+Enter)`}
          onClick={() => {
            if (verdict.canSend && !i.sending) i.onSend();
          }}
        >
          {i.sending ? 'Sending…' : shape.sendLabel}
        </button>
      )}
    </>
  );
}

/** The dock's centre for a draft: the live transcript while dictating, else the draft field (this is "Type"). */
export function composeCentre(
  i: ComposeDockInput & { editorOpen: boolean; placeholder: string; onCloseEditor: () => void },
): ReactNode {
  const { dict, draft, shape } = i;
  const p = dict?.phase ?? 'idle';
  if (i.editorOpen)
    return (
      <button type="button" className="dock-field done" onClick={i.onCloseEditor}>
        <KeyboardIcon size={18} />
        <span>Done</span>
      </button>
    );
  if (dict && (p === 'starting' || (p === 'recording' && !dict.micLive)))
    return (
      <div className="dock-field passive" role="status">
        <span className={`dock-hint${dict.micSilent ? ' warn' : ''}`}>
          {dict.permission
            ? 'Allow microphone access to continue'
            : dict.micSilent
              ? 'No sound from your microphone'
              : 'Starting microphone…'}
        </span>
      </div>
    );
  if (dict && (p === 'recording' || p === 'finishing'))
    return (
      <button
        type="button"
        className="dock-field live"
        onClick={i.onToggleTranscript}
        aria-label="View transcript"
      >
        <LiveTranscript final={dict.final} interim={dict.interim} />
      </button>
    );
  if (shape.fields.length === 0)
    return (
      <button type="button" className="dock-field" onClick={i.onChoose}>
        <span className="dock-placeholder">
          {i.selectionLabel ? 'Change your choice' : 'Choose an option'}
        </span>
      </button>
    );
  const value = fieldValue(draft, i.field);
  return (
    <button
      type="button"
      className={`dock-field${value.trim() ? ' filled' : ''}`}
      onClick={i.onOpenEditor}
      aria-label={value.trim() ? `Edit ${i.fieldNoun}: ${firstLine(value, 80)}` : i.placeholder}
    >
      {value.trim() ? (
        <span className="dock-preview">{value.trim()}</span>
      ) : (
        <span className="dock-placeholder">{i.placeholder}</span>
      )}
    </button>
  );
}

/** "View transcript": the whole passage so far, with Discard. */
export function TranscriptPanel({ dict, onClose }: { dict: DictState; onClose: () => void }) {
  return (
    <div className="transcript" role="region" aria-label="Transcript">
      <div className="transcript-head">
        <span className="eyebrow">Transcript</span>
        <span className="transcript-tools">
          <button
            type="button"
            className="btn small danger-outline"
            onClick={() => {
              dictation.discard();
              onClose();
            }}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn ghost icon"
            aria-label="Close transcript"
            onClick={onClose}
          >
            <CloseIcon size={16} />
          </button>
        </span>
      </div>
      <p className="transcript-text">
        {dict.final}
        {dict.interim && (
          <>
            {dict.final ? ' ' : ''}
            <span className="interim">{dict.interim}</span>
          </>
        )}
        {!dict.final && !dict.interim && <span className="dock-hint">Listening…</span>}
      </p>
    </div>
  );
}
