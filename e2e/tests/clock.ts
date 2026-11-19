import { LIMITS } from '@daintreehq/decisions-protocol';
import type { BrowserContext } from 'playwright-core';

/** The control route of the clocked relay (`CLOCKED_WORKER` in harness.ts). */
const CLOCK_PATH = '/__e2e/clock';

/**
 * The longest single step of a move. The relay refuses a signed request more than `LIMITS.requestSkewMs` from its
 * clock, and the three clocks move one after another, so each step keeps every participant well inside that.
 */
const STEP_MS = LIMITS.requestSkewMs / 2;

/**
 * One clock for the whole system under test: the relay (run as `CLOCKED_WORKER`), the bridge and MCP server in this
 * process (pass `now` to `RelayClient`, `DecisionsBridge` and `startDecisionsMcpServer`), and each phone (Playwright's
 * clock, installed on its browser context before the first page loads). It runs at real speed from wherever it was
 * moved to; only `advance` moves it.
 *
 * `advance` moves time only. Whatever the participants do about it (the bridge catching up, the delivery of a notice)
 * the test settles itself, so a participant that is offline can be left that way while time passes.
 */
export class TestClock {
  private offsetMs = 0;
  private readonly phones: BrowserContext[] = [];
  private moving: Promise<void> = Promise.resolve();

  constructor(private readonly relayOrigin: string) {}

  /** The system's time, in ms since the epoch: a drop-in for `Date.now`. */
  readonly now = (): number => Date.now() + this.offsetMs;

  /** How far the clock has been moved past the real one, in ms. */
  get offset(): number {
    return this.offsetMs;
  }

  /** Puts a phone on this clock. Call it before the context's first page loads. */
  async attach(context: BrowserContext): Promise<void> {
    await context.clock.install({ time: this.now() });
    this.phones.push(context);
  }

  /**
   * Moves every clock forward by `ms`, in steps of at most `STEP_MS`. Each step moves this process first, then the
   * relay (which runs whatever came due), then the phones, so the bridge is never behind the relay when an expiry
   * reaches it (an expiry received well before its deadline by the receiver's clock is refused for good), and no
   * signed request is ever outside the relay's skew allowance. Moves run one at a time.
   */
  advance(ms: number): Promise<void> {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error(`cannot advance the clock by ${ms}`);
    const move = this.moving.then(async () => {
      for (let left = ms; left > 0;) {
        const step = Math.min(left, STEP_MS);
        this.offsetMs += step;
        await this.setRelay(this.offsetMs);
        for (const phone of this.phones) await phone.clock.fastForward(step);
        left -= step;
      }
    });
    this.moving = move.catch(() => undefined);
    return move;
  }

  private async setRelay(offsetMs: number): Promise<void> {
    const res = await fetch(`${this.relayOrigin}${CLOCK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset_ms: offsetMs }),
    });
    if (!res.ok) {
      throw new Error(
        `the relay did not move its clock (${res.status}): is it running ${CLOCK_PATH}?`,
      );
    }
  }
}
