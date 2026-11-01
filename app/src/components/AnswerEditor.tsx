import { useEffect, useId, useRef, useState } from 'react';
import { app } from '../app/controller.js';
import type { ActionView, QuestionView } from '../domain/model.js';
import { announce } from '../lib/announce.js';
import { submitKind } from '../domain/selectors.js';
import { VoiceInput } from '../features/voice/VoiceInput.js';
import { ConfirmDialog } from './Dialog.js';
import type { ReviewState } from './AttachmentGallery.js';
import { SafeText } from './SafeText.js';
import { previewText } from '../lib/safe-text.js';

export interface EditorProps {
  view: QuestionView;
  mode: 'answer' | 'override';
  review: ReviewState;
  /** Prefill (e.g. after a conflict, the text the human had typed). */
  initial?: { selected: string[]; text: string };
  /** The answer in force, when correcting it. */
  current?: ActionView | null;
  onDone?: () => void;
  onCancel?: () => void;
}

/**
 * Option + text answer form. Choices are single-select and need an explicit Submit. The form is bound to the
 * revision it was opened on: if the question changes underneath it, choices lock until the human refreshes.
 */
export function AnswerEditor({
  view,
  mode,
  review,
  initial,
  current,
  onDone,
  onCancel,
}: EditorProps) {
  const c = view.content!;
  const [selected, setSelected] = useState<string[]>(initial?.selected ?? []);
  const [text, setText] = useState(initial?.text ?? '');
  const [reason, setReason] = useState('');
  const [baseRevision, setBaseRevision] = useState(view.revision);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const gid = useId();
  const stale = view.revision !== baseRevision;
  const hasOptions = c.options.length > 0 && c.kind !== 'text';
  const textOnly = !hasOptions;
  // A correction to a choice is a different choice plus the reason; a separate note box would compete with it.
  const showText = mode === 'override' ? textOnly || c.kind === 'mixed' : c.allow_text || textOnly;
  const approval = c.kind === 'approval';
  const currentContent = current?.content as {
    selected_option_ids?: string[];
    text?: string;
  } | null;
  const currentSel = currentContent?.selected_option_ids;
  const currentText = currentContent?.text?.trim() ?? '';
  const mixed = c.kind === 'mixed';
  const optionLabel = (id: string) => c.options.find((o) => o.id === id)?.label ?? id;
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

  // Correcting a choice to the same choice changes nothing; ask for a different one.
  const sameAsCurrent =
    mode === 'override' &&
    hasOptions &&
    !!currentSel &&
    selected.length > 0 &&
    selected.join() === currentSel.join() &&
    !text.trim();
  const hasAnswer = hasOptions
    ? selected.length > 0 || (c.kind === 'mixed' && text.trim().length > 0)
    : text.trim().length > 0;
  const reasonOk = mode === 'answer' || reason.trim().length > 0;
  const canSubmit = !busy && !stale && hasAnswer && !sameAsCurrent && reasonOk && imagesReady;
  const hint = stale
    ? null
    : !hasAnswer
      ? mixed
        ? 'Choose an option or write an answer to continue.'
        : hasOptions
          ? 'Choose an option to continue.'
          : 'Type your answer to continue.'
      : sameAsCurrent
        ? 'Choose a different answer to send a correction.'
        : !reasonOk
          ? 'Say why you are changing it to continue.'
          : !imagesReady
            ? 'Waiting for the images, so you approve exactly what you saw.'
            : null;

  // Opening a correction moves you to it, so tapping "Overrule…" never looks like it did nothing.
  useEffect(() => {
    if (mode !== 'override') return;
    const f = formRef.current;
    if (!f) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    f.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    f.querySelector<HTMLElement>('input, textarea')?.focus({ preventScroll: true });
  }, [mode]);

  // A confirmation for a revision that is no longer current must not stay armed.
  useEffect(() => {
    if (confirm && stale) setConfirm(false);
  }, [confirm, stale]);

  const submit = async () => {
    // Re-check at the moment of sending (not just when the button was enabled): the dialog can sit open while
    // another device commits a newer revision.
    if (busy) return;
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
      const what = mode === 'override' ? 'Your corrected answer' : 'Your answer';
      announce(
        navigator.onLine
          ? `${what} is saved and is being sent.`
          : `${what} is saved on this phone and will be sent when you are back online.`,
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
      ref={formRef}
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
          <button
            type="button"
            className="btn"
            onClick={() => {
              // The choice was made against the old wording: start the choice again, keep any prose.
              setSelected([]);
              setBaseRevision(view.revision);
            }}
          >
            Review the update
          </button>
        </div>
      )}
      {hasOptions && (
        <fieldset disabled={stale || busy}>
          <legend className="sr-only">
            {mode === 'override' ? 'Choose the corrected answer' : 'Choose an answer'}
          </legend>
          {mixed && selected.length > 0 && (
            <button type="button" className="link-btn" onClick={() => setSelected([])}>
              Clear my choice, I will write my answer instead
            </button>
          )}
          <div className="options">
            {c.options.map((o) => {
              const on = selected.includes(o.id);
              const isCurrent = mode === 'override' && !!currentSel?.includes(o.id);
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
                    {isCurrent && <span className="muted"> · current answer</span>}
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
            {mixed ? (
              <>
                Your answer or a note <span className="req-mark">(optional with a choice)</span>
              </>
            ) : hasOptions ? (
              <>
                Add a note <span className="req-mark">(optional)</span>
              </>
            ) : (
              'Your answer'
            )}
          </label>
          <textarea
            id={`${gid}-text`}
            value={text}
            rows={4}
            maxLength={16000}
            disabled={stale || busy}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              c.kind === 'mixed'
                ? 'Explain your choice, or give a different answer'
                : hasOptions
                  ? 'Anything the agent should know about your choice'
                  : 'Type your answer'
            }
          />
          <VoiceInput value={text} onChange={setText} view={view} disabled={stale || busy} />
        </div>
      )}
      {mode === 'override' && (
        <div className="field">
          <label htmlFor={`${gid}-reason`}>
            Why are you changing it? <span className="req-mark">(required)</span>
          </label>
          <textarea
            id={`${gid}-reason`}
            value={reason}
            rows={2}
            maxLength={2000}
            required
            aria-required="true"
            placeholder="Your agent sees this with the correction"
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      )}
      {needsImages && !imagesReady && (review.expired > 0 || review.failed > 0) && (
        <p className="note warn" role="status">
          {review.expired > 0
            ? 'An image under review has expired, so this cannot be approved from here.'
            : 'An image could not be loaded or verified, so this cannot be approved yet. Try it again above.'}
        </p>
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
      <div className="actions-bar">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="btn primary big"
          disabled={!canSubmit}
          aria-describedby={hint ? `${gid}-hint` : undefined}
        >
          {mode === 'override' ? 'Send correction' : approval ? 'Submit decision' : 'Submit answer'}
        </button>
        <p className="hint" id={`${gid}-hint`} aria-live="polite">
          {hint ?? ''}
        </p>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Send this correction?"
        confirmLabel={busy ? 'Sending…' : 'Send correction'}
        confirmDisabled={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void submit()}
      >
        {!!(currentSel?.length || selected.length || currentText || text.trim()) && (
          <div className="change-summary">
            {!!(currentSel?.length || currentText) && (
              <div>
                <span className="muted">From </span>
                {currentSel && currentSel.length > 0 && (
                  <strong>{currentSel.map(optionLabel).join(', ')}</strong>
                )}
                {currentText && (
                  <SafeText text={previewText(currentText, 240)} className="inline" />
                )}
              </div>
            )}
            <div>
              <span className="muted">To </span>
              {selected.length > 0 && <strong>{selected.map(optionLabel).join(', ')}</strong>}
              {showText && text.trim() && (
                <SafeText text={previewText(text.trim(), 240)} className="inline" />
              )}
            </div>
          </div>
        )}
        <p>
          Your agent may already have acted on the current answer. The correction reaches it as a
          new message; anything it already did is not undone automatically.
        </p>
      </ConfirmDialog>
    </form>
  );
}
