import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDurableObjectAlarm } from 'cloudflare:test';
import {
  act,
  ask,
  claimRelay,
  inRoom,
  pairDevice,
  settle,
  stub,
  type Actor,
  type World,
} from './helpers.js';

const HOURS_49 = 49 * 3600_000;

/** Every timestamp the room holds, moved `ms` into the past, as if that long had gone by. */
async function age(ms: number) {
  await inRoom((room) => {
    const tables = room
      .q<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
      )
      .map((t) => t.name);
    for (const table of tables) {
      const columns = room
        .q<{ name: string; type: string }>(`PRAGMA table_info(${table})`)
        .filter((c) => /_at$/.test(c.name) && /INT/i.test(c.type))
        .map((c) => c.name);
      for (const column of columns) {
        room.run(`UPDATE ${table} SET ${column} = ${column} - ? WHERE ${column} IS NOT NULL`, ms);
      }
    }
  });
}

/** Runs every job that would have come due meanwhile, the daily purge included. */
async function runEverythingDue() {
  await inRoom((room) =>
    room.run(`UPDATE scheduled_jobs SET run_at = ? WHERE status = 'pending'`, Date.now() - 1),
  );
  await runDurableObjectAlarm(stub());
  await settle();
}

describe('a desktop away for 48 hours', () => {
  let w: World;
  let phone: Actor;

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response(null, { status: 201 })) as never,
    );
    w = await claimRelay();
    phone = await pairDevice(w);
  });
  afterEach(() => vi.restoreAllMocks());

  it('still gets the answer given while it was away, with nothing purged', async () => {
    const { questionId } = await ask(w);
    await act(w, phone, 'answer', questionId, 0);
    const before = (await w.owner.call('GET', '/api/v1/events', undefined, 'after=0')).json.events;
    const answered = before.filter(
      (e: { event_type: string; question_id: string | null }) =>
        e.event_type === 'decision.answer.committed' && e.question_id === questionId,
    );
    expect(answered).toHaveLength(1);
    expect(answered[0].data).toMatchObject({ deliverable: true, status: 'human-answered' });

    await age(HOURS_49);
    await runEverythingDue();

    // The desktop comes back and reads from where it left off: every event is still there.
    const events = (await w.owner.call('GET', '/api/v1/events', undefined, 'after=0')).json.events;
    const id = (e: { event_id: string }) => e.event_id;
    expect(events.map(id)).toEqual(before.map(id));
    expect(
      events.find((e: { event_id: string }) => e.event_id === answered[0].event_id),
    ).toMatchObject({
      event_type: 'decision.answer.committed',
      data: answered[0].data,
    });
    const detail = await w.owner.call('GET', `/api/v1/questions/${questionId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.status).toBe('human-answered');
    expect(detail.json.actions).toHaveLength(1);
    expect(detail.json.deliveries[0]).toMatchObject({ answer_revision: 1, status: 'relay-queued' });
    // And it can still open a socket and acknowledge what it read.
    const ticket = await w.owner.call('POST', '/api/v1/socket-ticket', { protocol_version: 1 });
    expect(ticket.status).toBe(200);
  });
});
