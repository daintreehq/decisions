import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** SQLite's "database is locked" (SQLITE_BUSY). */
const SQLITE_BUSY = 5;

/**
 * The right to receive for one state directory (`--home`): to run the bridge that reads the relay and types notices
 * into this process's sink. Two receivers on one store would both deliver, and each one's start would take the
 * other's write in progress for a crashed one. `listen` and `mcp` hold it while they run; `ask --wait` and `wait`
 * hold it when it is free and otherwise only read the shared state, taking it over once its holder exits.
 *
 * The lock is an exclusive SQLite transaction on a file of its own, never on `decisions.db`, so it costs the store
 * nothing, is refused at once rather than waited for, and is released by the operating system when its process ends,
 * however it ends.
 */
export class ReceiverLock {
  private db: DatabaseSync | null = null;
  constructor(private readonly path: string) {}

  static forHome(home: string): ReceiverLock {
    return new ReceiverLock(join(home, 'receiver.lock'));
  }

  /**
   * Serialises `decisions ask` registrations in one state directory, so two at once with the same `--correlation-id`
   * cannot both find no earlier question and ask it twice. Held only while registering.
   */
  static forRegistration(home: string): ReceiverLock {
    return new ReceiverLock(join(home, 'register.lock'));
  }

  get held(): boolean {
    return this.db !== null;
  }

  /** Takes the lock if no other process (or connection) holds it; true when this one holds it now. */
  tryAcquire(): boolean {
    if (this.db) return true;
    const db = new DatabaseSync(this.path);
    try {
      db.exec('BEGIN EXCLUSIVE');
    } catch (e) {
      db.close();
      if ((e as { errcode?: number }).errcode === SQLITE_BUSY) return false;
      throw e;
    }
    this.db = db;
    return true;
  }

  /** Takes the lock, trying again every 50 ms for up to `timeoutMs`; false if it never came free. */
  async acquire(timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (!this.tryAcquire()) {
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  release(): void {
    const db = this.db;
    if (!db) return;
    this.db = null;
    try {
      db.exec('ROLLBACK');
    } catch {
      /* closing releases it either way */
    }
    db.close();
  }
}

/** What a receiving command says when another process already receives for the state directory. */
export const RECEIVER_BUSY =
  'another decisions process (listen, mcp, a wait, or an ask while it publishes) is already receiving for this state directory (--home): run one receiver per state directory, or stop that one first';
