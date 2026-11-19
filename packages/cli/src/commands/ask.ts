import { performance } from 'node:perf_hooks';
import {
  BridgeError,
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
import { ReceiverLock } from '../receiver.js';
import { humanFileResolver } from '../resolvers.js';
import {
  DemoSink,
  REVOKED,
  buildBridge,
  cliOrigin,
  closeBridge,
  parseSink,
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
 * The question's outcome, or null while there is none yet to report. A create whose reply was lost
 * (`possibly-committed`) is never concluded here, whatever the clock says; neither is an advisory deadline whose plan
 * this computer may yet let go ahead, while it still reads the relay (a reopen may be on its way).
 */
export function outcomeOf(v: DecisionView): QuestionOutcome | null {
  if (v.publication === 'possibly-committed') return null;
  const advisory = currentAdvisoryTimeout(v);
  if (advisory?.disposition === 'fallback-due' && !v.fallbackDue) return null;
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
/** How long `ask` without `--wait` tries to publish before leaving it to the next receiver. */
const PUBLISH_MS = 30_000;

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
  stopped: Promise<StopSignal>;
  tickMs?: number;
  settleMs?: number;
}

/**
 * Waits for the question's outcome, reading this computer's copy of it now (it may have settled before this wait
 * began, or in another process on the same store), whenever the bridge says something moved, and every `tickMs`.
 * While another process receives for the state directory, this one only reads; once that one exits, this one takes
 * over and receives itself. Its own sink gets `settleMs` to write the outcome's notice before the wait reports.
 * Stopping (the wait timeout, a signal) never cancels the question: a final read still reports an outcome that came.
 */
async function waitForOutcome(a: WaitArgs): Promise<WaitResult> {
  const { ctx, bridge } = a;
  // Set from listeners, so kept in an object the compiler does not narrow across awaits.
  const ended: { fatal: CliError | null; stop: StopSignal | null } = { fatal: null, stop: null };
  let finalSince: number | null = null;
  let wake!: () => void;
  let woken = new Promise<void>((r) => (wake = r));
  const offs = [
    bridge.on('delivered', (id) => id === a.questionId && wake()),
    bridge.on('sync', (s) => {
      if (s.outcome === 'fatal')
        ended.fatal ??= new CliError(
          `stopped waiting: the relay refuses this client (${s.reason}); update decisions`,
        );
      wake();
    }),
    bridge.on('state', (s) => {
      if (s !== 'revoked') return;
      ended.fatal ??= new CliError(REVOKED);
      wake();
    }),
  ];
  void a.stopped.then((sig) => {
    ended.stop ??= sig;
    wake();
  });
  const timer = setInterval(() => wake(), a.tickMs ?? TICK_MS);
  let receiving = false;
  let observing = false;
  try {
    for (;;) {
      if (!receiving && !ended.fatal && !ended.stop) {
        // Already held (an `ask` that took it before asking), or free now: this process receives.
        if (a.lock.tryAcquire()) {
          receiving = true;
          if (observing)
            ctx.err('[decisions] the other receiver stopped; receiving here from now on');
          await bridge.start(a.start);
        } else if (!observing) {
          observing = true;
          ctx.err(
            '[decisions] another decisions process receives for this state directory: its sink gets the notice, and this wait reads the outcome from the shared state',
          );
        }
      }
      const view = await bridge.getDecision(a.questionId, a.pane);
      const outcome = outcomeOf(view);
      const now = performance.now();
      if (outcome) {
        const delivery = deliveryOf(view, outcome);
        finalSince ??= now;
        const settling =
          receiving &&
          delivery === 'pending' &&
          now - finalSince < (a.settleMs ?? SETTLE_MS) &&
          !ended.stop &&
          !ended.fatal;
        if (!settling) return { outcome, view, delivery };
      } else {
        if (ended.fatal) throw ended.fatal;
        if (ended.stop)
          return { outcome: 'interrupted', view, delivery: 'none', signal: ended.stop };
        if (a.timeoutMs !== null && now - a.since >= a.timeoutMs)
          return { outcome: 'wait-timeout', view, delivery: 'none' };
      }
      await woken;
      woken = new Promise<void>((r) => (wake = r));
    }
  } finally {
    clearInterval(timer);
    for (const off of offs) off();
  }
}

/** Reads SIGINT and SIGTERM as a request to stop waiting, from now until `off`. */
function stopSignals(): { stopped: Promise<StopSignal>; off: () => void } {
  let resolve!: (s: StopSignal) => void;
  const stopped = new Promise<StopSignal>((r) => (resolve = r));
  const onInt = () => resolve('SIGINT');
  const onTerm = () => resolve('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  return {
    stopped,
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

const resultRecord = (r: WaitResult) => ({
  record: 'result',
  outcome: r.outcome,
  exit_code: exitCodeOf(r),
  delivery: r.delivery,
  ...(r.signal ? { signal: r.signal } : {}),
  ...decisionResult(r.view),
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

/** Everything one `ask` or `wait` run holds, and its way out. */
async function openWaiter(
  ctx: Ctx,
  g: GlobalOptions,
  o: { sink?: string; stopped?: Promise<StopSignal> },
  resolver?: typeof humanFileResolver,
) {
  const spec = parseSink(o.sink);
  // Installed before anything can take time, so a signal is a stop request, never an exit with the question unread.
  const signals = o.stopped ? null : stopSignals();
  const stopped = o.stopped ?? signals!.stopped;
  let rt: Runtime;
  try {
    rt = await openRuntime(ctx, g);
  } catch (e) {
    signals?.off();
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
  return {
    rt,
    lock,
    bridge,
    stopped,
    also,
    close: async () => {
      stopping = true;
      signals?.off();
      try {
        await closeBridge(rt, bridge, sink, also);
      } finally {
        lock.release();
      }
    },
  };
}

const startOf = (o: { socket?: boolean; poll?: HttpPollOptions }): WaitArgs['start'] =>
  o.socket === false ? { socket: false, poll: o.poll ?? true } : {};

/**
 * `decisions ask`: commit the question locally, print its receipt at once (before anything is sent), then publish it,
 * or with `--wait` wait for its outcome. Returns the exit status.
 */
export async function ask(ctx: Ctx, g: GlobalOptions, o: AskOptions): Promise<number> {
  // Usage errors before anything opens.
  const options = (o.option ?? []).map((s) => {
    const i = s.indexOf('=');
    if (i < 1) throw new CliError(`--option must look like id=Label, got "${s}"`);
    return { id: s.slice(0, i), label: s.slice(i + 1) };
  });
  if (o.waitTimeout !== undefined && !o.wait)
    throw new CliError('--wait-timeout only applies with --wait', 2);
  const timeoutMs = o.waitTimeout !== undefined ? parseWaitTimeout(o.waitTimeout) : null;
  const w = await openWaiter(ctx, g, o, humanFileResolver);
  const ended: { stop: StopSignal | null } = { stop: null };
  void w.stopped.then((s) => (ended.stop = s));
  try {
    // A receiver elsewhere publishes and delivers; this process then only publishes what it asked, and only reads.
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
      if (!ended.stop) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const send = w.lock.held ? w.bridge.pump() : w.bridge.publisher.flush();
        w.also.push(send);
        await Promise.race([
          send.catch((e: Error) => ctx.err(`warning: ${e.message}`)),
          w.stopped,
          new Promise<void>((resolve) => (timer = setTimeout(resolve, PUBLISH_MS))),
        ]);
        clearTimeout(timer);
      }
      if (!ctx.json)
        ctx.out(
          w.lock.held
            ? 'The outcome is delivered by a running `decisions listen` (or `decisions mcp`), or here with --wait.'
            : 'Another decisions process receives for this state directory: its sink gets the outcome.',
        );
      return ended.stop ? SIGNAL_EXIT[ended.stop] : 0;
    }
    // Receiving elsewhere: publish what was asked here at once rather than at that receiver's next pass.
    if (!w.lock.held) w.also.push(w.bridge.publisher.flush().catch(() => undefined));
    const res = await waitForOutcome({
      ctx,
      bridge: w.bridge,
      lock: w.lock,
      questionId: r.questionId,
      pane: paneIdentityOf(cliOrigin()),
      since,
      timeoutMs,
      start: startOf(o),
      stopped: w.stopped,
      ...(o.tickMs !== undefined ? { tickMs: o.tickMs } : {}),
      ...(o.settleMs !== undefined ? { settleMs: o.settleMs } : {}),
    });
    await writeLine(ctx, ctx.json ? JSON.stringify(resultRecord(res)) : resultText(res, timeoutMs));
    return exitCodeOf(res);
  } finally {
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
    let res: WaitResult;
    try {
      // An unknown question fails here, before this process takes over receiving for anything else.
      await w.bridge.getDecision(questionId, pane);
      res = await waitForOutcome({
        ctx,
        bridge: w.bridge,
        lock: w.lock,
        questionId,
        pane,
        since,
        timeoutMs,
        start: startOf(o),
        stopped: w.stopped,
        ...(o.tickMs !== undefined ? { tickMs: o.tickMs } : {}),
        ...(o.settleMs !== undefined ? { settleMs: o.settleMs } : {}),
      });
    } catch (e) {
      throw cliErrorOf(e);
    }
    await writeLine(ctx, ctx.json ? JSON.stringify(resultRecord(res)) : resultText(res, timeoutMs));
    return exitCodeOf(res);
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
      ...decisionResult(v),
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
