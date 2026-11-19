import {
  LIMITS,
  type DecisionContentV1,
  type LedgerEvent,
  type ProtocolFeature,
  type ReplyMode,
} from '@daintreehq/decisions-protocol';
import { AuditLog } from './audit.js';
import { BridgeError, PostMessageInput } from './content.js';
import {
  MemorySpool,
  type AttachmentResolver,
  type AttachmentSpool,
  type BridgeContext,
} from './context.js';
import { DeliveryEngine, type DrainResult } from './delivery.js';
import { EventVerifier } from './inbound.js';
import { Inbox } from './inbox.js';
import {
  InvolvementSync,
  SetInvolvementInput,
  type InvolvementPreference,
  type InvolvementView,
  type SetInvolvementResult,
} from './involvement.js';
import { PresenceReporter } from './presence.js';
import { AgentStoppedPusher, type AgentStoppedPushResult } from './agent-stopped.js';
import { PolicyRegistry, gateAllowsText } from './policy.js';
import {
  Publisher,
  type CreatePayload,
  type PostMessageResult,
  type RegisterOptions,
  type RegisterResult,
} from './publisher.js';
import { AnswerQuestionInput, ownerAnswerItemId, type OwnerAnswerResult } from './owner-answer.js';
import {
  DeclineQuestionInput,
  ownerDeclineItemId,
  type OwnerDeclineResult,
} from './owner-decline.js';
import {
  OWNER_MESSAGE_FEATURE,
  SendFollowUpInput,
  ownerMessageItemId,
  type OwnerFollowUpResult,
} from './owner-message.js';
import {
  answeredOn,
  closureInForce,
  currentDisposition,
  isAdvisoryNotice,
  parseAnswers,
  sameDigests,
  unpublishedPlanDue,
  type AdvisoryDisposition,
  type OpenAnswerEntry,
} from './answers.js';
import {
  openAnswers,
  openMessageContent,
  openQuestionContent,
  sealStoredContent,
} from './at-rest.js';
import { messageSentOn, parseMessages, type LocalMessageStatus } from './messages.js';
import { RelayError, isDeviceRevoked } from './errors.js';
import { refreshHostGrants } from './host-enrollment.js';
import {
  MemoryKeyStore,
  loadIdentity,
  promoteEpoch,
  type Identity,
  type KeyStore,
} from './identity.js';
import type { DecisionLearner, ProxyEngine, ProxyOutcome } from './proxy.js';
import { Mutex, TransientError } from './mutex.js';
import { RelayClient, type CallOptions } from './relay.js';
import {
  DECLARE_EVERY_MS,
  DEFAULT_POLL,
  HTTP_SYNC_META_KEY,
  NEVER_SYNCED,
  isFatalSyncError,
  readHttpSyncStatus,
  resolvePoll,
  retryDelayMs,
  syncFailureReason,
  type HttpPollOptions,
  type HttpSyncStatus,
  type ResolvedPoll,
} from './http-sync.js';
import type { AgentResumeAdapter, TerminalSink } from './sink.js';
import type { PhoneImageStore } from './phone-images.js';
import {
  SNAPSHOT_FEATURE,
  SnapshotPublisher,
  type PaneSnapshotInput,
  type SnapshotOptions,
  type SnapshotPublishResult,
} from './snapshots.js';
import { RelaySocket, type SocketState, type WebSocketFactory } from './socket.js';
import { AdvisorySupport, replyModeOfRow } from './advisory.js';
import type { LocalStore } from './store.js';
import type { OutboxItem, QuestionOrigin, QuestionRow } from './types.js';

export interface BridgeOptions {
  identity: Identity;
  /** Needed to pick up epoch keys rotated by another process while this one is running. */
  keyStore?: KeyStore;
  store: LocalStore;
  sink: TerminalSink;
  policy?: PolicyRegistry;
  resolver?: AttachmentResolver;
  spool?: AttachmentSpool;
  proxy?: ProxyEngine;
  proxyTimeoutMs?: number;
  /**
   * The decision model's history (`asBridgeLearner(history)` from the decision-model package). Human answers
   * are offered to it, and it records them only if the user opted into learning, with its secrets filter
   * applied. Without it, no question or answer plaintext is stored anywhere.
   */
  learner?: DecisionLearner;
  adapters?: AgentResumeAdapter[];
  /**
   * Where verified phone images go, so the agent can open the photos a person attaches to an answer: the host
   * stores each one where the pane's agent can read it and returns the path, which the typed block lists.
   * Without it, each image is listed as unavailable (`no_image_store`) and the words are delivered as usual.
   */
  phoneImages?: PhoneImageStore;
  /**
   * Type the person's follow-up messages into the asking pane (protocol section 16): declare `thread-messages-v1`
   * to the relay, take the thread's messages, and deliver each human one as a FOLLOW-UP block under the same rules
   * as an answer, with its own receipts. Off by default, so the relay neither sends this desktop messages nor
   * lets the person send any on its questions: a host whose sink parses the library's text (Daintree) turns it on
   * once it understands the follow-up block (docs/daintree-integration-spec.md section 6.4).
   */
  followUps?: boolean;
  /**
   * The host delivers the outcome of an advisory question to its agents (protocol section 21): an answer as usual,
   * or, when none commits by the deadline, a notice that the plan the agent stated is due. Declares
   * `advisory-deadlines-v1` to the relay. Off by default, so the bridge never signs an advisory question: a host
   * turns it on once its sink understands that notice, and its policy must allow them as well
   * (`PolicyRegistryOptions.advisoryQuestions`).
   */
  advisoryDeadlines?: boolean;
  auditPath?: string;
  debugContent?: boolean;
  client?: RelayClient;
  fetch?: typeof fetch;
  webSocket?: WebSocketFactory;
  now?: () => number;
  batch?: boolean;
  /** Background retry cadence for the outbox and busy panes. Default 30 s; 0 disables. */
  pumpIntervalMs?: number;
  /**
   * Pane snapshots (`publishSnapshot`, `clearSnapshots`) and the refresh callback. Setting it declares
   * `pane-snapshots-v1` to the relay, alongside `BRIDGE_FEATURES`, so refresh requests reach this bridge;
   * without it, both methods throw `not_configured` and the feature is never declared.
   */
  snapshots?: SnapshotOptions;
}

export type BridgeState = 'created' | 'running' | 'revoked' | 'stopped';

/**
 * Runs a task one run at a time. A kick while it runs asks for one more run after it, never a queue: however often
 * it is kicked while a run is stuck, it holds one run and one flag. The promise settles when the loop has run out of
 * kicks; a run's failure is reported and the loop goes on.
 */
class Rerun {
  private loop: Promise<void> | null = null;
  private again = false;
  constructor(
    private readonly task: () => Promise<void>,
    private readonly onError: (e: Error) => void,
  ) {}
  /** Settles once the run in progress, and any it was kicked for, have finished; never rejects. */
  idle(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }
  kick(): Promise<void> {
    this.again = true;
    this.loop ??= (async () => {
      try {
        while (this.again) {
          this.again = false;
          try {
            await this.task();
          } catch (e) {
            this.onError(e as Error);
          }
        }
      } finally {
        this.loop = null;
      }
    })();
    return this.loop;
  }
}

/** How long `stop` waits for the last status record before letting the host close the store anyway. */
const STATUS_WAIT_MS = 5_000;
/** The deadline of each page request a direct `catchUp` makes (it keeps the client's own retries). */
const CATCH_UP_TIMEOUT_MS = 30_000;

/** How many stored, unapplied events `ledgerUnsettled` looks through for the question's own. */
const UNAPPLIED_SCAN = 500;

/**
 * The protocol extensions the bridge declares to the relay (section 19), on its socket ticket and its event
 * pages. `phone-images-v1` is declared with or without a `phoneImages` store: a relay hides an image-bearing
 * answer from a client that does not declare it, and its words must still arrive. `involvement-v1` brings the
 * hint that the person's involvement preference changed (section 20). `owner-desktop-answers-v1` says this desktop
 * accepts the person's answer signed by the owner desktop (section 2), which the relay commits to its questions
 * only once declared; it needs nothing from the host. `person-declines-v1` says it files a phone's or tablet's
 * decline, and `owner-desktop-declines-v1` the owner desktop's signed `decline` (section 6.1); the relay refuses
 * either decline of a question whose desktop has not declared it.
 */
export const BRIDGE_FEATURES: readonly ProtocolFeature[] = [
  'phone-images-v1',
  'involvement-v1',
  'owner-desktop-answers-v1',
  'person-declines-v1',
  'owner-desktop-declines-v1',
];

/**
 * What a bridge declares: `BRIDGE_FEATURES`, plus `thread-messages-v1` and `owner-desktop-messages-v1` when it
 * delivers follow-ups (the second says it also takes the person's follow-up sent from the owner desktop, typed with
 * `sent_from: computer`), `pane-snapshots-v1` when snapshots are on, and `advisory-deadlines-v1` when the host
 * delivers advisory outcomes.
 */
export function bridgeFeatures(
  o: Pick<BridgeOptions, 'followUps' | 'snapshots' | 'advisoryDeadlines'> = {},
): readonly ProtocolFeature[] {
  const extra: ProtocolFeature[] = [
    ...(o.followUps ? (['thread-messages-v1', OWNER_MESSAGE_FEATURE] as const) : []),
    ...(o.snapshots ? [SNAPSHOT_FEATURE] : []),
    ...(o.advisoryDeadlines ? (['advisory-deadlines-v1'] as const) : []),
  ];
  return extra.length > 0 ? [...BRIDGE_FEATURES, ...extra] : BRIDGE_FEATURES;
}

/** One entry of a question's thread, in ledger order. */
export type ThreadEntryView =
  | {
      kind: 'answer';
      revision: number;
      source: 'human' | 'proxy' | 'system';
      /** Where the person gave a human answer: `computer` (the owner desktop) or `phone` (a phone or tablet). */
      answeredOn: 'computer' | 'phone' | null;
      choices: string[];
      text: string;
      correction: boolean;
      delivered: boolean;
      createdAt: string;
    }
  | {
      kind: 'message';
      messageId: string;
      /** The relay's order of the question's messages, from 1. */
      messageSeq: number;
      /** `agent`: posted from this pane (`send_followup`). `human`: the person's follow-up. */
      side: 'agent' | 'human';
      /**
       * Where the person sent a human follow-up from: `computer` (the owner desktop signed it; still the person's
       * own message) or `phone` (a phone or tablet). Null for the agent's own.
       */
      sentFrom: 'computer' | 'phone' | null;
      expectsReply: boolean;
      /** The whole text ('' for a message of images only, or one whose content can't be opened now). */
      text: string;
      /** The phone images attached (human only), with the host's path once stored. */
      images: { attachmentId: string; alt?: string; path?: string }[];
      createdAt: string;
      /** True when the stored content could not be opened: the message is listed without its text. */
      unreadable: boolean;
      /** Human only: where the follow-up stands on its way into the pane. Null for the agent's own. */
      delivery: {
        status: LocalMessageStatus;
        receivedAt: string;
        terminalDeliveredAt: string | null;
        injectionId: string | null;
        errorCode: string | null;
      } | null;
    };

/**
 * Whether a question reached the relay, from the evidence this desktop keeps durably:
 * - `not-sent`: queued, and provably never sent (no create request has been attempted);
 * - `possibly-committed`: queued, and a create request may have reached the relay, but no reply or history has
 *   confirmed it: its outcome is unknown until the relay can be reached;
 * - `accepted`: the relay acknowledged it (a receipt or its history). Nothing more: not that the person saw it;
 * - `never-published`: it never reached the relay, so it never reached the person's phone and no answer to it was
 *   recorded: its deadline passed first (`closedReason: never-published`), or it was withdrawn before it was sent
 *   (`closedReason: withdrawn`);
 * - `refused`: the relay refused it for good (`status: publish-failed`);
 * - `unknown`: imported history, or a row too old or damaged to tell.
 */
export type PublicationState =
  'not-sent' | 'possibly-committed' | 'accepted' | 'never-published' | 'refused' | 'unknown';

export interface DecisionView {
  questionId: string;
  alias: number;
  status: QuestionRow['local_status'];
  /** Whether the question reached the relay (`PublicationState`). */
  publication: PublicationState;
  requirement: QuestionRow['requirement'];
  deliveryStatus: QuestionRow['delivery_status'];
  revision: number;
  expiresAt: string | null;
  /**
   * The current round's mode (protocol section 21): `advisory` while the question is in the round its agent asked for
   * advice in (answered or not), so if no answer commits by that round's deadline the plan it stated is its own to
   * carry out. `blocking` otherwise, a reopened question included: it waits for a decision.
   */
  replyMode: ReplyMode;
  /**
   * The plan the agent stated, while `replyMode` is `advisory`; null otherwise, or for content this desktop cannot
   * open.
   */
  plannedFallback: string | null;
  /** Why the relay refused the question, when it is `publish-failed`; null otherwise. */
  errorCode: string | null;
  /** The trusted workflow gate that governs the question, if any. */
  workflowGateId: string | null;
  /**
   * Who put the answer in force: `human` (an answer, a correction, or a confirmed proxy answer) or `proxy`.
   * Null unless the question is answered (`human-answered` or `proxy-answered`): an open, expired or
   * cancelled question reports no provenance, no choice and no text, whatever its history holds.
   */
  provenance: 'human' | 'proxy' | null;
  /**
   * Where the person put a human answer in force: `computer` when they answered on their computer (the owner
   * desktop signed it; still their own answer, never a proxy's), `phone` from a phone or tablet (a confirmed proxy
   * answer included). Null unless `provenance` is `human`.
   */
  answeredOn: 'computer' | 'phone' | null;
  /**
   * Why a closed question is closed without an answer: `declined` when the person dismissed it (from a phone or
   * tablet, or on the computer through the owner desktop's signed decline), `withdrawn` when a desktop cancelled it,
   * `expired` when its deadline passed, `never-published` when its deadline passed before it ever reached the relay,
   * so no answer to it was recorded (`status: publish-failed`). Null otherwise. None of them authorises anything.
   */
  closedReason: 'declined' | 'withdrawn' | 'expired' | 'never-published' | null;
  /**
   * True only when the agent may carry out the plan its advisory question stated (protocol section 21): the advisory
   * round's deadline passed unanswered (`advisoryTimeout`, `fallback-due`), or the question never reached the relay
   * before it, under a host that delivers advisory outcomes and whose policy allows them. A notice already typed
   * keeps what it said; one still to be typed follows the policy as it is now, and is false while it waits for this
   * desktop to read the relay (a reopen may be on its way), unless its sink refused a write admitted after that read
   * (`advisoryTimeout.writeRefused`): that one waits only while an event of its question is stored and not yet applied.
   * It is never an answer or an approval: the person decided nothing.
   */
  fallbackDue: boolean;
  /**
   * What happened when the advisory round's deadline passed unanswered, kept after a reopen; null for every other
   * question, and for imported history.
   */
  advisoryTimeout: AdvisoryTimeoutView | null;
  /** The option id of the answer in force, or null for a text-only answer or no answer. */
  choice: string | null;
  /** The free text of the answer in force ('' when none). */
  text: string;
  /**
   * True only when the question carries attachments and the answer in force lists exactly their plaintext
   * SHA-256 digests as the images the person's device displayed. A question with no attachments, a proxy answer
   * (which reviews nothing, even once a human confirms it) or an approval sent before every image loaded
   * reports false.
   */
  reviewedDigestsMatch: boolean;
  answers: {
    revision: number;
    source: 'human' | 'proxy' | 'system';
    /** As `answeredOn`, for this entry. */
    answeredOn: 'computer' | 'phone' | null;
    choices: string[];
    text: string;
    correction: boolean;
    /** A correction's reason, as the human gave it ('' when none). */
    reason: string;
    delivered: boolean;
    createdAt: string;
  }[];
  /**
   * The question's thread in ledger order: its answers and the follow-up messages from both sides, each human
   * one with its own delivery state. A message never changes the answer in force reported above.
   */
  thread: ThreadEntryView[];
}

/**
 * An advisory question's unanswered deadline, as three separate facts (protocol section 21): the deadline elapsed
 * (`deadline`, the signed one the relay's expiry was checked against); the host told, or will tell, its agent
 * (`disposition` and `notice`); and what the agent then did, which Decisions never observes (`agentAction`).
 */
export interface AdvisoryTimeoutView {
  /** The round that expired: the advisory round, 0. */
  revision: number;
  /** The round's signed deadline that elapsed (ISO 8601, UTC). */
  deadline: string;
  /**
   * What the notice says, or will say: `fallback-due` lets the stated plan go ahead, at the agent's discretion;
   * `fallback-withheld` does not (the host's policy does not allow advice, or the question could not be read as
   * advisory). Neither is an answer.
   */
  disposition: AdvisoryDisposition;
  /**
   * The notice's delivery to the asking agent: `pending` (waiting for its pane, its host or the end of a replay),
   * `delivered` (the sink proved the write, or a restart found it on screen), `uncertain` (a write may or may not have
   * reached the terminal; it is never typed again on its own), `needs-attention` (nothing was typed and a person has
   * to decide), `superseded` (a reopen or deletion replaced the round before anything was typed). Delivered proves
   * the agent's terminal received it, never that the agent acted on it.
   */
  notice: 'pending' | 'delivered' | 'uncertain' | 'needs-attention' | 'superseded';
  /** The write that delivered the notice, or that may have; null otherwise. */
  injectionId: string | null;
  /**
   * True when the notice needs attention because its sink refused a write this host had admitted, once it had read the
   * relay for the notice's round as for a write that lands: the plan is settled as for a written notice, although
   * nothing was typed. False otherwise, a notice that needs attention for another reason (its pane gone) included.
   */
  writeRefused: boolean;
  /** Always `unobserved`: Decisions never sees whether the agent carried out the plan. */
  agentAction: 'unobserved';
}

/**
 * The COMPLETE trusted identity of the asking terminal. A relaunched terminal (new generation or new
 * ownership principal), a restarted agent (new incarnation), a new agent session or a different worktree
 * that happens to reuse a pane id is a different asker.
 */
export interface PaneIdentity {
  host_id: string;
  pane_id: string;
  terminal_generation: number;
  ownership_principal: string;
  agent_incarnation: string;
  agent_session_id: string | null;
  worktree_id: string;
}

/** The identity a pane presents, taken from the origin its credential resolves to. */
export function paneIdentityOf(o: QuestionOrigin): PaneIdentity {
  return {
    host_id: o.host_id,
    pane_id: o.pane_id,
    terminal_generation: o.terminal_generation,
    ownership_principal: o.ownership_principal,
    agent_incarnation: o.agent_incarnation,
    agent_session_id: o.agent_session_id,
    worktree_id: o.worktree_id,
  };
}

/** An empty principal or incarnation (a row migrated from before they existed) never matches anyone. */
const known = (a: string, b: string) => typeof a === 'string' && a !== '' && a === b;

function sameAsker(o: QuestionOrigin, p: PaneIdentity): boolean {
  return (
    o.host_id === p.host_id &&
    o.pane_id === p.pane_id &&
    o.terminal_generation === p.terminal_generation &&
    known(o.ownership_principal, p.ownership_principal) &&
    known(o.agent_incarnation, p.agent_incarnation) &&
    o.agent_session_id === p.agent_session_id &&
    o.worktree_id === p.worktree_id
  );
}

/**
 * What a settled delivery carried: an `answer`, a `decline`, an `expiry`, an `advisory-timeout` (the agent was told
 * its stated plan may or may not go ahead), or a neutral `notice` when the entries that settled mix kinds or none is
 * identifiable.
 */
export type DeliveredKind = 'answer' | 'decline' | 'expiry' | 'advisory-timeout' | 'notice';

function deliveredKind(beforeJson: string, afterJson: string): DeliveredKind {
  const was = new Set(
    parseAnswers(beforeJson)
      .filter((e) => e.delivered)
      .map((e) => e.entry_id),
  );
  const kinds = new Set<DeliveredKind>();
  for (const e of parseAnswers(afterJson)) {
    if (!e.delivered || was.has(e.entry_id)) continue;
    kinds.add(
      e.kind === 'answer'
        ? 'answer'
        : e.kind === 'declined'
          ? 'decline'
          : e.kind === 'unpublished'
            ? // Never-published notices read the same whether or not the plan may go ahead.
              'notice'
            : e.advisory_disposition !== undefined
              ? 'advisory-timeout'
              : 'expiry',
    );
  }
  return kinds.size === 1 ? [...kinds][0]! : 'notice';
}

type Listener = {
  state: (s: BridgeState) => void;
  socket: (s: SocketState, detail?: string) => void;
  delivered: (questionId: string, what: DeliveredKind) => void;
  error: (e: Error) => void;
  /** An answer from `answerQuestion` reached its outcome (anything but `queued`), however it was sent. */
  answer: (result: OwnerAnswerResult) => void;
  /** A decline from `declineQuestion` reached its outcome (anything but `queued`), however it was sent. */
  decline: (result: OwnerDeclineResult) => void;
  /** A follow-up from `sendFollowUp` reached its outcome (anything but `queued`), however it was sent. */
  followUp: (result: OwnerFollowUpResult) => void;
  /** An HTTP sync (`sync`) finished, with what it recorded. */
  sync: (status: HttpSyncStatus) => void;
  /**
   * Another connection for this device replaced this bridge's socket (4409): the socket stopped and reads nothing more,
   * while the bridge goes on running. Never on `stop` or a revocation. What to do is the host's call: the desktop app
   * yields, as two processes sharing an identity must not fight over the one socket.
   */
  replaced: () => void;
};

/**
 * The narrow host-level API Daintree calls: register a question for a pane, and deliver answers back.
 * Everything else (relay protocol, crypto, durable queues, verification) lives behind it.
 */
export class DecisionsBridge {
  readonly ctx: BridgeContext;
  readonly publisher: Publisher;
  /** What the relay and the person's devices support for advisory questions, read in the background. */
  private readonly advisory: AdvisorySupport;
  readonly verifier: EventVerifier;
  readonly inbox: Inbox;
  readonly delivery: DeliveryEngine;
  readonly socket: RelaySocket;
  readonly snapshots: SnapshotPublisher;
  /** The person's involvement preference, as this desktop last verified it (`getInvolvement`). */
  readonly involvement: InvolvementSync;
  /** Keeps the relay's presence lease current while the host reports the person is here (`reportPresence`). */
  readonly presence: PresenceReporter;
  /** Asks the relay for an agent-stopped push when the host says one is due (`requestAgentStoppedPush`). */
  readonly agentStopped: AgentStoppedPusher;
  /** What this bridge declares to the relay on its socket ticket and event pages (`bridgeFeatures`). */
  readonly features: readonly ProtocolFeature[];
  state: BridgeState = 'created';
  /** Bumped by every start, stop and revocation: a start still recovering when one comes starts nothing more. */
  private lifecycle = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping: Promise<void> | null = null;
  /**
   * The one paging pass in flight (`catchUp`, `sync`), which a caller arriving while it reads joins. It covers reading
   * and storing the pages only, never applying or delivering them, so a delivery that takes its time cannot hold up
   * the next read. `abortable`: started by a sync, whose requests `stop` aborts.
   */
  private paging: { pass: Promise<number>; abortable: boolean } | null = null;
  /**
   * What this desktop knows of the ledger, for an advisory notice (`ledgerUnsettled`): a socket replay is under way
   * (from its first segment, or a gap's, to its last), and whether a read reached the relay's end since this run
   * started and since a read last failed part-way.
   */
  private socketReplay = false;
  private ledgerRead = false;
  /** The one HTTP sync in flight (`sync`). */
  private syncing: Promise<HttpSyncStatus> | null = null;
  /** Set while this run polls the relay over HTTP (`start({ socket: false, poll })`). */
  private poll: ResolvedPoll | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Aborts the HTTP sync's requests when the bridge stops or is revoked; a new one for each start. */
  private httpAbort = new AbortController();
  /** The run in which the relay last recorded this bridge's features from a sync (`sync`), and when. */
  private declaredRun = -1;
  private declaredAt = 0;
  /** The relay said this device was revoked, or the ledger did: final for this bridge, whatever stops it next. */
  private revokedSeen = false;
  /** Failed HTTP syncs in a row. */
  private syncFailures = 0;
  /** This run was started to poll: gap recovery and background reads leave the relay to the poll schedule. */
  private pollMode = false;
  /** This bridge has synced over HTTP, so its status record is kept current (a revocation included). */
  private httpSynced = false;
  /** Status records, written in order; `stop` waits for them so the host can close the store after it. */
  private statusWrites: Promise<void> = Promise.resolve();
  /**
   * Applying what syncs read, and delivering what that brings, each one run at a time in the background, so a sink
   * or a key lookup that hangs holds one run, never a growing queue, and a hung sink does not stop events (a
   * withdrawal, a revocation) from being applied. `sync({ settle: true })` waits for both.
   */
  private readonly applier = new Rerun(
    () => this.applyStored(),
    (e) => this.emitError(e),
  );
  private readonly deliverer = new Rerun(
    () => this.deliverNow(),
    (e) => this.emitError(e),
  );
  /** Recovery and the reopening of delivery, chained across starts (`reopenDelivery`); never rejects. */
  private reopening: Promise<void> = Promise.resolve();
  /** Starts whose recovery has not finished. */
  private reopensPending = 0;
  /** Delivery was just reopened: the applier's next run delivers even when it applies nothing new. */
  private redeliver = false;
  /** The last sync was refused this device's signature: background requests wait for the sync's slow retry. */
  private authRefused = false;
  /** Deliveries already announced on `delivered`, so two drains settling the same one announce it once. */
  private announced = new Set<string>();
  private listeners: { [K in keyof Listener]: Listener[K][] } = {
    state: [],
    socket: [],
    delivered: [],
    error: [],
    answer: [],
    decline: [],
    followUp: [],
    sync: [],
    replaced: [],
  };

  constructor(private readonly o: BridgeOptions) {
    const client =
      o.client ??
      new RelayClient({
        identity: o.identity,
        ...(o.fetch ? { fetch: o.fetch } : {}),
        ...(o.now ? { now: o.now } : {}),
      });
    this.ctx = {
      identity: o.identity,
      client,
      store: o.store,
      audit: new AuditLog(o.store, {
        ...(o.auditPath ? { jsonlPath: o.auditPath } : {}),
        ...(o.debugContent ? { debugContent: true } : {}),
        ...(o.now ? { now: () => new Date(o.now!()) } : {}),
      }),
      policy: o.policy ?? new PolicyRegistry(),
      spool: o.spool ?? new MemorySpool(),
      resolver: o.resolver,
      now: o.now ?? Date.now,
      lock: new Mutex(),
      ...(o.learner ? { learner: o.learner } : {}),
      refreshIdentity: (announced) => this.refreshKeys(announced),
    };
    this.advisory = new AdvisorySupport(this.ctx, o.advisoryDeadlines === true);
    this.publisher = new Publisher(
      this.ctx,
      {
        onOwnerAnswer: (r) => this.notify('answer', r),
        onOwnerDecline: (r) => this.notify('decline', r),
        onOwnerFollowUp: (r) => this.notify('followUp', r),
        onQuestionClosed: (id) => this.snapshots.closedQuestion(id),
      },
      this.advisory,
    );
    this.verifier = new EventVerifier(this.ctx, { ownerMessages: !!o.followUps });
    this.snapshots = new SnapshotPublisher(this.ctx, o.snapshots, (e) => this.emitError(e));
    this.involvement = new InvolvementSync(this.ctx, this.verifier, (e) => this.emitError(e));
    this.presence = new PresenceReporter(this.ctx, (e) => this.emitError(e));
    this.agentStopped = new AgentStoppedPusher(this.ctx);
    this.features = bridgeFeatures(o);
    this.inbox = new Inbox(
      this.ctx,
      this.verifier,
      {
        onRevokedSelf: () => this.markRevoked(),
        onSnapshotRefresh: (row, refresh) => this.snapshots.refreshRequested(row, refresh),
        onQuestionClosed: (id) => this.snapshots.closedQuestion(id),
        onInvolvementHint: () => this.involvement.hint(),
        closureWrite: (id) => this.delivery.closureWrite(id),
      },
      { messages: !!o.followUps, advisoryOutcomes: o.advisoryDeadlines === true },
    );
    this.delivery = new DeliveryEngine(this.ctx, {
      sink: o.sink,
      ...(o.adapters ? { adapters: o.adapters } : {}),
      ...(o.batch !== undefined ? { batch: o.batch } : {}),
      ...(o.phoneImages ? { phoneImages: o.phoneImages } : {}),
      advisoryOutcomes: o.advisoryDeadlines === true,
      replaying: (id) => this.ledgerUnsettled(id),
    });
    this.socket = new RelaySocket({
      client,
      features: this.features,
      getCursor: () => this.ctx.store.getCursor(),
      ...(o.webSocket ? { webSocket: o.webSocket } : {}),
      handlers: {
        onEvent: (ev) => this.onSocketEvent(ev),
        onCaughtUp: (hw, more) => this.onCaughtUp(hw, more),
        onState: (s, d) => {
          // A replay is under way until its last segment is caught up; a socket that closes abandons it, and what an
          // HTTP read brought meanwhile may settle a notice that waited.
          const abandoned = this.socketReplay && s !== 'syncing' && s !== 'live';
          this.socketReplay = s === 'syncing' || (s === 'live' && this.socketReplay);
          if (s === 'syncing') this.ledgerRead = false;
          // What the replay applied was held from delivery while it ran (`onSocketEvent`): deliver it now.
          if (abandoned && this.running())
            void this.deliverNow().catch((e) => this.emitError(e as Error));
          this.involvement.socketState(s);
          this.listeners.socket.forEach((l) => l(s, d));
        },
        onRevoked: () => this.markRevoked(),
        onReplaced: () => [...this.listeners.replaced].forEach((l) => l()),
        onError: (e) => this.emitError(e),
      },
    });
  }

  on<K extends keyof Listener>(event: K, cb: Listener[K]): () => void {
    (this.listeners[event] as Listener[K][]).push(cb);
    return () => {
      const arr = this.listeners[event] as Listener[K][];
      arr.splice(arr.indexOf(cb), 1);
    };
  }

  private emitError(e: Error): void {
    this.listeners.error.forEach((l) => l(e));
  }

  /** Tell the host an owner-desktop answer, decline or follow-up settled; a listener that throws is reported on `error`. */
  private notify<K extends 'answer' | 'decline' | 'followUp'>(
    event: K,
    r: Parameters<Listener[K]>[0],
  ): void {
    for (const l of [...(this.listeners[event] as ((x: typeof r) => void)[])]) {
      try {
        l(r);
      } catch (e) {
        this.emitError(e as Error);
      }
    }
  }

  /** A Host without a persistent key store keeps the epochs it fetches here, seeded from its identity. */
  private hostKeys: KeyStore | null = null;

  /**
   * Pick up epoch keys rotated since the identity was loaded. The owner desktop holds every epoch key itself,
   * so it reloads them from the key store (another process may have rotated). A `desktop-host` holds only
   * what the owner sealed to it: it fetches its grants from the relay and opens them with the pinned owner.
   *
   * A rotation stages its new epoch in the key store, has the relay commit it, and only then marks it current;
   * the relay announces the commit (`announced`) in between, and the rotating process may die before that last
   * step. So an announced epoch whose key the store already holds is made current here, durably, or every
   * question asked after a revocation would be sealed under the old key, which a newly paired phone cannot
   * read. The announcement is the relay's word, not proof: a lying relay can at most select a key this
   * installation generated whose rotation it then refused (phones lacking its grant cannot read what it
   * seals), a denial of service it can cause anyway. It can never introduce a key: an epoch the store does not
   * hold is never made current.
   */
  private async refreshKeys(announced?: number): Promise<void> {
    const { ctx, o } = this;
    if (ctx.identity.role === 'desktop-host') {
      let keyStore = o.keyStore ?? this.hostKeys;
      if (!keyStore) {
        keyStore = new MemoryKeyStore();
        await keyStore.save(ctx.identity.stored);
        this.hostKeys = keyStore;
      }
      ctx.client.identity = ctx.identity;
      let grants;
      try {
        ({ grants } = await ctx.client.keyGrants());
      } catch (e) {
        // The grants could not be read: an unreachable relay, a refusal that can pass (a clock it could not correct, a
        // relay being upgraded) or a reply that is no grant list. None of it says anything about the event, which is
        // retried later, in order. Only the relay saying this device is revoked ends it.
        if (isDeviceRevoked(e)) throw e;
        throw new TransientError(`epoch grants unavailable: ${(e as Error).message}`);
      }
      // What the grants say is final: one the pinned owner did not seal, or a changed identity, fails closed.
      ctx.identity = await refreshHostGrants(ctx.client, keyStore, grants);
      return;
    }
    if (!o.keyStore) return;
    let id: Identity;
    try {
      id =
        announced !== undefined
          ? await promoteEpoch(o.keyStore, announced)
          : await loadIdentity(o.keyStore);
    } catch (e) {
      // The key store could not be read (a locked keychain, a file mid-write): that says nothing about the event.
      throw new TransientError(`key store unavailable: ${(e as Error).message}`);
    }
    ctx.identity = id;
    ctx.client.identity = id;
  }

  /* ---------------- lifecycle ---------------- */

  /**
   * Reconcile interrupted injections, connect the socket, start the retry timer. Without a socket
   * (`socket: false`) the host reads events itself (`catchUp`, `sync`), or passes `poll` to have the bridge
   * sync over HTTP continuously, starting now, until it stops or is revoked.
   *
   * A stopped bridge can be started again, and delivers again once a write still in flight from before the stop has
   * settled. A revoked one cannot: `start` throws `forbidden`.
   */
  async start(opts: { socket?: boolean; poll?: HttpPollOptions | true } = {}): Promise<void> {
    if (opts.poll && opts.socket !== false)
      throw new BridgeError(
        'validation_error',
        'HTTP polling replaces the socket: pass socket: false',
      );
    // Revocation is final for this bridge, also once a stop has replaced its state: nothing reads or types again.
    if (this.revokedSeen)
      throw new BridgeError('forbidden', 'this device was revoked from the relay');
    if (this.state === 'running') return;
    const run = ++this.lifecycle;
    this.httpAbort = new AbortController();
    this.state = 'running';
    this.advisory.start();
    // This run has read nothing yet: a reopen may be waiting at the relay for an advisory notice still to type.
    this.ledgerRead = false;
    this.listeners.state.forEach((l) => l(this.state));
    // A store migrated from before content was sealed still holds plaintext: seal it before anything else.
    // A failure is reported, not fatal: legacy rows stay readable, so delivery must not stop over it, and the
    // next start tries again.
    await sealStoredContent(this.ctx).catch((e) => this.emitError(e as Error));
    // Recovery waits for a drain still writing from before a stop, and for an earlier start's recovery
    // (`reopenDelivery`). Behind either, it runs in the background, so a write that never returns does not keep this run
    // from reading: delivery stays closed until it is done.
    const behind = this.delivery.draining || this.reopensPending > 0;
    // Nothing more is typed before recovery has run, also on a first start behind a drain the host began.
    if (behind) this.delivery.stopped = true;
    const reopening = this.reopenDelivery(run);
    if (behind) reopening.catch((e) => this.emitError(e as Error));
    else await reopening;
    // Images a crash left with no queued create to use them.
    await this.publisher.pruneSpool().catch((e) => this.emitError(e as Error));
    // Stopped or revoked while recovering: nothing may start sending in the background now.
    if (run !== this.lifecycle) return;
    this.snapshots.start();
    this.involvement.start();
    this.presence.start();
    if (opts.socket !== false) this.socket.start();
    if (opts.poll) {
      this.poll = resolvePoll(opts.poll);
      this.pollMode = true;
      this.schedulePoll(0);
    }
    const every = this.o.pumpIntervalMs ?? 30_000;
    if (every > 0) {
      this.timer = setInterval(
        () => void this.pump().catch((e) => this.emitError(e as Error)),
        every,
      );
      (this.timer as { unref?: () => void }).unref?.();
    }
    void this.pump().catch((e) => this.emitError(e as Error));
  }

  /**
   * Reconcile interrupted injections for run `run`, then reopen delivery if the last stop closed it. Waits first for
   * the previous start's recovery, so two never reconcile the same intent, and for a drain still writing from before
   * the stop: recovery would take its open intent for a crash, and delivery reopened under it would let it type on. A
   * stop or revocation meanwhile leaves delivery closed.
   */
  private reopenDelivery(run: number): Promise<void> {
    const prior = this.reopening;
    this.reopensPending++;
    const next = (async () => {
      try {
        await prior;
        await this.delivery.idle();
        if (run !== this.lifecycle) return;
        await this.delivery.recover();
        if (run !== this.lifecycle || !this.delivery.stopped) return;
        this.delivery.stopped = false;
        // A pump that drained while delivery was closed typed nothing, and this run's first pump may only join it. The
        // applier delivers once more, after applying what is stored, so a withdrawal waiting there is applied first.
        this.redeliver = true;
        void this.applier.kick();
      } finally {
        this.reopensPending--;
      }
    })();
    this.reopening = next.catch(() => undefined);
    return next;
  }

  /**
   * Stop everything this bridge started. An HTTP sync in flight has its requests aborted, and `stop` waits for it to
   * settle, so the host can close the store afterwards; a request that is not the sync's own (a key lookup while
   * verifying an event) is cut short only by `RelayClient.close()`.
   */
  async stop(): Promise<void> {
    this.lifecycle++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopPolling();
    this.socket.stop();
    this.snapshots.stop();
    this.involvement.stop();
    this.presence.stop();
    this.advisory.stop();
    this.delivery.stopped = true;
    this.state = 'stopped';
    this.listeners.state.forEach((l) => l(this.state));
    // A sync's page read writes events and the cursor: its requests were just aborted, so it settles at once. Applying
    // and delivering are not waited for, as with the socket: the delivery engine stops admitting on its own.
    if (this.paging?.abortable) await this.paging.pass.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.statusWrites,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STATUS_WAIT_MS);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Settles once the work this bridge already started has finished: a pump or sync in flight, applying what it read,
   * and delivering, with what the sink reported recorded. For a host that has stopped the bridge (and ended its sink's
   * commands) and is about to close the store; never rejects. Work started after it is called is not waited for.
   */
  async idle(): Promise<void> {
    const quiet = (p: Promise<unknown> | null | undefined) =>
      (p ?? Promise.resolve()).then(
        () => undefined,
        () => undefined,
      );
    await Promise.all([
      quiet(this.pumping),
      quiet(this.syncing),
      quiet(this.paging?.pass),
      this.reopening,
      this.applier.idle(),
      this.deliverer.idle(),
    ]);
    await this.delivery.idle();
  }

  private stopPolling(): void {
    this.pollMode = false;
    this.poll = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.httpAbort.abort();
  }

  private markRevoked(): void {
    if (this.state === 'revoked') return;
    this.revokedSeen = true;
    // Recorded before anyone hears of it, so a host that stops (and closes the store) on `revoked` keeps the record.
    if (this.httpSynced) this.recordRevoked();
    this.lifecycle++;
    this.state = 'revoked';
    this.delivery.stopped = true;
    this.stopPolling();
    this.socket.stop();
    this.snapshots.stop();
    this.involvement.stop();
    this.presence.stop();
    this.advisory.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.state.forEach((l) => l('revoked'));
  }

  /* ---------------- Daintree-facing API ---------------- */

  /**
   * Commits locally and returns immediately; publishing happens in the background. `pump: false` leaves the publishing
   * to the host (`pump`, or `publisher.flush` alone when another process on the same store receives), so nothing is
   * sent or delivered before the host has told its caller the question id.
   */
  async registerQuestion(
    args: {
      origin: QuestionOrigin;
      input: unknown;
    } & RegisterOptions & { pump?: boolean },
  ): Promise<RegisterResult> {
    if (this.state === 'revoked')
      throw new BridgeError('forbidden', 'this device was revoked from the relay');
    const r = await this.publisher.register(
      args.origin,
      args.input,
      args.awaitAdvisorySupport ? { awaitAdvisorySupport: true } : {},
    );
    if (!r.duplicate && args.pump !== false)
      void this.pump().catch((e) => this.emitError(e as Error));
    return r;
  }

  /**
   * Withdraw a question this desktop asked: the desktop calls it off, which tells its agent nothing. The person
   * declining it on the owner desktop is `declineQuestion`.
   */
  async cancelQuestion(questionId: string, pane?: PaneIdentity): Promise<void> {
    await this.owned(questionId, pane);
    await this.publisher.enqueueCancel(questionId);
    void this.pump().catch((e) => this.emitError(e as Error));
  }

  /**
   * Publish the person's answer to an open question, given in the host app's own UI on the owner desktop and signed
   * with its key (protocol section 2: `human-desktop` provenance, typed and reported as the person's answer made on the
   * computer). It answers the owner's own questions and a Remote Host's alike, and needs no local copy of the
   * question: the host passes the revision the person reviewed, and the answer is signed against it and never moved
   * to a later one. The owner's own question is checked against its options, text rule and gate first.
   *
   * The answer is committed to the outbox, and one send is tried at once, in the outbox's order. The result says where
   * it stands: `sent`; `already-answered` (another answer won); `changed` (the question is open at another revision);
   * `closed` (expired, cancelled or declined, or unknown to the relay); `unsupported` by the relay or by the computer
   * that asked (which has not declared `owner-desktop-answers-v1`); `rejected`; or `queued` when it is not settled yet
   * (the relay could not be reached, it waits behind its question's create or withdrawal or the person's earlier
   * follow-up or decline on it, or the bridge is stopped), in which case the outbox keeps sending it and its outcome
   * arrives on `answer` (and from `getAnswerResult`). Every
   * outcome is reported on `answer` by the process that settles it, this one included. Pass `answerId` to make a
   * repeated submission the same answer.
   *
   * Owner desktop only: a Remote Host is refused (`forbidden`) before anything is signed. This is a host API: it is
   * not an MCP tool, and a pane's bearer token never reaches it.
   */
  async answerQuestion(input: AnswerQuestionInput): Promise<OwnerAnswerResult> {
    if (this.ctx.identity.role !== 'owner-desktop') {
      throw new BridgeError(
        'forbidden',
        "only the owner desktop answers for the person; a Remote Host never signs the person's answer",
      );
    }
    if (this.state === 'revoked')
      throw new BridgeError('forbidden', 'this device was revoked from the relay');
    const parsed = AnswerQuestionInput.safeParse(input);
    if (!parsed.success) {
      throw new BridgeError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const { answerId, settled } = await this.publisher.enqueueOwnerAnswer(parsed.data);
    if (settled) return settled;
    // The same ordered outbox send as the pump's, for this answer alone: it still waits behind its question's create
    // or cancellation, and is called off if the bridge stops or is revoked while it waits its turn.
    if (this.running()) {
      await this.publisher
        .flush({ only: ownerAnswerItemId(answerId), proceed: this.running })
        .catch((e) => this.emitError(e as Error));
    }
    return (
      (await this.publisher.ownerAnswerResult(answerId)) ?? {
        answerId,
        questionId: parsed.data.questionId,
        expectedRevision: parsed.data.expectedRevision,
        status: 'queued',
      }
    );
  }

  /**
   * Where an answer from `answerQuestion` stands, by its id; null for an id this store never took, or one a crash
   * kept from being queued (submit it again with the same id).
   */
  getAnswerResult(answerId: string): Promise<OwnerAnswerResult | null> {
    return this.publisher.ownerAnswerResult(answerId);
  }

  /**
   * Decline an open question for the person, from the host app's own UI on the owner desktop: a `cancel` signed with
   * its key and carrying `decline: true` (protocol section 6.1). Every desktop files it as the person's decline, as it
   * would a phone's: `get_decision` reports `closed_reason: declined`, and a listening agent is told it was declined.
   * It declines the owner's own questions and a Remote Host's alike, and needs no local copy of the question: the host
   * passes the revision the person saw, and the decline is signed against it and never moved to a later one.
   * Withdrawing a question is `cancelQuestion`, a different action.
   *
   * The decline is committed to the outbox, and one send is tried at once, in the outbox's order. The result says where
   * it stands: `declined`; `already-answered`; `changed` (the question is open at another revision); `closed` (expired,
   * withdrawn or declined first, or unknown to the relay); `unsupported` by the relay or by the computer that asked
   * (which has not declared `owner-desktop-declines-v1`); `rejected`; or `queued` when it is not settled yet (the relay
   * could not be reached, it waits behind its question's create or withdrawal or the person's earlier follow-up or
   * answer on it, or the bridge is stopped), in which case the outbox keeps sending it and its outcome arrives on
   * `decline` (and from `getDeclineResult`). Every outcome is
   * reported on `decline` by the process that settles it, this one included. Pass `declineId` to make a repeated
   * submission the same decline.
   *
   * Owner desktop only: a Remote Host is refused (`forbidden`) before anything is signed. This is a host API: it is not
   * an MCP tool, and a pane's bearer token never reaches it.
   */
  async declineQuestion(input: DeclineQuestionInput): Promise<OwnerDeclineResult> {
    if (this.ctx.identity.role !== 'owner-desktop') {
      throw new BridgeError(
        'forbidden',
        "only the owner desktop declines for the person; a Remote Host never signs the person's decline",
      );
    }
    if (this.state === 'revoked')
      throw new BridgeError('forbidden', 'this device was revoked from the relay');
    const parsed = DeclineQuestionInput.safeParse(input);
    if (!parsed.success) {
      throw new BridgeError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const { declineId, settled } = await this.publisher.enqueueOwnerDecline(parsed.data);
    if (settled) return settled;
    const running = () => this.state !== 'stopped' && this.state !== 'revoked';
    if (running()) {
      await this.publisher
        .flush({ only: ownerDeclineItemId(declineId), proceed: running })
        .catch((e) => this.emitError(e as Error));
    }
    return (
      (await this.publisher.ownerDeclineResult(declineId)) ?? {
        declineId,
        questionId: parsed.data.questionId,
        expectedRevision: parsed.data.expectedRevision,
        status: 'queued',
      }
    );
  }

  /**
   * Where a decline from `declineQuestion` stands, by its id; null for an id this store never took, or one a crash
   * kept from being queued (submit it again with the same id).
   */
  getDeclineResult(declineId: string): Promise<OwnerDeclineResult | null> {
    return this.publisher.ownerDeclineResult(declineId);
  }

  /**
   * Publish the person's follow-up on a question's thread, written in the host app's own UI on the owner desktop and
   * signed with its key as the person's message (protocol section 16): the asking desktop types it into the pane as
   * a follow-up `sent_from: computer`, and `get_decision` shows it as the person's, sent from the computer. It goes
   * to the owner's own questions and a Remote Host's alike, open or answered, and needs no local copy of the
   * question. As from a phone, it is text only, never expects a reply and never answers or changes the answer.
   *
   * The follow-up is committed to the outbox, and one send is tried at once, in the outbox's order (after its
   * question's create, a queued withdrawal and the person's earlier follow-ups, answers and declines on it). The result says where it
   * stands: `sent`; `closed` (expired, cancelled or declined, or unknown to the relay); `unsupported` by the relay or
   * by the computer that asked (which has not declared `owner-desktop-messages-v1`); `rejected` (a thread at its
   * message limit is `invalid_state`); or `queued` when it is not settled yet (the relay could not be reached, it
   * waits its turn, or the bridge is stopped), in which case the outbox keeps sending it and its outcome arrives on
   * `followUp` (and from `getFollowUpResult`). Every outcome is reported on `followUp` by the process that settles
   * it, this one included. Pass `messageId` to make a repeated submission the same follow-up.
   *
   * Owner desktop only: a Remote Host is refused (`forbidden`) before anything is signed. This is a host API: it is
   * not an MCP tool, and a pane's bearer token never reaches it.
   */
  async sendFollowUp(input: SendFollowUpInput): Promise<OwnerFollowUpResult> {
    if (this.ctx.identity.role !== 'owner-desktop') {
      throw new BridgeError(
        'forbidden',
        "only the owner desktop sends the person's follow-up; a Remote Host never speaks for the person",
      );
    }
    if (this.state === 'revoked')
      throw new BridgeError('forbidden', 'this device was revoked from the relay');
    const parsed = SendFollowUpInput.safeParse(input);
    if (!parsed.success) {
      throw new BridgeError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const { messageId, settled } = await this.publisher.enqueueOwnerMessage(parsed.data);
    if (settled) return settled;
    // The same ordered outbox send as the pump's, for this follow-up alone, called off if the bridge stops or is
    // revoked while it waits its turn.
    if (this.running()) {
      await this.publisher
        .flush({ only: ownerMessageItemId(messageId), proceed: this.running })
        .catch((e) => this.emitError(e as Error));
    }
    return (
      (await this.publisher.ownerMessageResult(messageId)) ?? {
        messageId,
        questionId: parsed.data.questionId,
        status: 'queued',
      }
    );
  }

  /**
   * Where a follow-up from `sendFollowUp` stands, by its id; null for an id this store never took, or one a crash
   * kept from being queued (submit it again with the same id).
   */
  getFollowUpResult(messageId: string): Promise<OwnerFollowUpResult | null> {
    return this.publisher.ownerMessageResult(messageId);
  }

  /**
   * Post an agent message in the thread of a question `pane` asked: commits locally and returns immediately;
   * publishing happens in the background. Another pane's question is refused exactly like an unknown id. A
   * message never answers the question, changes its answer or touches its gate.
   */
  async postMessage(input: unknown, pane: PaneIdentity): Promise<PostMessageResult> {
    if (this.state === 'revoked')
      throw new BridgeError('forbidden', 'this device was revoked from the relay');
    const parsed = PostMessageInput.safeParse(input);
    if (!parsed.success) {
      throw new BridgeError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    // Scoped to a pane, always: unlike getDecision, there is no unscoped form.
    if (!pane) throw new BridgeError('not_found', 'unknown question');
    const row = await this.owned(parsed.data.question_id, pane);
    const r = await this.publisher.enqueueMessage(row.question_id, parsed.data);
    void this.pump().catch((e) => this.emitError(e as Error));
    return r;
  }

  /**
   * Publish what the asking pane looks like as the question's latest snapshot. The host supplies the text,
   * already redacted; the library bounds it to the protocol's caps, encrypts it and sends it in the
   * background. Updates closer together than `snapshots.minIntervalMs` are coalesced, so only the newest
   * of a burst is sent. Resolves once it is queued, not sent: transient failures are retried, and a refusal
   * other than a closed question or a stale observation is reported on `error`.
   */
  async publishSnapshot(
    questionId: string,
    input: PaneSnapshotInput,
    pane?: PaneIdentity,
  ): Promise<SnapshotPublishResult> {
    if (this.state === 'revoked')
      throw new BridgeError('forbidden', 'this device was revoked from the relay');
    const row = await this.owned(questionId, pane);
    return this.snapshots.publish(row, input);
  }

  /**
   * Stop sharing: replace the snapshot of one question, or of every open question this device published,
   * with a sharing-off record, so phones show "not shared" instead of a stale snapshot. A snapshot waiting
   * to be sent is dropped. Resolves once every record is settled (see `SnapshotPublisher.clear`). Publishing
   * again shares again; whether sharing is on is the host's decision.
   */
  async clearSnapshots(questionId?: string, pane?: PaneIdentity): Promise<void> {
    const row = questionId === undefined ? undefined : await this.owned(questionId, pane);
    return this.snapshots.clear(row);
  }

  /**
   * How involved the person wants to be right now (protocol section 20), from this desktop's verified copy: it
   * never touches the network and creates nothing. A temporary mode's end is worked out on each call, without a
   * new revision. Unavailable, stale or unsupported means the agent keeps its normal configured behaviour. It
   * carries no authority: no requirement, gate or proxy rule reads it.
   */
  async getInvolvement(): Promise<InvolvementView> {
    const v = await this.involvement.view();
    if (this.state !== 'revoked') return v;
    return {
      status: 'unavailable',
      reason: 'device-revoked',
      lastSyncedAt: v.lastSyncedAt,
      stale: true,
    };
  }

  /**
   * The whole involvement preference, for the host app's own settings screen: the normal mode, the consult count, the
   * temporary mode and its end, the revision a save replaces, and where the person set it (`computer` or `phone`, from
   * the signer's certificate). From the same verified copy as `getInvolvement`, so it never touches the network.
   * Agents never see where it was set. This is a host API: it is not an MCP tool, and a pane's bearer token never
   * reaches it.
   */
  async getInvolvementPreference(): Promise<InvolvementPreference> {
    const p = await this.involvement.preference();
    if (this.state !== 'revoked') return p;
    return {
      status: 'unavailable',
      reason: 'device-revoked',
      revision: p.revision,
      lastSyncedAt: p.lastSyncedAt,
      stale: true,
    };
  }

  /**
   * Set the person's involvement preference from the host app's own UI on the owner desktop, signed with its key
   * (protocol section 20). `expectedRevision` is the revision the person reviewed (`getInvolvementPreference`): the
   * relay compare-and-swaps on it, so a phone's save made meanwhile comes back as a `conflict` to show, never
   * overwritten. A saved preference reaches this desktop's agents at once, and every other device on the relay's hint.
   *
   * Owner desktop only: a Remote Host is refused (`forbidden`) before anything is signed, as is a revoked desktop, and
   * the bridge must be started (`invalid_state`). Input the relay would refuse is a `validation_error`. This is a host
   * API: it is not an MCP tool, and a pane's bearer token never reaches it.
   */
  async setInvolvementPreference(input: SetInvolvementInput): Promise<SetInvolvementResult> {
    if (this.ctx.identity.role !== 'owner-desktop') {
      throw new BridgeError(
        'forbidden',
        "only the owner desktop sets the person's involvement preference; a Remote Host never signs it",
      );
    }
    if (this.state === 'revoked')
      throw new BridgeError('forbidden', 'this device was revoked from the relay');
    if (this.state !== 'running')
      throw new BridgeError(
        'invalid_state',
        'start the bridge before setting the involvement preference',
      );
    const parsed = SetInvolvementInput.safeParse(input);
    if (!parsed.success) {
      throw new BridgeError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const issue = this.involvement.inputIssue(parsed.data);
    if (issue) throw new BridgeError('validation_error', issue);
    return this.involvement.save(parsed.data);
  }

  /**
   * Say whether the person is at the owner desktop (protocol section 11), so the relay holds a new question's phone
   * push briefly while they are. The host reports `true` when the person is active (again every 30 s or so while they
   * stay, and at once when they come back) and `false` when they leave, lock the screen or the computer sleeps. Each
   * `true` counts for `PRESENCE_REPORT_MS` (two minutes): while one does, the bridge keeps the relay's 60-second lease
   * current in the background; `false` ends it. Once reports stop, renewal stops when the last one goes stale, and when
   * the bridge stops it stops at once: either way the lease lapses 60 seconds after its last renewal. Returns at once,
   * without waiting for the relay.
   *
   * Only the flag is sent: nothing about questions, panes or content. A relay that does not advertise `presence-v1` is
   * never sent it, and reporting to one does nothing, without an error. Before `start()` the latest report is kept and
   * acted on when the bridge starts, if still fresh; `stop()` forgets it.
   *
   * Owner desktop only: a Remote Host is refused (`forbidden`). This is a host API: it is not an MCP tool, and a
   * pane's bearer token never reaches it.
   */
  reportPresence(present: boolean): void {
    if (this.ctx.identity.role !== 'owner-desktop') {
      throw new BridgeError(
        'forbidden',
        'only the owner desktop reports that the person is at the computer; a Remote Host never does',
      );
    }
    if (this.state === 'revoked')
      throw new BridgeError('forbidden', 'this device was revoked from the relay');
    if (typeof present !== 'boolean')
      throw new BridgeError('validation_error', 'present must be true or false');
    this.presence.report(present);
  }

  /**
   * Ask the relay to tell the person's phone that an agent stopped (protocol section 11, `agent-stopped-push-v1`).
   * When to ask (which stops count, whether the person is away, quiet hours, batching stops that land together) is
   * the host's call; the relay still drops a request in its quiet hours, and accepts at most one a minute.
   *
   * It takes nothing, and sends nothing but the protocol version: which agent stopped, where, how many and why stay
   * on the computer. A relay that does not advertise `agent-stopped-push-v1` is never asked, and asking one resolves
   * `unsupported`, without an error. The request is sent at most once, never retried, whatever its outcome: a refusal,
   * rate-limited or otherwise, or a relay that could not be reached, resolves `dropped`, so a stop is never alerted
   * late. Resolves with the outcome (`AgentStoppedPushResult`) and never rejects over the relay.
   *
   * Owner desktop only: a Remote Host is refused (`forbidden`) before anything is signed, as is a revoked desktop, and
   * the bridge must be started (`invalid_state`); one stopped while the relay's features are read sends nothing, though
   * a request already being signed or sent still goes out. This is a host API: it is not an MCP tool, and a pane's
   * bearer token never reaches it.
   */
  async requestAgentStoppedPush(): Promise<AgentStoppedPushResult> {
    if (this.ctx.identity.role !== 'owner-desktop') {
      throw new BridgeError(
        'forbidden',
        'only the owner desktop asks for an agent-stopped push; a Remote Host never does',
      );
    }
    if (this.state === 'revoked')
      throw new BridgeError('forbidden', 'this device was revoked from the relay');
    if (this.state !== 'running')
      throw new BridgeError('invalid_state', 'start the bridge before asking for a push');
    const run = this.lifecycle;
    return this.agentStopped.request(() => this.state === 'running' && run === this.lifecycle);
  }

  async getDecision(questionId: string, pane?: PaneIdentity): Promise<DecisionView> {
    // Whether an advisory notice would wait for the ledger is read before the row: an event applied in between is
    // then in the row, and one applied after it was still unsettled here. It starts no clock: the question may still be
    // open, and the two-minute hold is timed only once its notice waits (`view`).
    const unsettled = await this.delivery
      .ledgerHolds(questionId, { start: false })
      .catch(() => true);
    const unapplied = await this.unappliedEvent(questionId);
    const row = await this.owned(questionId, pane);
    return this.view(row, unsettled, unapplied);
  }

  async listPending(pane?: PaneIdentity): Promise<DecisionView[]> {
    const rows = await this.ctx.store.listQuestions({
      status: ['queued', 'open', 'proxy-answered'],
    });
    return Promise.all(
      rows.filter((r) => !pane || sameAsker(r.origin, pane)).map((r) => this.view(r)),
    );
  }

  /** Only the owning pane may see or cancel a question; others get the same error as an unknown id. */
  private async owned(questionId: string, pane?: PaneIdentity): Promise<QuestionRow> {
    const row = await this.ctx.store.getQuestion(questionId);
    if (!row || (pane && !sameAsker(row.origin, pane))) {
      throw new BridgeError('not_found', 'unknown question');
    }
    return row;
  }

  /** Opens the answers in memory to build the view; nothing decrypted is written back. */
  private async view(
    row: QuestionRow,
    unsettled?: boolean,
    unapplied?: boolean,
  ): Promise<DecisionView> {
    const create = (await this.ctx.store.outboxFor(row.question_id)).find(
      (o) => o.kind === 'create',
    );
    const entries = await openAnswers(this.ctx, row);
    const unpublished = entries.find((e) => e.kind === 'unpublished');
    const timeout = this.advisoryTimeout(row, entries);
    // The host as it stands while the answers just read are current, as the published notice's view reads it.
    const host = {
      outcomes: this.advisory.hostSupport,
      allowed: this.ctx.policy.advisoryQuestions,
    };
    // A notice nothing was typed for, waiting for the ledger (a reopen may be on its way), does not let the plan go
    // ahead here either.
    const noticeWaits =
      timeout?.inForce === true &&
      (timeout.view.notice === 'pending' ||
        (timeout.view.notice === 'needs-attention' && !timeout.view.writeRefused));
    // Read (and the hold timed from now, if it is not yet) only once a notice waits; an earlier unsettled read wins.
    const held = noticeWaits
      ? await this.delivery.ledgerHolds(row.question_id).catch(() => true)
      : false;
    // One whose admitted write its sink refused was settled as a typed one is, so only an event of its question stored
    // since and not yet applied (a reopen read past a gap) holds it: the store shows that to every process alike.
    const refusedWaits =
      timeout?.inForce === true && timeout.view.writeRefused
        ? (unapplied ?? (await this.unappliedEvent(row.question_id)))
        : false;
    const waiting = (noticeWaits && (unsettled === true || held)) || refusedWaits;
    const answered = row.local_status === 'human-answered' || row.local_status === 'proxy-answered';
    // The answer in force is the last one that carried content; a later confirm-proxy makes it the human's.
    let current: OpenAnswerEntry | undefined;
    let confirmation: OpenAnswerEntry | undefined;
    for (const e of entries) {
      if (e.kind !== 'answer') continue;
      if (e.action === 'confirm-proxy') confirmation = current ? e : undefined;
      else {
        current = e;
        confirmation = undefined;
      }
    }
    const confirmed = !!confirmation;
    const inForce = answered ? current : undefined;
    // Only a reopen changes a cancelled question, and it moves the revision on: a decline at this revision is the
    // cancellation in force.
    const declined = entries.some(
      (e) => e.kind === 'declined' && e.revision === row.question_revision,
    );
    // Every answer, correction or confirmation moves the revision on and is kept with its revision; a reopen moves it
    // without one. So a revision the answers do not account for means the question was reopened into a round that
    // waits for a decision. History an older bridge did not keep reads as reopened: the safe side.
    const answeredRevisions = new Set(
      entries.filter((e) => e.kind === 'answer').map((e) => e.revision),
    ).size;
    const replyMode: ReplyMode =
      replyModeOfRow(row) === 'advisory' && row.question_revision <= answeredRevisions
        ? 'advisory'
        : 'blocking';
    let plannedFallback: string | null = null;
    if (replyMode === 'advisory') {
      // Opened with the keys already held: reading a decision never asks the relay for one.
      const content = await openQuestionContent({ identity: this.ctx.identity }, row).catch(
        () => null,
      );
      plannedFallback = content?.planned_fallback ?? null;
    }
    // A never-published notice that may have been typed keeps what it said: the question is flagged so, or an intent
    // for it is still uncertain (a retry clears the flag, never the intent, and delivery stays blocked on it).
    const planMaybeTyped =
      unpublished?.fallback_due === true &&
      !unpublished.delivered &&
      (row.delivery_status === 'delivery-uncertain' ||
        (await this.ctx.store.hasUncertainIntent(row.question_id)));
    return {
      questionId: row.question_id,
      alias: row.alias,
      status: row.local_status,
      publication: publicationOf(row, create, !!unpublished),
      requirement: row.requirement,
      deliveryStatus: row.delivery_status,
      revision: row.question_revision,
      expiresAt: row.expires_at,
      replyMode,
      plannedFallback,
      errorCode: row.local_status === 'publish-failed' ? row.error_code : null,
      workflowGateId: row.origin.workflow_gate_id,
      provenance: inForce
        ? confirmed
          ? 'human'
          : inForce.source === 'proxy'
            ? 'proxy'
            : 'human'
        : null,
      answeredOn: inForce ? answeredOn(confirmation ?? inForce) : null,
      closedReason:
        row.local_status === 'cancelled'
          ? declined
            ? 'declined'
            : 'withdrawn'
          : row.local_status === 'expired'
            ? 'expired'
            : row.local_status === 'publish-failed' && unpublished
              ? 'never-published'
              : null,
      fallbackDue:
        !row.history_only &&
        ((row.local_status === 'publish-failed' &&
          !!unpublished &&
          unpublishedPlanDue(unpublished, planMaybeTyped, host)) ||
          (timeout?.inForce === true && timeout.view.disposition === 'fallback-due' && !waiting)),
      advisoryTimeout: timeout?.view ?? null,
      choice: inForce?.choices[0]?.id ?? null,
      text: inForce?.text ?? '',
      // Only a human answer that carried its own content attests to the images the phone displayed.
      reviewedDigestsMatch:
        !!inForce &&
        inForce.source === 'human' &&
        row.attachment_digests.length > 0 &&
        sameDigests(inForce.reviewed_attachment_digests, row.attachment_digests),
      answers: entries
        .filter((e) => e.kind === 'answer')
        .map((e) => ({
          revision: e.revision,
          source: e.source,
          answeredOn: answeredOn(e),
          choices: e.choices.map((c) => c.id),
          text: e.text,
          correction: e.correction,
          reason: e.reason ?? '',
          delivered: e.delivered,
          createdAt: e.created_at,
        })),
      thread: await this.thread(row, entries),
    };
  }

  /**
   * The advisory round's unanswered deadline, if it had one, with whether its notice still describes the question.
   * Imported history has none: its entries were never delivered by this desktop.
   */
  private advisoryTimeout(
    row: QuestionRow,
    entries: OpenAnswerEntry[],
  ): { view: AdvisoryTimeoutView; inForce: boolean } | null {
    const e = entries.findLast(isAdvisoryNotice);
    if (!e?.advisory_disposition || row.history_only) return null;
    const inForce = e.deliver && closureInForce(e, row);
    // A write that may have reached the terminal stays uncertain, also once a reopen or a deletion replaced the round.
    const notice: AdvisoryTimeoutView['notice'] = e.delivered
      ? 'delivered'
      : e.uncertain_injection_id
        ? 'uncertain'
        : !inForce
          ? 'superseded'
          : row.delivery_status === 'delivery-uncertain'
            ? 'uncertain'
            : row.delivery_status === 'needs-attention'
              ? 'needs-attention'
              : 'pending';
    // A notice nothing was typed for yet says what the host allows when it is typed (delivery checks again before
    // then); one that was typed, or may have been, keeps what it said.
    const disposition =
      notice === 'pending' || notice === 'needs-attention'
        ? (currentDisposition(e.advisory_disposition, {
            outcomes: this.advisory.hostSupport,
            allowed: this.ctx.policy.advisoryQuestions,
          }) ?? e.advisory_disposition)
        : e.advisory_disposition;
    return {
      inForce,
      view: {
        revision: e.revision,
        deadline: e.created_at,
        disposition,
        notice,
        injectionId:
          notice === 'delivered'
            ? (e.injection_id ?? null)
            : notice === 'uncertain'
              ? (e.uncertain_injection_id ?? null)
              : null,
        writeRefused: notice === 'needs-attention' && e.write_refused === true,
        agentAction: 'unobserved',
      },
    };
  }

  /** The question's answers and messages, merged in ledger order (answers stored before threads come first). */
  private async thread(row: QuestionRow, entries: OpenAnswerEntry[]): Promise<ThreadEntryView[]> {
    const out: { seq: number; entry: ThreadEntryView }[] = [];
    for (const e of entries) {
      if (e.kind !== 'answer') continue;
      out.push({
        seq: e.event_seq ?? 0,
        entry: {
          kind: 'answer',
          revision: e.revision,
          source: e.source,
          answeredOn: answeredOn(e),
          choices: e.choices.map((c) => c.id),
          text: e.text,
          correction: e.correction,
          delivered: e.delivered,
          createdAt: e.created_at,
        },
      });
    }
    for (const m of parseMessages(row.messages_json)) {
      let text = '';
      let images: { attachment_id: string; alt?: string }[] = [];
      let unreadable = false;
      try {
        const c = await openMessageContent(this.ctx, row.question_id, m);
        text = c.text;
        images = c.images;
      } catch {
        // Listed without its words, never shown as an empty message that was read; a key not loaded yet never
        // keeps the answers from being reported.
        unreadable = true;
      }
      const paths = new Map(
        (m.delivery?.stored_images ?? []).map((s) => [s.attachment_id, s.path]),
      );
      out.push({
        seq: m.event_seq,
        entry: {
          kind: 'message',
          messageId: m.message_id,
          messageSeq: m.message_seq,
          side: m.side,
          sentFrom: messageSentOn(m),
          expectsReply: m.expects_reply,
          text,
          images: images.map((i) => ({
            attachmentId: i.attachment_id,
            ...(i.alt ? { alt: i.alt } : {}),
            ...(paths.has(i.attachment_id) ? { path: paths.get(i.attachment_id)! } : {}),
          })),
          createdAt: m.created_at,
          unreadable,
          delivery: m.delivery
            ? {
                status: m.delivery.status,
                receivedAt: m.delivery.received_at,
                terminalDeliveredAt: m.delivery.terminal_delivered_at,
                injectionId: m.delivery.injection_id,
                errorCode: m.delivery.error_code,
              }
            : null,
        },
      });
    }
    return out.sort((a, b) => a.seq - b.seq).map((x) => x.entry);
  }

  /**
   * Whether the ledger may hold a later event (a reopen, a deletion) for the round an advisory notice of `questionId`
   * closed (`DeliveryOptions.replaying`): `unapplied` when an event of that question is stored and not applied yet (a
   * gap waits for the events before it), `reading` while a read of the relay is under way, a read failed part-way or
   * none reached the relay's end since this run started, or an event of another question waits to be applied.
   */
  private async ledgerUnsettled(questionId: string): Promise<'unapplied' | 'reading' | null> {
    const stored = await this.ctx.store.unprocessedEvents(UNAPPLIED_SCAN);
    for (const e of stored) {
      let id: unknown;
      try {
        id = (JSON.parse(e.json) as { question_id?: unknown }).question_id;
      } catch {
        id = undefined;
      }
      if (id === questionId) return 'unapplied';
    }
    // More than were looked through: one of them may be the question's, so the wait is bounded like a read's.
    return this.socketReplay || this.paging !== null || !this.ledgerRead || stored.length > 0
      ? 'reading'
      : null;
  }

  /** Whether an event of `questionId` is stored and not yet applied (`ledgerUnsettled`); one that cannot be read is. */
  private async unappliedEvent(questionId: string): Promise<boolean> {
    const state = await this.ledgerUnsettled(questionId).catch(() => 'unapplied' as const);
    return state === 'unapplied';
  }

  /** The pane became idle (Daintree's wake gate): try pending deliveries now. */
  async notifyPaneIdle(): Promise<DrainResult> {
    return this.delivery.drain();
  }

  async retryDelivery(questionId: string): Promise<DrainResult> {
    await this.delivery.retry(questionId);
    return this.delivery.drain();
  }

  /* ---------------- pump ---------------- */

  /** Neither stopped nor revoked: an outbox send waiting its turn goes ahead only while this holds. */
  private readonly running = () => this.state !== 'stopped' && this.state !== 'revoked';

  /** Flush the outbox, run the proxy for new proxy-capable questions, apply inbound events, deliver. */
  pump(): Promise<void> {
    if (!this.running()) return Promise.resolve();
    // The relay is refusing this device's signature: every signed request now counts against its limit on failed
    // authentications from this address, so the background work waits for the sync's slow retry to get through.
    if (this.pollMode && this.authRefused) return Promise.resolve();
    // Beside the pump, never inside it: a slow relay must not keep a question asked meanwhile from the next flush. It
    // reads only on a host that could ask for advice, and never throws.
    const advisory = this.advisory.refreshIfDue();
    // This run's recovery failed, so delivery is still closed: try it again rather than leave it closed until a restart.
    if (this.delivery.stopped && this.reopensPending === 0)
      void this.reopenDelivery(this.lifecycle).catch((e) => this.emitError(e as Error));
    if (this.pumping) return Promise.all([this.pumping, advisory]).then(() => undefined);
    const core = (async () => {
      try {
        // A flush that waits behind another, or is still sending when the bridge stops, sends nothing more.
        const flushed = await this.publisher.flush({ proceed: this.running });
        if (flushed.created.length > 0) this.snapshots.kick();
        for (const id of flushed.created) await this.maybeRunProxy(id);
        if (flushed.created.length > 0) await this.publisher.flush({ proceed: this.running });
        await this.inbox.processPending();
        await this.deliverNow();
        if (await this.inbox.hasGap()) await this.recoverGap();
        // A polling bridge reads the preference after each successful sync instead, so a relay refusing this device
        // hears from it on the sync's slow schedule, not every pump.
        if (!this.pollMode) this.involvement.retryIfDue();
      } finally {
        this.pumping = null;
      }
    })();
    this.pumping = core;
    return Promise.all([core, advisory]).then(() => undefined);
  }

  private async deliverNow(): Promise<void> {
    const before = await this.ctx.store.listQuestions({
      status: [
        'open',
        'proxy-answered',
        'human-answered',
        'expired',
        'cancelled',
        'publish-failed',
      ],
    });
    const r = await this.delivery.drain();
    if (r.delivered > 0) {
      for (const q of before) {
        const after = await this.ctx.store.getQuestion(q.question_id);
        if (
          after &&
          after.delivery_status === 'terminal-delivered' &&
          q.delivery_status !== 'terminal-delivered'
        ) {
          // Two drains running at once (overlapping catch-ups) can both see this one settle.
          const key = `${q.question_id}:${after.last_injection_id ?? ''}`;
          if (this.announced.has(key)) continue;
          this.announced.add(key);
          const what = deliveredKind(q.answers_json, after.answers_json);
          this.listeners.delivered.forEach((l) => l(q.question_id, what));
        }
      }
    }
  }

  /* ---------------- inbound ---------------- */

  private async onSocketEvent(ev: LedgerEvent): Promise<void> {
    const { cursor } = await this.inbox.persist(ev); // durable BEFORE the ack
    try {
      this.socket.ack(cursor);
    } catch {
      /* socket closed; the next sync re-sends from the stored cursor */
    }
    // A frame of a replay is applied but not delivered: a later frame of the same replay (a reopen) may replace
    // what it closed. The pump after the replay's last segment delivers whatever is still in force.
    const drain = await this.inbox.processPending();
    if (this.socket.currentState !== 'syncing' && (drain || this.delivery.replayHeld))
      await this.deliverNow();
    if (await this.inbox.hasGap()) await this.recoverGap();
  }

  /** A replay segment finished: everything the relay holds up to `highWater` is now stored. */
  private async onCaughtUp(highWater: number, hasMore: boolean): Promise<void> {
    // Holes left by tombstoned (deleted) questions are legitimate; the relay's replay is authoritative.
    await this.ctx.store.forceCursor(highWater);
    const cursor = await this.ctx.store.getCursor();
    try {
      this.socket.ack(cursor);
    } catch {
      /* closed */
    }
    if (!hasMore) {
      // Read in full: the pump applies and delivers what the replay brought, advisory notices included. A pump
      // already running when the replay ended may have held one: it is delivered now.
      this.socketReplay = false;
      this.ledgerRead = true;
      await this.pump();
      if (this.delivery.replayHeld) await this.deliverNow();
    } else await this.inbox.processPending();
  }

  private lastGap = { cursor: -1, at: 0 };

  /**
   * Events exist beyond the confirmed frontier: ask the relay for an authoritative replay of the hole
   * instead of acting on events that arrived out of order. Throttled so a persistent hole cannot loop.
   */
  async recoverGap(): Promise<void> {
    // Stopped: nothing reads any more. Polling: the next scheduled sync reads the hole, keeping its backoff.
    if (!this.running() || this.pollMode) return;
    const cursor = await this.ctx.store.getCursor();
    if (cursor === this.lastGap.cursor && this.ctx.now() - this.lastGap.at < 5000) return;
    this.lastGap = { cursor, at: this.ctx.now() };
    try {
      if (this.socket.currentState === 'live' || this.socket.currentState === 'syncing') {
        this.socketReplay = true;
        this.socket.syncFrom(cursor);
      } else await this.catchUp();
    } catch (e) {
      this.emitError(e as Error);
    }
  }

  /**
   * HTTP catch-up (no socket): page through events after the stored cursor, then apply and deliver them. After each
   * fully persisted page the cursor moves to `next_after`, which also steps over legitimate tombstone holes. Reading
   * is one pass at a time: a call while another reads joins that read, so two never page (or move the cursor) at once.
   * Applying and delivering are not: a call while an earlier one is still delivering reads afresh and applies what it
   * finds, so a withdrawal still lands while an answer waits to be typed.
   */
  catchUp(): Promise<number> {
    // Bounded, and cut short by `stop`, so a sync that joins this read cannot hang behind it.
    return this.catchUpWith({
      timeoutMs: CATCH_UP_TIMEOUT_MS,
      ...(this.running() ? { signal: this.httpAbort.signal } : {}),
    });
  }

  private async catchUpWith(req: CallOptions): Promise<number> {
    const cursor = await this.readPages(req);
    await this.reportReceived(cursor, req);
    // An advisory notice held while the ledger was read is delivered now, even when the read brought nothing.
    const drain = await this.inbox.processPending();
    if (drain || this.delivery.replayHeld) await this.deliverNow();
    this.refreshPreference();
    return cursor;
  }

  /** Tell the relay how far this desktop has read. Informational, unless the relay says the device was revoked. */
  private async reportReceived(cursor: number, req: CallOptions): Promise<void> {
    try {
      await this.ctx.client.deliveriesReceived(cursor, req);
    } catch (e) {
      if (isDeviceRevoked(e)) this.markRevoked();
    }
  }

  /** Without a socket there is no reconnect to read the preference on: read it after each complete catch-up. */
  private refreshPreference(): void {
    if (this.socket.currentState !== 'live')
      void this.involvement.refresh().catch((e) => this.emitError(e as Error));
  }

  /** The applier's run: apply the stored events, and have the deliverer type what they bring. */
  private async applyStored(): Promise<void> {
    if (!this.running()) return;
    const drain = await this.inbox.processPending();
    const reopened = this.redeliver;
    this.redeliver = false;
    if (drain || reopened || this.delivery.replayHeld) void this.deliverer.kick();
  }

  private readPages(req: CallOptions): Promise<number> {
    if (this.paging) return this.paging.pass;
    // A read that started before the bridge was (re)started says nothing about what this run has read.
    const run = this.lifecycle;
    const pass = this.pageEvents(req)
      .then(
        (cursor) => {
          if (run === this.lifecycle) this.ledgerRead = true;
          return cursor;
        },
        (e: unknown) => {
          // Read part-way: what the pages after it hold is unknown until a read gets through.
          this.ledgerRead = false;
          throw e;
        },
      )
      .finally(() => {
        if (this.paging?.pass === pass) this.paging = null;
      });
    this.paging = { pass, abortable: req.signal !== undefined };
    return pass;
  }

  private async pageEvents(req: CallOptions): Promise<number> {
    let after = await this.ctx.store.getCursor();
    for (;;) {
      const page = await this.ctx.client.events(after, LIMITS.eventPageSize, this.features, req);
      for (const ev of page.events) await this.inbox.persist(ev as LedgerEvent);
      await this.ctx.store.advanceCursor();
      if (page.next_after > after) {
        await this.ctx.store.forceCursor(page.next_after);
        after = page.next_after;
      } else if (page.has_more) {
        throw new Error('relay returned a page that does not advance the cursor');
      }
      if (!page.has_more) break;
    }
    return this.ctx.store.getCursor();
  }

  /**
   * One HTTP sync, for a host without a socket: declare this bridge's features to the relay (on its first sync after
   * each start and every few minutes after, through a socket ticket it never uses, since the relay keeps only a
   * ticket's declaration and another process of the same device may have replaced it), and read every event after
   * the stored cursor (`catchUp`) with a deadline on each request and no retries of its own. It records the outcome
   * in the store (`readHttpSyncStatus`) and emits `sync`, then applies and delivers what it read in the background,
   * so a sink that takes its time never holds up the next read; `settle` waits for that too (a one-shot run). A device
   * the relay reports revoked stops the bridge as a revocation through the socket would; a relay that needs a newer
   * client (`fatal`) stops the polling. Never throws: a failure is the result's `outcome`. A call while a sync runs
   * joins it.
   */
  async sync(opts: { settle?: boolean } = {}): Promise<HttpSyncStatus> {
    if (!this.syncing) {
      const pass = this.runSync().finally(() => {
        if (this.syncing === pass) this.syncing = null;
      });
      this.syncing = pass;
    }
    const status = await this.syncing;
    if (opts.settle) {
      // Fresh runs of both, after this sync's read: whatever another run already took is done by then too.
      await this.applier.kick();
      await this.deliverer.kick();
    }
    return status;
  }

  private async runSync(): Promise<HttpSyncStatus> {
    const run = this.lifecycle;
    this.httpSynced = true;
    const prev = (await readHttpSyncStatus(this.ctx.store).catch(() => null)) ?? NEVER_SYNCED;
    if (this.revokedSeen) return { ...prev, outcome: 'revoked', reason: 'device_revoked' };
    const poll = this.poll;
    const req: CallOptions = {
      retry: false,
      timeoutMs: (poll ?? DEFAULT_POLL).requestTimeoutMs,
      signal: this.httpAbort.signal,
    };
    const startedAt = this.ctx.now();
    let cursor = 0;
    let failure: { error: unknown } | null = null;
    try {
      if (this.declaredRun !== run || startedAt - this.declaredAt >= DECLARE_EVERY_MS) {
        await this.ctx.client.socketTicket(this.features, req);
        this.declaredRun = run;
        this.declaredAt = startedAt;
      }
      cursor = await this.readPages(req);
      await this.reportReceived(cursor, req);
    } catch (e) {
      failure = { error: e };
      if (isDeviceRevoked(e)) this.markRevoked();
    }
    // Read afresh: a revocation (the refusal above, or a `device.revoked` event the pass applied) is final, even when
    // the host stopped the bridge since; any other change of run means the stop cut this sync short.
    const revoked = this.revokedSeen as boolean;
    if (!revoked && (run !== this.lifecycle || this.state === 'stopped'))
      return { ...prev, outcome: 'stopped', next_attempt_at: null };
    const now = this.ctx.now();
    let status: HttpSyncStatus;
    if (revoked) {
      status = {
        ...prev,
        outcome: 'revoked',
        last_attempt_at: startedAt,
        reason: 'device_revoked',
        next_attempt_at: null,
      };
    } else if (!failure) {
      this.syncFailures = 0;
      this.authRefused = false;
      status = {
        v: 1,
        outcome: 'ok',
        last_success_at: now,
        last_success_cursor: cursor,
        last_attempt_at: startedAt,
        failures: 0,
        reason: null,
        next_attempt_at: poll ? now + poll.intervalMs : null,
      };
    } else {
      this.syncFailures++;
      this.authRefused =
        failure.error instanceof RelayError && failure.error.code === 'not_authenticated';
      const fatal = isFatalSyncError(failure.error);
      if (fatal) {
        // Polling ends, but this run stays one that polls: nothing else starts reading the relay instead.
        this.poll = null;
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
      status = {
        ...prev,
        outcome: fatal ? 'fatal' : 'degraded',
        last_attempt_at: startedAt,
        failures: this.syncFailures,
        reason: syncFailureReason(failure.error),
        next_attempt_at:
          poll && !fatal ? now + retryDelayMs(this.syncFailures, poll, failure.error) : null,
      };
    }
    // Queued, not awaited: a store slow to write must not hold up polling. A revocation was recorded as it happened
    // (`markRevoked`). Classifying, queueing and announcing run without a pause, so nothing changes in between.
    if (!revoked) void this.recordStatus(status);
    if (run === this.lifecycle) {
      // Whatever was read, a failed sync's earlier pages included, is applied and delivered in the background.
      void this.applier.kick();
      // Not after a failed sync: the relay is not answering, or refusing this device, and is asked on its schedule.
      if (!failure) this.refreshPreference();
    }
    for (const l of [...this.listeners.sync]) {
      try {
        l(status);
      } catch (e) {
        this.emitError(e as Error);
      }
    }
    return status;
  }

  private recordStatus(status: HttpSyncStatus): Promise<void> {
    return this.writeStatus(async () => status);
  }

  /** The device is revoked: what the last sync recorded stays, with that as its outcome. */
  private recordRevoked(): void {
    const at = this.ctx.now();
    void this.writeStatus(async () => ({
      ...((await readHttpSyncStatus(this.ctx.store)) ?? NEVER_SYNCED),
      outcome: 'revoked',
      last_attempt_at: at,
      reason: 'device_revoked',
      next_attempt_at: null,
    }));
  }

  private writeStatus(make: () => Promise<HttpSyncStatus>): Promise<void> {
    const write = this.statusWrites
      .then(async () => this.ctx.store.setMeta(HTTP_SYNC_META_KEY, JSON.stringify(await make())))
      .catch((e) => {
        try {
          this.emitError(e as Error);
        } catch {
          /* a listener threw: the queue must still settle */
        }
      });
    this.statusWrites = write;
    return write;
  }

  private schedulePoll(delayMs: number): void {
    if (!this.poll || !this.running()) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    // Kept referenced: a host that asked for continuous polling stays up while it polls, until `stop`.
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce();
    }, delayMs);
  }

  /** One scheduled sync; the next is scheduled only once it finishes, so polls never overlap. */
  private async pollOnce(): Promise<void> {
    const run = this.lifecycle;
    const s = await this.sync();
    if (run !== this.lifecycle || !this.poll) return;
    const next = s.next_attempt_at ?? this.ctx.now() + this.poll.intervalMs;
    this.schedulePoll(Math.max(0, next - this.ctx.now()));
  }

  /* ---------------- proxy ---------------- */

  private async maybeRunProxy(questionId: string): Promise<void> {
    const row = await this.ctx.store.getQuestion(questionId);
    if (!row || row.requirement === 'human-required' || !this.o.proxy) return;
    // A create replayed well after its deadline: the relay has expired it, so a proxy answer could only be refused.
    // The allowance keeps a round this clock reads as just past due but the relay's may not.
    if (
      row.expires_at !== null &&
      Date.parse(row.expires_at) + LIMITS.requestSkewMs <= this.ctx.now()
    )
      return;
    await this.runProxy(questionId);
  }

  /** Hard-fails for human-required questions: a proxy can never be asked about those. */
  async runProxy(questionId: string): Promise<'answered' | 'abstained' | 'skipped'> {
    const { ctx } = this;
    const row = await ctx.store.getQuestion(questionId);
    if (!row) throw new BridgeError('not_found', 'unknown question');
    if (row.requirement === 'human-required') {
      await ctx.audit.log({
        event: 'proxy.refused',
        question_id: questionId,
        requirement: row.requirement,
        result: 'human-required',
      });
      throw new BridgeError(
        'proxy_forbidden',
        'the decision model may never act on a human-required question',
      );
    }
    if (!this.o.proxy || row.local_status !== 'open') return 'skipped';
    const markerKey = `proxy:${questionId}`;
    if (await ctx.store.getMeta(markerKey)) return 'skipped';
    await ctx.store.setMeta(markerKey, 'started');

    let content: DecisionContentV1;
    try {
      content = (await openQuestionContent(ctx, row)) ?? ({} as DecisionContentV1);
    } catch {
      // Unreadable content: the model cannot see the question, so the human decides.
      await this.publisher.enqueueProxyAction('proxy-abstain', questionId);
      await ctx.store.setMeta(markerKey, 'abstained');
      await ctx.audit.log({
        event: 'proxy.abstain',
        question_id: questionId,
        requirement: row.requirement,
        result: 'content-unreadable',
      });
      return 'abstained';
    }
    // The gate is the origin's trusted one (registered by the host), never something the agent named.
    const gateId =
      row.origin.workflow_gate_id && ctx.policy.get(row.origin.workflow_gate_id)
        ? row.origin.workflow_gate_id
        : null;
    let outcome: ProxyOutcome;
    if (gateId && this.o.proxy.gateAware !== true) {
      // Fail closed: the engine cannot see the gate, so its gate-based blocks cannot run. Do not call it.
      outcome = { action: 'abstain', reason: 'engine-cannot-see-workflow-gate' };
    } else {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.o.proxyTimeoutMs ?? 25_000);
      try {
        outcome = await this.o.proxy.suggest(
          {
            questionId,
            question: content.question,
            ...(content.context ? { context: content.context } : {}),
            options: content.options ?? [],
            requirement: row.requirement,
            projectId: row.origin.project_id,
            createdAt: row.origin_created_at,
            kind: content.kind ?? 'mixed',
            ...(gateId ? { workflowGateId: gateId } : {}),
            attachments: (content.attachments ?? []).map((a) => ({
              role: a.role,
              sha256: a.sha256,
            })),
          },
          ac.signal,
        );
      } catch (e) {
        outcome = { action: 'abstain', reason: `model-error:${(e as Error).name}` };
      } finally {
        clearTimeout(timer);
      }
    }

    const optionIds = new Set((content.options ?? []).map((o) => o.id));
    const gate = ctx.policy.get(row.origin.workflow_gate_id);
    const textAllowed = content.allow_text !== false && gateAllowsText(gate);
    const valid =
      outcome.action === 'answer' &&
      outcome.risk_flags.length === 0 &&
      outcome.confidence >= 0 &&
      outcome.confidence <= 1 &&
      outcome.selected_option_ids.every(
        (id) =>
          optionIds.has(id) &&
          (!gate?.allowedOptionIds || gate.allowedOptionIds.includes(id)) &&
          (!gate?.choices || gate.choices.some((c) => c.id === id)),
      ) &&
      (!gate?.choices || outcome.selected_option_ids.length <= 1) &&
      (textAllowed || (!outcome.answer_text && outcome.selected_option_ids.length > 0)) &&
      (optionIds.size === 0 || outcome.selected_option_ids.length > 0 || !!outcome.answer_text);
    if (outcome.action === 'answer' && valid) {
      await this.publisher.enqueueProxyAction('proxy-answer', questionId, {
        content_version: 1,
        selected_option_ids: outcome.selected_option_ids,
        ...(outcome.answer_text ? { text: outcome.answer_text } : {}),
        reviewed_attachment_digests: [],
        model_id: outcome.model_id,
        prompt_template_version: outcome.prompt_template_version,
        confidence: outcome.confidence,
        retrieval_reference_ids: outcome.retrieval_reference_ids,
        ...(outcome.rationale ? { rationale: outcome.rationale } : {}),
      });
      await ctx.store.setMeta(markerKey, 'answered');
      await ctx.audit.log({
        event: 'proxy.answer',
        question_id: questionId,
        requirement: row.requirement,
        provenance: 'proxy',
        result: 'queued',
      });
      return 'answered';
    }
    await this.publisher.enqueueProxyAction('proxy-abstain', questionId);
    await ctx.store.setMeta(markerKey, 'abstained');
    await ctx.audit.log({
      event: 'proxy.abstain',
      question_id: questionId,
      requirement: row.requirement,
      // Only the reason's leading code: a model's own explanation can quote the question, so its prose is kept
      // only with debug content logging on.
      result: outcome.action === 'abstain' ? abstainCode(outcome.reason) : 'invalid-suggestion',
      ...(outcome.action === 'abstain' ? { content: outcome.reason } : {}),
    });
    return 'abstained';
  }
}

/** The machine-readable head of an abstention reason (`model-abstained: <prose>` → `model-abstained`). */
export function abstainCode(reason: string): string {
  const head = (reason.split(/[:\s]/, 1)[0] ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
  return head || 'abstained';
}

/**
 * Where a question stands with the relay (`PublicationState`), from its row, its queued create if any, and whether it
 * was settled as never published.
 */
function publicationOf(
  row: QuestionRow,
  create: OutboxItem | undefined,
  unpublished: boolean,
): PublicationState {
  if (row.history_only) return 'unknown';
  switch (row.local_status) {
    case 'queued':
      if (!create) return 'unknown';
      return (create.payload as CreatePayload).maybePublished ? 'possibly-committed' : 'not-sent';
    case 'publish-failed':
      return unpublished ? 'never-published' : 'refused';
    case 'cancelled':
      // Withdrawn before its create was ever sent (`enqueueCancel`): no relay event was ever applied to it. A
      // withdrawal the relay took arrives as an event, which records its seq.
      return row.remote_event_seq === null ? 'never-published' : 'accepted';
    default:
      return 'accepted';
  }
}
