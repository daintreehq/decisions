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

/** Takes the attachments table back to before phone images (schema 4). */
function dropPhoneImageColumns(sql: SqlStorage): void {
  sql.exec(`DROP INDEX attachments_creator_unbound_idx`);
  for (const c of ['kind', 'binding_kind', 'binding_record_id', 'bound_at'])
    sql.exec(`ALTER TABLE attachments DROP COLUMN ${c}`);
}

/** Takes the actions table back to its version 4 shape, whose provenance CHECK knows only human and proxy. */
function restoreV4Actions(sql: SqlStorage): void {
  const cols =
    'action_id, question_id, action, revision, provenance, actor_device_id, record_json, envelope_json, created_at, event_seq';
  sql.exec(`CREATE TABLE actions_v4 (
    action_id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    action TEXT NOT NULL,
    revision INTEGER NOT NULL,
    provenance TEXT CHECK(provenance IN ('human','proxy')),
    actor_device_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    envelope_json TEXT,
    created_at INTEGER NOT NULL,
    event_seq INTEGER NOT NULL
  )`);
  sql.exec(`INSERT INTO actions_v4 (rowid, ${cols}) SELECT rowid, ${cols} FROM actions`);
  sql.exec(`DROP TABLE actions`);
  sql.exec(`ALTER TABLE actions_v4 RENAME TO actions`);
  sql.exec(`CREATE INDEX actions_question_idx ON actions(question_id, event_seq)`);
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

  it('upgrades a version 3 database, keeping every question image as one and taking phone images at once', async () => {
    const w = await claimRelay();
    await declare(w.owner, ['phone-images-v1', 'thread-messages-v1']);
    const phone = await pairDevice(w);
    const questionId = newId();
    const asked = await uploadImage(w, questionId, PNG);
    expect((await ask(w, { questionId, attachmentIds: [asked.attachmentId] })).res.status).toBe(
      201,
    );
    const later = newId();
    const pending = await uploadImage(w, later, PNG);

    const result = await inRoom((_room, state) => {
      const sql = state.storage.sql;
      dropPhoneImageColumns(sql);
      sql.exec(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
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
    const img = await uploadPhoneImage(w, phone, questionId, {
      kind: 'answer',
      record_id: actionId,
    });
    expect(img.complete!.status).toBe(200);
    const answered = await act(w, phone, 'answer', questionId, 0, {
      actionId,
      attachmentIds: [img.attachmentId],
      content: { selected_option_ids: ['approve'], images: [img.ref] },
    });
    expect(answered.res.status).toBe(201);
  });

  it('upgrades a version 4 database, keeping every action and taking owner-desktop answers at once', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const human = await ask(w);
    expect((await act(w, phone, 'answer', human.questionId, 0)).res.status).toBe(201);
    const proxied = await ask(w, { requirement: 'proxy-ok' });
    const proxy = await act(w, w.owner, 'proxy-answer', proxied.questionId, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.9,
      },
    });
    expect(proxy.res.status).toBe(201);
    const cancelled = await ask(w);
    expect((await act(w, w.owner, 'cancel', cancelled.questionId, 0)).res.status).toBe(201);
    const open = await ask(w);

    const result = await inRoom((_room, state) => {
      const sql = state.storage.sql;
      restoreV4Actions(sql);
      sql.exec(`UPDATE meta SET value = '4' WHERE key = 'schema_version'`);
      const rows = () => sql.exec(`SELECT rowid AS r, * FROM actions ORDER BY rowid`).toArray();
      const checkSql = () =>
        (
          sql.exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'actions'`).toArray()[0] as {
            sql: string;
          }
        ).sql;
      const v4Check = checkSql();
      const before = rows();
      migrate(sql);
      const after = rows();
      const indexes = sql
        .exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'actions'`)
        .toArray()
        .map((r) => (r as { name: string }).name);
      const version = (
        sql.exec(`SELECT value FROM meta WHERE key = 'schema_version'`).toArray()[0] as {
          value: string;
        }
      ).value;
      // Still a CHECK: anything but the three provenances (or none) is refused.
      let invalid: unknown = null;
      try {
        sql.exec(
          `INSERT INTO actions (action_id, question_id, action, revision, provenance, actor_device_id, record_json,
             created_at, event_seq) VALUES ('bogus_action', 'q', 'answer', 1, 'model', 'd', '{}', 0, 0)`,
        );
      } catch (e) {
        invalid = e;
      }
      migrate(sql);
      return { v4Check, before, after, indexes, version, invalid, again: rows(), check: checkSql() };
    });
    expect(result.v4Check).not.toContain('human-desktop');
    expect(result.check).toContain("'human','human-desktop','proxy'");
    expect(result.version).toBe(String(SCHEMA_VERSION));
    expect(result.before.map((r) => r.provenance)).toEqual(['human', 'proxy', null]);
    expect(result.after).toEqual(result.before);
    expect(result.again).toEqual(result.before);
    expect(result.indexes).toContain('actions_question_idx');
    expect(result.invalid).toBeTruthy();

    // The upgraded relay records an owner-desktop answer at once.
    await declare(w.owner, ['owner-desktop-answers-v1']);
    expect((await act(w, w.owner, 'answer', open.questionId, 0)).res.status).toBe(201);
    const detail = await phone.call('GET', `/api/v1/questions/${open.questionId}`);
    expect(detail.json.actions[0].provenance).toBe('human-desktop');
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
