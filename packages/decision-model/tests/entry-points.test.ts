import { describe, expect, it } from 'vitest';
import * as root from '@daintreehq/decisions-model';
import * as sqlite from '@daintreehq/decisions-model/sqlite';

// `pnpm pack:check` proves against the built packages that the root never loads node:sqlite; this
// checks the same split through the workspace's source condition.
describe('entry points', () => {
  it('keeps the SQLite history store off the root and exports it from /sqlite', () => {
    expect('SqliteHistoryStore' in root).toBe(false);
    expect(typeof root.MemoryHistoryStore).toBe('function');
    // Shared internals of the two history stores stay unexported.
    for (const name of ['prepare', 'redactExample', 'CommonState'])
      expect(name in root).toBe(false);
    expect(Object.keys(sqlite)).toEqual(['SqliteHistoryStore']);
  });

  it('serves a working HistoryStore from /sqlite', () => {
    const store = new sqlite.SqliteHistoryStore(':memory:');
    const history: root.HistoryStore = store;
    expect(history.count()).toBe(0);
    expect(history.learningEnabled()).toBe(false);
    store.close();
  });
});
