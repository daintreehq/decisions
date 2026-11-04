import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import { newId } from '@daintreehq/decisions-crypto';
import { SCHEMA_VERSION, migrate } from '../src/db/schema.js';
import {
  PNG,
  act,
  ask,
  claimRelay,
  declare,
  inRoom,
  pairDevice,
  say,
  uploadImage,
  uploadPhoneImage,
} from './helpers.js';

const V1_TABLES = ['questions', 'actions', 'deliveries', 'events', 'command_receipts'] as const;

/** Takes the attachments table back to before phone images (schema 3). */
function dropPhoneImageColumns(sql: SqlStorage): void {
  sql.exec(`DROP INDEX attachments_creator_unbound_idx`);
  for (const c of ['kind', 'binding_kind', 'binding_record_id', 'bound_at'])
    sql.exec(`ALTER TABLE attachments DROP COLUMN ${c}`);
}

describe('schema migrations', () => {
  it('upgrades a version 1 database in place, keeping every row as it was', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const answered = await ask(w);
    expect((await act(w, phone, 'answer', answered.questionId, 0)).res.status).toBe(201);
    const open = await ask(w);

    const result = await inRoom((_room, state) => {
      const sql = state.storage.sql;
      const dump = () =>
        Object.fromEntries(
          V1_TABLES.map((t) => [t, sql.exec(`SELECT * FROM ${t} ORDER BY rowid`).toArray()]),
        );
      // Put the database back to what a relay deployed before thread messages holds.
      dropPhoneImageColumns(sql);
      sql.exec(`DROP TABLE messages`);
      sql.exec(`DROP TABLE message_deliveries`);
      sql.exec(`ALTER TABLE devices DROP COLUMN features`);
      sql.exec(`UPDATE meta SET value = '1' WHERE key = 'schema_version'`);
      const devicesBefore = sql.exec(`SELECT * FROM devices ORDER BY device_id`).toArray();
      const before = dump();
      migrate(sql);
      const one = <T>(q: string) => sql.exec(q).toArray()[0] as T;
      return {
        before,
        after: dump(),
        devicesBefore,
        devicesAfter: sql
          .exec(`SELECT * FROM devices ORDER BY device_id`)
          .toArray()
          .map(({ features, ...rest }) => ({ rest, features })),
        version: one<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`)
          .value,
        messages: one<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`).n,
      };
    });
    expect(result.version).toBe(String(SCHEMA_VERSION));
    expect(result.after).toEqual(result.before);
    expect(result.before.actions).toHaveLength(1);
    expect(result.before.deliveries).toHaveLength(1);
    expect(result.devicesAfter.map((d) => d.rest)).toEqual(result.devicesBefore);
    expect(result.devicesAfter.map((d) => d.features)).toEqual(['[]', '[]']);
    expect(result.messages).toBe(0);

    // The upgraded relay takes messages and receipts at once, and running the migration again keeps them.
    await declare(w.owner);
    const human = await say(w, phone, open.questionId);
    expect(human.res.status).toBe(201);
    const receipt = await w.owner.call('POST', '/api/v1/deliveries/messages', {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(),
      question_id: open.questionId,
      message_id: human.messageId,
      host_id: 'host_aaaaaaaa',
      status: 'received',
    });
    expect(receipt.status).toBe(200);
    const again = await inRoom((_room, state) => {
      const sql = state.storage.sql;
      const rows = () => ({
        messages: sql.exec(`SELECT * FROM messages`).toArray(),
        deliveries: sql.exec(`SELECT * FROM message_deliveries`).toArray(),
        devices: sql.exec(`SELECT device_id, features FROM devices ORDER BY device_id`).toArray(),
      });
      const before = rows();
      migrate(sql);
      return { before, after: rows() };
    });
    expect(again.before.messages).toHaveLength(1);
    expect(again.before.deliveries).toMatchObject([{ status: 'received' }]);
    expect(again.after).toEqual(again.before);
  });

  it('upgrades a version 2 database, keeping every question image as one and taking phone images at once', async () => {
    const w = await claimRelay();
    await declare(w.owner, ['phone-images-v1', 'thread-messages-v1']);
    const phone = await pairDevice(w);
    const questionId = newId();
    const asked = await uploadImage(w, questionId, PNG);
    expect((await ask(w, { questionId, attachmentIds: [asked.attachmentId] })).res.status).toBe(201);
    const later = newId();
    const pending = await uploadImage(w, later, PNG);

    const result = await inRoom((_room, state) => {
      const sql = state.storage.sql;
      dropPhoneImageColumns(sql);
      sql.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
      const rows = () => sql.exec(`SELECT * FROM attachments ORDER BY attachment_id`).toArray();
      const before = rows();
      migrate(sql);
      const after = rows().map(({ kind, binding_kind, binding_record_id, bound_at, ...rest }) => ({
        rest,
        added: { kind, binding_kind, binding_record_id, bound_at },
      }));
      return { before, after };
    });
    expect(result.before).toHaveLength(2);
    expect(result.after.map((r) => r.rest)).toEqual(result.before);
    for (const r of result.after)
      expect(r.added).toEqual({
        kind: 'question',
        binding_kind: null,
        binding_record_id: null,
        bound_at: null,
      });
    // The desktop still asks with an image it uploaded before the upgrade, and a phone attaches one right away.
    expect(
      (await ask(w, { questionId: later, attachmentIds: [pending.attachmentId] })).res.status,
    ).toBe(201);
    const actionId = newId();
    const img = await uploadPhoneImage(w, phone, questionId, { kind: 'answer', record_id: actionId });
    expect(img.complete!.status).toBe(200);
    const answered = await act(w, phone, 'answer', questionId, 0, {
      actionId,
      attachmentIds: [img.attachmentId],
      content: { selected_option_ids: ['approve'], images: [img.ref] },
    });
    expect(answered.res.status).toBe(201);
  });

  it('refuses a database newer than the Worker', async () => {
    await claimRelay();
    await inRoom((_room, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `UPDATE meta SET value = ? WHERE key = 'schema_version'`,
        String(SCHEMA_VERSION + 1),
      );
      expect(() => migrate(sql)).toThrow(/newer than this Worker/);
      sql.exec(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, String(SCHEMA_VERSION));
    });
  });
});
