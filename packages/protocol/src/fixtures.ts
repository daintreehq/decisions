import type { ErrorCode } from './errors.js';
import type {
  DecisionContentV1,
  HumanAnswerContentV1,
  PhoneImageReference,
  Provenance,
  QuestionStatus,
  Requirement,
} from './schema.js';
import type { RoundAuthority, RoundEvent, RoundOutcome, RoundState } from './state.js';
import type { PaneSnapshotContentV1, SnapshotRefresh, SnapshotSharing } from './snapshot.js';
import type {
  AgentMessageContentV1,
  HumanMessageContentV1,
  MessageDeliveryInfo,
  MessageSide,
} from './thread.js';

export {
  Legacy030,
  legacyDesktopCatchUp,
  legacyPhoneCatchUp,
  legacySocketReceive,
} from './legacy-0.3.0.js';
export type { LegacyCatchUp } from './legacy-0.3.0.js';
export {
  LEGACY_DESKTOP_INVOLVEMENT_START,
  LEGACY_PHONE_INVOLVEMENT_START,
  legacyDesktopInvolvementRead,
  legacyDesktopInvolvementSteering,
  legacyPhoneInvolvementRead,
} from './legacy-involvement-0.7.0.js';
export { Legacy080Question } from './legacy-question-0.8.0.js';
export type {
  LegacyDesktopInvolvement,
  LegacyInvolvementContext,
  LegacyInvolvementRecord,
  LegacyInvolvementSigner,
  LegacyPhoneInvolvement,
} from './legacy-involvement-0.7.0.js';

/*
 * Shared test data for thread messages, phone images and pane snapshots (docs/protocol.md sections 16-18), so
 * relay, client and app tests start from the same thread. Content is decrypted plaintext and records are unsigned
 * templates: each test encrypts the content with its own epoch key, fills in `envelope_digest`, and signs with its
 * own device keys. Nothing here is a trusted signature or ciphertext. Times are fixed against `FIXTURE_NOW`.
 */

/** The clock every fixture is relative to, in relay time. Evaluate freshness with `Date.parse(FIXTURE_NOW)`. */
export const FIXTURE_NOW = '2026-11-01T10:00:00.000Z';
const at = (secondsBeforeNow: number) =>
  new Date(Date.parse(FIXTURE_NOW) - secondsBeforeNow * 1000).toISOString();

export const FIXTURE_IDS = {
  installation_id: 'inst_fixture01',
  question_id: 'q_fixture0001',
  /** The desktop that published the question; it alone speaks for the agent and publishes snapshots. */
  desktop_device_id: 'dev_desktop01',
  phone_device_id: 'dev_phone0001',
  /** `QuestionRecord.target_host_id`: an opaque host reference, not a device id. */
  target_host_id: 'host_fixture01',
  answer_action_id: 'act_answer0001',
  answer_image_id: 'att_answerimg1',
  message_image_id: 'att_msgimage01',
} as const;

/** A `MessageRecord` before encryption and signing: add `envelope_digest` and `signature`. */
export interface UnsignedMessageRecord {
  v: 1;
  type: 'thread.message';
  installation_id: string;
  question_id: string;
  message_id: string;
  side: MessageSide;
  expects_reply: boolean;
  attachment_ids: string[];
  created_at: string;
  signer_device_id: string;
}

/** A `PaneSnapshotRecord` before encryption and signing: add `envelope_digest` and `signature`. */
export interface UnsignedSnapshotRecord {
  v: 1;
  type: 'pane.snapshot';
  installation_id: string;
  question_id: string;
  snapshot_id: string;
  question_revision: number;
  observed_at: string;
  sharing: SnapshotSharing;
  signer_device_id: string;
}

/** A png the phone attached to its answer: what the answer content references and the action record lists. */
export const ANSWER_IMAGE_FIXTURE: PhoneImageReference = {
  attachment_id: FIXTURE_IDS.answer_image_id,
  mime: 'image/png',
  size: 48_213,
  sha256: '3f0b8a6c2d9e4f71a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b',
  nonce: 'AAECAwQFBgcICQoL',
  key_epoch: 1,
  alt: 'Screenshot of the failing test',
};

/** A jpeg the phone attached to a follow-up message. */
export const MESSAGE_IMAGE_FIXTURE: PhoneImageReference = {
  attachment_id: FIXTURE_IDS.message_image_id,
  mime: 'image/jpeg',
  size: 1_204_771,
  sha256: '9c1d2e3f4a5b6c7d8e9fa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1',
  nonce: 'DA0ODxAREhMUFRYX',
  key_epoch: 1,
  alt: 'Photo of the whiteboard schema',
};

/** The human answer in force: option `b`, with one phone image (bound to `answer_action_id`). */
export const ANSWER_FIXTURE = {
  action_id: FIXTURE_IDS.answer_action_id,
  /** Signed into the action record, equal to the content's image ids. */
  attachment_ids: [FIXTURE_IDS.answer_image_id],
  revision: 1,
  committed_at: at(600),
  content: {
    content_version: 1,
    selected_option_ids: ['b'],
    text: 'Go with the second option.',
    reviewed_attachment_digests: [],
    images: [ANSWER_IMAGE_FIXTURE],
  } satisfies HumanAnswerContentV1,
};

export interface ThreadMessageFixture<C> {
  message_seq: number;
  /** Ledger seq of its `decision.message.posted` event. */
  event_seq: number;
  committed_at: string;
  record: UnsignedMessageRecord;
  content: C;
  delivery: MessageDeliveryInfo | null;
}

const messageRecord = (
  message_id: string,
  side: 'human' | 'agent',
  signer: string,
  secondsBeforeNow: number,
  extra: { expects_reply?: boolean; attachment_ids?: string[] } = {},
): UnsignedMessageRecord => ({
  v: 1,
  type: 'thread.message',
  installation_id: FIXTURE_IDS.installation_id,
  question_id: FIXTURE_IDS.question_id,
  message_id,
  side,
  expects_reply: extra.expects_reply ?? false,
  attachment_ids: extra.attachment_ids ?? [],
  created_at: at(secondsBeforeNow),
  signer_device_id: signer,
});

const THREAD_MESSAGES: [
  ThreadMessageFixture<AgentMessageContentV1>,
  ThreadMessageFixture<HumanMessageContentV1>,
  ThreadMessageFixture<AgentMessageContentV1>,
] = [
  {
    message_seq: 1,
    event_seq: 4,
    committed_at: at(300),
    record: messageRecord('msg_agent0001', 'agent', FIXTURE_IDS.desktop_device_id, 300, {
      expects_reply: true,
    }),
    content: {
      content_version: 1,
      side: 'agent',
      text: 'Done with option B. Should the migration also keep the old column?',
    },
    delivery: null,
  },
  {
    message_seq: 2,
    event_seq: 6,
    committed_at: at(240),
    record: messageRecord('msg_human0001', 'human', FIXTURE_IDS.phone_device_id, 240, {
      attachment_ids: [FIXTURE_IDS.message_image_id],
    }),
    content: {
      content_version: 1,
      side: 'human',
      text: 'Yes, keep it for one release. The whiteboard has the plan.',
      images: [MESSAGE_IMAGE_FIXTURE],
    },
    delivery: {
      status: 'terminal-delivered',
      received_at: at(238),
      terminal_delivered_at: at(236),
      injection_id: 'inj_msghuman01',
      error_code: null,
    },
  },
  {
    message_seq: 3,
    event_seq: 8,
    committed_at: at(120),
    record: messageRecord('msg_agent0002', 'agent', FIXTURE_IDS.desktop_device_id, 120),
    content: {
      content_version: 1,
      side: 'agent',
      text: 'Kept the old column; it is marked for removal in the next release.',
    },
    delivery: null,
  },
];

/**
 * A human-answered question whose thread runs in both directions after the answer: the agent asks a follow-up
 * and waits, the person replies with a photo, the agent confirms without asking anything. The answer, revision and
 * `deliverable` are those of `ANSWER_FIXTURE` throughout.
 */
export const THREAD_FIXTURE = {
  ...FIXTURE_IDS,
  status: 'human-answered' as const,
  revision: 1,
  /** Ledger seq of the human answer, for `threadAwaitsHuman`. */
  answer_event_seq: 2,
  answer: ANSWER_FIXTURE,
  messages: THREAD_MESSAGES,
};

const snapshotRecord = (snapshot_id: string, secondsBeforeNow: number): UnsignedSnapshotRecord => ({
  v: 1,
  type: 'pane.snapshot',
  installation_id: FIXTURE_IDS.installation_id,
  question_id: FIXTURE_IDS.question_id,
  snapshot_id,
  question_revision: 1,
  observed_at: at(secondsBeforeNow),
  sharing: 'on',
  signer_device_id: FIXTURE_IDS.desktop_device_id,
});

/**
 * A snapshot the relay received 19 seconds before `FIXTURE_NOW` (observed a second earlier, desktop time): `fresh`.
 * `received_at` is what `PaneSnapshotResponse` carries beside the signed snapshot.
 */
export const SNAPSHOT_FIXTURE = {
  record: snapshotRecord('snap_fresh0001', 20),
  received_at: at(19),
  content: {
    content_version: 1,
    observed_at: at(20),
    agent_state: 'waiting',
    waiting_reason: 'question',
    pane_title: 'claude: api-server',
    terminal_lines: [
      '● Updated src/db/migrate.ts',
      '  ⎿  Kept users.legacy_email; marked for removal',
      '',
      '> Waiting for your reply on your phone',
    ],
  } satisfies PaneSnapshotContentV1,
  refresh: null as SnapshotRefresh | null,
};

/**
 * Stale snapshots. `aged`: received five minutes before `FIXTURE_NOW`, past `LIMITS.snapshotFreshMs`.
 * `refreshTimedOut`: received 29 seconds before (fresh on its own), but a refresh asked 20 seconds before passed its
 * 15 second deadline with no new snapshot.
 */
export const STALE_SNAPSHOT_FIXTURE = {
  aged: {
    record: snapshotRecord('snap_aged00001', 300),
    received_at: at(299),
    content: {
      ...SNAPSHOT_FIXTURE.content,
      observed_at: at(300),
      agent_state: 'working',
      waiting_reason: null,
    } satisfies PaneSnapshotContentV1,
    refresh: null as SnapshotRefresh | null,
  },
  refreshTimedOut: {
    record: snapshotRecord('snap_timeout01', 30),
    received_at: at(29),
    content: { ...SNAPSHOT_FIXTURE.content, observed_at: at(30) } satisfies PaneSnapshotContentV1,
    refresh: {
      refresh_id: 'rfr_timeout001',
      requested_by_device_id: FIXTURE_IDS.phone_device_id,
      requested_at: at(20),
      deadline_at: at(5),
    } satisfies SnapshotRefresh,
  },
};

/** The record a desktop sends when it does not share pane snapshots. */
export const SHARING_OFF_FIXTURE: UnsignedSnapshotRecord = {
  ...snapshotRecord('snap_off000001', 10),
  sharing: 'off',
};

/* ---------- advisory questions (docs/protocol.md section 21) ---------- */

/** A `QuestionRecord` before encryption and signing: add `envelope_digest` and `signature`. */
export interface UnsignedQuestionRecord {
  v: 1;
  type: 'question';
  installation_id: string;
  question_id: string;
  originating_device_id: string;
  target_host_id: string;
  origin_ref: string;
  requirement: Requirement;
  workflow_gate_id_hash: string | null;
  policy_version: number | null;
  created_at: string;
  expires_at: string | null;
  key_epoch: number;
  attachment_ids: string[];
  signer_device_id: string;
}

/**
 * The visible fields of a question's content envelope: encrypt `content` with them (`encryptEnvelope` with
 * `replyMode: 'advisory'` when `aad.reply_mode` is set), then put the envelope's digest in the record and sign it.
 */
export interface QuestionEnvelopeBinding {
  record_id: string;
  purpose: 'question-content';
  aad: {
    installation_id: string;
    question_id: string;
    record_type: 'question';
    revision: 0;
    sender_device_id: string;
    reply_mode?: 'advisory';
  };
}

const ADVISORY_QUESTION_ID = 'q_advisory001';
const APPROVAL_QUESTION_ID = 'q_approval001';
/** The advisory question was asked at `FIXTURE_NOW` and waits fifteen minutes for advice. */
const ADVISORY_DEADLINE = at(-15 * 60);

const questionRecord = (
  question_id: string,
  extra: Pick<UnsignedQuestionRecord, 'requirement' | 'workflow_gate_id_hash' | 'policy_version' | 'expires_at'>,
): UnsignedQuestionRecord => ({
  v: 1,
  type: 'question',
  installation_id: FIXTURE_IDS.installation_id,
  question_id,
  originating_device_id: FIXTURE_IDS.desktop_device_id,
  target_host_id: FIXTURE_IDS.target_host_id,
  origin_ref: 'pane_fixture01',
  ...extra,
  created_at: FIXTURE_NOW,
  key_epoch: 1,
  attachment_ids: [],
  signer_device_id: FIXTURE_IDS.desktop_device_id,
});

const questionBinding = (question_id: string, advisory: boolean): QuestionEnvelopeBinding => ({
  record_id: question_id,
  purpose: 'question-content',
  aad: {
    installation_id: FIXTURE_IDS.installation_id,
    question_id,
    record_type: 'question',
    revision: 0,
    sender_device_id: FIXTURE_IDS.desktop_device_id,
    ...(advisory ? { reply_mode: 'advisory' as const } : {}),
  },
});

/**
 * An advisory question: the agent asks which fixture to use and, if no answer commits within fifteen minutes,
 * plans to choose one itself. Ungated and `human-required` (no proxy answers it), with a finite signed deadline;
 * the plan is encrypted content, bound to the question and its first round by the AAD and the signed digest.
 */
export const ADVISORY_QUESTION_FIXTURE = {
  record: questionRecord(ADVISORY_QUESTION_ID, {
    requirement: 'human-required',
    workflow_gate_id_hash: null,
    policy_version: null,
    expires_at: ADVISORY_DEADLINE,
  }),
  envelope: questionBinding(ADVISORY_QUESTION_ID, true),
  content: {
    content_version: 1,
    question: 'Which fixture should the migration tests use?',
    kind: 'choice',
    options: [
      { id: 'sqlite', label: 'A SQLite file per test' },
      { id: 'memory', label: 'One in-memory database' },
    ],
    attachments: [],
    allow_text: true,
    planned_fallback:
      'Use the in-memory database, and say in the pull request that it can be switched to SQLite files.',
  } satisfies DecisionContentV1,
};

/**
 * A design sign-off that must wait for a decision: an approval under a workflow gate, with a deadline. It is never
 * advisory (`advisoryRefusal` says `gated`), and its expiry authorises nothing.
 */
export const BLOCKING_APPROVAL_FIXTURE = {
  record: questionRecord(APPROVAL_QUESTION_ID, {
    requirement: 'human-required',
    workflow_gate_id_hash: '5d1be7e9dda1ee8896be5b7e34a85ee16452a7b4f6fc2b9b4b3b0f6b6a3f1c22',
    policy_version: 1,
    expires_at: at(-24 * 60 * 60),
  }),
  envelope: questionBinding(APPROVAL_QUESTION_ID, false),
  content: {
    content_version: 1,
    question: 'Approve the final design of the settings screen?',
    kind: 'approval',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    attachments: [],
    allow_text: false,
  } satisfies DecisionContentV1,
};

/** One step of a round case, and what every implementation must observe. */
export interface RoundCaseStep {
  event: RoundEvent;
  /** What commits, or null when the event is refused and nothing commits. */
  outcome: RoundOutcome | null;
  /**
   * The error the submitter observes: a refusal that commits nothing, or the `expired` of a submission that met a due
   * deadline (the deadline commits). Null when the event commits.
   */
  error: ErrorCode | null;
  /** The round after the step; null once the question is deleted. */
  after: Pick<RoundState, 'status' | 'revision'> | null;
  authority?: RoundAuthority;
  provenance?: Provenance | null;
  fallbackDue?: boolean;
  trainable?: boolean;
}

export interface RoundCase {
  name: string;
  start: RoundState;
  steps: RoundCaseStep[];
}

/** The advisory round of `ADVISORY_QUESTION_FIXTURE`, in ms of relay time. */
const T0 = Date.parse(FIXTURE_NOW);
const D = Date.parse(ADVISORY_DEADLINE);
const MIN = 60_000;
const ADVISORY_ROUND: RoundState = {
  status: 'open',
  revision: 0,
  requirement: 'human-required',
  proxyAbstained: false,
  expiresAt: D,
  advisory: true,
};
const open = (revision = 0) => ({ status: 'open' as QuestionStatus, revision });
const phoneAnswer = (at: number, expectedRevision = 0): RoundEvent => ({
  type: 'action',
  action: 'answer',
  role: 'phone',
  expectedRevision,
  at,
});
const deadline = (at: number): RoundEvent => ({ type: 'deadline', at });
const unanswered: RoundCaseStep = {
  event: deadline(D),
  outcome: 'advisory-unanswered',
  error: null,
  after: { status: 'expired', revision: 0 },
  authority: 'relay',
  provenance: null,
  fallbackDue: true,
  trainable: false,
};
const settled = (at: number, after: Pick<RoundState, 'status' | 'revision'>): RoundCaseStep => ({
  event: deadline(at),
  outcome: 'unchanged',
  error: null,
  after,
  fallbackDue: false,
});

/**
 * The executable transition table of section 21: each case starts from a round and applies its events in order with
 * `applyRoundEvent`, and every implementation (the relay, the publishing desktop, the phone app, Daintree) must
 * observe exactly the same. Times are relay commit times around the advisory deadline `D`, fifteen minutes after
 * `FIXTURE_NOW`.
 */
export const ROUND_CASES: RoundCase[] = [
  {
    name: 'a timely answer wins and the deadline then changes nothing',
    start: ADVISORY_ROUND,
    steps: [
      {
        // Committed a millisecond before D: timely, however late the asking desktop receives it.
        event: phoneAnswer(D - 1),
        outcome: 'answered',
        error: null,
        after: { status: 'human-answered', revision: 1 },
        authority: 'person',
        provenance: 'human',
        fallbackDue: false,
        trainable: true,
      },
      settled(D, { status: 'human-answered', revision: 1 }),
    ],
  },
  {
    name: "the person's answer on the computer is as timely as one from a phone",
    start: ADVISORY_ROUND,
    steps: [
      {
        event: { type: 'action', action: 'answer', role: 'owner-desktop', expectedRevision: 0, at: T0 + MIN },
        outcome: 'answered',
        error: null,
        after: { status: 'human-answered', revision: 1 },
        authority: 'person',
        provenance: 'human-desktop',
        trainable: true,
      },
    ],
  },
  {
    name: 'an unanswered advisory deadline makes the plan due, and nothing else',
    start: ADVISORY_ROUND,
    steps: [settled(D - 1, open()), unanswered, settled(D + MIN, { status: 'expired', revision: 0 })],
  },
  {
    name: 'a blocking deadline stays unsatisfied',
    start: { ...ADVISORY_ROUND, advisory: false },
    steps: [
      {
        event: deadline(D),
        outcome: 'expired-unsatisfied',
        error: null,
        after: { status: 'expired', revision: 0 },
        authority: 'relay',
        provenance: null,
        fallbackDue: false,
        trainable: false,
      },
    ],
  },
  {
    name: "a phone's verified decline closes the round and suppresses the plan",
    start: ADVISORY_ROUND,
    steps: [
      {
        event: { type: 'action', action: 'cancel', role: 'phone', expectedRevision: 0, at: D - MIN },
        outcome: 'declined',
        error: null,
        after: { status: 'cancelled', revision: 0 },
        authority: 'person',
        provenance: null,
        fallbackDue: false,
        trainable: false,
      },
      {
        // A retry from any device is a no-op: a decline is never relabelled a withdrawal.
        event: { type: 'action', action: 'cancel', role: 'owner-desktop', expectedRevision: 0, at: D - 1 },
        outcome: 'unchanged',
        error: null,
        after: { status: 'cancelled', revision: 0 },
      },
      settled(D, { status: 'cancelled', revision: 0 }),
    ],
  },
  {
    name: "the owner desktop's signed decline is the person's",
    start: ADVISORY_ROUND,
    steps: [
      {
        event: {
          type: 'action',
          action: 'cancel',
          role: 'owner-desktop',
          expectedRevision: 0,
          decline: true,
          at: D - MIN,
        },
        outcome: 'declined',
        error: null,
        after: { status: 'cancelled', revision: 0 },
        authority: 'person',
      },
    ],
  },
  {
    name: 'a desktop-host never declines for the person',
    start: ADVISORY_ROUND,
    steps: [
      {
        event: {
          type: 'action',
          action: 'cancel',
          role: 'desktop-host',
          expectedRevision: 0,
          decline: true,
          at: D - MIN,
        },
        outcome: null,
        error: 'forbidden',
        after: open(),
      },
    ],
  },
  {
    name: "the desktop's withdrawal closes the round and suppresses the plan",
    start: ADVISORY_ROUND,
    steps: [
      {
        event: { type: 'action', action: 'cancel', role: 'desktop-host', expectedRevision: 0, at: D - MIN },
        outcome: 'withdrawn',
        error: null,
        after: { status: 'cancelled', revision: 0 },
        authority: 'desktop',
        provenance: null,
        fallbackDue: false,
      },
      settled(D, { status: 'cancelled', revision: 0 }),
    ],
  },
  {
    name: 'a reopen after the advisory deadline opens a blocking round',
    start: ADVISORY_ROUND,
    steps: [
      unanswered,
      {
        event: {
          type: 'action',
          action: 'reopen',
          role: 'owner-desktop',
          expectedRevision: 0,
          expiresAt: D + 60 * MIN,
          at: D + MIN,
        },
        outcome: 'reopened',
        error: null,
        after: open(1),
        authority: 'desktop',
      },
      {
        // An answer signed in the first round names its revision and conflicts with the new one.
        event: phoneAnswer(D + 2 * MIN, 0),
        outcome: null,
        error: 'revision_conflict',
        after: open(1),
      },
      {
        event: deadline(D + 60 * MIN),
        outcome: 'expired-unsatisfied',
        error: null,
        after: { status: 'expired', revision: 1 },
        fallbackDue: false,
      },
    ],
  },
  {
    name: 'a reopen without a deadline waits for a decision',
    start: { ...ADVISORY_ROUND, status: 'cancelled' },
    steps: [
      {
        event: { type: 'action', action: 'reopen', role: 'owner-desktop', expectedRevision: 0, at: D + MIN },
        outcome: 'reopened',
        error: null,
        after: open(1),
      },
      settled(D + 365 * 24 * 60 * MIN, open(1)),
    ],
  },
  {
    name: 'deleting the question ends every round, and a late answer finds nothing',
    start: ADVISORY_ROUND,
    steps: [
      {
        event: { type: 'delete', role: 'phone' },
        outcome: null,
        error: 'forbidden',
        after: open(),
      },
      {
        event: { type: 'delete', role: 'owner-desktop' },
        outcome: 'deleted',
        error: null,
        after: null,
        authority: 'desktop',
        fallbackDue: false,
      },
      { event: phoneAnswer(D - 1), outcome: null, error: 'not_found', after: null },
    ],
  },
  {
    name: 'a competing proxy answer wins over the deadline, and is never ground truth',
    start: { ...ADVISORY_ROUND, requirement: 'proxy-ok' },
    steps: [
      {
        event: { type: 'action', action: 'proxy-answer', role: 'desktop-host', expectedRevision: 0, at: D - 1 },
        outcome: 'proxy-answered',
        error: null,
        after: { status: 'proxy-answered', revision: 1 },
        authority: 'proxy',
        provenance: 'proxy',
        fallbackDue: false,
        trainable: false,
      },
      settled(D, { status: 'proxy-answered', revision: 1 }),
      {
        // The person's answer after it conflicts; they override the proxy instead, even after the deadline.
        event: phoneAnswer(D + MIN, 1),
        outcome: null,
        error: 'revision_conflict',
        after: { status: 'proxy-answered', revision: 1 },
      },
      {
        event: { type: 'action', action: 'override', role: 'phone', expectedRevision: 1, at: D + MIN },
        outcome: 'overridden',
        error: null,
        after: { status: 'human-answered', revision: 2 },
        authority: 'person',
        provenance: 'human',
        trainable: true,
      },
    ],
  },
  {
    name: "a proxy's abstention leaves the deadline armed",
    start: { ...ADVISORY_ROUND, requirement: 'proxy-first' },
    steps: [
      {
        event: { type: 'action', action: 'proxy-abstain', role: 'desktop-host', expectedRevision: 0, at: T0 + MIN },
        outcome: 'proxy-abstained',
        error: null,
        after: open(),
        authority: 'proxy',
        provenance: null,
      },
      unanswered,
    ],
  },
  {
    name: 'a follow-up from either side never answers, and the deadline still makes the plan due',
    start: ADVISORY_ROUND,
    steps: [
      {
        event: {
          type: 'message',
          side: 'human',
          role: 'phone',
          signerIsPublisher: false,
          messageCount: 0,
          at: D - 2 * MIN,
        },
        outcome: 'message',
        error: null,
        after: open(),
        authority: 'person',
        provenance: null,
        trainable: false,
      },
      {
        event: {
          type: 'message',
          side: 'agent',
          role: 'desktop-host',
          signerIsPublisher: true,
          messageCount: 1,
          at: D - MIN,
        },
        outcome: 'message',
        error: null,
        after: open(),
        authority: 'desktop',
      },
      unanswered,
    ],
  },
  {
    name: 'a late phone answer meets the deadline: the round expires and the answer is refused',
    start: ADVISORY_ROUND,
    steps: [
      {
        // At D exactly the round is due: the relay commits the expiry and refuses the answer in one transaction.
        event: phoneAnswer(D),
        outcome: 'advisory-unanswered',
        error: 'expired',
        after: { status: 'expired', revision: 0 },
        authority: 'relay',
        provenance: null,
        fallbackDue: true,
        trainable: false,
      },
      { event: phoneAnswer(D + MIN), outcome: null, error: 'expired', after: { status: 'expired', revision: 0 } },
      {
        // A dismissal sent once the round expired finds it closed.
        event: { type: 'action', action: 'cancel', role: 'phone', expectedRevision: 0, at: D + MIN },
        outcome: null,
        error: 'invalid_state',
        after: { status: 'expired', revision: 0 },
      },
      {
        event: {
          type: 'message',
          side: 'human',
          role: 'phone',
          signerIsPublisher: false,
          messageCount: 0,
          at: D + MIN,
        },
        outcome: null,
        error: 'expired',
        after: { status: 'expired', revision: 0 },
      },
    ],
  },
  {
    name: 'a second answer conflicts with the first',
    start: ADVISORY_ROUND,
    steps: [
      { event: phoneAnswer(D - 2 * MIN), outcome: 'answered', error: null, after: { status: 'human-answered', revision: 1 } },
      {
        event: { type: 'action', action: 'answer', role: 'tablet', expectedRevision: 0, at: D - MIN },
        outcome: null,
        error: 'revision_conflict',
        after: { status: 'human-answered', revision: 1 },
      },
    ],
  },
];
