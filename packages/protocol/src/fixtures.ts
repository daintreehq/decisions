import type { HumanAnswerContentV1, PhoneImageReference } from './schema.js';
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
