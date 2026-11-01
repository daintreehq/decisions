import { useEffect, useId, useRef, useState } from 'react';
import { app } from '../app/controller.js';
import type { QuestionView } from '../domain/model.js';
import { announce } from '../lib/announce.js';
import { submitKind } from '../domain/selectors.js';
import { VoiceInput } from '../features/voice/VoiceInput.js';
import { ConfirmDialog } from './Dialog.js';
import type { ReviewState } from './AttachmentGallery.js';
import { SafeText } from './SafeText.js';

export interface EditorProps {
  view: QuestionView;
  mode: 'answer' | 'override';
  review: ReviewState;
  /** Prefill (e.g. after a conflict, the text the human had typed). */
  initial?: { selected: string[]; text: string };
  onDone?: () => void;
  onCancel?: () => void;
}

/**
 * Option + text answer form. Choices are single-select and need an explicit Submit. The form is bound to the
 * revision it was opened on: if the question changes underneath it, choices lock until the human refreshes.
 */
export function AnswerEditor({ view, mode, review, initial, onDone, onCancel }: EditorProps) {
  const c = view.content!;
  const [selected, setSelected] = useState<string[]>(initial?.selected ?? []);
  const [text, setText] = useState(initial?.text ?? '');
  const [reason, setReason] = useState('');
  const [baseRevision, setBaseRevision] = useState(view.revision);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const gid = useId();
  const stale = view.revision !== baseRevision;
  const hasOptions = c.options.length > 0 && c.kind !== 'text';
  const textOnly = !hasOptions;
  const showText = c.allow_text || textOnly;
  const approval = c.kind === 'approval';
  const needsImages = approval && c.attachments.length > 0;
  const imagesReady = !needsImages || (review.loaded === review.total && review.total > 0);

  // Restore a saved draft once (answer mode only; overrides always start clean).
  useEffect(() => {
    if (mode !== 'answer' || initial) {
      loaded.current = true;
      return;
    }
    void app.drafts?.load(view.id).then((d) => {
      if (d) {
        setSelected(d.selected);
        setText(d.text);
      }
      loaded.current = true;
    });
  }, [view.id, mode, initial]);

  // Autosave (encrypted) on every meaningful edit, because a mobile browser can be killed at any moment.
  useEffect(() => {
    if (!loaded.current || mode !== 'answer') return;
    const t = setTimeout(() => {
      if (selected.length || text.trim())
        void app.drafts?.save(view.id, { selected, text, reason: '' });
      else void app.drafts?.delete(view.id);
    }, 400);
    return () => clearTimeout(t);
  }, [selected, text, mode, view.id]);

  const hasAnswer = hasOptions
    ? selected.length > 0 || (c.kind === 'mixed' && text.trim().length > 0)
    : text.trim().length > 0;
  const reasonOk = mode === 'answer' || reason.trim().length > 0;
  const canSubmit = !busy && !stale && hasAnswer && reasonOk && imagesReady;

  // A confirmation for a revision that is no longer current must not stay armed.
  useEffect(() => {
    if (confirm && stale) setConfirm(false);
  }, [confirm, stale]);

  const submit = async () => {
    // Re-check at the moment of sending (not just when the button was enabled): the dialog can sit open while
    // another device commits a newer revision.
    if (view.revision !== baseRevision || submitKind(view) !== mode) {
      setConfirm(false);
      setError('This question changed while you were answering. Review the update before sending.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await app.submit({
        view,
        kind: mode,
        expectedRevision: baseRevision,
        selected,
        text,
        reason: mode === 'override' ? reason : undefined,
        reviewedDigests: review.digests,
      });
      announce(
        mode === 'override'
          ? 'Your corrected answer is queued and will be sent now.'
          : 'Your answer is queued and will be sent now.',
      );
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare your answer.');
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <form
      className="editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        if (mode === 'override') setConfirm(true);
        else void submit();
      }}
    >
      {stale && (
        <div className="card warn" role="alert">
          <strong>This question changed while you were answering.</strong>
          <p>Your choice is locked so you do not answer something you have not seen.</p>
          <button type="button" className="btn" onClick={() => setBaseRevision(view.revision)}>
            Review the update
          </button>
        </div>
      )}
      {hasOptions && (
        <fieldset disabled={stale || busy}>
          <legend className="sr-only">Choose an answer</legend>
          <div className="options" role="radiogroup" aria-label="Choose an answer">
            {c.options.map((o) => {
              const on = selected.includes(o.id);
              return (
                <label key={o.id} className={`option ${on ? 'on' : ''}`}>
                  <input
                    type="radio"
                    name={`${gid}-opt`}
                    checked={on}
                    onChange={() => setSelected([o.id])}
                  />
                  <span className="option-body">
                    <span className="option-label">{o.label}</span>
                    {o.description && <SafeText text={o.description} className="option-desc" />}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      {showText && (
        <div className="field">
          <label htmlFor={`${gid}-text`}>
            {hasOptions ? 'Add a note (optional)' : 'Your answer'}
          </label>
          <textarea
            id={`${gid}-text`}
            value={text}
            rows={4}
            maxLength={16000}
            disabled={stale || busy}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              hasOptions ? 'Explain your choice, or give a different answer' : 'Type your answer'
            }
          />
          <VoiceInput value={text} onChange={setText} view={view} disabled={stale || busy} />
        </div>
      )}
      {mode === 'override' && (
        <div className="field">
          <label htmlFor={`${gid}-reason`}>Why are you changing it?</label>
          <textarea
            id={`${gid}-reason`}
            value={reason}
            rows={2}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      )}
      {needsImages && !imagesReady && (
        <p className="note warn" role="status">
          {review.expired > 0
            ? 'An image under review has expired, so this cannot be approved from here.'
            : 'Waiting for the images to load. Approvals are tied to the exact images you reviewed.'}
        </p>
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn primary big" disabled={!canSubmit}>
          {mode === 'override' ? 'Send correction' : approval ? 'Submit decision' : 'Submit answer'}
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Overrule the current answer?"
        confirmLabel="Overrule"
        onCancel={() => setConfirm(false)}
        onConfirm={() => void submit()}
      >
        <p>
          Your agent already received the current answer. Your correction will be sent to it as a
          new message, but anything it already did cannot be undone automatically.
        </p>
      </ConfirmDialog>
    </form>
  );
}
