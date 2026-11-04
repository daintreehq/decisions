import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, migrate } from '../src/db/schema.js';
import { ask, claimRelay, declare, inRoom, pairDevice, say } from './helpers.js';

describe('schema migrations', () => {
  it('upgrades a version 1 database in place, keeping its rows', async () => {
    const w = await claimRelay();
    await pairDevice(w);
    const { questionId } = await ask(w);
    const after = await inRoom((_room, state) => {
      const sql = state.storage.sql;
      // Put the database back to what a relay deployed before thread messages holds.
      sql.exec(`DROP TABLE messages`);
      sql.exec(`DROP TABLE message_deliveries`);
      sql.exec(`ALTER TABLE devices DROP COLUMN features`);
      sql.exec(`UPDATE meta SET value = '1' WHERE key = 'schema_version'`);
      migrate(sql);
      migrate(sql); // a second run changes nothing
      const one = <T>(q: string) => sql.exec(q).toArray()[0] as T;
      return {
        version: one<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`)
          .value,
        devices: sql.exec(`SELECT features FROM devices`).toArray(),
        questions: one<{ n: number }>(`SELECT COUNT(*) AS n FROM questions`).n,
        messages: one<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`).n,
        deliveries: one<{ n: number }>(`SELECT COUNT(*) AS n FROM message_deliveries`).n,
      };
    });
    expect(after).toEqual({
      version: String(SCHEMA_VERSION),
      devices: [{ features: '[]' }, { features: '[]' }],
      questions: 1,
      messages: 0,
      deliveries: 0,
    });
    // The upgraded relay takes messages at once.
    await declare(w.owner);
    expect((await say(w, w.owner, questionId)).res.status).toBe(201);
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
