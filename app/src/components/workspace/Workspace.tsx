import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { app } from '../../app/controller.js';
import { useApp, useNow, useQuestions } from '../../app/hooks.js';
import { backTarget, cameFromApp, openQuestion } from '../../app/listState.js';
import { StaleQuestionError } from '../../domain/answer.js';
import {
  composeShape,
  verdict as computeVerdict,
  type ComposeMode,
  type FieldId,
} from '../../domain/compose.js';
import type { QuestionView } from '../../domain/model.js';
import {
  currentAnswer,
  deliveryProgress,
  effectiveStatus,
  lastProxyAction,
  originParts,
  proxyNeedsReview,
  submitKind,
  unreadableHere,
} from '../../domain/selectors.js';
import { drafts, useDraft } from '../../features/compose/draftStore.js';
import { dictation, MESSAGES, useDictation, type Binding } from '../../features/voice/dictation.js';
import { announce } from '../../lib/announce.js';
import { previewText } from '../../lib/safe-text.js';
import { absoluteLabel, dueLabel, momentLabel } from '../../lib/time.js';
import {
  AttachmentGallery,
  NO_REVIEW,
  type GalleryHandle,
  type ReviewState,
} from '../AttachmentGallery.js';
import { ActivityTimeline } from '../history/ActivityTimeline.js';
import { SafeText } from '../SafeText.js';
import {
  ArrowRight,
  CheckIcon,
  ChevronDown,
  ClockIcon,
  ModelIcon,
  PersonIcon,
  RefreshIcon,
  UndoIcon,
  WarningIcon,
} from '../Icons.js';
import { AnswerDock } from './AnswerDock.js';
import { Composer } from './Composer.js';
import { ConsentSheet } from './ConsentSheet.js';
import { AnswerBody, ConflictCard, CopyButton, OptionCards } from './DecisionArea.js';
import { Receipt } from './DeliveryStatus.js';
import { nextQuestion } from './nextQuestion.js';
import { WorkspaceOpening } from './Opening.js';
import { Sheet } from './Sheet.js';
import {
  AgentMessage,
  HumanAnswer,
  MessageContext,
  ModelMessage,
  OutgoingMessage,
  StaticChoices,
  SystemLine,
  Thread,
} from './Thread.js';
import { useKeyboardInset } from './useKeyboardInset.js';
import { WorkspaceHeader, type MenuItem } from './WorkspaceHeader.js';

/** The gallery's review report: `digests` are the files both verified and actually presented. */
type Review = ReviewState;
const Gallery = AttachmentGallery;

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  const threadRef = useRef<HTMLDivElement>(null);
  const galleryRef = useRef<GalleryHandle | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useKeyboardInset(rootRef);
  const all = useQuestions();
  const dictAll = useDictation();
  const [review, setReview] = useState<Review>(NO_REVIEW);
  const [correcting, setCorrecting] = useState(false);
  const [field, setField] = useState<FieldId | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
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
  // Where the answer in force has reached, and (separately) where this device's reply on its way has reached.
  const progress = app.store ? deliveryProgress(view, app.store) : null;
  const pendingProgress =
    app.store && pendingEntry
      ? deliveryProgress(view, app.store, pendingEntry.state as 'queued' | 'sending')
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
  const next = nextQuestion(all, id, now);
  const { project, machine } = originParts(view);
  const excerpt = content ? previewText(content.question, 90) : '';
  const offerChoices = composing && mode === 'answer' && !!shape?.hasOptions;

  // A draft emptied by a revision change simply follows the question; one with words in it waits for Review update.
  // Capture for it settles first: words still arriving belong to the revision they were spoken for.
  const settling = dictation.busyFor(draft.key);
  useEffect(() => {
    if (!composing || !draft.loaded || draft.revision === view.revision || settling) return;
    const empty = !draft.text.trim() && !draft.reason.trim() && !draft.selected.length;
    if (empty) drafts.rebind(draft.key, view.revision);
  }, [composing, draft, view.revision, settling]);

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
      // A consent still being saved for this question starts nothing once the person has left it.
      if (b?.questionId === id && dictation.getState().phase === 'consent')
        dictation.declineConsent();
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

  const select = (optionId: string) => {
    if (stale) return;
    drafts.edit(draft.key, { selected: [optionId] });
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

  const menu: MenuItem[] = [];
  if (content) {
    menu.push({ label: 'Question details', onSelect: () => setDetailsOpen(true) });
    menu.push({
      label: 'Copy question',
      onSelect: () => void navigator.clipboard?.writeText(content.question).catch(() => undefined),
    });
  }
  menu.push({
    label: 'Copy question ID',
    onSelect: () => void navigator.clipboard?.writeText(id).catch(() => undefined),
  });
  if (content) menu.push({ label: 'View activity', onSelect: () => setActivityOpen(true) });
  if (canCorrect && !inCorrection)
    menu.push({
      label: hasWords(correctionDraft) ? 'Resume correction' : 'Change answer',
      onSelect: startCorrection,
    });
  // Clearing is an explicit loss with Undo, so it lives here rather than in the composer.
  if (composing && hasWords(draft))
    menu.push({
      label: 'Clear draft',
      onSelect: () => {
        if (dictation.isActive()) dictation.release(draft.key);
        drafts.clear(draft.key);
      },
    });

  /* ---------- dock ---------- */

  // A lateral move keeps the first question's origin, so Back still returns to the list it came from.
  const goNext = () => {
    if (!next) return;
    if (dictation.isActive()) void dictation.stop();
    openQuestion(next.id, backTarget() === '/history' ? 'history' : 'questions', null, {
      refocus: false,
    });
  };
  /** Moving on, as the dock's whole width: the one thing left to do once an answer is on its way. */
  const moveOn = (strong: boolean) =>
    next ? (
      <button type="button" className={`btn${strong ? ' primary' : ''} dock-next`} onClick={goNext}>
        Next question
        <ArrowRight size={18} />
      </button>
    ) : (
      <span className="dock-done">
        <CheckIcon size={16} />
        No more questions need you
      </span>
    );
  let dock: ReactNode;
  if (!verified || !content) {
    dock = (
      <AnswerDock>
        <p className="dock-line">
          {unreadableHere(view)
            ? 'This device can’t read this question, so it can’t be answered here.'
            : 'This question could not be verified, so it can’t be answered.'}
        </p>
        {next && moveOn(false)}
      </AnswerDock>
    );
  } else if (pendingEntry) {
    // The reply and its receipt are in the thread; the dock offers what comes next.
    dock = <AnswerDock>{moveOn(true)}</AnswerDock>;
  } else if (failed.length > 0) {
    dock = (
      <AnswerDock>
        <p className="dock-line warn" role="status">
          Your answer was not applied. Your words are kept.
        </p>
        <button
          type="button"
          className="btn dock-next"
          onClick={() => document.getElementById('ws-conflict')?.scrollIntoView({ block: 'start' })}
        >
          Review change
        </button>
      </AnswerDock>
    );
  } else if (composing && shape && verdict) {
    const voice = !dictation.unavailable();
    const reason = activeField === 'reason';
    const placeholder = reason
      ? 'Why are you changing it?'
      : mode === 'correction'
        ? 'Write the corrected answer'
        : shape.textIsAnswer
          ? voice
            ? 'Type or hold to talk'
            : 'Type an answer'
          : 'Add a note';
    const focusedPlaceholder = reason
      ? 'Why are you changing it?'
      : mode === 'correction'
        ? 'Write the corrected answer'
        : shape.textIsAnswer
          ? 'Type an answer'
          : 'Add a note';
    const fieldNoun = reason
      ? 'reason'
      : shape.textIsAnswer || mode === 'correction'
        ? 'answer'
        : 'note';
    const fieldLabel = reason
      ? 'Reason for the change'
      : mode === 'correction'
        ? 'Corrected answer'
        : shape.textIsAnswer
          ? 'Answer'
          : 'Note';
    const two = shape.fields.length > 1;
    dock = (
      <AnswerDock>
        <Composer
          shape={shape}
          draft={draft}
          verdict={verdict}
          field={activeField}
          fieldLabel={fieldLabel}
          fieldNoun={fieldNoun}
          placeholder={placeholder}
          focusedPlaceholder={focusedPlaceholder}
          fieldTabs={
            two
              ? [
                  { id: 'text', label: 'Corrected answer' },
                  { id: 'reason', label: 'Reason · required' },
                ]
              : null
          }
          caption={mode === 'correction' && reason ? 'Reason · required' : null}
          dict={mine}
          voice={voice}
          stale={stale}
          error={error}
          sending={busy}
          // The choice is pinned beside the field in both modes; a correction marks the answer in force.
          options={
            (offerChoices || (inCorrection && shape.hasOptions)) && content
              ? content.options.map((o) => ({ id: o.id, label: o.label }))
              : null
          }
          optionsLabel={
            inCorrection
              ? 'Corrected answer'
              : content?.kind === 'approval'
                ? 'Your decision'
                : 'Choose one'
          }
          currentOptions={inCorrection ? (currentContent?.selected_option_ids ?? []) : undefined}
          selected={draft.selected}
          disabled={busy}
          canUseOriginal={dictation.canUseOriginal(draft)}
          fieldRef={fieldRef}
          onSelect={select}
          onClearChoice={
            shape.mixed && draft.selected.length > 0 && draft.text.trim()
              ? () => drafts.edit(draft.key, { selected: [] })
              : null
          }
          onSend={send}
          onReviewUpdate={() => {
            void dictation.rebind(draft.key, view.revision);
            setError(null);
            announce('Updated. Your choice was cleared; review the question before sending.');
          }}
          onShowRemaining={() => galleryRef.current?.showFirstUnreviewed()}
          onDismissError={() => setError(null)}
          onField={setField}
          onDictate={toggleDictation}
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
      </AnswerDock>
    );
  } else if (modelReview && proxy) {
    // Confirm and Overrule live on the model's message; moving on stays here, quieter than Confirm.
    dock = <AnswerDock>{moveOn(false)}</AnswerDock>;
  } else {
    // Answered, expired or withdrawn: the thread says which; the dock offers the next question.
    dock = <AnswerDock>{moveOn(true)}</AnswerDock>;
  }

  /* ---------- the thread ---------- */

  const soon =
    status === 'open' && !!view.expiresAt && Date.parse(view.expiresAt) - now < 24 * 3_600_000;
  const due =
    status === 'open' && view.expiresAt ? (
      <span className={soon ? 'due soon' : 'due'}>
        <ClockIcon size={13} />
        {dueLabel(view.expiresAt, now)}
      </span>
    ) : null;
  const inForce =
    (answer?.content as { selected_option_ids?: string[] } | null)?.selected_option_ids ?? [];
  const closed = status === 'expired' || status === 'cancelled';
  const items: ReactNode[] = [];
  if (content) {
    items.push(
      <AgentMessage
        key="question"
        view={view}
        now={now}
        headingRef={headingRef}
        files={<Gallery view={view} onReview={onReview} handleRef={galleryRef} />}
        context={content.context ? <MessageContext text={content.context} /> : undefined}
        choices={
          offerChoices ? (
            <OptionCards
              view={view}
              selected={draft.selected}
              onSelect={select}
              disabled={stale || busy}
              legend={content.kind === 'approval' ? 'Your decision' : 'Choose one'}
            />
          ) : (
            <StaticChoices
              view={view}
              chosen={
                pendingEntry && pendingEntry.kind !== 'confirm-proxy'
                  ? pendingEntry.selected
                  : inForce
              }
              caption={closed ? 'The options were' : undefined}
            />
          )
        }
        meta={due}
      />,
    );
    // The gate matters while the question is open: no model will step in, so it waits for a person.
    if (status === 'open' && view.requirement === 'human-required')
      items.push(
        <SystemLine
          key="gate"
          now={now}
          icon={<PersonIcon size={14} />}
          detail="The decision model doesn’t answer this one."
        >
          Human decision required
        </SystemLine>,
      );
    if (view.integrityIssues.length > 0)
      items.push(
        <SystemLine
          key="integrity"
          now={now}
          tone="warn"
          icon={<WarningIcon size={14} />}
          detail={
            <ul className="plain">
              {view.integrityIssues.slice(0, 4).map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          }
        >
          Some activity could not be verified
        </SystemLine>,
      );
    for (const a of view.actions) {
      if (!a.verified) {
        items.push(
          <SystemLine key={a.actionId} now={now} tone="warn" icon={<WarningIcon size={14} />}>
            An action could not be verified and was ignored
          </SystemLine>,
        );
        continue;
      }
      const isCurrent = a === answer;
      if (a.action === 'answer' || a.action === 'override') {
        items.push(
          <HumanAnswer
            key={a.actionId}
            view={view}
            a={a}
            now={now}
            receipt={isCurrent && progress ? <Receipt progress={progress} fromPhone /> : undefined}
            flagged={isCurrent && progress?.step === 'attention'}
          />,
        );
      } else if (a.action === 'proxy-answer') {
        items.push(
          <ModelMessage
            key={a.actionId}
            view={view}
            a={a}
            now={now}
            review={modelReview && a === proxy && !confirmed && !pendingEntry}
            busy={busy}
            error={confirmError}
            onConfirm={() => void confirmModel()}
            onOverrule={canCorrect ? startCorrection : undefined}
            receipt={
              isCurrent && progress ? <Receipt progress={progress} fromPhone={false} /> : undefined
            }
          />,
        );
      } else if (a.action === 'proxy-abstain') {
        items.push(
          <SystemLine
            key={a.actionId}
            now={now}
            at={a.createdAt}
            icon={
              <span className="model-mark">
                <ModelIcon size={12} />
              </span>
            }
          >
            The decision model left it to you
          </SystemLine>,
        );
      } else if (a.action === 'confirm-proxy') {
        items.push(
          <OutgoingMessage key={a.actionId} at={a.createdAt} now={now}>
            <p className="answer-text">Confirmed the model answer</p>
            {a.content?.reason && <SafeText text={a.content.reason} className="answer-reason" />}
          </OutgoingMessage>,
        );
      } else if (a.action === 'cancel') {
        items.push(
          <SystemLine
            key={a.actionId}
            now={now}
            at={a.createdAt}
            icon={<UndoIcon size={14} />}
            detail="No answer is needed, and nothing was approved here."
          >
            Withdrawn by your agent
          </SystemLine>,
        );
      } else if (a.action === 'reopen') {
        items.push(
          <SystemLine key={a.actionId} now={now} at={a.createdAt} icon={<RefreshIcon size={14} />}>
            Reopened by your agent
          </SystemLine>,
        );
      }
    }
    if (status === 'expired' && view.expiresAt)
      items.push(
        <SystemLine
          key="expired"
          now={now}
          at={view.expiresAt}
          icon={<ClockIcon size={14} />}
          detail="Nothing was approved. To decide now, ask your agent again from your computer."
        >
          Expired without an answer
        </SystemLine>,
      );
    if (pendingEntry) {
      const queuedOffline = pendingEntry.state === 'queued' && !navigator.onLine;
      items.push(
        <OutgoingMessage
          key="pending"
          now={now}
          tone="pending"
          id="ws-answer"
          label={pendingEntry.kind === 'override' ? 'Changed answer' : undefined}
          receipt={
            pendingProgress ? (
              <Receipt
                progress={pendingProgress}
                fromPhone
                steps={pendingEntry.kind !== 'confirm-proxy'}
                note={queuedOffline ? 'Sends when you’re back online' : undefined}
              />
            ) : undefined
          }
        >
          {pendingEntry.kind === 'confirm-proxy' ? (
            <p className="answer-text">Confirmed the model answer</p>
          ) : (
            <AnswerBody
              view={view}
              content={{
                content_version: 1,
                selected_option_ids: pendingEntry.selected,
                text: pendingEntry.text.trim() || undefined,
                reviewed_attachment_digests: [],
                reason: pendingEntry.reason.trim() || undefined,
              }}
            />
          )}
        </OutgoingMessage>,
      );
    }
    for (const e of failed)
      items.push(
        <div key={e.id} className="msg out wide">
          <ConflictCard
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
        </div>,
      );
    if (composing && mode === 'answer' && stale)
      items.push(
        <SystemLine
          key="stale"
          now={now}
          tone="warn"
          icon={<WarningIcon size={14} />}
          detail={
            <button
              type="button"
              className="btn small"
              onClick={() => void dictation.rebind(draft.key, view.revision)}
            >
              Review update
            </button>
          }
        >
          This question changed. Your draft is saved; review the update before sending.
        </SystemLine>,
      );
    if (inCorrection && shape)
      items.push(
        <div key="correction" className="msg out wide">
          <CorrectionArea
            view={view}
            answerContent={answer?.content ?? null}
            // The answer in force is already in the thread just above.
            showCurrent={false}
            draft={correctionDraft}
            hasOptions={shape.hasOptions}
            reasonInPage={shape.fields.length > 1}
            onSelect={select}
            onReason={() => {
              setField('reason');
              setTimeout(() => fieldRef.current?.focus(), 0);
            }}
            onCancel={() => {
              if (dictation.isActive()) void dictation.stop();
              setCorrecting(false);
            }}
            onDiscard={() => setDiscardOpen(true)}
          />
        </div>,
      );
    if (closed && answerDraft.text.trim())
      items.push(
        <OutgoingMessage key="draft" now={now} tone="draft" label="Unsent draft">
          <SafeText text={answerDraft.text} className="answer-text" />
          <div className="row">
            <CopyButton text={answerDraft.text} />
          </div>
        </OutgoingMessage>,
      );
  }

  // On open, a question still waiting for an answer starts at the question; anything else shows its latest item
  // (a reply, a model answer, an expiry line): all of it when it fits, otherwise from its start. Later, a new item
  // or a delivery change that grows the latest one (a problem and its explanation) is brought into view when it is
  // the person's own reply or when they were already following the end. Someone reading further up keeps their
  // place, and "New activity" offers the way down.
  // What counts as activity: the thread's items by identity (a gate line replaced by an expiry is activity even
  // though the count is the same) and the delivery steps of the answer in force and any pending reply.
  const itemKeys = items.map((it) => String((it as { key?: string | null }).key ?? ''));
  const keysKey = itemKeys.join('|');
  const lastKey = itemKeys[itemKeys.length - 1] ?? '';
  const deliveryKey = `${progress?.step ?? ''}/${pendingProgress?.step ?? ''}`;
  const waitingForAnswer = status === 'open' && !pendingEntry && failed.length === 0;
  const shownKeys = useRef<string | null>(null);
  const shownDelivery = useRef(deliveryKey);
  const following = useRef(true);
  const [newBelow, setNewBelow] = useState(false);
  const atEnd = (b: HTMLElement) => b.scrollHeight - b.scrollTop - b.clientHeight < 96;
  const onBodyScroll = () => {
    const b = bodyRef.current;
    if (!b) return;
    following.current = atEnd(b);
    if (following.current && newBelow) setNewBelow(false);
  };
  /** The latest item: all of it when it fits, otherwise from its start (`end` shows its end instead). */
  const showLatest = (smooth: boolean, end = false) => {
    const body = bodyRef.current;
    const thread = threadRef.current;
    if (!body || !thread) return;
    const all = thread.querySelectorAll<HTMLElement>(':scope > .msg');
    const latest = all[all.length - 1];
    const max = body.scrollHeight - body.clientHeight;
    if (max <= 0) return;
    const top =
      latest && !end
        ? latest.getBoundingClientRect().top -
          body.getBoundingClientRect().top +
          body.scrollTop -
          12
        : max;
    const to = Math.min(max, Math.max(0, top));
    if (smooth) body.scrollTo({ top: to, behavior: reducedMotion() ? 'auto' : 'smooth' });
    else body.scrollTop = to;
    following.current = max - to < 96;
  };
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !threadRef.current) return;
    const first = shownKeys.current === null;
    const before = new Set((shownKeys.current ?? '').split('|'));
    // Something new arrived (an item that wasn't there before); a removal alone is not activity.
    const added = itemKeys.filter((k) => !before.has(k));
    const itemsChanged = added.length > 0;
    const deliveryChanged = deliveryKey !== shownDelivery.current;
    shownKeys.current = keysKey;
    shownDelivery.current = deliveryKey;
    if (first) {
      if (waitingForAnswer) body.scrollTop = 0;
      else showLatest(false);
      following.current = atEnd(body);
      return;
    }
    if (!itemsChanged && !deliveryChanged) return;
    // The person's own reply is always followed; anything else only while they are following the end.
    const mine = added.includes(lastKey) && (lastKey === 'pending' || lastKey === 'correction');
    if (mine || following.current) {
      // A delivery change grows the end of the latest reply (its receipt or problem): show that end.
      showLatest(true, deliveryChanged && !itemsChanged);
      setNewBelow(false);
    } else setNewBelow(true);
  }, [keysKey, deliveryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Delivery outcomes are announced once, when they happen: typed into the terminal, or needing attention, for the
  // person's answer or the model's. The steps in between stay silent, and an outcome already reached when the
  // question opens is not repeated.
  const outcomeKey = answer && progress ? `${answer.actionId}:${progress.step}` : '';
  const lastOutcome = useRef(outcomeKey);
  useEffect(() => {
    const prev = lastOutcome.current;
    lastOutcome.current = outcomeKey;
    if (!outcomeKey || outcomeKey === prev || !answer || !progress) return;
    const subject = answer.provenance === 'proxy' ? 'The model answer' : 'Your answer';
    if (progress.step === 'terminal') announce(`${subject} was typed into the terminal.`);
    else if (progress.step === 'attention')
      announce(`${progress.label}. Open Daintree on your computer to see what happened.`);
  }, [outcomeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={rootRef} className="ws" data-state={composing ? 'compose' : status}>
      <WorkspaceHeader
        project={project}
        machine={machine}
        excerpt={excerpt}
        showExcerpt={headingAway}
        onExcerpt={() => {
          bodyRef.current?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
          headingRef.current?.focus({ preventScroll: true });
        }}
        back={cameFromApp()}
        menu={menu}
      />
      <Sheet
        open={activityOpen}
        title="Activity"
        onClose={() => setActivityOpen(false)}
        className="activity-sheet"
      >
        {activityOpen && <ActivityTimeline view={view} now={now} />}
      </Sheet>
      <Sheet open={detailsOpen} title="Question details" onClose={() => setDetailsOpen(false)}>
        {detailsOpen && <QuestionDetails view={view} />}
      </Sheet>
      <div className="ws-body" ref={bodyRef} onScroll={onBodyScroll}>
        <article className="ws-column" aria-labelledby={content ? 'q-title' : undefined}>
          {!verified && <TrustState view={view} headingRef={headingRef} />}
          {content && <Thread ref={threadRef}>{items}</Thread>}
        </article>
        {newBelow && (
          <button
            type="button"
            className="new-activity"
            onClick={() => {
              setNewBelow(false);
              showLatest(true);
            }}
          >
            New activity
            <ChevronDown size={16} />
          </button>
        )}
      </div>
      <div id="workspace-overlay" className="ws-overlay" />
      {dock}
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
