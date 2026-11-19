import worker, { DecisionRoom as RelayRoom } from '../src/index.js';
import type { Env } from '../src/env.js';

/*
 * The relay with a clock the end-to-end suite can move: the production Worker and Durable Object, unchanged, behind
 * a shifted `Date.now` and one extra route. Only the e2e harness runs it, as the script `wrangler dev` is given in
 * place of the config's `main`; the shipped bundle is built from `main` and never includes this file.
 *
 * `POST /__e2e/clock` with `{ "offset_ms": n }` sets how far the relay's clock runs ahead of the real one (absolute,
 * so a repeated request never moves it twice) and then runs the room's alarm, as the runtime would once the new time
 * reached it. The relay reads its clock through `nowMs()` (`Date.now()`), so deadlines, expiries, request skew and the
 * ledger's timestamps all move with it. Native alarms are set in real time, so the room translates them, and HTTP
 * responses carry the moved time in `Date`, the header a client learns its skew from after a refusal.
 */

// Every export of an entry module is an entrypoint to workerd: only the handler and the room class are exported.
const CLOCK_PATH = '/__e2e/clock';
const OFFSET_KEY = 'e2e_clock_offset_ms';
/** Alarm passes per move: each runs a bounded batch of due jobs, and one move can make many due. */
const MAX_ALARM_PASSES = 20;

const nativeNow = Date.now.bind(Date);
let offsetMs = 0;
Date.now = () => nativeNow() + offsetMs;

export class DecisionRoom extends RelayRoom {
  /** The alarm runs from the runtime and from a move: one pass at a time, so no due job runs twice at once. */
  private alarms: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The room schedules its alarm on its own clock; the runtime fires it on the real one.
    const storage = ctx.storage;
    const setAlarm = storage.setAlarm.bind(storage);
    const getAlarm = storage.getAlarm.bind(storage);
    storage.setAlarm = (at, options) => setAlarm(Number(at) - offsetMs, options);
    storage.getAlarm = async (options) => {
      const at = await getAlarm(options);
      return at == null ? at : at + offsetMs;
    };
    // A room started again (evicted, or a relay restarted on the same storage) keeps the time it had reached. An
    // alarm still set for an earlier offset (a move cut short) fires now, so the room schedules it again on this one.
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await storage.get<number>(OFFSET_KEY);
      if (typeof saved !== 'number' || saved === offsetMs) return;
      offsetMs = saved;
      if ((await getAlarm()) !== null) await setAlarm(nativeNow());
    });
  }

  override alarm(): Promise<void> {
    const pass = this.alarms.then(() => super.alarm());
    this.alarms = pass.catch(() => undefined);
    return pass;
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== CLOCK_PATH) return super.fetch(request);
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const body = (await request.json().catch(() => null)) as { offset_ms?: unknown } | null;
    const next = body?.offset_ms;
    if (typeof next !== 'number' || !Number.isSafeInteger(next)) {
      return new Response('offset_ms must be an integer', { status: 400 });
    }
    offsetMs = next;
    await this.ctx.storage.put(OFFSET_KEY, next);
    // What the alarm would have done by now: every job that has come due, in as many passes as that takes.
    for (let pass = 0; pass < MAX_ALARM_PASSES; pass++) {
      await this.alarm();
      const at = await this.ctx.storage.getAlarm();
      if (at === null || at > Date.now()) {
        return Response.json({ offset_ms: offsetMs, now: new Date(Date.now()).toISOString() });
      }
    }
    return new Response(`jobs still due after ${MAX_ALARM_PASSES} alarm passes`, { status: 500 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === CLOCK_PATH) {
      return env.DECISION_ROOM.get(env.DECISION_ROOM.idFromName('primary')).fetch(request);
    }
    const res = await worker.fetch(request, env);
    // A socket upgrade is passed on as it is; it carries no Date a client reads.
    if (res.status === 101 || res.webSocket) return res;
    const dated = new Response(res.body, res);
    dated.headers.set('Date', new Date(Date.now()).toUTCString());
    return dated;
  },
} satisfies ExportedHandler<Env>;
