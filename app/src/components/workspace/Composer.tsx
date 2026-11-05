import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ComposeShape, ComposeVerdict, FieldId } from '../../domain/compose.js';
import { drafts, fieldValue, type DraftModel } from '../../features/compose/draftStore.js';
import { resolveSpan, type SpanChoice } from '../../features/voice/correction.js';
import {
  dictation,
  type DictPhase,
  type DictState,
  type Review,
  type Unsure,
} from '../../features/voice/dictation.js';
import { OrbitRing } from '../../features/voice/OrbitRing.js';
import { useMicPermission } from '../../features/voice/permission.js';
import { announce } from '../../lib/announce.js';
import { clockLabel } from '../../lib/time.js';
import { ArrowUp, CheckIcon, CloseIcon, MicIcon, StopIcon, UndoIcon } from '../Icons.js';
import { AttachButton, imageFiles, PhotoTray, type ComposerPhotosProps } from './ComposerPhotos.js';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
export const MOD = MAC ? '⌘' : 'Ctrl';

/** A press released sooner than this is a tap; held longer, it is push-to-talk and letting go stops. */
export const HOLD_MS = 250;
/** After the last touch on the mic, Send waits this long before a tap can reach it. */
export const SEND_QUIET_MS = 750;

const now = () => Date.now();
/** Keeps a press's events on its target even when the finger drifts off it (a synthetic event has no pointer). */
const capture = (e: ReactPointerEvent<HTMLElement>) => {
  try {
    e.currentTarget.setPointerCapture?.(e.pointerId);
  } catch {
    /* no such pointer */
  }
};
/** Measures a line of the field's text without laying it out. */
let measureCanvas: HTMLCanvasElement | null = null;
const isCapture = (p: DictPhase) => p === 'starting' || p === 'recording' || p === 'finishing';

export interface ComposerProps {
  shape: ComposeShape;
  draft: DraftModel;
  verdict: ComposeVerdict;
  field: FieldId;
  /** The field's programmatic name: "Answer", "Note", "Corrected answer", "Reason". */
  fieldLabel: string;
  /** How the mic names what it fills: "answer", "note", "reason". */
  fieldNoun: string;
  placeholder: string;
  /** Shown while the field has focus (holding is a gesture for the empty, resting field). */
  focusedPlaceholder: string;
  /** Two text fields (a text correction): a switch above the pill. */
  fieldTabs: { id: FieldId; label: string }[] | null;
  /** A visible name above the pill when the field is not the obvious one (a correction's reason). */
  caption: string | null;
  /** Send's words when they differ from the shape's. */
  sendLabel?: string;
  /** Send's full name for assistive tech and its tooltip, when the visible words are shorter ("Send follow-up"). */
  sendName?: string;
  /** A quiet row just above the pill where choices would sit: moving on, once an answer is on its way. */
  above?: ReactNode;
  /** Dictation state when it belongs to this draft; null otherwise. */
  dict: DictState | null;
  /** Dictation is set up and online here, so holding can start it. */
  voice: boolean;
  stale: boolean;
  error: string | null;
  sending: boolean;
  /** The options to pick from in the composer (answer mode), or null. */
  options: { id: string; label: string }[] | null;
  optionsLabel: string;
  /** The answer in force, marked on its chip when correcting it. */
  currentOptions?: readonly string[];
  selected: readonly string[];
  disabled: boolean;
  canUseOriginal: boolean;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  onSelect: (id: string) => void;
  onClearChoice: (() => void) | null;
  onSend: () => void;
  onReviewUpdate: () => void;
  onShowRemaining: () => void;
  onDismissError: () => void;
  onField: (f: FieldId) => void;
  onDictate: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  /** Photos for this draft when the question can take them; null leaves `+` out entirely. */
  photos: ComposerPhotosProps | null;
}

/**
 * A compact message bar, expanding only when the words wrap, photos arrive, or a notice needs room.
 * Capture freezes the Send slot and arms it only after the hand leaves Stop.
 */
export function Composer(p: ComposerProps) {
  const canHold = useMicPermission() === 'granted';
  const { shape, draft, verdict, dict, field } = p;
  const phase: DictPhase = dict?.phase ?? 'idle';
  const capturing = isCapture(phase);
  const value = fieldValue(draft, field);
  const [focused, setFocused] = useState(false);
  const [multiline, setMultiline] = useState(false);
  useEffect(() => {
    if (!value) setMultiline(false);
  }, [value]);
  const [reviewing, setReviewing] = useState(false);
  const quietUntil = useRef(0);
  // The hand-off is visible: Send reads as not ready (and is) until the quiet period after the mic has passed.
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quiet = () => {
    quietUntil.current = now() + SEND_QUIET_MS;
    setSettling(true);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => setSettling(false), SEND_QUIET_MS);
  };
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  // Send keeps the place it had when capture began: the Stop under the finger never moves, and Send never appears
  // beside it mid-passage.
  const wantSend = verdict.hasContent;
  const frozen = useRef<boolean | null>(null);
  if (capturing && frozen.current === null) frozen.current = wantSend;
  if (!capturing) frozen.current = null;
  const sendSlot = capturing ? frozen.current! : wantSend;
  // Capture settling is a hand-off moment too: whatever tap is still in flight lands on nothing. (What the words came
  // to is announced by the controller, which knows whether any were kept.)
  const lastPhase = useRef(phase);
  useEffect(() => {
    const was = lastPhase.current;
    lastPhase.current = phase;
    if (isCapture(was) && !capturing) quiet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  // Failures and interruptions are spoken once, when they happen; the clock and interim words never are.
  // An error's lane is an alert, which speaks for itself.
  const message = dict?.message && dict.message.tone !== 'error' ? dict.message.text : null;
  useEffect(() => {
    if (message) announce(message);
  }, [message]);

  const textless = shape.fields.length === 0;
  const photos = p.photos;
  const hasPhotos = !!photos?.list.length;
  // Send's one reason it can't send yet owns the action row's slot; otherwise "Use original wording" sits there,
  // from the moment the tidy-up starts until the passage is edited, so it never needs a row of its own.
  const hintShown = verdict.hasContent && !!verdict.hint && !p.stale && !p.error;
  const originalInSlot = p.canUseOriginal && !hintShown && !capturing;
  // The microphone starting into an empty answer keeps the compact bar: the field's placeholder says so, and Stop is
  // where the mic was. The pill opens when there is something to show (the clock and the words).
  const startingEmpty =
    !!dict &&
    (phase === 'starting' || (phase === 'recording' && !dict.micLive)) &&
    !dict.permission &&
    !dict.micSilent &&
    !dict.escArmed &&
    !value;
  // Focus alone never enlarges the input. Once typed text wraps, keep the wider writing surface until it is cleared
  // (a replacement that isn't typing, such as a tidy-up, measures again).
  const two =
    textless ||
    multiline ||
    hasPhotos ||
    (capturing && !startingEmpty) ||
    originalInSlot ||
    (verdict.hasContent && !!verdict.hint);
  const [dropping, setDropping] = useState(false);
  const takesDrop = !!photos && !p.disabled && !p.stale;
  const dropped = (list: FileList | null | undefined) => {
    const files = imageFiles(list);
    if (!photos || !files.length) return false;
    if (photos.room <= 0) photos.onFull();
    else photos.onAdd(files);
    return true;
  };

  const unsure =
    dict?.unsure &&
    dict.unsure.key === draft.key &&
    fieldValue(draft, dict.unsure.field) === dict.unsure.text
      ? dict.unsure
      : null;
  useEffect(() => {
    if (!unsure) setReviewing(false);
  }, [unsure]);

  // The tidy-up's changed words, underlined on the answer itself for a few seconds; a caret placed in one says what
  // was heard there.
  const review = dict?.review && reviewApplies(dict.review, draft) ? dict.review : null;
  const marks = review && review.field === field ? review.marks : null;
  const caret = draft.caret;
  const heard =
    review && caret && caret.field === review.field && caret.start === caret.end
      ? (review.marks.find((m) => caret.start >= m.from && caret.start < m.to) ?? null)
      : null;

  // The microphone's own states and the heard word are spoken once, when they change (the lane rows that show them
  // mount with their words already in, which screen readers often skip).
  const micNotice = dict?.permission
    ? 'Allow microphone access to continue'
    : dict?.micSilent
      ? 'No sound from your microphone'
      : phase === 'starting'
        ? 'Starting microphone…'
        : null;
  useEffect(() => {
    if (micNotice) announce(micNotice);
  }, [micNotice]);
  const heardText = heard
    ? heard.heard
      ? `Heard “${heard.heard}”`
      : 'Added by the tidy-up'
    : null;
  useEffect(() => {
    if (heardText) announce(heardText);
  }, [heardText]);

  const lane = Lane({
    ...p,
    // While the word check is open above the pill, its own chip would only repeat it.
    unsure: reviewing ? null : unsure,
    originalInSlot,
    heard: heardText,
    // The word check takes focus itself (its choices come first), and the word is marked on the answer, so the
    // keyboard stays down.
    onReviewWords: () => {
      if (!unsure) return;
      p.onField(unsure.field);
      setReviewing(true);
    },
  });
  // While checking, the word in question is marked on the answer itself.
  const checking =
    reviewing && unsure && unsure.field === field && unsure.spans[0]
      ? [{ from: unsure.spans[0].start, to: unsure.spans[0].end, kind: 'check' as const }]
      : null;

  const note = capturing ? null : sendNote(p, originalInSlot);

  return (
    <div className="composer" data-rows={two ? 'two' : 'one'}>
      {p.above && <div className="composer-above">{p.above}</div>}
      {p.options && (
        <ChoiceChips
          options={p.options}
          selected={p.selected}
          current={p.currentOptions}
          label={p.optionsLabel}
          disabled={p.disabled || p.stale}
          onSelect={p.onSelect}
          onClear={p.onClearChoice}
        />
      )}
      {p.fieldTabs ? (
        <div className="seg composer-tabs" role="tablist" aria-label="Field">
          {p.fieldTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === field}
              tabIndex={t.id === field ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                const tabs = p.fieldTabs!;
                const at = tabs.findIndex((x) => x.id === t.id);
                const next =
                  tabs[(at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!;
                const buttons =
                  e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  );
                buttons?.[tabs.indexOf(next)]?.focus();
                buttons?.[tabs.indexOf(next)]?.click();
              }}
              onClick={() => {
                if (t.id === field) return;
                // Switching fields while dictating stops first, so words never land in the other field.
                if (dictation.isActive()) void dictation.stop();
                p.onField(t.id);
                setTimeout(() => p.fieldRef.current?.focus({ preventScroll: true }), 0);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : (
        p.caption && <p className="composer-caption">{p.caption}</p>
      )}
      {reviewing && unsure && (
        <UnsureReview
          draft={draft}
          unsure={unsure}
          textarea={p.fieldRef}
          onClose={() => setReviewing(false)}
        />
      )}
      <div
        className={`composer-pill${two ? ' two' : ''}${capturing ? ' capturing' : ''}${
          photos ? ' has-add' : ''
        }${dropping ? ' dropping' : ''}`}
        onDragOver={(e) => {
          if (!takesDrop || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={(e) => {
          setDropping(false);
          if (!takesDrop) return;
          if (dropped(e.dataTransfer.files)) e.preventDefault();
        }}
      >
        {lane && <div className="composer-lane">{lane}</div>}
        {photos && hasPhotos && (
          <div className="composer-tray-row">
            <PhotoTray photos={photos} />
          </div>
        )}
        {!textless && (
          <Field
            {...p}
            canHold={canHold}
            value={value}
            capturing={capturing}
            focused={focused}
            setFocused={setFocused}
            onContact={quiet}
            onPastePhotos={takesDrop ? dropped : undefined}
            open={two}
            multiline={multiline}
            onMultiline={setMultiline}
            marks={checking ?? marks}
          />
        )}
        {photos && (
          <div className="composer-add-slot">
            <AttachButton photos={photos} />
          </div>
        )}
        <div className="composer-actions">
          {(two || !!verdict.hint) && (
            <span className={two ? 'composer-note' : 'sr-only'} id="ws-send-hint">
              {note}
            </span>
          )}
          <span className="composer-buttons">
            {!textless && (
              <DictateButton
                dict={dict ?? IDLE_DICT}
                fieldLabel={p.fieldNoun}
                canHold={canHold}
                onToggle={p.onDictate}
                onHoldStart={p.onHoldStart}
                onHoldEnd={p.onHoldEnd}
                onContact={quiet}
              />
            )}
            {sendSlot && (
              <SendButton
                label={p.sendLabel ?? shape.sendLabel}
                name={p.sendName}
                ready={verdict.canSend && !p.sending && !capturing && !settling}
                sending={p.sending}
                describedBy={verdict.hint && two ? 'ws-send-hint' : undefined}
                quietUntil={quietUntil}
                onSend={p.onSend}
              />
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

const IDLE_DICT: DictState = {
  phase: 'idle',
  binding: null,
  micLive: false,
  micSilent: false,
  permission: false,
  startedAt: null,
  final: '',
  interim: '',
  capWarning: false,
  message: null,
  review: null,
  unsure: null,
  escArmed: false,
};

/* ---------- the field ---------- */

function Field(
  p: ComposerProps & {
    value: string;
    canHold: boolean;
    capturing: boolean;
    focused: boolean;
    setFocused: (v: boolean) => void;
    onContact: () => void;
    /** A paste that carries photos adds them (true when it did). */
    onPastePhotos?: (files: FileList) => boolean;
    /** The pill is open into two rows; the field measures itself again when it changes. */
    open: boolean;
    /** The words have wrapped at the compact width (what keeps the pill open while typing). */
    multiline: boolean;
    onMultiline: (value: boolean) => void;
    /** The tidy-up's changed words, in this field's offsets, while they are underlined. */
    marks: readonly { from: number; to: number; kind?: 'check' }[] | null;
  },
) {
  const { draft, field, dict, fieldRef: ref, value } = p;
  const phase = dict?.phase ?? 'idle';
  const liveMic = phase === 'recording' && !!dict?.micLive;
  const interim = p.capturing ? (dict?.interim ?? '').trim() : '';
  const hold = useHold({
    onHoldStart: p.onHoldStart,
    onHoldEnd: p.onHoldEnd,
    onTap: () => ref.current?.focus(),
    onContact: p.onContact,
  });
  // Holding is offered on the resting, empty field only: once the caret is in it, the platform's own text handling
  // (caret, selection, paste, the magnifier) owns every press.
  const holdable =
    p.voice &&
    p.canHold &&
    !p.stale &&
    !p.disabled &&
    !value &&
    !p.focused &&
    (phase === 'idle' || phase === 'cleaning');

  // What the person typed last: any other change of value (dictated words, a tidy-up, Use original wording, Undo) is
  // a replacement, after which the pill measures the words at the compact width again instead of staying open.
  const typed = useRef<string | null>(null);
  const seen = useRef(value);
  // The text width the compact bar gives the words, from its last measure: deleting back to a short answer that fits
  // it closes the pill again, measured at that width so the open pill's wider field can't keep it open.
  const compactWidth = useRef(0);

  // Grow with the text; the cap (about five lines, less with the keyboard up) is in CSS, and beyond it the field
  // scrolls. While words are arriving, keep the newest of them in view.
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    if (value !== seen.current) {
      const shorter = value.length < seen.current.length;
      seen.current = value;
      // Before paint: the closed pill measures on the next pass and opens again at once if the words still wrap.
      if (p.open && p.multiline && (value !== typed.current || (shorter && fitsCompact(t, value))))
        p.onMultiline(false);
    }
    const measure = () => {
      t.style.height = 'auto';
      const style = getComputedStyle(t);
      const line =
        parseFloat(style.lineHeight) +
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom);
      if (!p.open) {
        compactWidth.current =
          t.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (value && t.scrollHeight > line + 2) p.onMultiline(true);
      }
      t.style.height = `${t.scrollHeight}px`;
      if (p.capturing) t.scrollTop = t.scrollHeight;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    let width = t.clientWidth;
    const observer = new ResizeObserver(() => {
      if (t.clientWidth === width) return;
      width = t.clientWidth;
      measure();
    });
    observer.observe(t);
    return () => observer.disconnect();
  }, [value, p.capturing, interim, ref, p.open, p.multiline, p.onMultiline]);

  // The changed words' underline is drawn by a copy of the text laid exactly under the field's own (transparent, and
  // never in the way of the caret, selection or scrolling).
  const mirror = useRef<HTMLDivElement>(null);
  const marks = p.marks?.length ? p.marks : null;
  useLayoutEffect(() => {
    const t = ref.current;
    const m = mirror.current;
    if (!t || !m) return;
    const sync = () => {
      const cs = getComputedStyle(t);
      // Only a scrolled field clips: unscrolled, the wave may hang into the field's bottom margin like any underline.
      const scrolled = t.scrollHeight > t.clientHeight + 1;
      Object.assign(m.style, {
        top: `${t.offsetTop}px`,
        left: `${t.offsetLeft}px`,
        width: `${t.clientWidth}px`,
        height: `${t.clientHeight}px`,
        padding: cs.padding,
        overflow: scrolled ? 'hidden' : 'visible',
      });
      m.scrollTop = t.scrollTop;
    };
    // A word being checked is brought into view in a long, scrolled answer (the field scrolls; focus stays put).
    const checked = m.querySelector<HTMLElement>('.composer-mark.is-check');
    if (checked) {
      const top = checked.offsetTop - parseFloat(getComputedStyle(t).paddingTop);
      if (top < t.scrollTop || top + checked.offsetHeight > t.scrollTop + t.clientHeight)
        t.scrollTop = Math.max(0, top - (t.clientHeight - checked.offsetHeight) / 2);
    }
    sync();
    t.addEventListener('scroll', sync);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    observer?.observe(t);
    return () => {
      t.removeEventListener('scroll', sync);
      observer?.disconnect();
    };
  }, [marks, value, p.open, ref]);

  function fitsCompact(t: HTMLTextAreaElement, text: string): boolean {
    if (!compactWidth.current || text.includes('\n')) return false;
    const ctx = (measureCanvas ??= document.createElement('canvas')).getContext('2d');
    if (!ctx) return false;
    ctx.font = getComputedStyle(t).font;
    // A few px of slack, so an answer right at the edge doesn't flip between the two forms as it is edited.
    return ctx.measureText(text).width <= compactWidth.current - 6;
  }

  const caret = () => {
    const t = ref.current;
    if (t) drafts.setCaret(draft.key, { field, start: t.selectionStart, end: t.selectionEnd });
  };

  return (
    <div className={`composer-field${hold.holding ? ' holding' : ''}`}>
      {marks && (
        <div className="composer-marks" ref={mirror} aria-hidden="true">
          {withMarks(value, marks)}
        </div>
      )}
      <textarea
        id="ws-field"
        ref={ref}
        className="composer-input"
        rows={1}
        value={value}
        aria-label={p.fieldLabel}
        aria-describedby={p.verdict.hint ? 'ws-send-hint' : undefined}
        // While the microphone starts, the empty field says so (a row of its own would only hold those words);
        // once it is live it promises the words.
        placeholder={
          p.capturing
            ? liveMic
              ? 'Listening…'
              : (phase === 'starting' || phase === 'recording') &&
                  !dict?.permission &&
                  !dict?.micSilent
                ? 'Starting microphone…'
                : ''
            : p.focused
              ? p.focusedPlaceholder
              : p.placeholder
        }
        readOnly={p.disabled}
        enterKeyHint="enter"
        onFocus={() => p.setFocused(true)}
        onChange={(e) => {
          typed.current = e.target.value;
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
        onPaste={(e) => {
          const files = e.clipboardData?.files;
          if (!files?.length || !p.onPastePhotos?.(files)) return;
          // Photos only: the text that sometimes rides along (a copied image's name) is not wanted in the answer.
          if (!e.clipboardData.getData('text/plain').trim()) e.preventDefault();
        }}
        onBlur={() => {
          p.setFocused(false);
          void drafts.flush(draft.key).catch(() => undefined);
        }}
        onKeyDown={(e) => {
          // Escape puts the keyboard away (a running dictation keeps Escape for its own discard).
          if (e.key === 'Escape' && !dictation.isActive()) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        title={`${MOD}+Enter sends`}
      />
      {interim && (
        // At most two lines, always showing the newest words (overflow is clipped at the top).
        <div className="composer-interim" aria-hidden="true">
          <span>{interim}</span>
        </div>
      )}
      {(holdable || hold.holding) && (
        <span className="composer-hold" aria-hidden="true" {...hold.handlers} />
      )}
    </div>
  );
}

/** The text with its marked runs wrapped, ending in a zero-width space so a trailing newline keeps its line. */
function withMarks(
  text: string,
  marks: readonly { from: number; to: number; kind?: 'check' }[],
): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  marks.forEach((m, k) => {
    if (m.from > at) out.push(text.slice(at, m.from));
    out.push(
      <span key={k} className={`composer-mark${m.kind === 'check' ? ' is-check' : ''}`}>
        {text.slice(m.from, m.to)}
      </span>,
    );
    at = Math.max(at, m.to);
  });
  out.push(text.slice(at) + '\u200b');
  return out;
}

/**
 * Press and hold to talk, on a surface that is not editable text (a long press on a native field belongs to the
 * platform: caret, callout, magnifier). Short presses are taps; holding past HOLD_MS starts dictation, and letting
 * go, cancelling or losing the pointer stops it. Release never sends.
 */
function useHold(o: {
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onTap: () => void;
  onContact: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const held = useRef(false);
  const swallowClick = useRef(false);
  const latest = useRef(o);
  latest.current = o;
  useEffect(
    () => () => {
      if (press.current) clearTimeout(press.current.timer);
    },
    [],
  );
  const finish = (cancel: boolean) => {
    const pr = press.current;
    if (pr) clearTimeout(pr.timer);
    press.current = null;
    if (held.current) {
      held.current = false;
      setHolding(false);
      swallowClick.current = true;
      latest.current.onContact();
      latest.current.onHoldEnd();
    } else if (cancel) swallowClick.current = true;
  };
  const handlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      capture(e);
      swallowClick.current = false;
      const timer = setTimeout(() => {
        if (!press.current) return;
        held.current = true;
        setHolding(true);
        latest.current.onContact();
        latest.current.onHoldStart();
      }, HOLD_MS);
      press.current = { x: e.clientX, y: e.clientY, timer };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const pr = press.current;
      // A drift before the hold starts is not a press on the field.
      if (pr && !held.current && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 10) finish(true);
    },
    onPointerUp: () => finish(false),
    onPointerCancel: () => finish(true),
    onLostPointerCapture: () => {
      if (press.current || held.current) finish(true);
    },
    onClick: () => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      latest.current.onTap();
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
  return { holding, handlers };
}

/* ---------- the mic ---------- */

/**
 * The mic, at the pill's right edge (or just left of Send). Tap it to start and tap again to stop; hold it to talk
 * and let go to stop. The glyph is what a press does now: the mic, or Stop while capture runs. Starting and finishing
 * spin the neutral wait arc; live capture wears the accent orbit, and "Recording · 00:24" is in words beside it.
 * Enter and Space toggle, untimed.
 */
export function DictateButton({
  dict,
  fieldLabel,
  onToggle,
  onHoldStart,
  onHoldEnd,
  onContact,
  canHold = false,
}: {
  dict: DictState;
  fieldLabel: string;
  onToggle: () => void;
  onHoldStart?: () => void;
  onHoldEnd: () => void;
  onContact?: () => void;
  /** A hold must never open a permission prompt underneath a finger that still needs to release. */
  canHold?: boolean;
}) {
  const p = dict.phase;
  const open = p === 'starting' || p === 'recording';
  const live = p === 'recording' && dict.micLive;
  const waiting = (open && !live) || p === 'finishing';
  const press = useRef<{ held: boolean; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const latest = useRef({ onToggle, onHoldStart, onHoldEnd, canHold, open });
  latest.current = { onToggle, onHoldStart, onHoldEnd, canHold, open };
  useEffect(
    () => () => {
      if (press.current?.timer) clearTimeout(press.current.timer);
    },
    [],
  );
  const label =
    p === 'starting'
      ? 'Cancel dictation'
      : p === 'recording'
        ? 'Stop dictation'
        : p === 'finishing'
          ? 'Finishing your words'
          : `Dictate ${fieldLabel}`;
  const tip =
    p === 'recording' || p === 'starting'
      ? `Stop (${MOD}+Shift+Space)`
      : p === 'finishing'
        ? 'Finishing your words…'
        : canHold
          ? `Tap to dictate, or hold to talk (${MOD}+Shift+Space)`
          : `Tap to dictate (${MOD}+Shift+Space)`;
  const end = (cancelled: boolean) => {
    const pr = press.current;
    press.current = null;
    if (!pr) return;
    if (pr.timer) clearTimeout(pr.timer);
    onContact?.();
    if (pr.held) latest.current.onHoldEnd();
    else if (!cancelled) latest.current.onToggle();
  };
  return (
    <span className={`dictate${open || p === 'finishing' ? ' active' : ''}${live ? ' live' : ''}`}>
      <OrbitRing mode={live ? 'orbit' : waiting ? 'wait' : null} level={() => dictation.level} />
      <button
        type="button"
        className="dictate-btn"
        aria-label={label}
        aria-disabled={p === 'finishing' || undefined}
        title={tip}
        onPointerDown={(e) => {
          if (e.button !== 0 || p === 'finishing') return;
          capture(e);
          onContact?.();
          // A tap starts on release, after the original pointer is finished. Permission prompts cannot cancel it.
          // Only a known grant enables push-to-talk; otherwise even a long press is a tap to request access.
          const pr = { held: false, timer: null as ReturnType<typeof setTimeout> | null };
          press.current = pr;
          if (!open && canHold)
            pr.timer = setTimeout(() => {
              if (press.current !== pr || !latest.current.canHold || latest.current.open) return;
              pr.held = true;
              (latest.current.onHoldStart ?? latest.current.onToggle)();
            }, HOLD_MS);
        }}
        onPointerUp={() => end(false)}
        onPointerCancel={() => end(true)}
        onLostPointerCapture={() => end(true)}
        onContextMenu={(e) => e.preventDefault()}
        // Pointer presses are handled above; a keyboard activation (detail 0) toggles.
        onClick={(e) => {
          if (e.detail === 0 && p !== 'finishing') onToggle();
        }}
      >
        {open || p === 'finishing' ? <StopIcon size={18} /> : <MicIcon size={22} />}
      </button>
    </span>
  );
}

/* ---------- Send ---------- */

function SendButton({
  label,
  name,
  ready,
  sending,
  describedBy,
  quietUntil,
  onSend,
}: {
  label: string;
  /** The full name when `label` is a shortened form of it (the visible words stay inside it). */
  name?: string;
  ready: boolean;
  sending: boolean;
  describedBy?: string;
  quietUntil: RefObject<number>;
  onSend: () => void;
}) {
  // A pointer activation counts only if it began on an armed Send: never the tail of a tap or hold on the mic.
  const armed = useRef(false);
  // An up arrow on a contrast circle, in the mic's footprint: the words ("Send answer", "Send decision"…) are its
  // name, for assistive tech and in its tooltip, so the glyph never has to carry the meaning alone.
  const full = name ?? label;
  return (
    <button
      type="button"
      className="btn primary composer-send"
      aria-disabled={!ready || undefined}
      aria-describedby={describedBy}
      aria-label={sending ? 'Sending…' : full}
      title={`${full} (${MOD}+Enter)`}
      // Armed only if it was ready when the press began: a press that starts on a not-ready Send never becomes a send.
      onPointerDown={() => (armed.current = ready && now() >= (quietUntil.current ?? 0))}
      onClick={(e) => {
        const pointer = e.detail > 0;
        const ok = !pointer || armed.current;
        armed.current = false;
        if (ok && ready) onSend();
      }}
    >
      {sending ? <span className="spinner small" aria-hidden="true" /> : <ArrowUp size={22} />}
    </button>
  );
}

/**
 * Use original wording leaves with its own press, so a keyboard activation hands focus back to the field it acted on
 * (a tap doesn't, which would raise the phone's keyboard).
 */
function revertTidy(
  e: React.MouseEvent<HTMLButtonElement>,
  key: string,
  field: RefObject<HTMLTextAreaElement | null>,
) {
  const keyboard = e.detail === 0;
  dictation.useOriginal(key);
  if (keyboard) setTimeout(() => field.current?.focus({ preventScroll: true }), 0);
}

/**
 * The slot beside Send, one thing at a time: the one reason it can't send yet, else Use original wording (from the
 * tidy-up starting until the passage is edited), else the quiet word on the draft (restored, saving, saved).
 */
function sendNote(p: ComposerProps, original: boolean): ReactNode {
  const { verdict, draft } = p;
  if (p.stale || p.error) return null;
  if (verdict.hasContent && verdict.hint) {
    if (verdict.remainingFiles > 0)
      return (
        <button type="button" className="note-action" onClick={p.onShowRemaining}>
          {verdict.hint}
        </button>
      );
    return verdict.hint;
  }
  if (original)
    return (
      <button
        type="button"
        className="composer-action"
        onClick={(e) => revertTidy(e, draft.key, p.fieldRef)}
      >
        <UndoIcon size={14} />
        Use original wording
      </button>
    );
  if (!verdict.hasContent || draft.save === 'error' || p.dict?.phase === 'cleaning') return null;
  if (draft.notice === 'restored') return 'Draft restored';
  if (draft.save === 'saving') return 'Saving…';
  if (draft.save === 'saved') return 'Saved on this device';
  return null;
}

/* ---------- the lane: dictation, errors and notices ---------- */

function Lane(
  i: ComposerProps & {
    unsure: Unsure | null;
    /** Use original wording is in the action row's slot, not here. */
    originalInSlot: boolean;
    /** What was heard at the changed word the caret is in, during the few seconds the changes are underlined. */
    heard: string | null;
    onReviewWords: () => void;
  },
): ReactNode {
  const { dict, draft } = i;
  const p = dict?.phase ?? 'idle';
  const action = (
    label: string,
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void,
    icon?: ReactNode,
  ) => (
    <button type="button" className="composer-action" onClick={onClick}>
      {icon}
      {label}
    </button>
  );
  const dismiss = (onClick: () => void) => (
    <button type="button" className="lane-x" aria-label="Dismiss" onClick={onClick}>
      <CloseIcon size={14} />
    </button>
  );
  if (dict && p === 'recording' && dict.micLive)
    return (
      <span className="lane rec">
        <span className="lane-text">
          <span className="rec-dot" aria-hidden="true" />
          <span>
            Recording · <RecordingClock since={dict.startedAt} />
          </span>
          {i.field === 'reason' && <span className="lane-quiet">· Dictating your reason</span>}
          {dict.capWarning && <span className="lane-quiet">· Stopping in 15 s</span>}
          {dict.escArmed && <span className="lane-quiet">· Press Escape again to discard</span>}
        </span>
        {action('Discard', () => dictation.discard())}
      </span>
    );
  // Starting into an empty field: the field itself says so, so the pill doesn't open a row for it.
  if (
    dict &&
    (p === 'starting' || p === 'recording') &&
    !dict.permission &&
    !dict.micSilent &&
    !dict.escArmed &&
    !fieldValue(draft, i.field)
  )
    return null;
  if (dict && (p === 'starting' || p === 'recording'))
    return (
      <span className={`lane${dict.micSilent ? ' warn' : ''}`}>
        <span className="lane-text">
          {dict.permission
            ? 'Allow microphone access to continue'
            : dict.micSilent
              ? 'No sound from your microphone'
              : 'Starting microphone…'}
        </span>
        {dict.escArmed && <span className="lane-quiet">Press Escape again to discard</span>}
      </span>
    );
  if (p === 'finishing')
    return (
      <span className="lane">
        <span className="lane-text">
          <span className="spinner small" aria-hidden="true" /> Finishing your words…
        </span>
      </span>
    );
  if (p === 'cleaning')
    return (
      <span className="lane">
        <span className="lane-text">
          <span className="spinner small" aria-hidden="true" /> Tidying wording…
        </span>
        {!i.originalInSlot &&
          action('Use original wording', (e) => revertTidy(e, draft.key, i.fieldRef))}
      </span>
    );
  // A failed save outranks everything below it: the words are only on screen until it is fixed.
  if (draft.save === 'error')
    return (
      <span className="lane error" role="alert">
        <span className="lane-text">Couldn’t save on this device</span>
        {action('Retry', () => void drafts.flush(draft.key).catch(() => undefined))}
        {action('Copy', () => void navigator.clipboard?.writeText(fieldValue(draft, i.field)))}
      </span>
    );
  if (i.error)
    return (
      <span className="lane error" role="alert">
        <span className="lane-text">{i.error}</span>
        {dismiss(i.onDismissError)}
      </span>
    );
  // A changed question blocks Send, so its way out comes before anything merely informational.
  if (i.stale)
    return (
      <span className="lane warn">
        <span className="lane-text">This question changed</span>
        {action('Review update', i.onReviewUpdate)}
      </span>
    );
  if (draft.undo)
    return (
      <span className="lane">
        <span className="lane-text">{draft.undo.message}</span>
        {action('Undo', draft.undo.restore, <UndoIcon size={14} />)}
      </span>
    );
  if (draft.photoNotice)
    return (
      <span
        className={`lane photo${draft.photoNotice.tone === 'error' ? ' error' : ''}`}
        role={draft.photoNotice.tone === 'error' ? 'alert' : 'status'}
      >
        <span className="lane-text">{draft.photoNotice.text}</span>
        {dismiss(() => drafts.dismissPhotoNotice(draft.key))}
      </span>
    );
  if (dict?.message)
    return (
      <span
        className={`lane${dict.message.tone === 'error' ? ' error' : ''}`}
        role={dict.message.tone === 'error' ? 'alert' : undefined}
      >
        <span className="lane-text">{dict.message.text}</span>
        {dict.message.retry && action('Try again', i.onDictate)}
        {dismiss(() => dictation.dismissMessage())}
      </span>
    );
  if (i.heard)
    return (
      <span className="lane">
        <span className="lane-text">{i.heard}</span>
      </span>
    );
  const original = i.canUseOriginal && !i.originalInSlot;
  if (original || i.unsure)
    return (
      <span className="lane only-actions">
        {original && action('Use original wording', (e) => revertTidy(e, draft.key, i.fieldRef))}
        {i.unsure &&
          action(
            `Review ${i.unsure.spans.length} ${i.unsure.spans.length === 1 ? 'word' : 'words'}`,
            i.onReviewWords,
          )}
      </span>
    );
  if (draft.notice === 'earlier')
    return (
      <span className="lane warn">
        <span className="lane-text">Draft from an earlier version of this question</span>
      </span>
    );
  return null;
}

/** The cleaned passage is still exactly where it landed, so its marks still point at the right words. */
function reviewApplies(review: Review, draft: DraftModel): boolean {
  const text = fieldValue(draft, review.field);
  return text.slice(review.start, review.start + review.cleaned.length) === review.cleaned;
}

/** "Recording · 00:24", ticking from the moment capture began. Not a live region: the start and stop are announced. */
export function RecordingClock({ since }: { since: number | null }) {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const id = setInterval(() => setT(Date.now()), 500);
    return () => clearInterval(id);
  }, [since]);
  return <span className="tabular">{clockLabel(since == null ? 0 : t - since)}</span>;
}

/* ---------- choices ---------- */

/**
 * The options as one row of chips just above the pill: one tap picks, another tap changes it, and the descriptions
 * stay in the agent's message above. The row scrolls under the gutters to the screen edge, where the next chip is
 * cut off (the cue that there is more). A radio group (arrow keys move and select); selection is a raised neutral fill,
 * an edge and a check, never colour alone. Nothing here sends.
 */
function ChoiceChips({
  options,
  selected,
  current: currentIds,
  label,
  disabled,
  onSelect,
  onClear,
}: {
  options: { id: string; label: string }[];
  selected: readonly string[];
  current?: readonly string[];
  label: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onClear: (() => void) | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const current = options.findIndex((o) => selected.includes(o.id));
  // The chosen chip is always in view, whether it was picked here, in the message, or restored with the draft. Only
  // the row scrolls: never the thread, and focus stays where it was.
  const chosen = selected.join('|');
  useLayoutEffect(() => {
    const row = ref.current;
    const el = row?.querySelector<HTMLElement>('.chip.on');
    if (!row || !el) return;
    const pad = parseFloat(getComputedStyle(row).paddingLeft) || 0;
    const left = el.offsetLeft - pad;
    const right = el.offsetLeft + el.offsetWidth + pad - row.clientWidth;
    if (left < row.scrollLeft) row.scrollLeft = left;
    else if (right > row.scrollLeft) row.scrollLeft = right;
  }, [chosen]);
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const n = (i + step + options.length) % options.length;
    onSelect(options[n]!.id);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[n]?.focus();
  };
  return (
    <div className="chips" role="radiogroup" aria-label={label} ref={ref}>
      {options.map((o, i) => {
        const on = selected.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={disabled || undefined}
            tabIndex={on || (current < 0 && i === 0) ? 0 : -1}
            className={`chip${on ? ' on' : ''}`}
            onClick={() => !disabled && onSelect(o.id)}
            onKeyDown={(e) => !disabled && onKey(e, i)}
          >
            {on && <CheckIcon size={16} />}
            <span className="chip-label">
              {o.label}
              {currentIds?.includes(o.id) && <span className="chip-note"> · Current answer</span>}
            </span>
          </button>
        );
      })}
      {onClear && (
        <button type="button" className="chip quiet" onClick={onClear}>
          Clear choice
        </button>
      )}
    </div>
  );
}

/* ---------- unsure words ---------- */

/** "Review 2 words": the first unsure span selected, with what was heard and what the model suggested. */
function UnsureReview({
  draft,
  unsure,
  textarea,
  onClose,
}: {
  draft: DraftModel;
  unsure: Unsure;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onClose: () => void;
}) {
  const s = unsure.spans[0]!;
  const text = unsure.text;
  const word = text.slice(s.start, s.end);
  const group = useRef<HTMLDivElement>(null);
  // Focus starts on the choices, which come before the field; the word itself is marked on the answer.
  useEffect(() => {
    group.current
      ?.querySelector<HTMLButtonElement>('.unsure-choices button')
      ?.focus({ preventScroll: true });
  }, [s.start, s.end]);
  // Leaving the check from the keyboard goes back to the answer; a tap leaves focus alone, so the phone's keyboard
  // stays down for someone who only came to check a word.
  const backToField = (e: React.MouseEvent) => {
    if (e.detail === 0) textarea.current?.focus({ preventScroll: true });
  };
  const choose = (c: SpanChoice, e: React.MouseEvent) => {
    const r = resolveSpan(text, unsure.spans, 0, c);
    drafts.edit(draft.key, unsure.field === 'reason' ? { reason: r.text } : { text: r.text });
    dictation.setUnsure(r.spans.length ? { ...unsure, text: r.text, spans: r.spans } : null);
    if (!r.spans.length) backToField(e);
  };
  return (
    <div className="unsure" role="group" aria-labelledby="ws-unsure-line" ref={group}>
      <p className="unsure-line" id="ws-unsure-line">
        Not sure about <mark>{word}</mark>
        {unsure.spans.length > 1 && (
          <span className="muted"> · {unsure.spans.length - 1} more</span>
        )}
      </p>
      {/* A new set of choices for each word, so moving on to the next one is a new focus that is spoken. */}
      <div className="unsure-choices" key={`${s.start}-${s.end}`}>
        <button type="button" className="composer-action" onClick={(e) => choose('corrected', e)}>
          Keep “{word}”
        </button>
        {s.candidate && s.candidate !== word && (
          <button type="button" className="composer-action" onClick={(e) => choose('candidate', e)}>
            Use “{s.candidate}”
          </button>
        )}
        {s.raw && s.raw !== word && (
          <button type="button" className="composer-action" onClick={(e) => choose('raw', e)}>
            Heard “{s.raw}”
          </button>
        )}
        <button
          type="button"
          className="lane-x"
          aria-label="Stop checking words"
          onClick={(e) => {
            dictation.setUnsure(null);
            onClose();
            backToField(e);
          }}
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}
