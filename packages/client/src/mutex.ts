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
