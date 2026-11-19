/** Minimal async mutex: callers run one at a time, in arrival order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** A failure that says nothing about the event itself (network, missing key material): retry, don't reject. */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

/**
 * Key material is still missing after a reload that succeeded: no outage, but not provably permanent either (a
 * rotation another process is still saving, a key store being restored). Retried in order like any `TransientError`,
 * but the inbox waits for it only for a while, since a key erased from the store never comes back and must not hold
 * the ledger forever.
 */
export class KeyUnavailableError extends TransientError {
  constructor(message: string) {
    super(message);
    this.name = 'KeyUnavailableError';
  }
}
