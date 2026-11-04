import { DeleteDataBody, PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import { z } from 'zod';
import { WORKER_VERSION } from '../env.js';
import type { Handler, Room } from '../room/types.js';
import { iso, isoOrNull, json } from '../util.js';
import type { DecisionRoom } from '../decision-room.js';

export const diagnostics: Handler = async (room) => {
  const count = (t: string) => room.q1<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n;
  const jobs = room.q<{ status: string; n: number; m: number | null }>(
    `SELECT status, COUNT(*) AS n, MIN(run_at) AS m FROM scheduled_jobs GROUP BY status`,
  );
  const pending = jobs.find((j) => j.status === 'pending');
  const att = room.q1<{ reserved: number; available: number; bytes: number | null }>(
    `SELECT SUM(state IN ('reserved','uploaded')) AS reserved, SUM(state = 'available') AS available,
       SUM(CASE WHEN state != 'deleted' THEN ciphertext_bytes ELSE 0 END) AS bytes FROM attachments`,
  )!;
  const push = room.q1<{ subs: number; failing: number | null }>(
    `SELECT COUNT(*) AS subs, SUM(last_error_code IS NOT NULL) AS failing FROM push_subscriptions`,
  )!;
  const alarm = await room.alarmAt();
  return json(200, {
    protocol_version: PROTOCOL_VERSION,
    worker_version: WORKER_VERSION,
    key_epoch: room.currentEpoch(),
    counts: {
      devices: count('devices'),
      questions: count('questions'),
      actions: count('actions'),
      events: count('events'),
      deliveries: count('deliveries'),
      messages: count('messages'),
    },
    jobs: {
      pending: pending?.n ?? 0,
      failed: jobs.find((j) => j.status === 'failed')?.n ?? 0,
      next_run_at: isoOrNull(pending?.m),
      alarm_at: alarm ? iso(alarm) : null,
    },
    attachments: {
      reserved: att.reserved ?? 0,
      available: att.available ?? 0,
      bytes: att.bytes ?? 0,
    },
    sockets: room.socketCount(),
    event_high_water: (room as unknown as DecisionRoom).eventHighWater(),
    push: { subscriptions: push.subs, failing: push.failing ?? 0 },
  });
};

async function emptyBucket(room: Room): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await room.env.ATTACHMENTS.list({
      prefix: 'a/',
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    if (page.objects.length) await room.env.ATTACHMENTS.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export const deleteData: Handler = async (room, c) => {
  const b = c.body(DeleteDataBody);
  await emptyBucket(room);
  await room.tx(() => {
    for (const t of [
      'actions',
      'deliveries',
      'messages',
      'message_deliveries',
      'question_snapshots',
      'questions',
      'attachments',
      'events',
      'command_receipts',
    ])
      room.run(`DELETE FROM ${t}`);
    // Maintenance (purge) survives a questions wipe; a full reset removes every job.
    room.run(
      b.scope === 'everything'
        ? `DELETE FROM scheduled_jobs`
        : `DELETE FROM scheduled_jobs WHERE kind != 'purge'`,
    );
    if (b.scope === 'everything') {
      for (const t of [
        'push_subscriptions',
        'device_key_grants',
        'pairing_sessions',
        'tickets',
        'request_nonces',
        'devices',
        'voice_sessions',
        'voice_usage',
      ])
        room.run(`DELETE FROM ${t}`);
      for (const k of ['installation_id', 'claimed_at', 'current_epoch', 'vapid', 'settings'])
        room.run(`DELETE FROM meta WHERE key = ?`, k);
    }
  });
  if (b.scope === 'everything') await room.resetRuntime();
  return json(200, { ok: true, scope: b.scope });
};
