import { performance } from 'node:perf_hooks';
import { knownFeatures, type ProtocolFeature } from '@daintreehq/decisions-protocol';
import {
  BridgeError,
  RelayError,
  adjustmentText,
  askedResult,
  decisionResult,
  decisionText,
  paneIdentityOf,
  type DecisionView,
  type DecisionsBridge,
  type HttpPollOptions,
  type PaneIdentity,
  type RegisterResult,
} from '@daintreehq/decisions-client';
import { CliError, openRuntime, type Ctx, type GlobalOptions, type Runtime } from '../runtime.js';
import { ReceiverLock, socketReplaced } from '../receiver.js';
import { humanFileResolver } from '../resolvers.js';
import {
  DemoSink,
  REVOKED,
  buildBridge,
  cliOrigin,
  closeBridge,
  parseSink,
  quiesceBridge,
  reportSyncs,
} from './daemon.js';

/**
 * How a wait ends. The first seven are the question's outcome, read from this computer's copy of it; the last two are
 * this command stopping on its own, which leaves the question as it is.
 * - `answered`: an answer is in force (`provenance` says whose; only `human` is the person's decision).
 * - `declined`: the person chose not to answer. `withdrawn`: a desktop called the question off.
 * - `expired`: the deadline passed unanswered and nothing may go ahead (a question that waits for a decision, or
 *   advice whose plan this host did not let go ahead).
 * - `advisory-expired`: the advisory deadline passed unanswered and the plan its asker stated may go ahead, at the
 *   asker's discretion (`fallback_due` is true). Nothing was decided or approved.
 * - `never-published`: the deadline passed before the question reached the relay, so the person never saw it;
 *   `fallback_due` says whether its plan may go ahead.
 * - `refused`: the relay refused the question (`error_code`).
 * - `wait-timeout`: `--wait-timeout` passed first. `interrupted`: SIGINT or SIGTERM came first.
 */
export type WaitOutcome =
  | 'answered'
  | 'declined'
  | 'withdrawn'
  | 'expired'
  | 'advisory-expired'
  | 'never-published'
  | 'refused'
  | 'wait-timeout'
  | 'interrupted';

/** The question's own outcomes: everything but this command stopping on its own. */
export type QuestionOutcome = Exclude<WaitOutcome, 'wait-timeout' | 'interrupted'>;

/** Exit status of `ask --wait` and `wait` for each outcome; 1 is an error and 2 a usage error, as for every command. */
export const OUTCOME_EXIT: Record<Exclude<WaitOutcome, 'interrupted'>, number> = {
  answered: 0,
  declined: 10,
  withdrawn: 11,
  expired: 12,
  'advisory-expired': 13,
  'never-published': 14,
  refused: 15,
  'wait-timeout': 16,
};
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;
export type StopSignal = keyof typeof SIGNAL_EXIT;

/**
 * Where the notice of the outcome stands on its way into the receiving process's sink, as this computer knows it:
 * `delivered` (the sink confirmed the write; not that anyone acted on it), `pending` (not written yet), `uncertain`
 * (a write may or may not have happened; it is never written again on its own), `needs-attention` (nothing was
 * written and a person has to decide), `none` (no notice is due: a withdrawal, a refusal, or no outcome yet).
 */
export type NoticeDelivery = 'delivered' | 'pending' | 'uncertain' | 'needs-attention' | 'none';

/** The advisory round's unanswered deadline, while it still describes the question's current round. */
function currentAdvisoryTimeout(v: DecisionView) {
  const a = v.advisoryTimeout;
  return v.status === 'expired' && a && a.revision === v.revision && a.notice !== 'superseded'
    ? a
    : null;
}

/**
 * The question's outcome, or null while there is none yet to report. A queued question is never concluded here,
 * whatever the clock says, a create whose reply was lost (`possibly-committed`) included; neither is an advisory
 * deadline whose plan this computer may yet let go ahead while it still reads the relay (a reopen may be on its way).
 *
 * `receiving`: this process runs the bridge that reads the relay, so its own view of the ledger decides that. A process
 * that does not (another one receives, or `get`) cannot see a replay under way there, so it takes the plan as due only
 * once the receiver has written, or may have written, its notice.
 */
export function outcomeOf(
  v: DecisionView,
  o: { receiving?: boolean } = {},
): QuestionOutcome | null {
  const advisory = currentAdvisoryTimeout(v);
  if (advisory?.disposition === 'fallback-due') {
    if (!v.fallbackDue) return null;
    // Written, or perhaps written, by the receiver: it read the relay before it wrote. Nothing written proves nothing.
    if (!o.receiving && advisory.notice !== 'delivered' && advisory.notice !== 'uncertain')
      return null;
  }
  switch (v.status) {
    case 'human-answered':
    case 'proxy-answered':
      return 'answered';
    case 'cancelled':
      return v.closedReason === 'declined' ? 'declined' : 'withdrawn';
    case 'publish-failed':
      return v.closedReason === 'never-published' ? 'never-published' : 'refused';
    case 'expired':
      return advisory && v.fallbackDue ? 'advisory-expired' : 'expired';
    default:
      return null;
  }
}

/** Where the outcome's notice stands (`NoticeDelivery`). */
export function deliveryOf(v: DecisionView, outcome: WaitOutcome): NoticeDelivery {
  // Nothing is typed for a withdrawal or a refusal.
  if (
    outcome === 'withdrawn' ||
    outcome === 'refused' ||
    outcome === 'wait-timeout' ||
    outcome === 'interrupted'
  )
    return 'none';
  const advisory = currentAdvisoryTimeout(v);
  if (advisory) return advisory.notice === 'superseded' ? 'none' : advisory.notice;
  switch (v.deliveryStatus) {
    case 'terminal-delivered':
      return 'delivered';
    case 'delivery-uncertain':
      return 'uncertain';
    case 'needs-attention':
      return 'needs-attention';
    default:
      return 'pending';
  }
}

const WAIT_DURATION = /^([1-9][0-9]{0,8})([smhd])$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const MAX_WAIT_MS = 365 * UNIT_MS.d;

/** A `--wait-timeout`: a whole number and one unit (s, m, h or d), from 1s to 365d. */
export function parseWaitTimeout(v: string): number {
  const m = WAIT_DURATION.exec(v);
  const ms = m ? Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS] : NaN;
  if (!(ms <= MAX_WAIT_MS))
    throw new CliError(
      '--wait-timeout must be a whole number and one unit (s, m, h or d), from 1s to 365d, such as 2m',
      2,
    );
  return ms;
}

/** What `ask --wait` and `wait` end with. */
export interface WaitResult {
  outcome: WaitOutcome;
  /** The snapshot the outcome was read from. */
  view: DecisionView;
  delivery: NoticeDelivery;
  signal?: StopSignal;
}

export const exitCodeOf = (r: Pick<WaitResult, 'outcome' | 'signal'>): number =>
  r.outcome === 'interrupted' ? SIGNAL_EXIT[r.signal ?? 'SIGINT'] : OUTCOME_EXIT[r.outcome];

/** How often a wait reads the question again, beside the bridge's own events. */
const TICK_MS = 1_000;
/** How long a wait that receives here gives its own sink to write the outcome's notice before it reports. */
const SETTLE_MS = 10_000;
/** How long `ask` without `--wait` sees to its question's publication before leaving it to the next receiver. */
const PUBLISH_MS = 30_000;
/** How often it looks again meanwhile. */
const PUBLISH_TICK_MS = 250;
/**
 * The longest its declaration of this device's features may hold up its first send, at most half of what is left of
 * `PUBLISH_MS`.
 */
const DECLARE_MS = 5_000;

interface WaitArgs {
  ctx: Ctx;
  bridge: DecisionsBridge;
  lock: ReceiverLock;
  questionId: string;
  pane: PaneIdentity;
  /** `performance.now()` when the wait's budget started (the receipt, for `ask --wait`). */
  since: number;
  timeoutMs: number | null;
  /** How this process receives once it holds the lock. */
  start: { socket: false; poll: HttpPollOptions | true } | { socket?: true };
  /** Set the moment a signal arrives (`Halt`), and the wake that goes with it. */
  halt: Halt;
  /** Starting the bridge, once this process receives: shutdown waits for it. */
  starting: Promise<unknown>[];
  tickMs?: number;
  settleMs?: number;
}

/** A stop request, readable at once: set from the signal handler itself, not a later callback. */
export interface Halt {
  signal: StopSignal | null;
  /** Called when `signal` is set. */
  onStop: (() => void) | null;
}

/**
 * Waits for the question's outcome, reading this computer's copy of it first (it may have settled before this wait
 * began, or in another process on the same store), then whenever the bridge says something moved, and every `tickMs`.
 * An outcome already there is reported without receiving anything. Otherwise, while another process receives for the
 * state directory, this one only reads; when none does (or once that one exits) this one receives, starting its bridge
 * in the background so a slow start never holds up a signal, the timeout or an outcome another process records. Its
 * own sink gets `settleMs` (within the wait's budget) to write the outcome's notice. Stopping never cancels the
 * question.
 */
async function waitForOutcome(a: WaitArgs): Promise<WaitResult> {
  const { ctx, bridge, halt } = a;
  // Set from listeners, so kept in an object the compiler does not narrow across awaits.
  const ended: { fatal: CliError | null } = { fatal: null };
  let finalSince: number | null = null;
  let wake!: () => void;
  let woken = new Promise<void>((r) => (wake = r));
  const fail = (e: CliError) => {
    ended.fatal ??= e;
    wake();
  };
  const offs = [
    bridge.on('delivered', (id) => id === a.questionId && wake()),
    bridge.on('sync', (s) => {
      if (s.outcome === 'fatal')
        fail(
          new CliError(
            `stopped waiting: the relay refuses this client (${s.reason}); update decisions`,
          ),
        );
      wake();
    }),
    // Over the socket, a relay that speaks another protocol version ends the socket for good.
    bridge.on('error', (e) => {
      if (e instanceof RelayError && e.code === 'upgrade_required')
        fail(new CliError('stopped waiting: the relay needs a newer decisions; update decisions'));
    }),
    bridge.on('state', (s) => s === 'revoked' && fail(new CliError(REVOKED))),
    // Another connection took this device's socket: nothing more arrives here, so the wait ends, and so does its hold on
    // the state directory, leaving another wait or listener free to receive.
    bridge.on('replaced', () => fail(new CliError(socketReplaced('waiting')))),
  ];
  halt.onStop = () => wake();
  const timer = setInterval(() => wake(), a.tickMs ?? TICK_MS);
  let receiving = false;
  let observing = false;
  let attention = false;
  /** The loop has returned: a start that fails later is only reported. */
  let done = false;
  const remaining = (now: number) =>
    a.timeoutMs === null ? Infinity : a.timeoutMs - (now - a.since);
  try {
    for (;;) {
      const view = await bridge.getDecision(a.questionId, a.pane);
      const outcome = outcomeOf(view, { receiving });
      const now = performance.now();
      if (outcome) {
        const delivery = deliveryOf(view, outcome);
        finalSince ??= now;
        // Only this process's own sink is waited for, and never past the wait's budget.
        const settling =
          receiving &&
          delivery === 'pending' &&
          now - finalSince < Math.min(a.settleMs ?? SETTLE_MS, remaining(finalSince)) &&
          !halt.signal &&
          !ended.fatal;
        if (!settling) return { outcome, view, delivery };
      } else {
        if (ended.fatal) throw ended.fatal;
        if (halt.signal)
          return { outcome: 'interrupted', view, delivery: 'none', signal: halt.signal };
        if (remaining(now) <= 0) return { outcome: 'wait-timeout', view, delivery: 'none' };
        if (!attention && view.deliveryStatus === 'needs-attention') {
          attention = true;
          ctx.err(
            `[decisions] q-${view.alias} needs attention: something could not be accepted or written for it (see \`decisions status\`). This wait goes on until it has an outcome${a.timeoutMs === null ? '; --wait-timeout bounds it' : ''}.`,
          );
        }
        if (!receiving) {
          // Already held (an `ask` that took it before asking), or free now: this process receives.
          if (a.lock.tryAcquire()) {
            receiving = true;
            if (observing)
              ctx.err('[decisions] the other receiver stopped; receiving here from now on');
            // A start that fails leaves nothing receiving: the wait ends, and so does its hold on the lock.
            a.starting.push(
              bridge
                .start(a.start)
                .catch((e: Error) =>
                  done
                    ? ctx.err(`warning: could not start receiving (${e.message})`)
                    : fail(
                        new CliError(`stopped waiting: could not start receiving (${e.message})`),
                      ),
                ),
            );
          } else if (!observing) {
            observing = true;
            ctx.err(
              '[decisions] another decisions process receives for this state directory: its sink gets the notice, and this wait reads the outcome from the shared state',
            );
          }
        }
      }
      await woken;
      woken = new Promise<void>((r) => (wake = r));
    }
  } finally {
    done = true;
    halt.onStop = null;
    clearInterval(timer);
    for (const off of offs) off();
  }
}

/**
 * Reads SIGINT and SIGTERM (or, in tests, `stopped`) as a request to stop, from now until `off`, recording it in the
 * returned `Halt` the moment it arrives.
 */
function stopSignals(stopped?: Promise<StopSignal>): { halt: Halt; off: () => void } {
  const halt: Halt = { signal: null, onStop: null };
  const stop = (s: StopSignal) => {
    if (halt.signal) return;
    halt.signal = s;
    halt.onStop?.();
  };
  if (stopped) {
    void stopped.then(stop);
    return { halt, off: () => undefined };
  }
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  return {
    halt,
    off: () => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    },
  };
}

/** Writes one line and waits until it is really written. */
const writeLine = (ctx: Ctx, line: string): Promise<void> =>
  ctx.outAcked ? ctx.outAcked(line) : Promise.resolve(ctx.out(line));

const durationText = (ms: number) => {
  for (const [u, n] of [
    ['d', UNIT_MS.d],
    ['h', UNIT_MS.h],
    ['m', UNIT_MS.m],
  ] as const)
    if (ms % n === 0) return `${ms / n}${u}`;
  return `${ms / 1000}s`;
};

/** The receipt's words: the deadline and mode that apply, what policy changed, and how to find the question again. */
export function askedCliText(r: RegisterResult): string {
  const q = `q-${r.alias}`;
  const head = r.duplicate
    ? `Already asked as ${q} (${r.questionId}): this --correlation-id and request match it, so this is that question, not a new one; requirement: ${r.requirement}.`
    : `Asked as ${q} (${r.questionId}), requirement: ${r.requirement}.`;
  const plan =
    r.replyMode === 'advisory'
      ? `Asked for advice, due ${r.expiresAt} (UTC). An answer committed before then is delivered as usual. If none is, the plan you gave (--planned-fallback) is yours to carry out, at your discretion: the deadline decides and approves nothing.`
      : r.expiresAt
        ? `It waits for a decision until ${r.expiresAt} (UTC); unanswered by then, it expires, and expiry authorises nothing.`
        : 'It has no deadline: it waits for a decision until it is answered, declined or withdrawn.';
  const policy = r.adjustments?.length
    ? ` Policy: ${r.adjustments.map(adjustmentText).join('; ')}.`
    : '';
  return `${head} ${plan}${policy} See where it stands with \`decisions get ${r.questionId}\`; wait for its outcome with \`decisions wait ${r.questionId}\`.`;
}

/** The final record's words. */
function resultText(r: WaitResult, timeoutMs: number | null): string {
  const v = r.view;
  const code = exitCodeOf(r);
  const lines = [`Outcome: ${r.outcome} (exit ${code}).`];
  if (r.outcome === 'interrupted' || r.outcome === 'wait-timeout') {
    const why =
      r.outcome === 'interrupted'
        ? `on ${r.signal}`
        : `after --wait-timeout ${durationText(timeoutMs ?? 0)}`;
    lines.push(
      `Stopped waiting here ${why}; nothing was cancelled. q-${v.alias} is ${v.status}. Resume with \`decisions wait ${v.questionId}\`, or check with \`decisions get ${v.questionId}\`.`,
    );
    return lines.join('\n');
  }
  lines.push(decisionText(v));
  // The summary shortens the answer: here it is the record, so all of it is shown.
  if (r.outcome === 'answered' && v.text.length > 500) lines.push(`Full answer text:\n${v.text}`);
  if (r.delivery === 'uncertain')
    lines.push(
      'Its notice may or may not have been written to the sink, and is not written again: what is above is the record.',
    );
  else if (r.delivery === 'needs-attention')
    lines.push('Its notice could not be written to the sink: what is above is the record.');
  return lines.join('\n');
}

/**
 * The `get_decision` fields, with `fallback_due` true only when the outcome reported says the stated plan may go ahead:
 * a process that does not receive cannot see a replay under way elsewhere, so its own reading of the ledger never
 * lets a plan go ahead on its own.
 */
const decisionFields = (v: DecisionView, outcome: WaitOutcome | null) => ({
  ...decisionResult(v),
  fallback_due: (outcome === 'advisory-expired' || outcome === 'never-published') && v.fallbackDue,
});

const resultRecord = (r: WaitResult) => ({
  record: 'result',
  outcome: r.outcome,
  exit_code: exitCodeOf(r),
  delivery: r.delivery,
  ...(r.signal ? { signal: r.signal } : {}),
  ...decisionFields(r.view, r.outcome),
});

/** A library refusal, as the CLI reports it: a request the library finds invalid is a usage error. */
function cliErrorOf(e: unknown): unknown {
  if (e instanceof BridgeError)
    return new CliError(`${e.code}: ${e.message}`, e.code === 'validation_error' ? 2 : 1);
  return e;
}

export interface AskOptions {
  question: string;
  context?: string;
  option?: string[];
  require?: string;
  attach?: string[];
  expiresIn?: string;
  expiresAt?: string;
  plannedFallback?: string;
  correlationId?: string;
  wait?: boolean;
  waitTimeout?: string;
  sink?: string;
  /** `false`: receive over HTTP instead of a live socket (`--no-socket`). */
  socket?: boolean;
  /** Tests: stop as a signal would; default SIGINT and SIGTERM. */
  stopped?: Promise<StopSignal>;
  /** Tests: the HTTP polling cadence without a socket. */
  poll?: HttpPollOptions;
  tickMs?: number;
  settleMs?: number;
  /** Tests: the longest the declaration of this device's features may hold up a plain ask's first send. */
  declareMs?: number;
}

export interface WaitCommandOptions {
  pane?: string;
  waitTimeout?: string;
  sink?: string;
  socket?: boolean;
  stopped?: Promise<StopSignal>;
  poll?: HttpPollOptions;
  tickMs?: number;
  settleMs?: number;
}

/** Everything one `ask` or `wait` run holds, and its ways out. */
async function openWaiter(
  ctx: Ctx,
  g: GlobalOptions,
  o: { sink?: string; stopped?: Promise<StopSignal> },
  resolver?: typeof humanFileResolver,
) {
  const spec = parseSink(o.sink);
  // Installed before anything can take time, so a signal is a stop request, never an exit with the question unread.
  const signals = stopSignals(o.stopped);
  let rt: Runtime;
  try {
    rt = await openRuntime(ctx, g);
  } catch (e) {
    signals.off();
    throw e;
  }
  const lock = ReceiverLock.forHome(ctx.home);
  const sink = new DemoSink(spec, ctx.outAcked ?? ctx.out, { json: ctx.json });
  const bridge = buildBridge(rt, sink, resolver ? { resolver } : {});
  let stopping = false;
  bridge.on('error', (e) => !stopping && ctx.err(`warning: ${e.message}`));
  bridge.on('socket', (s, d) => ctx.err(`[relay] ${s}${d ? ` (${d})` : ''}`));
  reportSyncs(ctx, bridge);
  const also: Promise<unknown>[] = [];
  let quiet: Promise<void> | null = null;
  /** Stop receiving and writing, and let what was in flight record itself; the store stays open to be read. */
  const quiesce = () => {
    stopping = true;
    quiet ??= quiesceBridge(rt, bridge, sink, also);
    return quiet;
  };
  return {
    rt,
    lock,
    bridge,
    halt: signals.halt,
    also,
    quiesce,
    close: async () => {
      signals.off();
      try {
        await quiesce();
        await rt.store.close();
      } finally {
        lock.release();
      }
    },
  };
}

const startOf = (o: { socket?: boolean; poll?: HttpPollOptions }): WaitArgs['start'] =>
  o.socket === false ? { socket: false, poll: o.poll ?? true } : {};

type Waiter = Awaited<ReturnType<typeof openWaiter>>;

/**
 * Waits, then reports. Before the result is written, this process stops receiving and lets its sink settle, so the
 * record says how the notice's write really ended and no notice follows it; it then reads the question once more, and
 * an outcome that came meanwhile (even as a signal or the timeout stopped the wait) is the one reported.
 */
async function waitAndReport(
  ctx: Ctx,
  w: Waiter,
  a: Omit<WaitArgs, 'ctx' | 'bridge' | 'lock' | 'halt' | 'starting'>,
): Promise<number> {
  let res: WaitResult | null = null;
  let fatal: unknown = null;
  try {
    res = await waitForOutcome({
      ...a,
      ctx,
      bridge: w.bridge,
      lock: w.lock,
      halt: w.halt,
      starting: w.also,
    });
  } catch (e) {
    fatal = cliErrorOf(e);
  }
  await w.quiesce();
  const view = await w.bridge.getDecision(a.questionId, a.pane).catch(() => null);
  const outcome = view ? outcomeOf(view, { receiving: false }) : null;
  if (view && outcome) {
    // An outcome that came while the wait stopped (a signal, the timeout, an error) is the one reported; for the same
    // outcome in the same round, the latest read says how its notice's write ended.
    const same = res && res.outcome === outcome && res.view.revision === view.revision;
    const stopped = !res || res.outcome === 'interrupted' || res.outcome === 'wait-timeout';
    if (same || stopped) res = { outcome, view, delivery: deliveryOf(view, outcome) };
    // Otherwise the question moved on to another round meanwhile: the result keeps the round it reports.
  }
  if (!res) throw fatal;
  if (fatal) ctx.err(`error: ${(fatal as Error).message}`);
  await writeLine(ctx, ctx.json ? JSON.stringify(resultRecord(res)) : resultText(res, a.timeoutMs));
  return exitCodeOf(res);
}

/**
 * `ask` without `--wait`: sees its question published, for up to `PUBLISH_MS`. While this process may receive, it
 * publishes it itself (a pump). While another process receives, it leaves the publishing to that one and watches, and
 * takes over if that process exits first. True once the question has left this computer's queue; false (with a word on
 * standard error) when it is still queued, for the next receiver to send.
 *
 * Before its first send it declares this device's features to the relay, as a receiver does on its socket ticket: the
 * phone offers, and the relay accepts, the person's decline of a question only once its desktop has declared that it
 * files one, and a device that never ran a receiver has declared nothing. A declaration that fails or is slow never
 * keeps the question from going out.
 */
async function publish(
  ctx: Ctx,
  w: Waiter,
  questionId: string,
  declareMs = DECLARE_MS,
): Promise<boolean> {
  const until = performance.now() + PUBLISH_MS;
  let interrupt: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (interrupt = resolve));
  w.halt.onStop = () => interrupt();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const after = (ms: number) =>
    new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms)));
  let sending: Promise<unknown> | null = null;
  let declared = false;
  try {
    for (;;) {
      if (w.halt.signal) return false;
      const row = await w.bridge.getDecision(questionId).catch(() => null);
      if (row && row.status !== 'queued') {
        // Its own pump may still be writing another question's notice: it finishes within the budget, unless stopped.
        if (sending)
          await Promise.race([sending, stopped, after(Math.max(0, until - performance.now()))]);
        return true;
      }
      // Stopped while it read: nothing more starts.
      if (w.halt.signal) return false;
      const left = until - performance.now();
      if (left <= 0) break;
      // One pump of its own at a time, looked at again every tick: a pump held up by another question's notice never
      // keeps this one from seeing its question go out, a signal or the deadline.
      if (!sending && w.lock.tryAcquire()) {
        const declare = !declared;
        declared = true;
        const send = (async () => {
          if (declare) await declareFeatures(ctx, w, Math.min(declareMs, left / 2));
          // Stopped, or out of time, meanwhile: nothing more goes out.
          if (w.halt.signal || performance.now() >= until) return;
          await w.bridge.pump();
        })();
        w.also.push(send);
        sending = send
          .catch((e: Error) => ctx.err(`warning: ${e.message}`))
          .finally(() => (sending = null));
      }
      await Promise.race([after(Math.min(left, PUBLISH_TICK_MS)), stopped]);
    }
  } finally {
    w.halt.onStop = null;
    for (const t of timers) clearTimeout(t);
  }
  ctx.err(
    '[decisions] the question is not published yet: it stays queued on this computer, and the decisions process that receives for this state directory sends it (a running listen or mcp, or the next one to start).',
  );
  return false;
}

/**
 * Sees that the relay lists this device's features: every `decisions` process of this state directory builds the same
 * bridge, so these are what its receivers declare. The relay keeps only the latest socket ticket's declaration, so a
 * missing one is declared, as an HTTP sync does, through a ticket it never uses. It only adds: what the relay already
 * lists for this device stays declared (a host of the same device may declare more), and when that covers them nothing
 * is sent, so a run of plain asks spends none of the device's few tickets a minute, which a receiver starting meanwhile
 * needs. When the list cannot be read, the ticket declares what a receiver would. Done within `ms` altogether. Never
 * throws; a failure is a warning.
 */
async function declareFeatures(ctx: Ctx, w: Waiter, ms: number): Promise<void> {
  try {
    // One deadline for all of it, however often a request is signed and sent again (after a clock-skew refusal).
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(ms)));
    let listed = new Set<ProtocolFeature>();
    try {
      const list = (await w.rt.client.devices({ retry: false, signal })) as {
        devices?: unknown;
      } | null;
      const me = w.rt.identity.config.deviceId;
      const rows = list?.devices;
      const self: unknown = Array.isArray(rows)
        ? rows.find((d) => (d as { device_id?: unknown } | null)?.device_id === me)
        : undefined;
      const features = (self as { features?: unknown } | undefined)?.features;
      if (Array.isArray(features))
        listed = knownFeatures(features.filter((f): f is string => typeof f === 'string'));
    } catch {
      // Unread: the ticket below says why, if it fails too.
    }
    if (w.bridge.features.every((f) => listed.has(f))) return;
    await w.rt.client.socketTicket([...listed, ...w.bridge.features], { retry: false, signal });
  } catch (e) {
    ctx.err(
      `warning: could not declare this device's features to the relay (${(e as Error).message}); the phone may not offer to dismiss the question until a decisions listen or mcp runs`,
    );
  }
}

/** How long `ask` waits for another `ask` in the same state directory to finish registering. */
const REGISTER_WAIT_MS = 60_000;

/**
 * `decisions ask`: commit the question locally, print its receipt at once (before this process sends anything), then
 * publish it, or with `--wait` wait for its outcome. Returns the exit status.
 */
export async function ask(ctx: Ctx, g: GlobalOptions, o: AskOptions): Promise<number> {
  // Usage errors before anything opens.
  const options = (o.option ?? []).map((s) => {
    const i = s.indexOf('=');
    if (i < 1) throw new CliError(`--option must look like id=Label, got "${s}"`, 2);
    return { id: s.slice(0, i), label: s.slice(i + 1) };
  });
  if (o.waitTimeout !== undefined && !o.wait)
    throw new CliError('--wait-timeout only applies with --wait', 2);
  const timeoutMs = o.waitTimeout !== undefined ? parseWaitTimeout(o.waitTimeout) : null;
  const w = await openWaiter(ctx, g, o, humanFileResolver);
  // Two asks at once with the same correlation id: the second sees what the first committed.
  const registering = o.correlationId !== undefined ? ReceiverLock.forRegistration(ctx.home) : null;
  try {
    if (registering && !(await registering.acquire(REGISTER_WAIT_MS, () => !!w.halt.signal)))
      if (!w.halt.signal)
        throw new CliError(
          'another decisions ask in this state directory did not finish registering',
        );
    // Stopped before asking (while another ask registered, say): nothing is asked.
    if (w.halt.signal) return SIGNAL_EXIT[w.halt.signal];
    // Receiving elsewhere, this process only asks and reads: that receiver publishes, within seconds.
    w.lock.tryAcquire();
    let r: RegisterResult;
    try {
      r = await w.bridge.registerQuestion({
        origin: cliOrigin(),
        input: {
          question: o.question,
          ...(o.context !== undefined ? { context: o.context } : {}),
          ...(options.length ? { options } : {}),
          ...(o.require !== undefined ? { requested_requirement: o.require } : {}),
          ...(o.attach?.length
            ? { attachments: o.attach.map((p) => ({ local_resource_id: p })) }
            : {}),
          ...(o.expiresIn !== undefined ? { expires_in: o.expiresIn } : {}),
          ...(o.expiresAt !== undefined ? { expires_at: o.expiresAt } : {}),
          ...(o.plannedFallback !== undefined ? { planned_fallback: o.plannedFallback } : {}),
          ...(o.correlationId !== undefined ? { correlation_id: o.correlationId } : {}),
        },
        // Nothing is sent before the receipt is out; a cold process reads what advice needs instead of refusing.
        pump: false,
        awaitAdvisorySupport: true,
      });
    } catch (e) {
      throw cliErrorOf(e);
    } finally {
      registering?.release();
    }
    const since = performance.now();
    const text = askedCliText(r);
    await writeLine(
      ctx,
      ctx.json
        ? JSON.stringify({ record: 'asked', alias: r.alias, ...askedResult(r, text) })
        : text,
    );
    if (!o.wait) {
      const published = await publish(ctx, w, r.questionId, o.declareMs);
      if (!ctx.json && published)
        ctx.out(
          'The outcome is delivered by a running `decisions listen` (or `decisions mcp`), or here with --wait.',
        );
      return w.halt.signal ? SIGNAL_EXIT[w.halt.signal] : 0;
    }
    return await waitAndReport(ctx, w, {
      questionId: r.questionId,
      pane: paneIdentityOf(cliOrigin()),
      since,
      timeoutMs,
      start: startOf(o),
      ...(o.tickMs !== undefined ? { tickMs: o.tickMs } : {}),
      ...(o.settleMs !== undefined ? { settleMs: o.settleMs } : {}),
    });
  } finally {
    registering?.release();
    await w.close();
  }
}

/** `decisions wait <id>`: wait for the outcome of a question asked earlier, as `ask --wait` does. */
export async function waitCmd(
  ctx: Ctx,
  g: GlobalOptions,
  questionId: string,
  o: WaitCommandOptions,
): Promise<number> {
  const timeoutMs = o.waitTimeout !== undefined ? parseWaitTimeout(o.waitTimeout) : null;
  const since = performance.now();
  const w = await openWaiter(ctx, g, o);
  try {
    const pane = paneIdentityOf(cliOrigin(o.pane ?? 'cli'));
    // An unknown question fails here, before this process takes over receiving for anything else.
    await w.bridge.getDecision(questionId, pane).catch((e: unknown) => {
      throw cliErrorOf(e);
    });
    return await waitAndReport(ctx, w, {
      questionId,
      pane,
      since,
      timeoutMs,
      start: startOf(o),
      ...(o.tickMs !== undefined ? { tickMs: o.tickMs } : {}),
      ...(o.settleMs !== undefined ? { settleMs: o.settleMs } : {}),
    });
  } finally {
    await w.close();
  }
}

/**
 * `decisions get <id>`: where a question asked from the CLI (or, with `--pane mcp`, through `decisions mcp`) stands,
 * from this computer's copy, without reaching the relay or typing anything: the `get_decision` fields, plus the
 * outcome a wait would report now (null while there is none).
 */
export async function getCmd(
  ctx: Ctx,
  g: GlobalOptions,
  questionId: string,
  o: { pane?: string } = {},
): Promise<void> {
  const rt = await openRuntime(ctx, g);
  const sink = new DemoSink({ kind: 'stdout' }, () => undefined);
  const bridge = buildBridge(rt, sink);
  try {
    let v: DecisionView;
    try {
      v = await bridge.getDecision(questionId, paneIdentityOf(cliOrigin(o.pane ?? 'cli')));
    } catch (e) {
      throw cliErrorOf(e);
    }
    const outcome = outcomeOf(v);
    const json = {
      outcome,
      delivery: outcome ? deliveryOf(v, outcome) : 'none',
      ...decisionFields(v, outcome),
    };
    ctx.out(
      ctx.json
        ? JSON.stringify(json)
        : `${outcome ? `Outcome: ${outcome}.` : 'No outcome yet.'}\n${decisionText(v)}`,
    );
  } finally {
    await closeBridge(rt, bridge, sink);
  }
}
