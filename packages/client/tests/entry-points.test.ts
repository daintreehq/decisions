import { describe, expect, it } from 'vitest';
import * as root from '@daintreehq/decisions-client';
import * as sqlite from '@daintreehq/decisions-client/sqlite';

// `pnpm pack:check` proves against the built packages that the root never loads node:sqlite; this
// checks the same split through the workspace's source condition.
describe('entry points', () => {
  it('keeps the SQLite store off the root and exports it from /sqlite', () => {
    expect('SqliteLocalStore' in root).toBe(false);
    expect(typeof root.MemoryLocalStore).toBe('function');
    expect(Object.keys(sqlite)).toEqual(['SqliteLocalStore']);
  });

  it('serves a working LocalStore from /sqlite', async () => {
    const store: root.LocalStore = new sqlite.SqliteLocalStore(':memory:');
    expect(store.durable).toBe(true);
    expect(await store.getCursor()).toBe(0);
    await store.close();
  });
});
