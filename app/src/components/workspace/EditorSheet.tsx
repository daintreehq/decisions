import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLayer } from '../../app/layers.js';
import type { FieldId } from '../../domain/compose.js';
import { drafts, fieldValue, type DraftModel } from '../../features/compose/draftStore.js';
import { resolveSpan, type SpanChoice } from '../../features/voice/correction.js';
import { dictation, type Unsure } from '../../features/voice/dictation.js';
import { CloseIcon, ExpandIcon, FitIcon, MoreIcon } from '../Icons.js';
import { Menu } from './Sheet.js';
import { MOD } from './AnswerDock.js';

export const FIELD_LABEL: Record<FieldId, string> = { text: 'Answer', reason: 'Reason' };

/**
 * The editor grows upward from the dock (3–5 lines, up to about a third of the visible height, then it scrolls) and
 * can expand into a full-height focused editor that keeps a compact question header. It is the same draft in every
 * view; there is only ever one editor. Return inserts a newline; closing saves and collapses. It never opens or
 * focuses itself because dictation produced text.
 */
export function EditorSheet({
  draft,
  field,
  fields,
  fieldLabels,
  placeholder,
  maxBytesHint,
  questionExcerpt,
  expanded,
  onExpand,
  onClose,
  onField,
  onSend,
}: {
  draft: DraftModel;
  field: FieldId;
  fields: FieldId[];
  fieldLabels: Record<FieldId, string>;
  placeholder: string;
  maxBytesHint: string | null;
  questionExcerpt: string;
  expanded: boolean;
  onExpand: (v: boolean) => void;
  onClose: () => void;
  onField: (f: FieldId) => void;
  onSend: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState(false);
  const dismiss = useLayer(true, onClose);
  const value = fieldValue(draft, field);
  const unsure = useUnsure(draft, field);

  // Focus once, when opened or when the field changes; never because text arrived.
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.focus({ preventScroll: true });
    const c = draft.caret?.field === field ? draft.caret : null;
    const end = t.value.length;
    t.setSelectionRange(c ? Math.min(c.start, end) : end, c ? Math.min(c.end, end) : end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field]);

  // Grow with the text up to the sheet's cap; beyond it the textarea scrolls.
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t || expanded) return;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight + 2}px`;
  }, [value, expanded]);

  const caret = () => {
    const t = ref.current;
    if (t) drafts.setCaret(draft.key, { field, start: t.selectionStart, end: t.selectionEnd });
  };

  return (
    <div className={`editor${expanded ? ' expanded' : ''}`}>
      {expanded && (
        <div className="editor-question">
          <span className="editor-question-text">{questionExcerpt}</span>
        </div>
      )}
      <div className="editor-head">
        {fields.length > 1 ? (
          <div className="seg editor-fields" role="tablist" aria-label="Field">
            {fields.map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={f === field}
                onClick={() => {
                  if (f === field) return;
                  // Switching fields while dictating stops first, so words never land in the other field.
                  if (dictation.isActive()) void dictation.stop();
                  onField(f);
                }}
              >
                {fieldLabels[f]}
              </button>
            ))}
          </div>
        ) : (
          <label className="editor-label" htmlFor="ws-editor">
            {fieldLabels[field]}
          </label>
        )}
        <span className="editor-tools">
          <span className="menu-anchor">
            <button
              type="button"
              className="btn ghost icon"
              aria-label="Editor options"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
            >
              <MoreIcon />
            </button>
            <Menu open={menu} onClose={() => setMenu(false)} label="Editor options">
              <button
                type="button"
                role="menuitem"
                disabled={!draft.text && !draft.reason && !draft.selected.length}
                onClick={() => {
                  setMenu(false);
                  if (dictation.isActive()) dictation.release(draft.key);
                  drafts.clear(draft.key);
                }}
              >
                Clear draft
              </button>
            </Menu>
          </span>
          <button
            type="button"
            className="btn ghost icon"
            aria-label={expanded ? 'Collapse editor' : 'Expand editor'}
            onClick={() => onExpand(!expanded)}
          >
            {expanded ? <FitIcon /> : <ExpandIcon />}
          </button>
        </span>
      </div>
      {unsure && <UnsureReview draft={draft} unsure={unsure} textarea={ref} />}
      <textarea
        id="ws-editor"
        ref={ref}
        className="editor-input"
        value={value}
        placeholder={placeholder}
        aria-describedby={maxBytesHint ? 'ws-editor-limit' : undefined}
        rows={3}
        onChange={(e) => {
          drafts.edit(
            draft.key,
            field === 'reason' ? { reason: e.target.value } : { text: e.target.value },
          );
          drafts.setCaret(draft.key, {
            field,
            start: e.target.selectionStart,
            end: e.target.selectionEnd,
          });
        }}
        onSelect={caret}
        onKeyUp={caret}
        onClick={caret}
        onBlur={() => void drafts.flush(draft.key).catch(() => undefined)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          } else if (e.key === 'Escape' && !dictation.isActive()) {
            e.preventDefault();
            e.stopPropagation();
            dismiss();
          }
        }}
        title={`${MOD}+Enter sends`}
      />
      {maxBytesHint && (
        <p className="editor-limit" id="ws-editor-limit" role="status">
          {maxBytesHint}
        </p>
      )}
    </div>
  );
}

/** Unsure spans from the cleanup, still valid only while the field is exactly what they were computed against. */
function useUnsure(draft: DraftModel, field: FieldId): Unsure | null {
  const [, force] = useState(0);
  useEffect(() => {
    const off = dictation.subscribe(() => force((n) => n + 1));
    return () => void off();
  }, []);
  const u = dictation.getState().unsure;
  if (!u || u.key !== draft.key || u.field !== field) return null;
  return fieldValue(draft, field) === u.text ? u : null;
}

/** "Review 2 words": the first unsure span selected, with what was heard and what the model suggested. */
function UnsureReview({
  draft,
  unsure,
  textarea,
}: {
  draft: DraftModel;
  unsure: Unsure;
  textarea: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const s = unsure.spans[0]!;
  const text = unsure.text;
  const now = text.slice(s.start, s.end);
  useEffect(() => {
    const t = textarea.current;
    if (t && document.activeElement === t) t.setSelectionRange(s.start, s.end);
  }, [s.start, s.end, textarea]);
  const choose = (c: SpanChoice) => {
    const r = resolveSpan(text, unsure.spans, 0, c);
    drafts.edit(draft.key, unsure.field === 'reason' ? { reason: r.text } : { text: r.text });
    dictation.setUnsure(r.spans.length ? { ...unsure, text: r.text, spans: r.spans } : null);
  };
  return (
    <div className="unsure" role="group" aria-label="Check a word">
      <p className="unsure-line">
        Not sure about <mark>{now}</mark>
        {unsure.spans.length > 1 && (
          <span className="muted"> · {unsure.spans.length - 1} more</span>
        )}
      </p>
      <div className="unsure-choices">
        <button type="button" className="btn small" onClick={() => choose('corrected')}>
          Keep “{now}”
        </button>
        {s.candidate && s.candidate !== now && (
          <button type="button" className="btn small" onClick={() => choose('candidate')}>
            Use “{s.candidate}”
          </button>
        )}
        {s.raw && s.raw !== now && (
          <button type="button" className="btn small" onClick={() => choose('raw')}>
            Heard “{s.raw}”
          </button>
        )}
        <button
          type="button"
          className="btn ghost icon"
          aria-label="Stop checking words"
          onClick={() => dictation.setUnsure(null)}
        >
          <CloseIcon size={16} />
        </button>
      </div>
    </div>
  );
}
