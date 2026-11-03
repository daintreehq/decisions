import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from 'react';
import { app } from '../../app/controller.js';
import { useApp, useNow, useQuestions } from '../../app/hooks.js';
import { navigate } from '../../app/router.js';
import { openNavigator } from '../../app/navigator.js';
import { StaleQuestionError } from '../../domain/answer.js';
import {
  composeShape,
  firstLine,
  formatBytes,
  verdict as computeVerdict,
  type ComposeMode,
  type EvidenceState,
  type FieldId,
} from '../../domain/compose.js';
import type { QuestionView } from '../../domain/model.js';
import {
  currentAnswer,
  deliveryProgress,
  effectiveStatus,
  lastProxyAction,
  needsAction,
  originParts,
  proxyNeedsReview,
  submitKind,
  unreadableHere,
} from '../../domain/selectors.js';
import { drafts, fieldValue, useDraft } from '../../features/compose/draftStore.js';
import { dictation, MESSAGES, useDictation, type Binding } from '../../features/voice/dictation.js';
import { announce } from '../../lib/announce.js';
import { previewText } from '../../lib/safe-text.js';
import { absoluteLabel, ageLabel, dueLabel, momentLabel } from '../../lib/time.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { SafeText } from '../SafeText.js';
import {
  ArrowRight,
  ClockIcon,
  ErrorIcon,
  LockIcon,
  ModelIcon,
  SuccessIcon,
  WarningIcon,
} from '../Icons.js';
import { AllQaButton, AnswerDock, DictateButton } from './AnswerDock.js';
import { ChoiceSheet, ConsentSheet } from './ChoiceSheet.js';
import { composeCentre, composeSummary, TranscriptPanel } from './ComposeDock.js';
import {
  AnswerBody,
  AnswerCard,
  ConflictCard,
  CopyButton,
  ModelAnswerCard,
  OptionCards,
  optionLabel,
  PendingCard,
} from './DecisionArea.js';
import { DeliveryStage, DeliveryStepper } from './DeliveryStatus.js';
import { EditorSheet, FIELD_LABEL } from './EditorSheet.js';
import { nextQuestion } from './nextQuestion.js';
import { WorkspaceOpening } from './Opening.js';
import { Sheet } from './Sheet.js';
import { useKeyboardInset } from './useKeyboardInset.js';
import { WorkspaceHeader, type MenuItem } from './WorkspaceHeader.js';

/** The gallery's review report; `presented` arrives with the file viewer work (verified and actually shown). */
type Review = EvidenceState & { digests: string[] };
interface GalleryHandle {
  showFirstUnreviewed(): void;
}
type GalleryProps = {
  view: QuestionView;
  onReview: (s: Review) => void;
  handleRef?: RefObject<GalleryHandle | null>;
};
const Gallery = AttachmentGallery as unknown as ComponentType<GalleryProps>;
const NO_REVIEW: Review = { digests: [], total: 0, loaded: 0, expired: 0, failed: 0 };

/** The question workspace for `/q/:id`. Keyed by id, so another question is always a fresh workspace. */
export function Workspace({ id }: { id: string }) {
  const snap = useApp();
  const now = useNow();
  void snap.rev;
  const view = app.store?.get(id);
  if (!view || !app.outbox) return <WorkspaceOpening />;
  return <QuestionWorkspace view={view} now={now} />;
}

function QuestionWorkspace({ view, now }: { view: QuestionView; now: number }) {
  const id = view.id;
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const galleryRef = useRef<GalleryHandle | null>(null);
  useKeyboardInset(rootRef);
  const all = useQuestions();
  const dictAll = useDictation();
  const [review, setReview] = useState<Review>(NO_REVIEW);
  const [correcting, setCorrecting] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; expanded: boolean }>({
    open: false,
    expanded: false,
  });
  const [field, setField] = useState<FieldId | null>(null);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [stepperOpen, setStepperOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [headingAway, setHeadingAway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const onReview = useCallback((s: Review) => setReview(s), []);

  const status = effectiveStatus(view, now);
  const verified = view.verification.ok;
  const content = view.content;
  const entries = app.outbox!.forQuestion(id);
  const pendingEntry = entries.find((e) => e.state === 'queued' || e.state === 'sending');
  const failed = entries.filter(
    (e) => e.state === 'conflicted' || e.state === 'rejected' || e.state === 'expired',
  );
  const answer = currentAnswer(view);
  const proxy = lastProxyAction(view);
  const kind = submitKind(view, now);
  const modelReview = proxyNeedsReview(view, now);
  const confirmed = view.actions.find((a) => a.verified && a.action === 'confirm-proxy');
  const progress = app.store
    ? deliveryProgress(view, app.store, pendingEntry?.state as 'queued' | 'sending' | undefined)
    : null;
  const canCorrect = verified && !!content && kind === 'override' && !pendingEntry;

  const answerDraft = useDraft(id, 'answer', view.revision);
  const correctionDraft = useDraft(id, 'correction', view.revision);
  const inCorrection = correcting && canCorrect;
  const mode: ComposeMode = inCorrection ? 'correction' : 'answer';
  const draft = inCorrection ? correctionDraft : answerDraft;
  const composing =
    verified &&
    !!content &&
    !pendingEntry &&
    failed.length === 0 &&
    (status === 'open' || inCorrection);
  const shape = content ? composeShape(content, mode) : null;
  const activeField: FieldId =
    field && shape?.fields.includes(field) ? field : (shape?.fields[0] ?? 'text');
  const mine = dictAll.binding?.key === draft.key ? dictAll : null;
  const capturing = composing ? dictation.busyFor(draft.key) : false;
  const stale = composing && draft.loaded && draft.revision !== view.revision;
  const currentContent = answer?.content as {
    selected_option_ids?: string[];
    text?: string;
  } | null;
  const verdict =
    shape && composing
      ? computeVerdict({
          shape,
          mode,
          selected: draft.selected,
          text: draft.text,
          reason: draft.reason,
          current: inCorrection
            ? {
                selected: currentContent?.selected_option_ids ?? [],
                text: currentContent?.text ?? '',
              }
            : null,
          attachments: content?.attachments.length ?? 0,
          evidence: review,
          stale,
          capturing,
        })
      : null;
  const waiting = all.filter((v) => needsAction(v, now)).length;
  const next = nextQuestion(all, id, now);
  const { project, machine } = originParts(view);
  const excerpt = content ? previewText(content.question, 90) : '';

  // A draft emptied by a revision change simply follows the question; one with words in it waits for Review update.
  useEffect(() => {
    if (!composing || !draft.loaded || draft.revision === view.revision) return;
    const empty = !draft.text.trim() && !draft.reason.trim() && !draft.selected.length;
    if (empty) drafts.rebind(draft.key, view.revision);
  }, [composing, draft, view.revision]);

  // The question changed or closed under a running dictation: stop, keep the words, lock Send.
  useEffect(() => {
    const b = dictation.getState().binding;
    if (!b || b.questionId !== id || !dictation.isActive()) return;
    if (b.revision !== view.revision || !composing) void dictation.stop(MESSAGES.changed);
  }, [id, view.revision, composing]);

  // Leaving the question (another question, History, Settings) stops capture and saves to this question.
  useEffect(
    () => () => {
      const b = dictation.getState().binding;
      if (b?.questionId === id && dictation.isActive()) void dictation.stop();
      void drafts.flushAll().catch(() => undefined);
    },
    [id],
  );

  // Opening a page focuses its heading (after the router's own focus move).
  useEffect(() => {
    const t = setTimeout(() => headingRef.current?.focus({ preventScroll: true }), 0);
    return () => clearTimeout(t);
  }, [id]);

  // Once the heading scrolls away, the header carries a one-line excerpt.
  useEffect(() => {
    const h = headingRef.current;
    const root = bodyRef.current;
    if (!h || !root || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setHeadingAway(!e!.isIntersecting), {
      root,
      threshold: 0,
    });
    io.observe(h);
    return () => io.disconnect();
  }, [content]);

  const binding = (): Binding => ({
    questionId: id,
    revision: draft.revision,
    mode,
    field: activeField,
    key: draft.key,
    epoch: draft.epoch,
    question: content?.question ?? '',
    context: content?.context,
    options: (content?.options ?? []).map((o) => ({
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    })),
    askedAt: view.createdAt,
    projectLabel: content?.project_label,
  });

  const toggleDictation = () => {
    if (!composing || !shape?.fields.length || stale) return;
    const p = mine?.phase ?? 'idle';
    if (p === 'starting' || p === 'recording') void dictation.stop();
    else if (p === 'finishing') return;
    else dictation.request(binding());
  };

  const allQa = () => {
    if (dictation.isActive()) void dictation.stop();
    openNavigator();
  };

  const select = (optionId: string) => {
    if (stale) return;
    drafts.edit(draft.key, { selected: [optionId] });
  };

  const openChoice = () => {
    const opts = content?.options ?? [];
    const long = opts.length > 3 || opts.some((o) => (o.description?.length ?? 0) > 90);
    const el = document.getElementById('ws-options');
    if (!long && el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    } else setChoiceOpen(true);
  };

  const commit = async () => {
    if (!shape || !verdict) return;
    const d = drafts.get(draft.key)!;
    const k = mode === 'answer' ? 'answer' : 'override';
    // Everything is checked again at the moment of Send, not only when the button was enabled.
    if (view.revision !== d.revision || submitKind(view) !== k) {
      setConfirmOpen(false);
      setError('This question changed. Review the update before sending.');
      return;
    }
    if (!verdict.canSend || dictation.busyFor(d.key)) return;
    setBusy(true);
    setError(null);
    try {
      await app.submit({
        view,
        kind: k,
        expectedRevision: d.revision,
        selected: shape.hasOptions ? d.selected : [],
        text: shape.textAllowed ? d.text : '',
        reason: mode === 'correction' ? d.reason : undefined,
        reviewedDigests: review.digests,
      });
      // Sealed and queued durably: only now does the draft go, and nothing in flight may bring it back.
      dictation.release(d.key);
      await drafts.sent(d.key);
      setConfirmOpen(false);
      setEditor({ open: false, expanded: false });
      setCorrecting(false);
      announce(
        navigator.onLine
          ? mode === 'correction'
            ? 'Your correction is queued and sending.'
            : 'Your answer is queued and sending.'
          : 'Queued on this device. It will send when you’re back online.',
      );
    } catch (e) {
      setConfirmOpen(false);
      setError(
        e instanceof StaleQuestionError
          ? 'This question changed. Review the update before sending.'
          : e instanceof Error
            ? e.message
            : 'Could not prepare your answer.',
      );
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    if (!verdict?.canSend || busy) return;
    if (mode === 'correction') setConfirmOpen(true);
    else void commit();
  };

  const confirmModel = async () => {
    if (!proxy) return;
    setBusy(true);
    setConfirmError(null);
    try {
      await app.submit({
        view,
        kind: 'confirm-proxy',
        expectedRevision: proxy.revision,
        selected: [],
        text: '',
        reviewedDigests: [],
      });
      announce('Your confirmation is saved and sending.');
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : 'Could not confirm. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const startCorrection = () => {
    if (!canCorrect) return;
    if (dictation.isActive()) void dictation.stop();
    setField(null);
    setCorrecting(true);
    setTimeout(
      () => document.getElementById('ws-correction')?.scrollIntoView({ block: 'start' }),
      0,
    );
  };

  // Desktop shortcuts: modifier keys only, never single letters.
  const latest = useRef({ send, toggleDictation });
  latest.current = { send, toggleDictation };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        latest.current.send();
      } else if (mod && e.shiftKey && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault();
        latest.current.toggleDictation();
      } else if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
        if (dictation.escape()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /* ---------- header ---------- */

  const glyph =
    status === 'open' ? (
      <span className="glyph-waiting" />
    ) : status === 'proxy-answered' ? (
      <ModelIcon size={12} />
    ) : status === 'human-answered' ? (
      <SuccessIcon size={14} />
    ) : status === 'expired' ? (
      <ClockIcon size={14} />
    ) : status === 'unverified' ? (
      unreadableHere(view) ? (
        <LockIcon size={14} />
      ) : (
        <ErrorIcon size={14} />
      )
    ) : null;
  const statusWords =
    status === 'open'
      ? 'Needs you'
      : status === 'proxy-answered'
        ? modelReview
          ? 'Model answer · review'
          : 'Answered by the model'
        : status === 'human-answered'
          ? 'Answered'
          : status === 'expired'
            ? 'Expired'
            : status === 'cancelled'
              ? 'Withdrawn'
              : unreadableHere(view)
                ? 'Not readable here'
                : 'Could not verify';
  const menu: MenuItem[] = [];
  if (content) {
    menu.push({
      label: 'Question details',
      onSelect: () => {
        const d = document.getElementById('ws-details') as HTMLDetailsElement | null;
        if (d) {
          d.open = true;
          d.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
      },
    });
    menu.push({
      label: 'Copy question',
      onSelect: () => void navigator.clipboard?.writeText(content.question).catch(() => undefined),
    });
  }
  menu.push({
    label: 'Copy question ID',
    onSelect: () => void navigator.clipboard?.writeText(id).catch(() => undefined),
  });
  if (canCorrect && !inCorrection) menu.push({ label: 'Change answer', onSelect: startCorrection });

  /* ---------- dock ---------- */

  const qa = (
    <AllQaButton
      waiting={waiting}
      recording={!!mine && (mine.phase === 'starting' || mine.phase === 'recording')}
      onClick={allQa}
    />
  );
  const nextButton = next ? (
    <button
      type="button"
      className="btn primary dock-next"
      onClick={() => navigate(`/q/${next.id}`)}
    >
      Next question
      <ArrowRight size={18} />
    </button>
  ) : (
    <span className="dock-none">No more questions need you</span>
  );
  let dock: ReactNode;
  let dockExpanded = false;
  if (!verified || !content) {
    dock = (
      <AnswerDock
        left={qa}
        summary={
          <div className="dock-status">
            <span className="status">
              {unreadableHere(view)
                ? 'This device can’t read this question, so it can’t be answered here.'
                : 'This question could not be verified, so it can’t be answered.'}
            </span>
          </div>
        }
        right={next ? nextButton : undefined}
      />
    );
  } else if (pendingEntry) {
    const queuedOffline = pendingEntry.state === 'queued' && !navigator.onLine;
    dock = (
      <AnswerDock
        left={qa}
        summary={
          <div className="dock-status">
            <span className="status" role="status">
              {pendingEntry.kind === 'confirm-proxy' ? (
                'Confirming…'
              ) : progress ? (
                <DeliveryStage progress={progress} />
              ) : null}
              {queuedOffline && (
                <span className="status-quiet"> It will send when you’re back online.</span>
              )}
            </span>
          </div>
        }
        centre={
          <div className="dock-field passive">
            <span className="dock-preview">
              {[
                pendingEntry.selected.map((s) => optionLabel(view, s)).join(', '),
                firstLine(pendingEntry.text),
              ]
                .filter(Boolean)
                .join(' · ') || 'Your answer'}
            </span>
          </div>
        }
      />
    );
  } else if (failed.length > 0) {
    dock = (
      <AnswerDock
        left={qa}
        summary={
          <div className="dock-status">
            <span className="status warn" role="status">
              Your answer was not applied. Your words are kept.
            </span>
          </div>
        }
        centre={
          <button
            type="button"
            className="dock-field"
            onClick={() =>
              document.getElementById('ws-conflict')?.scrollIntoView({ block: 'start' })
            }
          >
            <span className="dock-placeholder strong">Review change</span>
          </button>
        }
      />
    );
  } else if (composing && shape && verdict) {
    const placeholder =
      activeField === 'reason'
        ? 'Why are you changing it?'
        : mode === 'correction'
          ? 'Write the corrected answer'
          : shape.textIsAnswer
            ? 'Type an answer'
            : 'Add a note';
    const fieldNoun =
      activeField === 'reason'
        ? 'reason'
        : shape.textIsAnswer || mode === 'correction'
          ? 'answer'
          : 'note';
    const selectionLabel = draft.selected.length
      ? draft.selected.map((s) => optionLabel(view, s)).join(', ')
      : null;
    const input = {
      shape,
      draft,
      verdict,
      field: activeField,
      fieldNoun,
      dict: mine,
      stale,
      error,
      sending: busy,
      selectionLabel,
      canUseOriginal: dictation.canUseOriginal(draft),
      onSend: send,
      onChoose: openChoice,
      onReviewUpdate: () => {
        drafts.rebind(draft.key, view.revision);
        setError(null);
        announce('Updated. Your choice was cleared; review the question before sending.');
      },
      onShowRemaining: () => galleryRef.current?.showFirstUnreviewed(),
      onReviewWords: () => {
        const u = mine?.unsure;
        if (u) setField(u.field);
        setEditor({ open: true, expanded: false });
      },
      onOpenEditor: () => setEditor({ open: true, expanded: false }),
      onToggleTranscript: () => setTranscriptOpen((o) => !o),
      onDictate: toggleDictation,
      onDismissError: () => setError(null),
    };
    const limit =
      verdict.textOver > 0 && activeField === 'text'
        ? `${formatBytes(verdict.textOver)} over the limit. Nothing is cut; shorten it to send.`
        : verdict.reasonOver > 0 && activeField === 'reason'
          ? `${verdict.reasonOver} characters over the 2,000-character limit.`
          : null;
    dockExpanded = editor.open && editor.expanded;
    const v = app.getSnapshot().prefs.voice;
    dock = (
      <AnswerDock
        expanded={dockExpanded}
        above={
          <>
            {transcriptOpen && mine && dictation.isActive() && (
              <TranscriptPanel dict={mine} onClose={() => setTranscriptOpen(false)} />
            )}
            {editor.open && shape.fields.length > 0 && (
              <EditorSheet
                draft={draft}
                field={activeField}
                fields={shape.fields}
                fieldLabels={{
                  text:
                    mode === 'correction'
                      ? 'Corrected answer'
                      : shape.textIsAnswer
                        ? 'Answer'
                        : 'Note',
                  reason: FIELD_LABEL.reason,
                }}
                placeholder={placeholder}
                maxBytesHint={limit}
                questionExcerpt={excerpt}
                expanded={editor.expanded}
                onExpand={(x) => setEditor({ open: true, expanded: x })}
                onClose={() => {
                  setEditor({ open: false, expanded: false });
                  void drafts.flush(draft.key).catch(() => undefined);
                }}
                onField={setField}
                onSend={send}
              />
            )}
          </>
        }
        summary={composeSummary(input)}
        left={qa}
        centre={composeCentre({
          ...input,
          editorOpen: editor.open,
          placeholder,
          onCloseEditor: () => setEditor({ open: false, expanded: false }),
        })}
        right={
          shape.fields.length > 0 ? (
            <DictateButton
              dict={mine ?? { ...dictAll, phase: 'idle' }}
              holdMode={v.mode === 'hold'}
              fieldLabel={fieldNoun}
              onToggle={toggleDictation}
              onHoldStart={() => {
                if (!mine || mine.phase === 'idle' || mine.phase === 'cleaning') toggleDictation();
              }}
              onHoldEnd={() => {
                const p = dictation.getState().phase;
                if (
                  dictation.getState().binding?.key === draft.key &&
                  (p === 'starting' || p === 'recording')
                )
                  void dictation.stop();
              }}
            />
          ) : undefined
        }
      />
    );
  } else if (modelReview && proxy) {
    dock = (
      <AnswerDock
        left={qa}
        summary={
          <>
            <div className="dock-status">
              <span className="selection">
                <span className="selection-key">Model chose</span>
                <span className="selection-value">
                  {(
                    (proxy.content as { selected_option_ids?: string[] } | null)
                      ?.selected_option_ids ?? []
                  )
                    .map((o) => optionLabel(view, o))
                    .join(', ') || 'A written answer'}
                </span>
              </span>
              {confirmError && (
                <span className="status error" role="alert">
                  {confirmError}
                </span>
              )}
            </div>
            <button
              type="button"
              className="btn primary dock-send"
              aria-disabled={busy || undefined}
              onClick={() => !busy && void confirmModel()}
            >
              Confirm answer
            </button>
          </>
        }
        centre={
          canCorrect ? (
            <button type="button" className="dock-field" onClick={startCorrection}>
              <span className="dock-placeholder strong">Change answer</span>
            </button>
          ) : undefined
        }
      />
    );
  } else if (answer && (status === 'human-answered' || status === 'proxy-answered')) {
    dock = (
      <AnswerDock
        left={qa}
        above={
          stepperOpen && progress ? (
            <div className="dock-stepper">
              <DeliveryStepper progress={progress} fromPhone={answer.provenance !== 'proxy'} />
            </div>
          ) : undefined
        }
        summary={
          <>
            <div className="dock-status">
              {progress && (
                <button
                  type="button"
                  className="stage-button"
                  aria-expanded={stepperOpen}
                  onClick={() => setStepperOpen((o) => !o)}
                >
                  <DeliveryStage progress={progress} />
                </button>
              )}
            </div>
            {canCorrect && (
              <button type="button" className="btn small" onClick={startCorrection}>
                {hasWords(correctionDraft) ? 'Resume correction' : 'Change answer'}
              </button>
            )}
          </>
        }
        centre={
          <button
            type="button"
            className="dock-field"
            onClick={() =>
              document.getElementById('ws-answer')?.scrollIntoView({ block: 'center' })
            }
          >
            <span className="dock-placeholder strong">View answer</span>
          </button>
        }
        right={nextButton}
      />
    );
  } else {
    dock = (
      <AnswerDock
        left={qa}
        summary={
          <div className="dock-status">
            <span className="status">
              {status === 'expired' ? 'This question expired' : 'Withdrawn by your agent'}
            </span>
          </div>
        }
        right={nextButton}
      />
    );
  }

  /* ---------- body ---------- */

  const due =
    status === 'open' && view.expiresAt ? (
      <span className={Date.parse(view.expiresAt) - now < 24 * 3_600_000 ? 'due soon' : 'due'}>
        {Date.parse(view.expiresAt) - now < 24 * 3_600_000 && <ClockIcon size={13} />}
        {dueLabel(view.expiresAt, now)}
      </span>
    ) : null;

  return (
    <div
      ref={rootRef}
      className={`ws${dockExpanded ? ' editor-full' : ''}`}
      data-state={composing ? 'compose' : status}
    >
      <WorkspaceHeader
        project={project}
        machine={machine}
        glyph={glyph}
        statusText={statusWords}
        excerpt={excerpt}
        showExcerpt={headingAway}
        onExcerpt={() => {
          bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
          headingRef.current?.focus({ preventScroll: true });
        }}
        menu={menu}
      />
      <div className="ws-body" ref={bodyRef}>
        <article className="ws-column" aria-labelledby={content ? 'q-title' : undefined}>
          {!verified && <TrustState view={view} headingRef={headingRef} />}
          {content && (
            <>
              <div id="q-title" role="heading" aria-level={1} tabIndex={-1} ref={headingRef}>
                <SafeText text={content.question} className="question" />
              </div>
              <p className="status-line">
                <span className={`principal ${status}`}>
                  {glyph}
                  {statusWords}
                </span>
                {status === 'open' && view.requirement === 'human-required' && (
                  <span>Human decision required</span>
                )}
                {status === 'open' && view.proxyAbstained && <span>The model passed</span>}
                {due ?? (
                  <span title={absoluteLabel(view.createdAt)}>
                    Asked {ageLabel(view.createdAt, now)}
                  </span>
                )}
              </p>
              <Gallery view={view} onReview={onReview} handleRef={galleryRef} />
              {content.context && (
                <details className="disclosure context">
                  <summary>
                    <span className="summary-title">Context from the agent</span>
                    <span className="summary-preview">{previewText(content.context, 120)}</span>
                  </summary>
                  <SafeText text={content.context} />
                </details>
              )}
              {view.integrityIssues.length > 0 && (
                <div className="callout warn" role="alert">
                  <WarningIcon size={16} />
                  <div>
                    <strong>Some activity could not be verified</strong>
                    <ul className="plain">
                      {view.integrityIssues.slice(0, 4).map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              <section className="decision" aria-label="Decision">
                {pendingEntry ? (
                  <PendingCard view={view} entry={pendingEntry} />
                ) : failed.length > 0 ? (
                  failed.map((e) => (
                    <ConflictCard
                      key={e.id}
                      view={view}
                      entry={e}
                      current={answer}
                      now={now}
                      canCorrect={canCorrect || kind === 'override'}
                      onDismiss={() => {
                        if (status === 'open' && !hasWords(answerDraft) && e.text.trim())
                          drafts.edit(answerDraft.key, { text: e.text });
                        void app.outbox?.discard(e.id);
                      }}
                      onUseAsCorrection={() => {
                        drafts.edit(correctionDraft.key, {
                          selected: e.selected,
                          text: e.text,
                        });
                        void app.outbox?.discard(e.id);
                        setCorrecting(true);
                      }}
                    />
                  ))
                ) : (
                  <>
                    {answer &&
                      (answer.provenance === 'proxy' ? (
                        <ModelAnswerCard
                          view={view}
                          a={answer}
                          now={now}
                          confirmedAt={confirmed?.createdAt ?? null}
                          review={modelReview}
                        />
                      ) : (
                        !inCorrection && <AnswerCard view={view} a={answer} now={now} />
                      ))}
                    {inCorrection && shape && (
                      <CorrectionArea
                        view={view}
                        answerContent={answer?.content ?? null}
                        showCurrent={answer?.provenance !== 'proxy' && (!shape.hasOptions || !!currentContent?.text)}
                        draft={correctionDraft}
                        hasOptions={shape.hasOptions}
                        reasonInPage={shape.fields.length > 1}
                        onSelect={select}
                        onReason={() => {
                          setField('reason');
                          setEditor({ open: true, expanded: false });
                        }}
                        onCancel={() => {
                          if (dictation.isActive()) void dictation.stop();
                          setEditor({ open: false, expanded: false });
                          setCorrecting(false);
                        }}
                        onDiscard={() => setDiscardOpen(true)}
                      />
                    )}
                    {composing && mode === 'answer' && (
                      <>
                        {stale && (
                          <div className="callout warn" role="status">
                            <WarningIcon size={16} />
                            <div>
                              <p className="callout-text">
                                This question changed. Your draft is saved; review the update before
                                sending.
                              </p>
                              <button
                                type="button"
                                className="btn small"
                                onClick={() => drafts.rebind(draft.key, view.revision)}
                              >
                                Review update
                              </button>
                            </div>
                          </div>
                        )}
                        {shape?.hasOptions && (
                          <OptionCards
                            view={view}
                            selected={draft.selected}
                            onSelect={select}
                            disabled={stale || busy}
                            legend={content.kind === 'approval' ? 'Your decision' : 'Choose one'}
                          />
                        )}
                      </>
                    )}
                    {(status === 'expired' || status === 'cancelled') && (
                      <ClosedState view={view} status={status} draftText={answerDraft.text} />
                    )}
                  </>
                )}
              </section>
              <section className="record" aria-label="Record">
                {answer && progress && !pendingEntry && (
                  <details className="disclosure">
                    <summary>
                      <span className="summary-title">Delivery</span>
                      <span className="summary-preview">{progress.label}</span>
                    </summary>
                    <DeliveryStepper
                      progress={progress}
                      fromPhone={answer.provenance !== 'proxy'}
                    />
                  </details>
                )}
                <details className="disclosure" id="ws-details">
                  <summary>
                    <span className="summary-title">Question details</span>
                  </summary>
                  <QuestionDetails view={view} />
                </details>
              </section>
            </>
          )}
        </article>
      </div>
      <div id="workspace-overlay" className="ws-overlay" />
      {dock}
      {content && (
        <ChoiceSheet
          open={choiceOpen}
          view={view}
          selected={draft.selected}
          currentIds={inCorrection ? (currentContent?.selected_option_ids ?? []) : undefined}
          onSelect={select}
          onClose={() => setChoiceOpen(false)}
        />
      )}
      <ConsentSheet
        open={dictAll.phase === 'consent' && dictAll.binding?.key === draft.key}
        provider={app.getSnapshot().prefs.voice.transcription === 'xai' ? 'xAI (Grok)' : 'OpenAI'}
        cleanup={cleanupName()}
        onAccept={() => void dictation.acceptConsent()}
        onDecline={() => dictation.declineConsent()}
      />
      {inCorrection && shape && (
        <Sheet
          open={confirmOpen}
          title="Send this correction?"
          onClose={() => setConfirmOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmOpen(false)}>
                Keep editing
              </button>
              <button
                type="button"
                className="btn primary"
                aria-disabled={busy || undefined}
                onClick={() => !busy && void commit()}
              >
                {busy ? 'Sending…' : 'Send correction'}
              </button>
            </>
          }
        >
          <div className="change">
            <div className="change-side">
              <span className="eyebrow">Before</span>
              <AnswerBody view={view} content={(answer?.content as never) ?? null} />
            </div>
            <div className="change-side">
              <span className="eyebrow">After</span>
              <AnswerBody
                view={view}
                content={{
                  content_version: 1,
                  selected_option_ids: shape.hasOptions ? correctionDraft.selected : [],
                  text: shape.textAllowed ? correctionDraft.text.trim() || undefined : undefined,
                  reviewed_attachment_digests: [],
                  reason: correctionDraft.reason.trim() || undefined,
                }}
              />
            </div>
          </div>
          <p className="muted">
            Your agent may already have acted on the earlier answer. This sends a correction; it
            doesn’t undo completed work.
          </p>
        </Sheet>
      )}
      <Sheet
        open={discardOpen}
        title="Discard this correction?"
        onClose={() => setDiscardOpen(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDiscardOpen(false)}>
              Keep it
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                dictation.release(correctionDraft.key);
                void drafts.sent(correctionDraft.key);
                setDiscardOpen(false);
                setEditor({ open: false, expanded: false });
                setCorrecting(false);
              }}
            >
              Discard correction
            </button>
          </>
        }
      >
        <p>The corrected answer and your reason will be removed from this device.</p>
      </Sheet>
    </div>
  );
}

function hasWords(d: { text: string; reason: string; selected: string[] }) {
  return !!(d.text.trim() || d.reason.trim() || d.selected.length);
}

function cleanupName(): string | null {
  const s = app.getSnapshot();
  const c = s.prefs.voice.correction;
  if (c === 'anthropic' && s.info?.voice.anthropic) return 'Anthropic (Claude)';
  if (c === 'openai' && s.info?.voice.openai) return 'OpenAI';
  return null;
}

/** Correction mode: the answer in force, read-only, then the replacement and the required reason. */
function CorrectionArea({
  view,
  answerContent,
  showCurrent,
  draft,
  hasOptions,
  reasonInPage,
  onSelect,
  onReason,
  onCancel,
  onDiscard,
}: {
  view: QuestionView;
  answerContent: unknown;
  showCurrent: boolean;
  draft: ReturnType<typeof drafts.get> & object;
  hasOptions: boolean;
  reasonInPage: boolean;
  onSelect: (id: string) => void;
  onReason: () => void;
  onCancel: () => void;
  onDiscard: () => void;
}) {
  const current = answerContent as { selected_option_ids?: string[] } | null;
  return (
    <section className="correction" id="ws-correction" aria-labelledby="ws-correction-h">
      <header className="correction-head">
        <h2 id="ws-correction-h" className="eyebrow">
          {hasWords(draft) ? 'Unsent correction' : 'Change your answer'}
        </h2>
        <span className="correction-tools">
          {hasWords(draft) && (
            <button type="button" className="btn small ghost" onClick={onDiscard}>
              Discard
            </button>
          )}
          <button type="button" className="btn small" onClick={onCancel}>
            Cancel
          </button>
        </span>
      </header>
      {showCurrent && (
        <div className="current-answer">
          <span className="eyebrow">Current answer</span>
          <AnswerBody view={view} content={answerContent as never} />
        </div>
      )}
      {hasOptions && (
        <OptionCards
          view={view}
          selected={draft.selected}
          currentIds={current?.selected_option_ids ?? []}
          onSelect={onSelect}
          legend="Corrected answer"
        />
      )}
      {reasonInPage && (
        <button type="button" className="field-button" onClick={onReason}>
          <span className="field-button-label">Why are you changing it?</span>
          <span className={draft.reason.trim() ? 'field-button-value' : 'field-button-empty'}>
            {draft.reason.trim() || 'Required. Your agent sees this with the correction.'}
          </span>
        </button>
      )}
    </section>
  );
}

function ClosedState({
  view,
  status,
  draftText,
}: {
  view: QuestionView;
  status: 'expired' | 'cancelled';
  draftText: string;
}) {
  const opts = view.content?.options ?? [];
  return (
    <div className="closed">
      <div className="callout">
        {status === 'expired' ? <ClockIcon size={16} /> : <ErrorIcon size={16} />}
        <div>
          <p className="callout-text">
            {status === 'expired'
              ? 'It expired before it was answered, so nothing was approved. If you still want to decide, ask your agent again from your computer.'
              : 'Your agent withdrew it. No answer is needed and nothing was approved here.'}
          </p>
        </div>
      </div>
      {opts.length > 0 && (
        <div className="closed-options">
          <span className="eyebrow">The options were</span>
          <ul>
            {opts.map((o) => (
              <li key={o.id}>{o.label}</li>
            ))}
          </ul>
        </div>
      )}
      {draftText.trim() && (
        <div className="closed-draft">
          <span className="eyebrow">Your unsent draft</span>
          <SafeText text={draftText} />
          <div className="row">
            <CopyButton text={draftText} />
          </div>
        </div>
      )}
    </div>
  );
}

function TrustState({
  view,
  headingRef,
}: {
  view: QuestionView;
  headingRef: RefObject<HTMLDivElement | null>;
}) {
  const unreadable = unreadableHere(view);
  return (
    <div className="ws-state trust">
      <div role="heading" aria-level={1} tabIndex={-1} ref={headingRef} className="ws-state-title">
        {unreadable
          ? 'This device cannot read this earlier question'
          : 'Could not verify this question'}
      </div>
      <p>
        {unreadable
          ? 'It was sealed with a content key this device was never given, usually because it was asked before this device was paired. Answer it from a device that was paired then, or ask your agent to ask again.'
          : 'It was not signed by a device you trust, or its contents do not match its signature, so it is not shown and cannot be answered.'}
      </p>
      {!unreadable && !view.verification.ok && (
        <details className="disclosure">
          <summary>
            <span className="summary-title">Diagnostic detail</span>
          </summary>
          <p className="mono">{view.verification.reason}</p>
        </details>
      )}
    </div>
  );
}

function QuestionDetails({ view }: { view: QuestionView }) {
  const c = view.content;
  return (
    <dl className="details-list">
      {c?.project_label && (
        <>
          <dt>Project</dt>
          <dd>{c.project_label}</dd>
        </>
      )}
      {c?.machine_label && (
        <>
          <dt>Computer</dt>
          <dd>{c.machine_label}</dd>
        </>
      )}
      <dt>Asked</dt>
      <dd>{absoluteLabel(view.createdAt)}</dd>
      {view.expiresAt && (
        <>
          <dt>{Date.parse(view.expiresAt) > Date.now() ? 'Expires' : 'Expired'}</dt>
          <dd>{absoluteLabel(view.expiresAt)}</dd>
        </>
      )}
      <dt>Decision</dt>
      <dd>
        {view.requirement === 'human-required'
          ? 'A person must decide'
          : 'The decision model may answer'}
      </dd>
      <dt>Last activity</dt>
      <dd>{momentLabel(view.lastEventAt)}</dd>
      <dt>Question ID</dt>
      <dd className="mono">{view.id}</dd>
    </dl>
  );
}
