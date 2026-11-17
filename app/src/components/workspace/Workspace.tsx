import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { isPersonDecline, type HumanAnswerContentV1 } from '@daintreehq/decisions-protocol';
import { app } from '../../app/controller.js';
import { entryImages, type OutboxEntry } from '../../data/outbox.js';
import { photoCount, PHOTOS_PER_MESSAGE, PHOTOS_PER_QUESTION } from '../../data/photos.js';
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
import type { ActionView, QuestionView } from '../../domain/model.js';
import { choiceLine } from '../../domain/lists.js';
import { ThreadClosedError } from '../../domain/message.js';
import {
  agentName,
  canOverrule,
  currentAnswer,
  DELIVERY_LABELS,
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
import { drafts, readyPhotos, useDraft } from '../../features/compose/draftStore.js';
import { dictation, MESSAGES, useDictation, type Binding } from '../../features/voice/dictation.js';
import { announce } from '../../lib/announce.js';
import { useCamera } from '../../lib/camera.js';
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
import { DraftPhotoStrip, PhotoGrid, type PhotoUpload } from './Photos.js';
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
import { WorkspaceHeader, type HeaderAnswer, type MenuItem } from './WorkspaceHeader.js';

/** The gallery's review report: `digests` are the files both verified and actually presented. */
type Review = ReviewState;
const Gallery = AttachmentGallery;

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The question workspace for `/q/:id`. Keyed by id, so another question is always a fresh workspace. */

/** Whether a native modal dialog is open anywhere (`:modal`), so the chat behind it is inert to its shortcuts. */
const modalOpen = (): boolean => {
  try {
    return !!document.querySelector(':modal');
  } catch {
    return !!document.querySelector('dialog[open]');
  }
};

/** Messages from the agent this close together read as one turn: its name shows once. */
const GROUP_WITHIN_MS = 5 * 60_000;

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
  const [filesOpen, setFilesOpen] = useState(false);
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
  /** The revision the person was looking at when they chose Dismiss: what the decline is signed against. */
  const [declineAt, setDeclineAt] = useState<number | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineError, setDeclineError] = useState<string | null>(null);
  const [headingAway, setHeadingAway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  /** Why a refused answer's words and photos stayed where they were when the person tried to move them. */
  const [handOverNote, setHandOverNote] = useState<string | null>(null);
  const handingOver = useRef(new Set<string>());
  const onReview = useCallback((s: Review) => setReview(s), []);

  const status = effectiveStatus(view, now);
  const verified = view.verification.ok;
  const content = view.content;
  const entries = app.outbox!.forQuestion(id);
  const isRefused = (e: (typeof entries)[number]) =>
    e.state === 'conflicted' || e.state === 'rejected' || e.state === 'expired';
  // The person's answer (or confirmation) on its way, and the follow-ups queued behind it: separate lanes.
  const actionEntries = entries.filter((e) => e.kind !== 'message');
  // An answer the relay has committed is the thread's own from then on, even while its local copy is being let go.
  const committed = new Set(view.actions.map((a) => a.actionId));
  const onItsWay = (e: OutboxEntry) =>
    e.state === 'queued' || e.state === 'sending' || e.state === 'committed';
  const pendingEntry = actionEntries.find(
    (e) => onItsWay(e) && !(e.recordId && committed.has(e.recordId)),
  );
  const failed = actionEntries.filter(isRefused);
  const sentIds = new Set(view.messages.map((m) => m.messageId));
  const messageEntries = entries.filter(
    (e) => e.kind === 'message' && !(e.messageId && sentIds.has(e.messageId)),
  );
  const pendingMessages = messageEntries.filter(onItsWay);
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
  // On the relay but not yet read back here: that is exactly what the receipt says.
  const pendingProgress =
    app.store && pendingEntry
      ? pendingEntry.state === 'committed'
        ? { step: 'confirmed' as const, label: DELIVERY_LABELS.confirmed }
        : deliveryProgress(view, app.store, pendingEntry.state as 'queued' | 'sending')
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
  // Photos go with an answer, a correction or a follow-up, when the desktop that asked takes them.
  const camera = useCamera();
  const photosAllowed = composing && app.photosFor(view);
  // Every photo the question has taken, or has on its way from here, counts against its lifetime limit.
  const unsentEntries = entries.filter((e) => !(e.messageId && sentIds.has(e.messageId)));
  const photosUsed =
    view.actions.reduce(
      (n, a) =>
        n + (a.verified ? ((a.content as HumanAnswerContentV1 | null)?.images?.length ?? 0) : 0),
      0,
    ) +
    view.messages.reduce((n, m) => n + m.images.length, 0) +
    unsentEntries.reduce((n, e) => n + (e.images?.length ?? 0), 0);
  const questionRoom = Math.max(0, PHOTOS_PER_QUESTION - photosUsed);
  const photoLimit = Math.min(PHOTOS_PER_MESSAGE, questionRoom);
  const photoRoom = Math.max(0, photoLimit - draft.photos.length);
  const photoNoun = mode === 'message' ? (ask ? 'reply' : 'follow-up') : 'answer';
  const preparingPhotos = draft.photos.some((p) => p.status === 'preparing');
  /**
   * Move a refused answer's words and photos into a draft, then let it go: only once everything has moved and the
   * draft is saved on this device. Words join whatever the draft already says; photos that can't be read or don't
   * fit keep the whole answer where it is, with the reason.
   */
  const handOver = async (
    e: OutboxEntry,
    key: string,
    words: string,
    patch?: { selected: string[] },
    /** Dismiss: the person is letting it go, so keep what can be kept, say what couldn't, and always let it go. */
    lossy = false,
  ) => {
    // One move at a time per answer: a second tap while one runs does nothing.
    if (handingOver.current.has(e.id)) return;
    handingOver.current.add(e.id);
    setHandOverNote(null);
    try {
      if (!(await drafts.whenLoaded(key))) {
        setHandOverNote('This device couldn’t open that draft, so your unsent answer stays here.');
        return;
      }
      const want = e.images?.length ?? 0;
      const read = want ? await app.queuedPhotos(e).catch(() => []) : [];
      const have = drafts.get(key)?.photos.length ?? 0;
      // Its photos free their own share of the question's lifetime allowance as they move.
      const room = Math.max(0, Math.min(PHOTOS_PER_MESSAGE, questionRoom + want) - have);
      const back = lossy ? read.slice(0, room) : read;
      if (lossy) {
        if (!(await drafts.mergeInto(key, words, back, patch))) {
          setHandOverNote('This device couldn’t save the draft, so your unsent answer stays here.');
          return;
        }
        if (back.length < want)
          drafts.notePhotos(key, {
            text:
              want - back.length === 1
                ? '1 of its photos couldn’t be kept.'
                : `${want - back.length} of its photos couldn’t be kept.`,
            tone: 'error',
          });
        await app.outbox?.discard(e.id);
        return;
      }
      if (back.length < want) {
        setHandOverNote(
          'Its photos couldn’t be read on this device, so your unsent answer stays here. Copy the words, or dismiss it.',
        );
        return;
      }
      if (back.length > room) {
        setHandOverNote(
          'There isn’t room for its photos there, so your unsent answer stays here. Copy the words, or dismiss it.',
        );
        return;
      }
      // Written and read back before anything on screen changes; only then does the refused answer go.
      if (!(await drafts.mergeInto(key, words, back, patch))) {
        setHandOverNote('This device couldn’t save the draft, so your unsent answer stays here.');
        return;
      }
      await app.outbox?.discard(e.id);
    } finally {
      handingOver.current.delete(e.id);
    }
  };
  // Once all of an entry's photos are on the relay, that is said once: the progress itself is never announced.
  for (const e of entries) {
    const n = e.images?.length ?? 0;
    if (!n || uploadedAnnounced.has(e.id) || (app.outbox?.imagesSent(e) ?? 0) < n) continue;
    uploadedAnnounced.add(e.id);
    queueMicrotask(() => announce(n === 1 ? 'Photo uploaded.' : `${n} photos uploaded.`));
  }
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
          photos: photosAllowed ? readyPhotos(draft).length : 0,
          preparing: photosAllowed && preparingPhotos,
        })
      : null;
  const next = nextQuestion(all, id, now);
  const { project, machine } = originParts(view);
  const excerpt = content ? previewText(content.question, 90) : '';
  // The decision in force, in one line: the header keeps it in view while the follow-ups after it scroll by. It is
  // said as Home's rows say it ("You: Keep Canopy · 2 photos", "Model: Changed"). The header is narrow, so the
  // choice and photos lead and a note only stands in when there is neither.
  const headerAnswer = ((): HeaderAnswer | null => {
    const short = (selected: string[], text: string, photos = 0) =>
      [choiceLine(view, selected, ''), photos ? photoCount(photos) : '']
        .filter(Boolean)
        .join(' · ') ||
      choiceLine(view, [], text) ||
      'No note';
    if (pendingEntry && pendingEntry.kind !== 'confirm-proxy')
      return {
        author: 'You',
        text: short(pendingEntry.selected, pendingEntry.text, pendingEntry.images?.length),
      };
    if (!answer) return null;
    const c = answer.content as HumanAnswerContentV1 | null;
    return {
      author: answer.provenance === 'proxy' ? 'Model' : 'You',
      text: short(c?.selected_option_ids ?? [], c?.text ?? '', c?.images?.length),
    };
  })();
  const offerChoices = composing && mode === 'answer' && !!shape?.hasOptions;
  // Short, self-contained choices live in the dock; described choices are read once in the thread.
  const compactChoices =
    !!content &&
    content.options.length <= 3 &&
    content.options.every((option) => !option.description && option.label.length <= 40);

  // A draft emptied by a revision change simply follows the question; one with words in it waits for Review update.
  // Capture for it settles first: words still arriving belong to the revision they were spoken for.
  const settling = dictation.busyFor(draft.key);
  // A follow-up draft follows the question's revision whenever nothing is being captured into it.
  useEffect(() => {
    if (!composing || !draft.loaded || draft.revision === view.revision || settling) return;
    // Photos are part of the draft: a photo-only answer waits for Review update like words do.
    const empty =
      !draft.text.trim() && !draft.reason.trim() && !draft.selected.length && !draft.photos.length;
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
    const io = new IntersectionObserver(
      ([e]) => {
        const away = !e!.isIntersecting;
        // The excerpt is going away under a keyboard user: their place is the question it pointed at.
        if (!away && document.activeElement?.closest('.ws-excerpt'))
          headingRef.current?.focus({ preventScroll: true });
        setHeadingAway(away);
      },
      {
        root,
        rootMargin: wide
          ? '0px'
          : `-${rootRef.current?.querySelector('.ws-head')?.clientHeight ?? 60}px 0px 0px`,
        threshold: 0,
      },
    );
    io.observe(h);
    return () => io.disconnect();
  }, [content, wide]);

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
      await app.sendMessage({ view, text: d.text, photos: photosAllowed ? readyPhotos(d) : [] });
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
        photos: photosAllowed ? readyPhotos(d) : [],
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
      // A modal layer (the sidebar, the navigator, a sheet, a confirmation, the terminal drawer) covers the chat:
      // nothing behind it, the dock included, takes a command meanwhile. A layer that wants a shortcut handles it.
      if (mod && (terminalModalOpen() || modalOpen())) return;
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
  // Declining is deliberate and final, so it lives here behind a confirmation, never in the composer.
  if (status === 'open' && verified && !pendingEntry)
    menu.push({
      label: 'Dismiss question…',
      onSelect: () => {
        setDeclineError(null);
        setDeclineAt(view.revision);
      },
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
  /** Moving on stays a quiet, thumb-reachable action after an answer is on its way. */
  const moveOn = () =>
    next ? (
      <button type="button" className="btn dock-next" onClick={goNext}>
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
        {next && moveOn()}
      </AnswerDock>
    );
  } else if (pendingEntry && !following) {
    // The reply and its receipt are in the thread; the dock offers what comes next.
    dock = <AnswerDock>{moveOn()}</AnswerDock>;
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
            ? 'Type an answer'
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
          // Compact choices live beside the field; file review brings card labels into reach too.
          options={
            (offerChoices || (inCorrection && shape.hasOptions)) &&
            (compactChoices || filesOpen) &&
            content
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
          photos={
            photosAllowed
              ? {
                  view,
                  locked: busy,
                  list: draft.photos,
                  room: photoRoom,
                  limit: photoLimit,
                  noun: photoNoun,
                  camera,
                  onAdd: (files) =>
                    drafts.addPhotos(draft.key, files, {
                      room: photoRoom,
                      overflow: (over) =>
                        `${
                          photoLimit < PHOTOS_PER_MESSAGE
                            ? `This question can take ${photoCount(questionRoom)} more.`
                            : `Up to ${PHOTOS_PER_MESSAGE} photos per ${photoNoun}.`
                        } ${over} ${over === 1 ? 'wasn’t' : 'weren’t'} added.`,
                    }),
                  onRemove: (pid) => drafts.removePhoto(draft.key, pid),
                  onFull: () =>
                    drafts.notePhotos(draft.key, {
                      text:
                        questionRoom === 0
                          ? 'This question can’t take any more photos.'
                          : photoLimit < PHOTOS_PER_MESSAGE
                            ? `This question can take ${photoCount(questionRoom)} more, and they’re attached.`
                            : `Up to ${PHOTOS_PER_MESSAGE} photos per ${photoNoun}.`,
                      tone: 'info',
                    }),
                }
              : null
          }
        />
      </AnswerDock>
    );
  } else if (modelReview && proxy) {
    dock = <AnswerDock>{moveOn()}</AnswerDock>;
  } else if (decided && followUps === 'desktop') {
    // The relay takes follow-ups, but the computer that asked can't type them into the terminal yet.
    dock = (
      <AnswerDock>
        <p className="dock-line">
          {machine
            ? `Update Daintree on ${machine} to send follow\u2011ups.`
            : 'Update Daintree on the computer that asked to send follow\u2011ups.'}
        </p>
        {moveOn()}
      </AnswerDock>
    );
  } else {
    // Answered, expired or withdrawn: the thread says which; the dock offers the next question.
    dock = <AnswerDock>{moveOn()}</AnswerDock>;
  }

  /* ---------- the thread ---------- */

  // Once the person's answer is on its way the question no longer waits on them: its deadline and gate go at Send,
  // not later when the relay confirms, so nothing above the answer moves while it uploads.
  const waitingOnPerson = status === 'open' && !pendingEntry;
  const soon =
    waitingOnPerson && !!view.expiresAt && Date.parse(view.expiresAt) - now < 24 * 3_600_000;
  const due =
    waitingOnPerson && view.expiresAt ? (
      <span className={soon ? 'due soon' : 'due'}>
        <ClockIcon size={13} />
        {dueLabel(view.expiresAt, now)}
      </span>
    ) : null;
  // The gate matters while the question is open: no model will step in, so it waits for a person. It is one more
  // fact on the status line under the question (guide 4.1), not a block of its own.
  const gate =
    waitingOnPerson && view.requirement === 'human-required' ? (
      <span className="gate">
        <PersonIcon size={13} />
        Human decision required
        <span className="sr-only">. The decision model doesn’t answer this one.</span>
      </span>
    ) : null;
  const statusLine =
    due || gate ? (
      <>
        {due}
        {due && gate && (
          <span className="meta-dot" aria-hidden="true">
            ·
          </span>
        )}
        {gate}
      </>
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
        files={
          <Gallery
            view={view}
            onReview={onReview}
            handleRef={galleryRef}
            onFocusChange={setFilesOpen}
          />
        }
        context={content.context ? <MessageContext text={content.context} /> : undefined}
        choices={
          offerChoices ? (
            compactChoices ? null : (
              <OptionCards
                view={view}
                selected={draft.selected}
                onSelect={select}
                disabled={stale || busy}
                legend={content.kind === 'approval' ? 'Your decision' : 'Choose one'}
              />
            )
          ) : (
            <StaticChoices
              view={view}
              chosen={
                pendingEntry && pendingEntry.kind !== 'confirm-proxy'
                  ? pendingEntry.selected
                  : inForce
              }
              caption={closed ? 'The options were' : undefined}
              byModel={modelReview && !pendingEntry}
              pending={
                !!pendingEntry &&
                pendingEntry.kind !== 'confirm-proxy' &&
                pendingEntry.state !== 'committed'
              }
            />
          )
        }
        meta={statusLine}
      />,
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
    /** The agent's message just before this item, so a run of its messages shows its name once. */
    let lastNote: (typeof view.messages)[number] | null = null;
    for (const t of timeline) {
      const prevNote = lastNote;
      lastNote = null;
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
          const grouped =
            !!prevNote &&
            Date.parse(m.createdAt) - Date.parse(prevNote.createdAt) < GROUP_WITHIN_MS;
          items.push(
            <AgentNote
              key={m.messageId}
              view={view}
              m={m}
              now={now}
              asking={ask === m}
              grouped={grouped}
            />,
          );
          lastNote = m;
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
              <PhotoGrid view={view} images={m.images} />
              {m.text.trim() && <SafeText text={m.text} className="answer-text" />}
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
            key={`ans-${a.actionId}`}
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
            // While this device's own answer is in conflict with it, the conflict card owns what happens next
            // (Use as correction, or Confirm model answer).
            review={
              modelReview && a === proxy && !confirmed && !pendingEntry && failed.length === 0
            }
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
          // No model answer here, so no violet: the mark always travels with the words "Model answer".
          <SystemLine key={a.actionId} now={now} at={a.createdAt}>
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
        const declined = a.signerRole !== null && isPersonDecline(a.action, a.signerRole);
        items.push(
          <SystemLine
            key={a.actionId}
            now={now}
            at={a.createdAt}
            icon={<UndoIcon size={14} />}
            detail={
              declined
                ? 'You chose not to answer it, so nothing was approved.'
                : 'No answer is needed, and nothing was approved here.'
            }
          >
            {declined ? 'Declined by you' : 'Withdrawn by your agent'}
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
          detail={`${
            content.kind === 'approval' ? 'Nothing was approved.' : 'No answer was sent.'
          } To decide now, ask your agent again from your computer.`}
        >
          Expired without an answer
        </SystemLine>,
      );
    if (pendingEntry) {
      const queuedOffline = pendingEntry.state === 'queued' && !navigator.onLine;
      const receipt = pendingProgress ? (
        <Receipt
          progress={pendingProgress}
          fromPhone
          steps={pendingEntry.kind !== 'confirm-proxy'}
          label={uploadLabel(pendingEntry)}
          note={queuedOffline ? 'Sends when you’re back online' : undefined}
        />
      ) : undefined;
      items.push(
        pendingEntry.kind === 'confirm-proxy' ? (
          <OutgoingMessage
            key="pending"
            at={new Date(pendingEntry.createdAt).toISOString()}
            now={now}
            tone="pending"
            id="ws-answer"
            receipt={receipt}
          >
            <p className="answer-text">Confirmed the model answer</p>
          </OutgoingMessage>
        ) : (
          // The same component, under the same key, as the committed answer it becomes: its photos, and a viewer
          // open on one of them, stay exactly where they are when the relay confirms it.
          <HumanAnswer
            key={`ans-${pendingEntry.recordId ?? pendingEntry.id}`}
            view={view}
            a={pendingAction(pendingEntry)}
            now={now}
            tone="pending"
            receipt={receipt}
            upload={uploadOf(pendingEntry)}
            extra={<UploadTrouble entry={pendingEntry} subject="answer" />}
          />
        ),
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
              progress={messageProgress(
                null,
                e.state === 'committed' ? undefined : (e.state as 'queued' | 'sending'),
              )}
              fromPhone
              subject="Your follow-up"
              label={uploadLabel(e)}
              note={queuedOffline ? 'Sends when you’re back online' : undefined}
            />
          }
        >
          <PhotoGrid view={view} images={entryImages(e)} upload={uploadOf(e)} />
          {e.text.trim() && <SafeText text={e.text} className="answer-text" />}
          <UploadTrouble entry={e} subject="follow-up" />
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
          <PhotoGrid view={view} images={entryImages(e)} />
          {e.text.trim() && <SafeText text={e.text} className="answer-text" />}
          <div className="msg-failure" role="alert">
            <WarningIcon size={14} />
            <span>
              {e.state === 'expired'
                ? 'Not sent: the question expired first.'
                : closedThread
                  ? 'Not sent: this question no longer takes messages.'
                  : (photoRefusal(e) ?? 'Not sent: your relay refused it.')}
            </span>
          </div>
          <div className="row">
            {!closedThread && e.errorCode !== 'payload_too_large' && (
              <button
                type="button"
                className="btn small"
                onClick={() => void app.outbox?.retry(e.id)}
              >
                Try again
              </button>
            )}
            {e.text.trim() && <CopyButton text={e.text} />}
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
                    void handOver(e, messageDraft.key, words);
                  }
                : undefined
            }
            dismissDiscards={status !== 'open'}
            onKeepCurrent={
              modelReview && answer === proxy && !confirmed && !pendingEntry
                ? () => void confirmModel()
                : undefined
            }
            keepBusy={busy}
            keepError={confirmError}
            onDismiss={() => {
              // Back in the answer while it can still be sent; otherwise nothing could take them.
              void (status === 'open'
                ? handOver(e, answerDraft.key, e.text, undefined, true)
                : app.outbox?.discard(e.id));
            }}
            onUseAsCorrection={() => {
              void handOver(e, correctionDraft.key, e.text, { selected: e.selected });
              setCorrecting(true);
            }}
            note={handOverNote}
            onRetry={
              e.refusedAt === 'image' && e.errorCode === 'image_lost'
                ? () => void app.outbox?.retry(e.id)
                : undefined
            }
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
            hasOptions={shape.hasOptions && !compactChoices}
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
    if (closed && (answerDraft.text.trim() || answerDraft.photos.length))
      items.push(
        <OutgoingMessage key="draft" now={now} tone="draft" label="Unsent draft">
          <DraftPhotoStrip photos={answerDraft.photos} />
          {answerDraft.text.trim() && <SafeText text={answerDraft.text} className="answer-text" />}
          <div className="row">
            {answerDraft.text.trim() && <CopyButton text={answerDraft.text} />}
          </div>
        </OutgoingMessage>,
      );
    if (closed && (messageDraft.text.trim() || messageDraft.photos.length))
      items.push(
        <OutgoingMessage key="mdraft" now={now} tone="draft" label="Unsent follow-up">
          <DraftPhotoStrip photos={messageDraft.photos} />
          {messageDraft.text.trim() && (
            <SafeText text={messageDraft.text} className="answer-text" />
          )}
          <div className="row">
            {messageDraft.text.trim() && <CopyButton text={messageDraft.text} />}
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
  const pendingAnswerKey = pendingEntry ? `ans-${pendingEntry.recordId ?? pendingEntry.id}` : null;
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
  const bodyHeight = useRef(0);
  const [newBelow, setNewBelow] = useState(false);
  const atEnd = (b: HTMLElement) => b.scrollHeight - b.scrollTop - b.clientHeight < 96;
  const onBodyScroll = () => {
    const b = bodyRef.current;
    if (!b) return;
    // A viewport resize can dispatch scroll before ResizeObserver. Preserve the pre-resize reading intent until
    // the observer has anchored the new geometry.
    if (bodyHeight.current && b.clientHeight !== bodyHeight.current) return;
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
  // The keyboard and a growing draft resize the reading area without adding a message. Keep the latest reply
  // visible if the person was following it; someone reading earlier messages keeps their scroll position.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') return;
    bodyHeight.current = body.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = body.clientHeight;
      if (nextHeight === bodyHeight.current) return;
      bodyHeight.current = nextHeight;
      if (followingEnd.current) {
        body.scrollTop = body.scrollHeight - body.clientHeight;
      }
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
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
      (lastKey === 'pending' ||
        lastKey === 'correction' ||
        lastKey === pendingAnswerKey ||
        pendingKeys.has(lastKey));
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
        answer={headerAnswer}
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
              {readyPhotos(correctionDraft).length > 0 && (
                <p className="change-photos">
                  With {photoCount(readyPhotos(correctionDraft).length)}
                </p>
              )}
            </div>
          </div>
          <p className="muted">
            Your agent may already have acted on the earlier answer. This sends a correction; it
            doesn’t undo completed work.
          </p>
        </Sheet>
      )}
      <Sheet
        open={declineAt !== null}
        title="Dismiss this question?"
        // Closing never waits on the request (a swipe or Back must not leave a stuck layer); a failure reopens it.
        onClose={() => setDeclineAt(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDeclineAt(null)}>
              Keep it
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={declining}
              onClick={() => {
                if (declineAt === null || declining) return;
                const at = declineAt;
                setDeclining(true);
                setDeclineError(null);
                if (dictation.isActive()) void dictation.stop();
                app
                  .declineQuestion(view, at)
                  .then(() => {
                    setDeclineAt(null);
                    announce('Question dismissed.');
                  })
                  .catch((e: unknown) => {
                    setDeclineError(
                      e instanceof StaleQuestionError
                        ? e.message
                        : 'Could not dismiss it. Check your connection and try again.',
                    );
                    setDeclineAt(at);
                  })
                  .finally(() => setDeclining(false));
              }}
            >
              {declining ? 'Dismissing…' : 'Dismiss question'}
            </button>
          </>
        }
      >
        <p>
          You won’t answer it. It leaves Needs you on all your devices and stops reminders. If your
          agent is still waiting, it is told you declined, and nothing is approved.
        </p>
        {declineError && (
          <p className="status error" role="alert">
            {declineError}
          </p>
        )}
      </Sheet>
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

/** Entries whose photos have been announced as uploaded. */
const uploadedAnnounced = new Set<string>();

function hasWords(d: { text: string; reason: string; selected: string[]; photos?: unknown[] }) {
  return !!(d.text.trim() || d.reason.trim() || d.selected.length || d.photos?.length);
}

/** How a queued entry's photos are going, for their frames in the thread. */
function uploadOf(e: OutboxEntry): PhotoUpload | undefined {
  const outbox = app.outbox;
  if (!outbox || !e.images?.length) return undefined;
  return { state: (id) => outbox.photoState(e, id) };
}

/** The receipt's words while photos are going up ahead of the words: "Uploading photo 2 of 3". */
function uploadLabel(e: OutboxEntry): string | undefined {
  const outbox = app.outbox;
  const n = e.images?.length ?? 0;
  if (!outbox || !n || e.state !== 'sending' || outbox.uploadStopped(e.id)) return undefined;
  const done = outbox.imagesSent(e);
  if (done >= n) return undefined;
  return n === 1 ? 'Uploading photo' : `Uploading photo ${done + 1} of ${n}`;
}

/** A queued answer, shown as the answer it will be once the relay has it. */
function pendingAction(e: OutboxEntry): ActionView {
  return {
    actionId: e.recordId ?? e.id,
    action: e.kind === 'override' ? 'override' : 'answer',
    provenance: null,
    revision: e.expectedRevision + 1,
    createdAt: new Date(e.createdAt).toISOString(),
    seq: Number.MAX_SAFE_INTEGER,
    signerDeviceId: '',
    signerRole: null,
    content: {
      content_version: 1,
      selected_option_ids: e.selected,
      text: e.text.trim() || undefined,
      reviewed_attachment_digests: [],
      reason: e.reason.trim() || undefined,
      ...(e.images?.length ? { images: entryImages(e) } : {}),
    },
    verified: true,
    imagesOk: true,
  };
}

/** Why the relay turned down a follow-up's or answer's photos, when it did. */
function photoRefusal(e: OutboxEntry): string | null {
  if (e.refusedAt !== 'image') return null;
  if (e.errorCode === 'payload_too_large') return 'Not sent: this question can’t take more photos.';
  if (e.errorCode === 'image_lost') return 'Not sent: your relay lost its photos.';
  return 'Not sent: your relay refused its photos.';
}

/**
 * Photos that stopped on their way up: the words and photos are safe on this device, they try again by themselves,
 * and Try again does it now. While a try is running the row keeps its place and the button says so.
 */
function UploadTrouble({ entry, subject }: { entry: OutboxEntry; subject: string }) {
  void app.outbox?.getVersion();
  if (!app.outbox?.uploadStopped(entry.id)) return null;
  const trying = entry.state === 'sending';
  return (
    <div className="msg-trouble">
      <p className="msg-failure" role="status">
        <WarningIcon size={14} />
        <span>The upload stopped. Your {subject} is saved on this device and isn’t sent yet.</span>
      </p>
      <button
        type="button"
        className="btn small"
        aria-disabled={trying || undefined}
        onClick={() => !trying && void app.outbox?.retryNow()}
      >
        <RefreshIcon size={16} />
        {trying ? 'Trying again…' : 'Try again'}
      </button>
    </div>
  );
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
