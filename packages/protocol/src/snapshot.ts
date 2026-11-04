import { z } from 'zod';
import { utf8ByteLength } from './encoding.js';
import { LIMITS } from './limits.js';
import { CryptoEnvelope, Id, IsoTime, Sha256Hex, SigB64, type QuestionStatus } from './schema.js';
import { isThreadClosedStatus } from './thread.js';
import { PROTOCOL_VERSION } from './version.js';

/*
 * Pane snapshots (docs/protocol.md section 18): what the asking pane looked like, published by the desktop that
 * published the question. Encrypted, one per question (a new one replaces the last), cleared when the question
 * closes, and never part of a push payload. Ledger events about snapshots are content-free hints.
 */

/** `aad.record_type` and the signed record's `type`. */
export const SNAPSHOT_RECORD_TYPE = 'pane.snapshot' as const;

/** Daintree's observed agent states, plus `unknown` for one this version does not know. */
export const SnapshotAgentState = z.enum([
  'idle',
  'working',
  'waiting',
  'directing',
  'completed',
  'exited',
  'unknown',
]);
export type SnapshotAgentState = z.infer<typeof SnapshotAgentState>;

/** Why a `waiting` agent waits. */
export const SnapshotWaitingReason = z.enum(['prompt', 'question', 'approval', 'error']);
export type SnapshotWaitingReason = z.infer<typeof SnapshotWaitingReason>;

/**
 * The wire form of an agent state or waiting reason: an open vocabulary, so a newer desktop's value still parses.
 * Read it with `snapshotAgentState` / `snapshotWaitingReason`, which map values this version does not know.
 */
export const SnapshotToken = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'invalid state token');

export const snapshotAgentState = (token: string): SnapshotAgentState => {
  const s = SnapshotAgentState.safeParse(token);
  return s.success ? s.data : 'unknown';
};
export const snapshotWaitingReason = (token: string | null): SnapshotWaitingReason | null => {
  const r = SnapshotWaitingReason.safeParse(token);
  return r.success ? r.data : null;
};

/** C0 controls except tab, DEL and C1 controls: whatever could steer a terminal or a renderer. */
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;
const PlainLine = (max?: number) => {
  const s = max === undefined ? z.string() : z.string().max(max);
  return s.refine((v) => !CONTROL.test(v), 'plain text only: no control characters or line breaks');
};

const terminalBytes = (lines: readonly string[]): number => utf8ByteLength(lines.join('\n'));

export const PaneSnapshotContentV1 = z.object({
  content_version: z.literal(1).default(1),
  /** When the desktop read the pane. Equals the signed record's `observed_at`. */
  observed_at: IsoTime,
  /** A `SnapshotAgentState`, or a newer one (`snapshotAgentState` reads it as `unknown`). */
  agent_state: SnapshotToken,
  /** A `SnapshotWaitingReason`, a newer one (`snapshotWaitingReason` reads it as `null`), or null. */
  waiting_reason: SnapshotToken.nullable(),
  pane_title: PlainLine(LIMITS.snapshotPaneTitleChars),
  /** The newest lines of the terminal, oldest first, as plain text (no escape sequences). */
  terminal_lines: z
    .array(PlainLine())
    .max(LIMITS.snapshotTerminalLines)
    .refine((l) => terminalBytes(l) <= LIMITS.snapshotTerminalBytes, 'terminal text too large'),
});
export type PaneSnapshotContentV1 = z.infer<typeof PaneSnapshotContentV1>;

export const SnapshotSharing = z.enum(['on', 'off']);
export type SnapshotSharing = z.infer<typeof SnapshotSharing>;

export const PaneSnapshotRecord = z
  .looseObject({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal(SNAPSHOT_RECORD_TYPE),
    installation_id: Id,
    question_id: Id,
    snapshot_id: Id,
    /** The question revision the desktop saw. The relay refuses a snapshot for any other revision. */
    question_revision: z.number().int().min(0),
    /** Must increase per question; the relay refuses one no later than the last it accepted. */
    observed_at: IsoTime,
    /** `off`: this desktop does not share pane snapshots. Carries no envelope and clears the last snapshot. */
    sharing: SnapshotSharing,
    envelope_digest: Sha256Hex.nullable(),
    signer_device_id: Id,
    signature: SigB64,
  })
  .superRefine((r, ctx) => {
    if ((r.sharing === 'on') !== (r.envelope_digest !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['envelope_digest'],
        message: 'a shared snapshot has an envelope; sharing off has none',
      });
    }
  });
export type PaneSnapshotRecord = z.infer<typeof PaneSnapshotRecord>;

/** The visible fields a snapshot envelope must carry; `record_id` is the snapshot id and `aad.revision` is 0. */
export function snapshotEnvelopeIssues(r: PaneSnapshotRecord, env: CryptoEnvelope): string[] {
  const issues: string[] = [];
  if (env.purpose !== 'snapshot-content') issues.push('purpose must be snapshot-content');
  if (env.record_id !== r.snapshot_id) issues.push('record_id must be the snapshot id');
  if (env.aad.record_type !== SNAPSHOT_RECORD_TYPE) issues.push('aad.record_type mismatch');
  if (env.aad.revision !== 0) issues.push('aad.revision must be 0');
  if (env.aad.installation_id !== r.installation_id) issues.push('installation mismatch');
  if (env.aad.question_id !== r.question_id) issues.push('question mismatch');
  if (env.aad.sender_device_id !== r.signer_device_id) issues.push('sender mismatch');
  return issues;
}

export const SignedPaneSnapshot = z
  .object({ record: PaneSnapshotRecord, envelope: CryptoEnvelope.nullable() })
  .superRefine((s, ctx) => {
    if ((s.envelope === null) !== (s.record.envelope_digest === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['envelope'],
        message: 'envelope and envelope_digest must both be present or both absent',
      });
      return;
    }
    if (s.envelope) {
      for (const message of snapshotEnvelopeIssues(s.record, s.envelope)) {
        ctx.addIssue({ code: 'custom', path: ['envelope'], message });
      }
    }
  });
export type SignedPaneSnapshot = z.infer<typeof SignedPaneSnapshot>;

/** `PUT /questions/{id}/snapshot`. */
export const PaneSnapshotBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  idempotency_key: Id,
  snapshot: SignedPaneSnapshot,
});
export type PaneSnapshotBody = z.infer<typeof PaneSnapshotBody>;

/** An outstanding request for a fresh snapshot. Relay time; the first snapshot accepted after it fulfils it. */
export const SnapshotRefresh = z.object({
  refresh_id: Id,
  requested_by_device_id: Id,
  requested_at: IsoTime,
  /** `requested_at + LIMITS.snapshotRefreshTimeoutMs`. */
  deadline_at: IsoTime,
});
export type SnapshotRefresh = z.infer<typeof SnapshotRefresh>;

/** `POST /questions/{id}/snapshot/refresh`. While one is outstanding, another returns the same refresh. */
export const SnapshotRefreshBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  idempotency_key: Id,
});

/** `GET /questions/{id}/snapshot`. */
export const PaneSnapshotResponse = z.object({
  question_id: Id,
  snapshot: SignedPaneSnapshot.nullable(),
  /** Relay time when the relay accepted `snapshot`; freshness is measured from it. Null with no snapshot. */
  received_at: IsoTime.nullable(),
  refresh: SnapshotRefresh.nullable(),
});
export type PaneSnapshotResponse = z.infer<typeof PaneSnapshotResponse>;

/* ---------- rules ---------- */

export type SnapshotFreshness = 'none' | 'off' | 'pending' | 'fresh' | 'stale';

/**
 * How a phone labels a question's snapshot. Every time is relay time, so the desktop's, relay's and phone's clocks
 * never meet: `now` is the phone's clock corrected by the offset it measures from the relay (`hello.server_time`),
 * `received_at` is when the relay accepted the snapshot, and `deadline_at` is the relay's refresh deadline.
 * - `none`: the question is closed, or there is no snapshot and no request;
 * - `off`: the desktop said sharing is off;
 * - `pending`: a refresh is outstanding and its deadline has not passed;
 * - `stale`: a refresh passed its deadline with no new snapshot (however recent the last one), or the relay
 *   received the snapshot more than `LIMITS.snapshotFreshMs` ago;
 * - `fresh`: otherwise.
 * `observed_at`, in desktop time, is shown to the person but never compared with another clock.
 */
export function snapshotFreshness(i: {
  /** Relay time, epoch ms. */
  now: number;
  status: QuestionStatus;
  snapshot: { received_at: string; sharing: SnapshotSharing } | null;
  refresh: { deadline_at: string } | null;
}): SnapshotFreshness {
  if (isThreadClosedStatus(i.status)) return 'none';
  if (i.snapshot?.sharing === 'off') return 'off';
  if (i.refresh) return i.now < Date.parse(i.refresh.deadline_at) ? 'pending' : 'stale';
  if (!i.snapshot) return 'none';
  return i.now - Date.parse(i.snapshot.received_at) <= LIMITS.snapshotFreshMs ? 'fresh' : 'stale';
}

/**
 * Terminal escape sequences, 7-bit (ESC) and 8-bit (C1) forms: control strings (DCS, SOS, PM, APC, OSC) with their
 * payloads, across line breaks; CSI sequences; and the remaining escapes (charset selection, keypad modes, ...).
 */
const ESCAPES =
  /(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c)|(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]/g;
const CONTROL_ALL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

/**
 * Turns terminal text into snapshot lines within the limits: removes escape sequences (before splitting, so a
 * control string spanning lines goes whole), then the remaining control characters, keeps the newest
 * `LIMITS.snapshotTerminalLines` lines, and drops the oldest until the joined text fits
 * `LIMITS.snapshotTerminalBytes`, keeping the end of a single line that is too long on its own. Pass the rendered
 * screen text: a carriage return is read as a line break, not as an overwrite.
 */
export function boundTerminalLines(text: string): string[] {
  const lines = text
    .replace(ESCAPES, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(CONTROL_ALL, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const kept = lines.slice(-LIMITS.snapshotTerminalLines);
  let bytes = terminalBytes(kept);
  while (kept.length > 1 && bytes > LIMITS.snapshotTerminalBytes) {
    bytes -= utf8ByteLength(kept.shift()!) + 1;
  }
  if (kept.length === 1 && bytes > LIMITS.snapshotTerminalBytes) {
    const chars = Array.from(kept[0]!);
    let size = bytes;
    let start = 0;
    while (size > LIMITS.snapshotTerminalBytes) size -= utf8ByteLength(chars[start++]!);
    kept[0] = chars.slice(start).join('');
  }
  return kept;
}
