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
import { useWide } from '../../app/media.js';
import { StaleQuestionError } from '../../domain/answer.js';
import {
  composeShape,
  verdict as computeVerdict,
  type ComposeMode,
  type FieldId,
} from '../../domain/compose.js';
import type { QuestionView } from '../../domain/model.js';
import { choiceLine } from '../../domain/lists.js';
import { ThreadClosedError } from '../../domain/message.js';
import {
  agentName,
  canOverrule,
  currentAnswer,
  deliveryProgress,
  effectiveStatus,
  lastProxyAction,
  messageProgress,
  originParts,
  pendingAsk,
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
  AgentNote,
  HumanAnswer,
  MessageContext,
  ModelMessage,
  OutgoingMessage,
  StaticChoices,
  SystemLine,
  Thread,
} from './Thread.js';
import { useKeyboardInset } from './useKeyboardInset.js';
import {
  TerminalButton,
  TerminalDrawer,
  terminalModalOpen,
  useTerminalServed,
} from './TerminalDrawer.js';
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
  const [terminalOpen, setTerminalOpen] = useState(false);
  const terminalServed = useTerminalServed();
  const wide = useWide();
  // The drawer belongs to the question it was opened on.
  useEffect(() => setTerminalOpen(false), [id]);
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
  const isRefused = (e: (typeof entries)[number]) =>
    e.state === 'conflicted' || e.state === 'rejected' || e.state === 'expired';
  // The person's answer (or confirmation) on its way, and the follow-ups queued behind it: separate lanes.
  const actionEntries = entries.filter((e) => e.kind !== 'message');
  const pendingEntry = actionEntries.find((e) => e.state === 'queued' || e.state === 'sending');
  const failed = actionEntries.filter(isRefused);
  const sentIds = new Set(view.messages.map((m) => m.messageId));
  const messageEntries = entries.filter(
    (e) => e.kind === 'message' && !(e.messageId && sentIds.has(e.messageId)),
  );
  const pendingMessages = messageEntries.filter(
    (e) => e.state === 'queued' || e.state === 'sending',
  );
  const failedMessages = messageEntries.filter(isRefused);
  /** One identity per follow-up from the moment it is queued: its signed message id, the same once committed. */
  const messageKey = (e: (typeof entries)[number]) => e.messageId ?? `pm:${e.id}`;
  const pendingKeys = new Set(pendingMessages.map(messageKey));
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
  // Only a model answer can be replaced, by overruling it; the person's own answer is final, and anything more they
  // want to say is a follow-up.
  const canCorrect =
    verified && !!content && kind === 'override' && canOverrule(view, now) && !pendingEntry;
  const ask = pendingAsk(view, now);
  const followUps = app.followUpsFor(view);
  // Follow-ups open once the decision is made (sent or on its way), while the thread takes messages. A model answer
  // still awaiting review is decided first (Confirm or Overrule), unless the agent is asking the person something.
  const decided =
    status === 'human-answered' ||
    (status === 'proxy-answered' && (!modelReview || !!ask)) ||
    (status === 'open' && !!pendingEntry);
  const canFollowUp =
    verified && !!content && followUps === 'yes' && failed.length === 0 && decided;

  const answerDraft = useDraft(id, 'answer', view.revision);
  const correctionDraft = useDraft(id, 'correction', view.revision);
  const messageDraft = useDraft(id, 'message', view.revision);
  const inCorrection = correcting && canCorrect;
  const following = canFollowUp && !inCorrection;
  const mode: ComposeMode = inCorrection ? 'correction' : following ? 'message' : 'answer';
  const draft = inCorrection ? correctionDraft : following ? messageDraft : answerDraft;
  const composing =
    verified &&
    !!content &&
    (following || (!pendingEntry && failed.length === 0 && (status === 'open' || inCorrection)));
  const shape = content ? composeShape(content, mode) : null;
  const activeField: FieldId =
    field && shape?.fields.includes(field) ? field : (shape?.fields[0] ?? 'text');
  const mine = dictAll.binding?.key === draft.key ? dictAll : null;
  const capturing = composing ? dictation.busyFor(draft.key) : false;
  // A follow-up is about the thread, not a revision: a newer revision never holds it back.
  const stale = composing && mode !== 'message' && draft.loaded && draft.revision !== view.revision;
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
  // The decision in force, in one line: the header keeps it in view while the follow-ups after it scroll by. The
  // header is narrow, so the choice leads and a note only stands in when there is no choice.
  const answerLine = (() => {
    const short = (selected: string[], text: string) =>
      selected.length ? choiceLine(view, selected, '') : choiceLine(view, [], text) || 'No note';
    if (pendingEntry && pendingEntry.kind !== 'confirm-proxy')
      return `Answer: ${short(pendingEntry.selected, pendingEntry.text)}`;
    if (!answer) return null;
    const c = answer.content as { selected_option_ids?: string[]; text?: string } | null;
    const line = short(c?.selected_option_ids ?? [], c?.text ?? '');
    return `${answer.provenance === 'proxy' ? 'Model answer' : 'Answer'}: ${line}`;
  })();
  const offerChoices = composing && mode === 'answer' && !!shape?.hasOptions;

  // A draft emptied by a revision change simply follows the question; one with words in it waits for Review update.
  // Capture for it settles first: words still arriving belong to the revision they were spoken for.
  const settling = dictation.busyFor(draft.key);
  // A follow-up draft follows the question's revision whenever nothing is being captured into it.
  useEffect(() => {
    if (!composing || !draft.loaded || draft.revision === view.revision || settling) return;
    const empty = !draft.text.trim() && !draft.reason.trim() && !draft.selected.length;
    if (empty || mode === 'message') drafts.rebind(draft.key, view.revision);
  }, [composing, draft, view.revision, settling, mode]);

  // The question changed or closed under a running dictation: stop, keep the words, lock Send. A follow-up only
  // stops when the thread closes.
  useEffect(() => {
    const b = dictation.getState().binding;
    if (!b || b.questionId !== id || !dictation.isActive()) return;
    if (!composing || (b.mode !== 'message' && b.revision !== view.revision))
      void dictation.stop(MESSAGES.changed);
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

  const sendFollowUp = async () => {
    if (!verdict?.canSend) return;
    const d = drafts.get(draft.key)!;
    if (dictation.busyFor(d.key)) return;
    setBusy(true);
    setError(null);
    try {
      await app.sendMessage({ view, text: d.text });
      dictation.release(d.key);
      await drafts.sent(d.key);
      announce(
        navigator.onLine
          ? 'Your follow-up is queued and sending.'
          : 'Queued on this device. It will send when you’re back online.',
      );
    } catch (e) {
      setError(
        e instanceof ThreadClosedError
          ? 'This question no longer takes messages. Your words are kept.'
          : e instanceof Error
            ? e.message
            : 'Could not prepare your follow-up.',
      );
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!shape || !verdict) return;
    if (mode === 'message') return sendFollowUp();
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
      // The terminal drawer covers the chat: nothing behind it, the dock included, takes a command meanwhile.
      if (mod && terminalModalOpen()) return;
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
  } else if (pendingEntry && !following) {
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
    const message = mode === 'message';
    // A follow-up names who it goes to when the agent is waiting on it; otherwise it is plainly something more.
    const followUp = ask ? `Reply to ${agentName(view)}` : 'Add a follow-up';
    const placeholder = reason
      ? 'Why are you changing it?'
      : message
        ? followUp
        : mode === 'correction'
          ? 'Write the corrected answer'
          : shape.textIsAnswer
            ? voice
              ? 'Type or hold to talk'
              : 'Type an answer'
            : 'Add a note';
    const focusedPlaceholder = reason
      ? 'Why are you changing it?'
      : message
        ? followUp
        : mode === 'correction'
          ? 'Write the corrected answer'
          : shape.textIsAnswer
            ? 'Type an answer'
            : 'Add a note';
    const fieldNoun = reason
      ? 'reason'
      : message
        ? ask
          ? 'reply'
          : 'follow-up'
        : shape.textIsAnswer || mode === 'correction'
          ? 'answer'
          : 'note';
    const fieldLabel = reason
      ? 'Reason for the change'
      : message
        ? ask
          ? 'Reply'
          : 'Follow-up'
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
          // A follow-up is a chat message: Send, named in full for assistive tech, keeps the save state beside it on
          // one line. The bubble it becomes says "Follow-up".
          sendLabel={message ? 'Send' : undefined}
          sendName={message ? (ask ? 'Send reply' : 'Send follow-up') : undefined}
          above={
            // Once the answer is on its way, moving on stays one tap away beside the follow-up.
            message && next ? (
              <button type="button" className="btn small ghost dock-next-quiet" onClick={goNext}>
                Next question
                <ArrowRight size={16} />
              </button>
            ) : undefined
          }
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
  } else if (decided && followUps === 'desktop') {
    // The relay takes follow-ups, but the computer that asked can't type them into the terminal yet.
    dock = (
      <AnswerDock>
        <p className="dock-line">Follow-ups need a newer Daintree on the computer that asked.</p>
        {moveOn(true)}
      </AnswerDock>
    );
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
    // Answers, model answers, lifecycle lines and the thread's messages, in ledger order.
    const timeline: (
      | { seq: number; a: (typeof view.actions)[number] }
      | { seq: number; m: (typeof view.messages)[number] }
    )[] = [
      ...view.actions.map((a) => ({ seq: a.seq, a })),
      ...view.messages.map((m) => ({ seq: m.seq, m })),
    ].sort((x, y) => x.seq - y.seq);
    /** The answer each new one replaces, as the loop walks the ledger. */
    let replaced: (typeof view.actions)[number] | null = null;
    let lastAnswer: (typeof view.actions)[number] | null = null;
    for (const t of timeline) {
      if ('a' in t && t.a.verified && ['answer', 'override', 'proxy-answer'].includes(t.a.action)) {
        replaced = lastAnswer;
        lastAnswer = t.a;
      }
      if ('m' in t) {
        const m = t.m;
        if (!m.verified) {
          items.push(
            <SystemLine key={m.messageId} now={now} tone="warn" icon={<WarningIcon size={14} />}>
              A message could not be verified and was ignored
            </SystemLine>,
          );
        } else if (m.side === 'agent') {
          items.push(
            <AgentNote key={m.messageId} view={view} m={m} now={now} asking={ask === m} />,
          );
        } else {
          const p = messageProgress(m);
          items.push(
            <OutgoingMessage
              key={m.messageId}
              id={`ws-msg-${m.messageId}`}
              at={m.createdAt}
              now={now}
              label="Follow-up"
              flagged={p.step === 'attention'}
              // Every follow-up keeps its own receipt: each is typed (or held) on its own.
              receipt={<Receipt progress={p} fromPhone subject="Your follow-up" />}
            >
              <SafeText text={m.text} className="answer-text" />
            </OutgoingMessage>,
          );
        }
        continue;
      }
      const a = t.a;
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
            // Overruling the model makes it the person's answer; only an older app's correction of their own
            // answer reads as a changed one.
            changed={a.action === 'override' && replaced?.provenance !== 'proxy'}
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
          at={new Date(pendingEntry.createdAt).toISOString()}
          now={now}
          tone="pending"
          id="ws-answer"
          label={pendingEntry.kind === 'confirm-proxy' ? undefined : 'Your answer'}
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
    for (const e of pendingMessages) {
      const queuedOffline = e.state === 'queued' && !navigator.onLine;
      items.push(
        <OutgoingMessage
          key={messageKey(e)}
          at={new Date(e.createdAt).toISOString()}
          now={now}
          tone="pending"
          label="Follow-up"
          receipt={
            <Receipt
              progress={messageProgress(null, e.state as 'queued' | 'sending')}
              fromPhone
              subject="Your follow-up"
              note={queuedOffline ? 'Sends when you’re back online' : undefined}
            />
          }
        >
          <SafeText text={e.text} className="answer-text" />
        </OutgoingMessage>,
      );
    }
    for (const e of failedMessages) {
      const closedThread = e.errorCode === 'invalid_state' || e.state === 'expired';
      items.push(
        <OutgoingMessage
          key={messageKey(e)}
          at={new Date(e.createdAt).toISOString()}
          now={now}
          tone="failed"
          label="Follow-up · not sent"
        >
          <SafeText text={e.text} className="answer-text" />
          <div className="msg-failure" role="alert">
            <WarningIcon size={14} />
            <span>
              {e.state === 'expired'
                ? 'Not sent: the question expired first.'
                : closedThread
                  ? 'Not sent: this question no longer takes messages.'
                  : 'Not sent: your relay refused it.'}
            </span>
          </div>
          <div className="row">
            {!closedThread && (
              <button
                type="button"
                className="btn small"
                onClick={() => void app.outbox?.retry(e.id)}
              >
                Try again
              </button>
            )}
            <CopyButton text={e.text} />
            <button
              type="button"
              className="btn small ghost"
              onClick={() => void app.outbox?.discard(e.id)}
            >
              Remove
            </button>
          </div>
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
            canCorrect={canCorrect}
            onSendAsFollowUp={
              followUps === 'yes' && answer && answer.provenance !== 'proxy'
                ? () => {
                    const words = [
                      e.selected
                        .map((o) => content.options.find((x) => x.id === o)?.label ?? o)
                        .join(', '),
                      e.text.trim(),
                    ]
                      .filter(Boolean)
                      .join('\n\n');
                    if (!hasWords(messageDraft)) drafts.edit(messageDraft.key, { text: words });
                    void app.outbox?.discard(e.id);
                  }
                : undefined
            }
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
    if (closed && messageDraft.text.trim())
      items.push(
        <OutgoingMessage key="mdraft" now={now} tone="draft" label="Unsent follow-up">
          <SafeText text={messageDraft.text} className="answer-text" />
          <div className="row">
            <CopyButton text={messageDraft.text} />
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
  const sentFollowUps = view.messages.filter((m) => m.verified && m.side === 'human');
  const latestFollowUp = sentFollowUps.at(-1);
  // Every follow-up's step counts: one further up needing attention is activity too.
  const deliveryKey = `${progress?.step ?? ''}/${pendingProgress?.step ?? ''}/${sentFollowUps
    .map((m) => messageProgress(m).step)
    .join(',')}`;
  const waitingForAnswer =
    status === 'open' && !pendingEntry && failed.length === 0 && view.messages.length === 0;
  const shownKeys = useRef<string | null>(null);
  const shownDelivery = useRef(deliveryKey);
  // A follow-up that has just come to need attention is where "New activity" leads, even when later messages
  // followed it: its explanation sits under it, not at the end.
  const followSteps = new Map(sentFollowUps.map((m) => [m.messageId, messageProgress(m).step]));
  const shownSteps = useRef<Map<string, string> | null>(null);
  const stuckTarget = useRef<string | null>(null);
  const followingEnd = useRef(true);
  const [newBelow, setNewBelow] = useState(false);
  const atEnd = (b: HTMLElement) => b.scrollHeight - b.scrollTop - b.clientHeight < 96;
  const onBodyScroll = () => {
    const b = bodyRef.current;
    if (!b) return;
    followingEnd.current = atEnd(b);
    if (followingEnd.current && newBelow) setNewBelow(false);
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
    followingEnd.current = max - to < 96;
  };
  /** One item, from its start (`id` is its element's), as `showLatest` shows the latest. */
  const showItem = (id: string, smooth: boolean): boolean => {
    const body = bodyRef.current;
    const el = document.getElementById(id);
    if (!body || !el) return false;
    const max = body.scrollHeight - body.clientHeight;
    const top =
      el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 12;
    const to = Math.min(Math.max(0, max), Math.max(0, top));
    if (smooth) body.scrollTo({ top: to, behavior: reducedMotion() ? 'auto' : 'smooth' });
    else body.scrollTop = to;
    followingEnd.current = max - to < 96;
    return true;
  };
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !threadRef.current) return;
    const first = shownKeys.current === null;
    const priorSteps = shownSteps.current;
    shownSteps.current = followSteps;
    // The earliest follow-up that needs attention and did not before (on open: any that does), unless it is the
    // latest item anyway.
    const stuck = sentFollowUps.find(
      (m) =>
        followSteps.get(m.messageId) === 'attention' &&
        (first || priorSteps?.get(m.messageId) !== 'attention'),
    );
    const stuckId = stuck && stuck.messageId !== lastKey ? `ws-msg-${stuck.messageId}` : null;
    const before = new Set((shownKeys.current ?? '').split('|'));
    // Something new arrived (an item that wasn't there before); a removal alone is not activity.
    const added = itemKeys.filter((k) => !before.has(k));
    const itemsChanged = added.length > 0;
    const deliveryChanged = deliveryKey !== shownDelivery.current;
    shownKeys.current = keysKey;
    shownDelivery.current = deliveryKey;
    if (first) {
      if (waitingForAnswer) body.scrollTop = 0;
      else if (!stuckId || !showItem(stuckId, false)) showLatest(false);
      followingEnd.current = atEnd(body);
      return;
    }
    if (!itemsChanged && !deliveryChanged) return;
    // The person's own reply is always followed; anything else only while they are following the end.
    const mine =
      added.includes(lastKey) &&
      (lastKey === 'pending' || lastKey === 'correction' || pendingKeys.has(lastKey));
    if (mine) {
      showLatest(true);
      setNewBelow(false);
    } else if (followingEnd.current) {
      // A follow-up further up that now needs attention is shown from its start; otherwise a delivery change grows
      // the end of the latest reply (its receipt or problem): show that end.
      if (!stuckId || !showItem(stuckId, true)) showLatest(true, deliveryChanged && !itemsChanged);
      setNewBelow(false);
    } else {
      if (stuckId) stuckTarget.current = stuckId;
      setNewBelow(true);
    }
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

  // The same for the latest follow-up: typed, or needing attention, once each.
  const followKey = latestFollowUp
    ? `${latestFollowUp.messageId}:${messageProgress(latestFollowUp).step}`
    : '';
  const lastFollow = useRef(followKey);
  useEffect(() => {
    const prev = lastFollow.current;
    lastFollow.current = followKey;
    if (!followKey || followKey === prev || !latestFollowUp) return;
    const p = messageProgress(latestFollowUp);
    if (p.step === 'terminal') announce('Your follow-up was typed into the terminal.');
    else if (p.step === 'attention')
      announce(`${p.label}. Open Daintree on your computer to see what happened.`);
  }, [followKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={rootRef}
      className="ws"
      data-state={composing ? 'compose' : status}
      data-terminal={terminalOpen && wide ? 'docked' : undefined}
    >
      <WorkspaceHeader
        project={project}
        machine={machine}
        excerpt={excerpt}
        answerLine={answerLine}
        showExcerpt={headingAway}
        onExcerpt={() => {
          bodyRef.current?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
          headingRef.current?.focus({ preventScroll: true });
        }}
        back={cameFromApp()}
        terminal={
          terminalServed && verified ? (
            <TerminalButton
              view={view}
              open={terminalOpen}
              docked={wide}
              onOpen={() => setTerminalOpen((o) => !o)}
            />
          ) : undefined
        }
        menu={menu}
      />
      {terminalServed && verified && (
        <TerminalDrawer
          view={view}
          open={terminalOpen}
          docked={wide}
          onClose={() => setTerminalOpen(false)}
        />
      )}
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
              const target = stuckTarget.current;
              stuckTarget.current = null;
              if (!target || !showItem(target, true)) showLatest(true);
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
