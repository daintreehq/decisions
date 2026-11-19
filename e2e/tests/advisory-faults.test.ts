import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  FileKeyStore,
  RelayClient,
  RelayError,
  claimRelay,
  type DecisionsBridge,
  type WebSocketFactory,
  type WebSocketLike,
} from '@daintreehq/decisions-client';
import {
  ADVISORY_QUESTION_FIXTURE,
  ADVISORY_TIMEOUT_DECISION_FIXTURE,
  ADVISORY_TIMEOUT_NOTICE_FIXTURE,
} from '@daintreehq/decisions-protocol/fixtures';
import { DemoSink, daemon } from '../../packages/cli/src/commands/daemon.js';
import { getCmd, waitCmd, type StopSignal } from '../../packages/cli/src/commands/ask.js';
import type { Ctx } from '../../packages/cli/src/runtime.js';
import { TestClock } from './clock.js';
import {
  CLAIM_SECRET,
  CLOCKED_WORKER,
  findChromium,
  startRelay,
  until,
  type RunningRelay,
} from './harness.js';
import { callTool as call, connect, openFromInbox, pairPhone } from './mcp-agent.js';

/*
 * Advisory questions through the standalone path when something goes wrong on the way (docs/operations.md, "Asking
 * from a script or an agent without Daintree"): the real `decisions mcp` receiver (the CLI's `daemon`, in this
 * process) serves `ask_human` to an agent over MCP and writes notices to a file sink, which cannot wake the agent; the
 * relay is the real Worker on a moved clock; the phone is the PWA in Chromium. Each case ends in an outcome the agent
 * recovers by ID, as `get_decision` and `decisions wait <id> --pane mcp`, and none of them is a human answer.
 *
 * The CLI's relay client signs its requests on the real clock (its `Ctx.now` moves the bridge, not the signer), so the
 * moved clock has to stay within the relay's request skew allowance (`LIMITS.requestSkewMs`, two minutes) of the real
 * one: each test runs on a relay of its own and moves the clock once, past a 90-second deadline. The 15-minute window
 * and its countdown on the phone are covered by advisory-loop.test.ts.
 */

const PORT = 8893;
const MOUNT = '/mcp';
const WINDOW = '90s';
/** Between `get_decision` polls: MCP allows a pane 60 requests a minute. */
const POLL_MS = 1_000;
const ADVICE = ADVISORY_QUESTION_FIXTURE.content;
const CREATE = 'POST /api/v1/questions';
const RESERVE = 'POST /api/v1/attachments/reservations';
/** A one-pixel PNG: the screenshot an agent attaches. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);
/** The notes a never-published advisory notice carries (packages/client/src/notice.ts). */
const NEVER_PUBLISHED_LINES = [
  'source: system',
  'status: never-published',
  'authorised: no',
  "note: This question never reached the relay: its deadline passed before this computer could publish it, so it never reached the person's phone and no answer to it was recorded. Nothing was decided or approved.",
  'note: It was an advisory question. You may carry out the plan you stated, at your own discretion; the person did not choose it.',
];

/**
 * The receiving computer's network, with the faults a test turns on. `offline` fails every request before it leaves;
 * `loseCreateReply` lets the next create reach the relay and loses its reply, then holds every create after it (before
 * it leaves) until `releaseCreates`, so the client's own quick retries cannot recover the receipt early.
 */
class DesktopNet {
  offline = false;
  loseCreateReply = false;
  private holdCreates = false;
  /** Each request, as `METHOD /path`, and whether it left this computer. */
  readonly calls: { route: string; sent: boolean }[] = [];
  /** Each create that reached the relay: the body as signed, the relay's reply, and the system's time it left. */
  readonly creates: { body: string; status: number; reply: string; at: number }[] = [];

  constructor(private readonly now: () => number) {}

  releaseCreates(): void {
    this.holdCreates = false;
  }

  sent(route: string): number {
    return this.calls.filter((c) => c.route === route && c.sent).length;
  }

  held(route: string): number {
    return this.calls.filter((c) => c.route === route && !c.sent).length;
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    const create = route === CREATE;
    if (this.offline || (create && this.holdCreates)) {
      this.calls.push({ route, sent: false });
      throw new TypeError('fetch failed');
    }
    this.calls.push({ route, sent: true });
    if (!create) return fetch(input, init);
    const at = this.now();
    const res = await fetch(input, init);
    const reply = await res.text();
    this.creates.push({ body: String(init?.body), status: res.status, reply, at });
    if (this.loseCreateReply) {
      // The relay committed it; the connection broke before this computer read a word of the reply.
      this.loseCreateReply = false;
      this.holdCreates = true;
      throw new TypeError('fetch failed');
    }
    return new Response(reply, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }) as typeof fetch;
}

interface Frame {
  /** Which socket connection (1, 2, ...) it arrived on. */
  conn: number;
  t: string;
  seq?: number;
  event_id?: string;
  event_type?: string;
  question_id?: string | null;
  high_water?: number;
  has_more?: boolean;
}

/** Every frame the relay sends the receiving computer, read beside the bridge's own handler, per connection. */
class SocketTap {
  readonly frames: Frame[] = [];
  private conns = 0;

  get connections(): number {
    return this.conns;
  }

  readonly factory: WebSocketFactory = (url: string) => {
    const conn = ++this.conns;
    const ws = new WebSocket(url);
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let f: {
        t?: string;
        event?: Record<string, unknown>;
        high_water?: number;
        has_more?: boolean;
      };
      try {
        f = JSON.parse(ev.data) as typeof f;
      } catch {
        return; // `pong`
      }
      if (f.t === 'event' && f.event) {
        const e = f.event;
        this.frames.push({
          conn,
          t: 'event',
          seq: e.seq as number,
          event_id: e.event_id as string,
          event_type: e.event_type as string,
          question_id: e.question_id as string | null,
        });
      } else if (f.t === 'caught_up') {
        this.frames.push({ conn, t: 'caught_up', high_water: f.high_water, has_more: f.has_more });
      } else if (f.t) {
        this.frames.push({ conn, t: f.t });
      }
    });
    return ws as unknown as WebSocketLike;
  };

  events(questionId: string, type: string): Frame[] {
    return this.frames.filter(
      (f) => f.t === 'event' && f.question_id === questionId && f.event_type === type,
    );
  }
}

/** `p`, or a failure naming `what` once `ms` pass first. */
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

/** The longest one teardown step may take before the steps after it run anyway. */
const TEARDOWN_STEP_MS = 20_000;

/**
 * What one test started, stopped last first when the test ends, however it ends. Every step runs even if one before
 * it fails or hangs, so the receivers, Chromium contexts and wrangler always stop; a step that hangs fails the
 * teardown once the rest have run. Something a timed-out test starts after its scope closed is stopped as soon as it
 * is added, and the next test waits for that before it starts (`Scope.stragglers`).
 */
class Scope {
  private static readonly late = new Set<Promise<boolean>>();
  private steps: (() => unknown)[] = [];
  private closed = false;

  /** Waits for what closed scopes are still stopping. */
  static async stragglers(): Promise<void> {
    await Promise.all(Scope.late);
  }

  add(step: () => unknown): void {
    if (!this.closed) {
      this.steps.push(step);
      return;
    }
    const stopping = Scope.run(step);
    Scope.late.add(stopping);
    void stopping.finally(() => Scope.late.delete(stopping));
  }

  async close(): Promise<void> {
    this.closed = true;
    let hung = 0;
    for (const step of this.steps.splice(0).reverse()) if (!(await Scope.run(step))) hung++;
    if (hung) throw new Error(`${hung} teardown step(s) did not finish in ${TEARDOWN_STEP_MS} ms`);
  }

  /** False when the step neither ended nor failed in time. A step that fails has still ended. */
  private static run(step: () => unknown): Promise<boolean> {
    return within(
      Promise.resolve()
        .then(step)
        .catch(() => undefined),
      TEARDOWN_STEP_MS,
      'a teardown step',
    ).then(
      () => true,
      () => false,
    );
  }
}

const chromiumPath = findChromium();

describe.skipIf(!chromiumPath)(
  'advisory faults: offline publish, a lost receipt, an offline phone, a restart and a replay, recovered by ID',
  () => {
    let browser: Browser;
    let scope = new Scope();

    beforeAll(async () => {
      browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    }, 60_000);

    beforeEach(async () => {
      await Scope.stragglers();
      scope = new Scope();
    }, 30_000);

    afterEach(async () => {
      try {
        await scope.close();
      } finally {
        // Only once the receivers have stopped, so none finds its terminal idle again while it shuts down.
        vi.restoreAllMocks();
      }
    }, 240_000);

    afterAll(async () => {
      await browser?.close().catch(() => undefined);
    });

    interface System {
      /** The test's own scope, held from its start, so what it starts late is never stopped with the next test. */
      scope: Scope;
      relay: RunningRelay;
      clock: TestClock;
      context: BrowserContext;
      page: Page;
      /** The receiving computer's state directory (`--home`): its keys, database, MCP token and notice file. */
      home: string;
      /** The file sink's file: what the receiver typed. */
      notices: string;
      /** A second client on the same keys, for reading the relay as it is. */
      observer: RelayClient;
      problems: string[];
    }

    /** A fresh relay claimed by this computer, with a phone paired to it that can show an agent's plan. */
    const startSystem = async (label: string): Promise<System> => {
      const owner = scope;
      const relay = await startRelay(PORT, undefined, { script: CLOCKED_WORKER });
      owner.add(() => relay.stop());
      const clock = new TestClock(relay.origin);
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'allow',
      });
      owner.add(() => context.close());
      await clock.attach(context);
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

      const home = mkdtempSync(join(tmpdir(), 'decisions-faults-e2e-'));
      owner.add(() => rmSync(home, { recursive: true, force: true }));
      // Claimed into the state directory as `decisions setup` stores it, so the receiver loads these keys from disk.
      const { identity } = await claimRelay({
        origin: relay.origin,
        claimSecret: CLAIM_SECRET,
        label,
        store: new FileKeyStore(home),
      });
      const observer = new RelayClient({ identity, now: clock.now });
      owner.add(() => observer.close());
      await pairPhone(page, observer);
      // The receiver signs advice only once a device of the person's has said it can show the plan.
      await until(
        async () =>
          (await observer.devices()).devices.some(
            (d) =>
              d.role === 'phone' && !d.revoked_at && d.features?.includes('advisory-deadlines-v1'),
          ),
        30_000,
        'the phone to declare advisory deadlines',
      );
      return {
        scope: owner,
        relay,
        clock,
        context,
        page,
        home,
        notices: join(home, 'notices.log'),
        observer,
        problems,
      };
    };

    /** One `decisions` command's context on the system's state directory and clock. */
    const ctxFor = (s: System, o: { fetch?: typeof fetch; webSocket?: WebSocketFactory } = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const ctx: Ctx = {
        home: s.home,
        json: true,
        fetch: o.fetch ?? fetch,
        ...(o.webSocket ? { webSocket: o.webSocket } : {}),
        out: (l) => void out.push(l),
        outAcked: async (l) => void out.push(l),
        err: (l) => void err.push(l),
        prompt: async () => '',
        env: {},
        now: s.clock.now,
        readStdin: async () => '',
      };
      return { ctx, out, err };
    };

    interface Receiver {
      bridge: DecisionsBridge;
      /** The agent's MCP session, with the token `decisions mcp` keeps in the state directory. */
      agent: Client;
      token: string;
      stop(): Promise<void>;
    }

    /**
     * `decisions mcp --sink file:<notices>`, as the daemon runs it: the receiver for the state directory, serving MCP
     * on loopback. It pumps only when the test (or its socket) asks, so each step happens when the test says.
     */
    const startReceiver = async (
      s: System,
      o: { fetch?: typeof fetch; webSocket?: WebSocketFactory; attachmentsDir?: string } = {},
    ): Promise<Receiver> => {
      const { ctx, err } = ctxFor(s, o);
      let release!: () => void;
      const until_ = new Promise<void>((r) => (release = r));
      let ready!: (h: { bridge: DecisionsBridge; url: string; token: string }) => void;
      const readied = new Promise<{ bridge: DecisionsBridge; url: string; token: string }>(
        (r) => (ready = r),
      );
      const serving = daemon(
        ctx,
        {},
        {
          sink: `file:${s.notices}`,
          pumpIntervalMs: 0,
          mcp: {
            port: 0,
            path: MOUNT,
            ...(o.attachmentsDir ? { attachmentsDir: o.attachmentsDir } : {}),
          },
          until: until_,
          onReady: (h) => ready({ bridge: h.bridge, url: h.mcp!.url, token: h.token! }),
        },
      );
      // One stop, however many ask for it: a teardown after a stop cut short by a timeout still waits for it to end.
      let stopping: Promise<void> | null = null;
      const stop = () =>
        (stopping ??= (async () => {
          release();
          await serving.catch(() => undefined);
        })());
      s.scope.add(stop);
      // Ends a wait below as soon as the receiver ends on its own, with what it reported.
      const exited = serving.then(
        () => {
          throw new Error(`the receiver stopped:\n${err.join('\n')}`);
        },
        (e: unknown) => {
          throw new Error(`the receiver failed: ${(e as Error).message}\n${err.join('\n')}`);
        },
      );
      exited.catch(() => undefined);
      const h = await within(Promise.race([readied, exited]), 60_000, 'the receiver to be ready');
      const agent = await within(connect(h.url, h.token), 15_000, 'the agent to connect');
      s.scope.add(() => agent.close());
      await Promise.race([
        until(
          async () => h.bridge.socket.currentState === 'live',
          30_000,
          'the receiver’s socket live',
        ),
        exited,
      ]);
      return {
        bridge: h.bridge,
        agent,
        token: h.token,
        stop: async () => {
          await agent.close().catch(() => undefined);
          await stop();
        },
      };
    };

    /** What the receiver does on its own once its socket and pump have caught up: send, take in, deliver. */
    const settle = async (b: DecisionsBridge) => {
      await b.pump();
      await b.delivery.drain();
    };

    const decision = async (c: Client, id: string) =>
      (await call(c, 'get_decision', { question_id: id })).structuredContent!;

    const decisionWhen = (
      c: Client,
      id: string,
      done: (r: Record<string, unknown>) => boolean,
      what: string,
    ) =>
      until(
        async () => {
          const r = await decision(c, id);
          return done(r) ? r : null;
        },
        30_000,
        what,
        POLL_MS,
      );

    /** Asks for advice with the fixture's choices and plan. The receipt says it is committed here, not published. */
    const askAdvice = async (
      agent: Client,
      question: string,
      extra: Record<string, unknown> = {},
    ) => {
      const asked = await call(agent, 'ask_human', {
        question,
        kind: ADVICE.kind,
        options: ADVICE.options,
        planned_fallback: ADVICE.planned_fallback,
        expires_in: WINDOW,
        ...extra,
      });
      expect(asked.isError, JSON.stringify(asked.structuredContent)).toBeFalsy();
      expect(asked.structuredContent).toMatchObject({
        status: 'queued',
        enforced_requirement: 'human-required',
        reply_mode: 'advisory',
        planned_fallback: ADVICE.planned_fallback,
      });
      const id = String(asked.structuredContent!.question_id);
      // The sink cannot wake the agent, so the receipt tells it how to find the outcome again.
      const text = asked.content.map((c) => c.text ?? '').join('\n');
      expect(text).toContain('This host does not type the answer into your terminal');
      expect(text).toContain(`call get_decision with question_id ${id}`);
      return { id, expiresAt: String(asked.structuredContent!.expires_at) };
    };

    /** Moves the clock five seconds past the question's deadline. */
    const pastDeadline = (s: System, expiresAt: string) =>
      s.clock.advance(Math.max(0, Math.ceil(Date.parse(expiresAt) - s.clock.now())) + 5_000);

    const typed = (s: System) => (existsSync(s.notices) ? readFileSync(s.notices, 'utf8') : '');

    /** The notice block for `id`, typed by the file sink: the frozen preface and delimiters around `body`. */
    const noticeFor = (
      id: string,
      alias: unknown,
      injectionId: string,
      question: string,
      body: string[],
    ) => {
      const frozen = ADVISORY_TIMEOUT_NOTICE_FIXTURE.due.split('\n');
      return (
        [
          frozen[0], // the preface
          frozen[1], // [DAINTREE DECISION ANSWER]
          `question_id: ${id} (q-${String(alias)})`,
          'revision: 0',
          `injection_id: ${injectionId}`,
          `question: ${question}`,
          ...body,
          frozen.at(-1), // [END DAINTREE DECISION ANSWER]
        ].join('\n') + '\n'
      );
    };

    /**
     * Recovery by ID from another process on the same state directory, while the receiver runs: `decisions --json
     * wait <id> --pane mcp`, then `decisions --json get <id> --pane mcp`. Neither reaches the relay for an outcome
     * already recorded here.
     */
    const recoverById = async (s: System, id: string) => {
      const net = new DesktopNet(s.clock.now);
      const w = ctxFor(s, { fetch: net.fetch });
      const code = await waitCmd(w.ctx, {}, id, {
        pane: 'mcp',
        waitTimeout: '10s',
        stopped: new Promise<StopSignal>(() => undefined),
      });
      const records = w.out.map((l) => JSON.parse(l) as Record<string, unknown>);
      const g = ctxFor(s, { fetch: net.fetch });
      await getCmd(g.ctx, {}, id, { pane: 'mcp' });
      const got = JSON.parse(g.out[0]!) as Record<string, unknown>;
      return { code, records, got, calls: net.calls.map((c) => c.route) };
    };

    /** Fields every outcome here shares: the question as asked, and no answer of any kind. */
    const noAnswer = (id: string, expiresAt: string) => ({
      question_id: id,
      expires_at: expiresAt,
      reply_mode: 'advisory',
      planned_fallback: ADVICE.planned_fallback,
      revision: 0,
      provenance: null,
      answered_on: null,
      choice: null,
      text: '',
      answers: [],
    });

    it('a question the computer could not publish before its deadline settles as never-published, its plan due', async () => {
      const s = await startSystem('Offline publish E2E Mac');
      const net = new DesktopNet(s.clock.now);
      // The pane's attachments folder holds the screenshot it attaches. A question with an image reserves it on the
      // relay before the create is sent, so a computer that cannot reach the relay provably never sent the create. (A
      // text-only create is marked possibly published before its first send, and only the relay can settle it then.)
      const attachments = join(s.home, 'attachments');
      mkdirSync(join(attachments, 'mcp'), { recursive: true });
      writeFileSync(join(attachments, 'mcp', 'screen.png'), PNG);
      const r = await startReceiver(s, { fetch: net.fetch, attachmentsDir: attachments });
      // Read once while online which of the person's devices can show a plan, as a running receiver has.
      await r.bridge.pump();

      // The computer goes offline: its socket drops, and every request fails before it leaves.
      r.bridge.socket.stop();
      net.offline = true;
      const question = 'Which screenshot should the release notes lead with?';
      const { id, expiresAt } = await askAdvice(r.agent, question, {
        attachments: [{ local_resource_id: 'screen.png', role: 'reference' }],
      });
      await r.bridge.pump();
      expect(net.held(RESERVE)).toBeGreaterThan(0);
      expect(net.sent(RESERVE)).toBe(0);
      expect(net.calls.some((c) => c.route === CREATE)).toBe(false);
      // Queued here, never sent, and nothing concluded before the deadline.
      expect(await decision(r.agent, id)).toMatchObject({
        status: 'queued',
        publication: 'not-sent',
        closed_reason: null,
        fallback_due: false,
      });
      expect(typed(s)).toBe('');

      // The deadline passes with the computer still offline: the question closes here, never published, and the
      // agent's plan is due.
      await pastDeadline(s, expiresAt);
      await settle(r.bridge);
      const view = await decisionWhen(
        r.agent,
        id,
        (v) => v.delivery_status === 'terminal-delivered',
        'the never-published notice delivered',
      );
      expect(view).toMatchObject({
        ...noAnswer(id, expiresAt),
        status: 'publish-failed',
        publication: 'never-published',
        closed_reason: 'never-published',
        fallback_due: true,
        advisory_timeout: null,
      });
      const notice = typed(s);
      const injectionId = /^injection_id: (\S+)$/m.exec(notice)?.[1] ?? '';
      expect(injectionId).not.toBe('');
      expect(notice).toBe(noticeFor(id, view.alias, injectionId, question, NEVER_PUBLISHED_LINES));

      // Back online: nothing about it goes to the relay, which never heard of it, and the phone never shows it.
      const offlineCalls = net.calls.length;
      net.offline = false;
      r.bridge.socket.start();
      await until(
        async () => r.bridge.socket.currentState === 'live',
        30_000,
        'the socket live again',
      );
      await settle(r.bridge);
      expect(net.calls.length).toBeGreaterThan(offlineCalls);
      const online = net.calls.slice(offlineCalls);
      expect(online.every((c) => c.sent)).toBe(true);
      expect(online.filter((c) => c.route === CREATE || c.route === RESERVE)).toEqual([]);
      expect(net.calls.some((c) => c.route === CREATE)).toBe(false);
      const missing = await s.observer.getQuestion(id).then(
        () => null,
        (e: unknown) => e,
      );
      expect(missing).toBeInstanceOf(RelayError);
      expect(missing).toMatchObject({ status: 404, code: 'not_found' });
      await s.page.goto(`${s.relay.origin}/`);
      await s.page.getByText('No questions yet.').waitFor({ timeout: 20_000 });
      expect(typed(s)).toBe(notice);
      expect(await decision(r.agent, id)).toEqual(view);

      // The agent, which the file sink cannot wake, recovers the outcome by ID.
      const recovered = await recoverById(s, id);
      expect(recovered.code).toBe(14);
      expect(recovered.records.map((x) => x.record)).toEqual(['result']);
      expect(recovered.records[0]).toMatchObject({
        ...view,
        record: 'result',
        outcome: 'never-published',
        exit_code: 14,
        delivery: 'delivered',
      });
      const { outcome, delivery, ...fields } = recovered.got;
      expect({ outcome, delivery }).toEqual({ outcome: 'never-published', delivery: 'delivered' });
      expect(fields).toEqual(view);
      expect(recovered.calls).toEqual([]);
      expect(typed(s)).toBe(notice);
      expect(s.problems).toEqual([]);
    }, 180_000);

    it('a published question keeps its outcome through a lost receipt, an offline phone, a restart and a replay', async () => {
      const s = await startSystem('Advisory faults E2E Mac');
      const net = new DesktopNet(s.clock.now);
      const tap = new SocketTap();
      const first = await startReceiver(s, { fetch: net.fetch, webSocket: tap.factory });
      await first.bridge.pump();
      // The receiver's socket is down until after the deadline, so the relay's word reaches it only in replies, and
      // the terminal its notices go to is busy, so nothing is typed until another receiver takes over.
      first.bridge.socket.stop();
      const busy = vi.spyOn(DemoSink.prototype, 'isIdle').mockResolvedValue(false);

      // 1. The create reaches the relay and its reply is lost; every retry is held for now.
      net.loseCreateReply = true;
      const question = 'Which fixture should the migration tests use?';
      const { id, expiresAt } = await askAdvice(first.agent, question);
      await first.bridge.pump();
      expect(net.creates).toHaveLength(1);
      expect(net.creates[0]!.status).toBe(201);
      expect(net.held(CREATE)).toBeGreaterThan(0);
      expect(await decision(first.agent, id)).toMatchObject({
        status: 'queued',
        publication: 'possibly-committed',
        closed_reason: null,
        fallback_due: false,
      });
      expect(await s.observer.getQuestion(id)).toMatchObject({ status: 'open', revision: 0 });

      // 2. The person opens it on the phone and answers with the phone offline: the answer waits on the phone.
      await openFromInbox(s.page, s.relay.origin, question);
      const plan = s.page.getByRole('note', { name: 'Your agent’s plan' });
      await plan.waitFor({ timeout: 20_000 });
      expect(await plan.innerText()).toContain(ADVICE.planned_fallback);
      await s.context.setOffline(true);
      expect(await s.page.evaluate(() => navigator.onLine)).toBe(false);
      await s.page
        .getByRole('radio', { name: /A SQLite file per test/ })
        .first()
        .check();
      await s.page.getByRole('button', { name: /^Send (decision|answer)$/ }).click();
      await s.page.getByText('Queued on this device').first().waitFor({ timeout: 20_000 });

      // 3. The deadline passes. The relay expires the question; the offline phone and the receiver, without its socket,
      // each know only what they last heard, and neither concludes anything from its own clock.
      await pastDeadline(s, expiresAt);
      expect(await s.observer.getQuestion(id)).toMatchObject({
        status: 'expired',
        revision: 0,
        actions: [],
      });
      await s.page
        .getByText('The deadline passed on this phone')
        .first()
        .waitFor({ timeout: 20_000 });
      await s.page
        .getByText('Your relay will say whether your answer reached it in time.')
        .first()
        .waitFor();
      expect(await decision(first.agent, id)).toMatchObject({
        status: 'queued',
        publication: 'possibly-committed',
        fallback_due: false,
      });

      // 4. The phone comes back online and sends its answer, late: the relay refuses it, and the phone says so.
      const late = s.page.waitForResponse(
        (res) =>
          res.request().method() === 'POST' &&
          new URL(res.url()).pathname === `/api/v1/questions/${id}/answer`,
        { timeout: 30_000 },
      );
      await s.context.setOffline(false);
      const refused = await late;
      expect(refused.status()).toBe(410);
      expect(await refused.json()).toMatchObject({ code: 'expired' });
      await s.page.getByText('Your answer was not applied').first().waitFor({ timeout: 20_000 });
      await s.page
        .getByText('The question expired before your answer reached your relay.')
        .first()
        .waitFor();
      await s.page.getByText('No answer by the deadline').first().waitFor({ timeout: 20_000 });
      expect(await s.observer.getQuestion(id)).toMatchObject({
        status: 'expired',
        revision: 0,
        actions: [],
      });

      // 5. The receiver retries the create after the deadline. The relay replays the receipt it gave the first time,
      // byte for byte, and the question stays published: neither refused nor never-published.
      net.releaseCreates();
      await first.bridge.pump();
      expect(net.creates).toHaveLength(2);
      const [sent, retried] = net.creates as [(typeof net.creates)[0], (typeof net.creates)[0]];
      expect(retried.body).toBe(sent.body);
      expect(retried.at).toBeGreaterThan(Date.parse(expiresAt));
      expect(retried.status).toBe(sent.status);
      expect(retried.reply).toBe(sent.reply);
      expect(JSON.parse(retried.reply)).toMatchObject({
        question_id: id,
        revision: 0,
        status: 'open',
      });
      expect(await decision(first.agent, id)).toMatchObject({
        publication: 'accepted',
        closed_reason: null,
        fallback_due: false,
      });
      expect(typed(s)).toBe('');

      // 6. The socket returns, and the relay's history brings the expiry. It is taken in, and its notice waits for the
      // busy terminal.
      busy.mockClear();
      const away = tap.connections;
      first.bridge.socket.start();
      // Everything the relay holds since the receiver last read: up to the catch-up's final `caught_up`.
      await until(
        async () =>
          tap.frames.some((f) => f.conn > away && f.t === 'caught_up' && f.has_more === false) &&
          tap.events(id, 'decision.expired').length > 0,
        30_000,
        'the receiver caught up with the expiry',
      );
      // The relay's history holds the question once, created at the receipt's event, then expired: the retry added
      // nothing to it.
      expect(tap.events(id, 'decision.created').map((f) => f.seq)).toEqual([
        (JSON.parse(retried.reply) as { event_seq: number }).event_seq,
      ]);
      expect(tap.events(id, 'decision.expired')).toHaveLength(1);
      const received = await decisionWhen(
        first.agent,
        id,
        (v) => v.status === 'expired',
        'the expiry taken in',
      );
      expect(received.advisory_timeout).toMatchObject({
        disposition: 'fallback-due',
        notice: 'pending',
        injection_id: null,
      });
      expect(received.delivery_status).not.toBe('terminal-delivered');
      await until(
        async () => busy.mock.calls.length > 0,
        30_000,
        'delivery to find the terminal busy',
      );
      expect(typed(s)).toBe('');

      // 7. The receiver restarts between the deadline and the notice's delivery: the next one types it, once.
      await first.stop();
      busy.mockRestore();
      expect(typed(s)).toBe('');
      const before = tap.connections;
      const second = await startReceiver(s, { webSocket: tap.factory });
      // The agent's configured token still works: the state directory keeps it.
      expect(second.token).toBe(first.token);
      await settle(second.bridge);
      const view = await decisionWhen(
        second.agent,
        id,
        (v) =>
          v.delivery_status === 'terminal-delivered' &&
          (v.advisory_timeout as { notice?: string } | null)?.notice === 'delivered',
        'the notice delivered by the restarted receiver',
      );
      const fixture = ADVISORY_TIMEOUT_DECISION_FIXTURE;
      const injectionId = String((view.advisory_timeout as { injection_id: string }).injection_id);
      expect(view).toMatchObject({
        ...fixture,
        ...noAnswer(id, expiresAt),
        publication: 'accepted',
        advisory_timeout: {
          ...fixture.advisory_timeout,
          deadline: expiresAt,
          injection_id: injectionId,
        },
      });
      // Byte for byte the frozen notice with this run's values (each stands in exactly one place, so none is left
      // behind unreplaced), typed once.
      const frozen = ADVISORY_TIMEOUT_NOTICE_FIXTURE;
      const swap = (text: string, from: string, to: string) => {
        expect(text.split(from)).toHaveLength(2);
        return text.replace(from, () => to);
      };
      let notice: string = frozen.due;
      notice = swap(
        notice,
        `question_id: ${frozen.questionId} (q-${frozen.alias})`,
        `question_id: ${id} (q-${String(view.alias)})`,
      );
      notice = swap(notice, `injection_id: ${frozen.injectionId}`, `injection_id: ${injectionId}`);
      notice = swap(notice, `question: ${frozen.question}`, `question: ${question}`);
      notice = swap(notice, `deadline: ${frozen.deadline}`, `deadline: ${expiresAt}`);
      expect(typed(s)).toBe(notice + '\n');
      // It typed what the first receiver had taken in and stored: the relay sent it nothing more about the question.
      expect(tap.frames.filter((f) => f.conn > before && f.question_id === id)).toEqual([]);

      // 8. The relay sends the expiry again over the socket: taken in as already known, and not typed again.
      const [expiry] = tap.events(id, 'decision.expired');
      const conn = tap.connections;
      const from = tap.frames.length;
      const errors: Error[] = [];
      const offError = second.bridge.on('error', (e) => errors.push(e));
      // The socket stays live through the replay, so its next `live` is the replay's own `caught_up`, handled after
      // every event before it (the socket handles frames one at a time, in order).
      let offLive = () => {};
      const live = new Promise<void>((resolve) => {
        offLive = second.bridge.on('socket', (state) => {
          if (state === 'live') resolve();
        });
      });
      try {
        second.bridge.socket.syncFrom(expiry!.seq! - 1);
        await within(live, 30_000, 'the replay to be caught up');
      } finally {
        offLive();
      }
      expect(tap.connections).toBe(conn);
      const replay = tap.frames.slice(from).filter((f) => f.conn === conn);
      expect(replay.filter((f) => f.t === 'event' && f.event_id === expiry!.event_id)).toEqual([
        { ...expiry, conn },
      ]);
      expect(replay.at(-1)).toMatchObject({ t: 'caught_up', has_more: false });
      await settle(second.bridge);
      offError();
      expect(errors).toEqual([]);
      expect(typed(s)).toBe(notice + '\n');
      expect(await decision(second.agent, id)).toEqual(view);

      // A receiver started again once the notice is written does not write it again.
      await second.stop();
      const third = await startReceiver(s, { webSocket: tap.factory });
      expect(third.token).toBe(first.token);
      await settle(third.bridge);
      expect(typed(s)).toBe(notice + '\n');
      expect(await decision(third.agent, id)).toEqual(view);

      // 9. The agent recovers the outcome by ID: its plan is due, and nothing was answered.
      const recovered = await recoverById(s, id);
      expect(recovered.code).toBe(13);
      expect(recovered.records.map((x) => x.record)).toEqual(['result']);
      expect(recovered.records[0]).toMatchObject({
        ...view,
        record: 'result',
        outcome: 'advisory-expired',
        exit_code: 13,
        delivery: 'delivered',
      });
      const { outcome, delivery, ...fields } = recovered.got;
      expect({ outcome, delivery }).toEqual({ outcome: 'advisory-expired', delivery: 'delivered' });
      expect(fields).toEqual(view);
      expect(recovered.calls).toEqual([]);
      expect(typed(s)).toBe(notice + '\n');
      expect(s.problems).toEqual([]);
    }, 180_000);
  },
);
