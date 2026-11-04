import type {
  CryptoEnvelope,
  PaneSnapshotRecord,
  SnapshotRefresh,
} from '@daintreehq/decisions-protocol';
import { nowMs } from '../util.js';
import type { Room } from './types.js';

/*
 * Pane snapshot state (docs/protocol.md section 18). One row per question, replaced in place: the relay holds the
 * latest signed record and its ciphertext and nothing older, and never sees what is inside.
 */

export interface SnapshotRow {
  question_id: string;
  /** Epoch ms of the newest `observed_at` accepted; outlives the snapshot so an older one never returns. */
  last_observed_at: number | null;
  /** 1 once the desktop said sharing is off, until it publishes a shared snapshot again. */
  sharing_off: number;
  snapshot_id: string | null;
  record_json: string | null;
  envelope_json: string | null;
  received_at: number | null;
  retain_until: number | null;
  refresh_json: string | null;
}

export type SnapshotHint = 'decision.snapshot.updated' | 'decision.snapshot.refresh_requested';

export function snapshotRow(room: Room, questionId: string): SnapshotRow | undefined {
  return room.q1<SnapshotRow>(`SELECT * FROM question_snapshots WHERE question_id = ?`, questionId);
}

export function storedSnapshot(
  row: SnapshotRow | undefined,
): { record: PaneSnapshotRecord; envelope: CryptoEnvelope | null } | null {
  if (!row?.record_json) return null;
  return {
    record: JSON.parse(row.record_json) as PaneSnapshotRecord,
    envelope: row.envelope_json ? (JSON.parse(row.envelope_json) as CryptoEnvelope) : null,
  };
}

export function storedRefresh(row: SnapshotRow | undefined): SnapshotRefresh | null {
  return row?.refresh_json ? (JSON.parse(row.refresh_json) as SnapshotRefresh) : null;
}

/**
 * Appends a content-free hint and removes the question's earlier hint of the same type. Hints only say "fetch the
 * current state", so a superseded one tells nobody anything, and keeping them would leave a history of snapshot
 * ids and times in the ledger (section 7: sequence numbers can have holes). Must run inside `room.tx`.
 */
export function emitSnapshotHint(
  room: Room,
  type: SnapshotHint,
  questionId: string,
  deviceId: string | null,
  data: Record<string, unknown>,
): number {
  room.run(`DELETE FROM events WHERE question_id = ? AND event_type = ?`, questionId, type);
  return room.emit(type, { questionId, revision: null, deviceId, data }).seq;
}

/**
 * The question closed or reopened: drop its snapshot, refresh request and hints. The order watermark and a
 * sharing-off choice stay. Must run inside `room.tx`.
 */
export function clearSnapshot(room: Room, questionId: string): void {
  const cleared = room.run(
    `UPDATE question_snapshots SET snapshot_id = NULL, record_json = NULL, envelope_json = NULL,
       received_at = NULL, retain_until = NULL, refresh_json = NULL
     WHERE question_id = ? AND (record_json IS NOT NULL OR refresh_json IS NOT NULL)`,
    questionId,
  );
  room.run(
    `DELETE FROM events WHERE question_id = ? AND event_type IN ('decision.snapshot.updated', 'decision.snapshot.refresh_requested')`,
    questionId,
  );
  if (cleared) room.markAlarmDirty();
}

/** The question is being deleted: remove every trace of its snapshots. Must run inside `room.tx`. */
export function deleteSnapshotState(room: Room, questionId: string): void {
  if (room.run(`DELETE FROM question_snapshots WHERE question_id = ?`, questionId)) {
    room.markAlarmDirty();
  }
}

/** The earliest moment a stored snapshot's ciphertext must be removed, or null. */
export function nextSnapshotRetention(room: Room): number | null {
  return (
    room.q1<{ m: number | null }>(
      `SELECT MIN(retain_until) AS m FROM question_snapshots WHERE retain_until IS NOT NULL`,
    )?.m ?? null
  );
}

/**
 * Removes the question's snapshot if the relay received it more than `LIMITS.snapshotRetentionMs` ago, with any
 * refresh waiting on it, and tells readers with a hint so they drop what they show. Must run inside `room.tx`.
 */
export function retireSnapshotIfDue(room: Room, questionId: string, t = nowMs()): void {
  const row = snapshotRow(room, questionId);
  if (!row || row.retain_until === null || row.retain_until > t) return;
  const gone = storedSnapshot(row);
  room.run(
    `UPDATE question_snapshots SET snapshot_id = NULL, record_json = NULL, envelope_json = NULL,
       received_at = NULL, retain_until = NULL, refresh_json = NULL WHERE question_id = ?`,
    questionId,
  );
  room.run(
    `DELETE FROM events WHERE question_id = ? AND event_type = 'decision.snapshot.refresh_requested'`,
    questionId,
  );
  room.markAlarmDirty();
  const q = room.q1<{ target_host_id: string }>(
    `SELECT target_host_id FROM questions WHERE question_id = ?`,
    questionId,
  );
  if (!q || !gone) return;
  emitSnapshotHint(room, 'decision.snapshot.updated', questionId, null, {
    snapshot_id: gone.record.snapshot_id,
    observed_at: gone.record.observed_at,
    sharing: gone.record.sharing,
    target_host_id: q.target_host_id,
  });
}

/**
 * Retires every overdue snapshot in bounded batches. Runs from the alarm and before snapshot reads; a read also
 * retires its own question in its final transaction, so a late alarm or a long backlog never exposes overdue
 * ciphertext.
 */
export async function sweepSnapshotRetention(room: Room): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const due = room.q<{ question_id: string }>(
      `SELECT question_id FROM question_snapshots WHERE retain_until IS NOT NULL AND retain_until <= ? LIMIT 50`,
      nowMs(),
    );
    if (due.length === 0) return;
    await room.tx(() => {
      const t = nowMs();
      for (const { question_id } of due) retireSnapshotIfDue(room, question_id, t);
    });
  }
}
