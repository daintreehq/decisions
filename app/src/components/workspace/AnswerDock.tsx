import { useEffect, useState, type ReactNode } from 'react';
import { clockLabel } from '../../lib/time.js';
import { dictation, type DictState } from '../../features/voice/dictation.js';
import { OrbitRing } from '../../features/voice/OrbitRing.js';
import { MicIcon, QuestionsIcon, StopIcon } from '../Icons.js';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
export const MOD = MAC ? '⌘' : 'Ctrl';

/**
 * The answer dock: a real layout row at the foot of the workspace. Bottom row: All Q&A at the left, the draft
 * field in the centre, Dictate/Stop as a circle at the right that never moves. The summary row (selection, status
 * and Send) appears above it only when there is something to commit, so Send sits directly over Dictate and a
 * double tap on Stop can never send. Anything that grows (the editor, the stepper, the transcript) grows upward.
 */
export function AnswerDock({
  above,
  summary,
  left,
  centre,
  right,
  expanded,
  label = 'Answer',
}: {
  above?: ReactNode;
  summary?: ReactNode;
  left: ReactNode;
  centre?: ReactNode;
  right?: ReactNode;
  expanded?: boolean;
  label?: string;
}) {
  return (
    <section className={`dock${expanded ? ' expanded' : ''}`} aria-label={label}>
      {above}
      {summary && <div className="dock-summary">{summary}</div>}
      <div className="dock-row">
        {left}
        <div className="dock-centre">{centre}</div>
        {right && <div className="dock-right">{right}</div>}
      </div>
    </section>
  );
}

export function AllQaButton({
  waiting,
  recording,
  onClick,
}: {
  waiting: number;
  recording: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`dock-qa${recording ? ' recording' : ''}`}
      onClick={onClick}
      title={`Questions & answers (${MOD}+K)`}
    >
      <span className="dock-qa-icon">
        <QuestionsIcon size={20} />
        {waiting > 0 && !recording && (
          <span className="count waiting">
            <span className="sr-only">, </span>
            {waiting}
            <span className="sr-only"> waiting</span>
          </span>
        )}
      </span>
      <span className="dock-qa-label">{recording ? 'Stop & questions' : 'All Q&A'}</span>
    </button>
  );
}

/**
 * Dictate → Stop in the same place. The glyph is what a tap does. Starting and finishing spin a neutral arc; live
 * capture wears the accent orbit; the words "Recording · 00:24" are always beside it, so the ring is never the only
 * signal.
 */
export function DictateButton({
  dict,
  holdMode,
  onToggle,
  onHoldStart,
  onHoldEnd,
  fieldLabel,
}: {
  dict: DictState;
  holdMode: boolean;
  onToggle: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  fieldLabel: string;
}) {
  const p = dict.phase;
  const open = p === 'starting' || p === 'recording';
  const live = p === 'recording' && dict.micLive;
  const waiting = (open && !live) || p === 'finishing';
  const label =
    p === 'starting'
      ? 'Cancel dictation'
      : p === 'recording'
        ? 'Stop dictation'
        : p === 'finishing'
          ? 'Finishing your words'
          : holdMode
            ? `Hold to dictate ${fieldLabel}`
            : `Dictate ${fieldLabel}`;
  const tip =
    p === 'recording' || p === 'starting'
      ? `Stop (${MOD}+Shift+Space)`
      : p === 'finishing'
        ? 'Finishing your words…'
        : `Dictate (${MOD}+Shift+Space)`;
  const handlers = holdMode
    ? {
        onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
          if (e.button !== 0 || p === 'finishing') return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          onHoldStart();
        },
        onPointerUp: onHoldEnd,
        onPointerCancel: onHoldEnd,
        onLostPointerCapture: onHoldEnd,
        // Keyboard activation toggles.
        onClick: (e: React.MouseEvent) => e.detail === 0 && onToggle(),
      }
    : { onClick: onToggle };
  return (
    <span className={`dictate${open || p === 'finishing' ? ' active' : ''}${live ? ' live' : ''}`}>
      <OrbitRing mode={live ? 'orbit' : waiting ? 'wait' : null} level={() => dictation.level} />
      <button
        type="button"
        className="dictate-btn"
        aria-label={label}
        aria-pressed={open}
        aria-disabled={p === 'finishing' || undefined}
        title={tip}
        {...handlers}
      >
        {open || p === 'finishing' ? <StopIcon size={18} /> : <MicIcon size={24} />}
      </button>
    </span>
  );
}

/** "Recording · 00:24", ticking once a second from the moment capture began. */
export function RecordingClock({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [since]);
  return <span className="tabular">{clockLabel(since == null ? 0 : now - since)}</span>;
}

/** The live passage while recording: the end of the locked words, then the words still being recognised. */
export function LiveTranscript({ final, interim }: { final: string; interim: string }) {
  if (!final && !interim) return <span className="dock-hint">Listening…</span>;
  // The newest words matter while speaking: show the end of the passage, never its start.
  const room = Math.max(20, 44 - interim.length);
  const cut = final.length > room ? final.slice(-room) : final;
  const tail = cut === final ? final : '…' + cut.replace(/^\S*\s/, '');
  return (
    <span className="live-text" aria-hidden="true">
      {tail}
      {interim && (
        <>
          {tail ? ' ' : ''}
          <span className="interim">{interim}</span>
        </>
      )}
    </span>
  );
}
