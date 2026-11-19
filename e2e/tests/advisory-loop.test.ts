import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  DecisionsBridge,
  FileKeyStore,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  TokenMapAuthenticator,
  claimRelay,
  startDecisionsMcpServer,
  type RunningMcp,
} from '@daintreehq/decisions-client';
import {
  ADVISORY_QUESTION_FIXTURE,
  ADVISORY_TIMEOUT_DECISION_FIXTURE,
  ADVISORY_TIMEOUT_NOTICE_FIXTURE,
  BLOCKING_APPROVAL_FIXTURE,
} from '@daintreehq/decisions-protocol/fixtures';
import { replyModeOf } from '@daintreehq/decisions-protocol';
import { TestClock } from './clock.js';
import {
  CLAIM_SECRET,
  CLOCKED_WORKER,
  findChromium,
  startRelay,
  until,
  type RunningRelay,
} from './harness.js';
import {
  PaneSink,
  callTool as call,
  connect,
  openFromInbox,
  pairPhone,
  paneOrigin,
} from './mcp-agent.js';

/*
 * Advisory questions through the standalone path (docs/protocol.md section 21): an agent asks over MCP, the bridge
 * publishes to the relay, the person sees it on the phone, and the outcome is typed into the asking pane. The relay,
 * the bridge and the phone share one clock (clock.ts), so a fifteen-minute deadline passes without waiting for it.
 */

const PORT = 8891;
const MOUNT = '/mcp/decisions';
const TOKEN_A = 'pane-a-advisory-bearer-0123456789abcdef';
const TOKEN_B = 'pane-b-advisory-bearer-0123456789abcdef';
const TOKEN_C = 'pane-c-advisory-bearer-0123456789abcdef';
/**
 * A design sign-off the host registered and bound to pane C's agent, as Daintree binds a workflow's gate to the pane
 * running it: its questions wait for a decision and are never advisory.
 */
const GATE = 'design-review/final';
const MINUTE = 60_000;
const WINDOW = '15m';
/** Between `get_decision` polls: MCP allows a pane 60 requests a minute. */
const POLL_MS = 1_000;

const ADVICE = ADVISORY_QUESTION_FIXTURE.content;
const APPROVAL = BLOCKING_APPROVAL_FIXTURE.content;

const chromiumPath = findChromium();

describe.skipIf(!chromiumPath)(
  'advisory deadlines: agent → MCP → relay → phone → the asking pane, on one controllable clock',
  () => {
    let relay: RunningRelay;
    let clock: TestClock;
    let browser: Browser;
    let page: Page;
    let relayClient: RelayClient;
    let bridge: DecisionsBridge;
    let mcp: RunningMcp;
    let paneA: Client;
    let paneB: Client;
    let paneC: Client;
    const sink = new PaneSink();
    const problems: string[] = [];
    let keyDir = '';

    beforeAll(async () => {
      relay = await startRelay(PORT, undefined, { script: CLOCKED_WORKER });
      clock = new TestClock(relay.origin);
      browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'allow',
      });
      await clock.attach(context);
      page = await context.newPage();
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

      keyDir = mkdtempSync(join(tmpdir(), 'decisions-advisory-e2e-'));
      const { identity } = await claimRelay({
        origin: relay.origin,
        claimSecret: CLAIM_SECRET,
        label: 'Advisory E2E Mac',
        store: new FileKeyStore(keyDir),
      });
      relayClient = new RelayClient({ identity, now: clock.now });
      await pairPhone(page, relayClient);
      // The bridge signs advice only once a device of the person's has said it can show the plan: the phone says so on
      // its socket ticket. Started before that, the bridge would refuse advice until its next read of the devices.
      await until(
        async () =>
          (await relayClient.devices()).devices.some(
            (d) =>
              d.role === 'phone' && !d.revoked_at && d.features?.includes('advisory-deadlines-v1'),
          ),
        30_000,
        'the phone to declare advisory deadlines',
      );

      // Configured as the standalone daemon configures it (packages/cli/src/commands/daemon.ts), plus one gate.
      const policy = new PolicyRegistry({ advisoryQuestions: true });
      policy.register({
        gateId: GATE,
        minRequirement: 'human-required',
        policyVersion: 1,
        choices: APPROVAL.options.map((o) => ({ ...o })),
      });
      bridge = new DecisionsBridge({
        identity,
        store: new MemoryLocalStore(),
        sink,
        client: relayClient,
        policy,
        now: clock.now,
        pumpIntervalMs: 0,
        followUps: true,
        advisoryDeadlines: true,
      });
      await bridge.start();

      const auth = new TokenMapAuthenticator();
      auth.register(TOKEN_A, paneOrigin('pane-a'));
      auth.register(TOKEN_B, paneOrigin('pane-b'));
      auth.register(TOKEN_C, { ...paneOrigin('pane-c'), workflow_gate_id: GATE });
      mcp = await startDecisionsMcpServer({
        bridge,
        authenticator: auth,
        path: MOUNT,
        now: clock.now,
      });
      paneA = await connect(mcp.url, TOKEN_A);
      paneB = await connect(mcp.url, TOKEN_B);
      paneC = await connect(mcp.url, TOKEN_C);
    }, 120_000);

    afterAll(async () => {
      // every step runs even if an earlier one rejects, so Chromium and wrangler always stop
      for (const step of [
        () => paneA?.close(),
        () => paneB?.close(),
        () => paneC?.close(),
        () => mcp?.close(),
        () => bridge?.stop?.(),
        () => browser?.close(),
        () => relay?.stop(),
      ]) {
        await Promise.resolve()
          .then(step)
          .catch(() => undefined);
      }
      if (keyDir) rmSync(keyDir, { recursive: true, force: true });
    });

    /** What the bridge does on its own once its socket and pump have caught up: take in the relay's events, deliver. */
    const settle = async () => {
      await bridge.catchUp();
      await bridge.pump();
      await bridge.delivery.drain();
    };

    const decision = async (c: Client, id: string) =>
      (await call(c, 'get_decision', { question_id: id })).structuredContent!;

    /** Polls `get_decision` until `done` holds, at a pace MCP's rate limit allows. */
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

    /** The chunks typed into any pane since `before`, once there are at least `n`. */
    const typedSince = async (before: number, n = 1) => {
      await until(async () => sink.typed.length >= before + n, 30_000, `${n} typed chunk(s)`);
      return sink.typed.slice(before);
    };

    /** Pushes the question to the relay and waits until the relay holds it open, so its deadline is the relay's. */
    const published = async (id: string) => {
      await bridge.pump();
      await until(
        async () => (await relayClient.getQuestion(id)).status === 'open',
        30_000,
        `${id} open on the relay`,
      );
    };

    /** Asks for advice from pane A with the fixture's choices and plan, due in fifteen minutes. */
    const askAdvice = async (question: string) => {
      // A pump reads again which of the person's devices can show a plan, when its last read is out of date: a move
      // of the clock ages it like any other wait.
      await bridge.pump();
      const asked = await call(paneA, 'ask_human', {
        question,
        kind: ADVICE.kind,
        options: ADVICE.options,
        planned_fallback: ADVICE.planned_fallback,
        expires_in: WINDOW,
      });
      expect(asked.isError, JSON.stringify(asked.structuredContent)).toBeFalsy();
      expect(asked.structuredContent).toMatchObject({
        enforced_requirement: 'human-required',
        reply_mode: 'advisory',
        planned_fallback: ADVICE.planned_fallback,
      });
      const id = String(asked.structuredContent!.question_id);
      const expiresAt = String(asked.structuredContent!.expires_at);
      // The window is worked out on the system's clock, wherever it has been moved to.
      expect(Date.parse(expiresAt) - clock.now()).toBeGreaterThan(14 * MINUTE);
      await published(id);
      return { id, expiresAt };
    };

    /** Moves the clock to `ms` past the question's deadline. */
    const pastDeadline = (expiresAt: string, ms = 30_000) =>
      clock.advance(Math.max(0, Math.ceil(Date.parse(expiresAt) - clock.now())) + ms);

    it('a timely answer to an advisory question reaches the asking pane as the person’s answer', async () => {
      const before = sink.typed.length;
      const question = 'Which fixture should the importer tests use?';
      const { id, expiresAt } = await askAdvice(question);
      await openFromInbox(page, relay.origin, question);
      await page.getByRole('note', { name: 'Your agent’s plan' }).waitFor({ timeout: 20_000 });

      // Most of the window passes before the person answers, and the plan they leave aside is not the one they pick.
      await clock.advance(10 * MINUTE);
      await page
        .getByRole('radio', { name: /A SQLite file per test/ })
        .first()
        .check();
      await page.getByRole('button', { name: /^Send (decision|answer)$/ }).click();

      const typed = await typedSince(before);
      expect(typed.map((t) => t.pane)).toEqual(['pane-a']);
      expect(typed[0]!.text).toContain(`question_id: ${id}`);
      expect(typed[0]!.text).toContain('source: human');
      expect(typed[0]!.text).toContain('choice: sqlite');
      expect(typed[0]!.text).toContain('choice_label: A SQLite file per test');
      expect(typed[0]!.text).not.toContain('advisory-unanswered');

      const answered = await decisionWhen(
        paneA,
        id,
        (r) => r.status === 'human-answered' && r.delivery_status === 'terminal-delivered',
        'the answer recorded as delivered',
      );
      expect(answered).toMatchObject({
        question_id: id,
        provenance: 'human',
        answered_on: 'phone',
        choice: 'sqlite',
        closed_reason: null,
        fallback_due: false,
        advisory_timeout: null,
        reply_mode: 'advisory',
        expires_at: expiresAt,
        planned_fallback: ADVICE.planned_fallback,
      });

      // Its deadline passing changes nothing: the answer stands, and nothing more is typed.
      await pastDeadline(expiresAt);
      await settle();
      expect(sink.typed.slice(before)).toHaveLength(1);
      expect(await decision(paneA, id)).toMatchObject({
        status: 'human-answered',
        choice: 'sqlite',
        fallback_due: false,
        advisory_timeout: null,
      });
      expect((await relayClient.getQuestion(id)).status).toBe('human-answered');
    });

    it('an ignored advisory question: the phone shows its deadline and plan, then that it closed; the agent hears its plan is due', async () => {
      const before = sink.typed.length;
      // Not the fixture's own question, so the notice below is checked against every value this run substituted.
      const question = 'Which fixture should the parser tests use?';
      const { id, expiresAt } = await askAdvice(question);
      expect(replyModeOf((await relayClient.getQuestion(id)).question.envelope)).toBe('advisory');
      await openFromInbox(page, relay.origin, question);

      // Before the deadline: when it is, how long is left, and what the agent will do without an answer.
      const due = page.locator('.msg-meta .due');
      await due.waitFor({ timeout: 20_000 });
      expect(await due.innerText()).toContain('Reply by');
      expect(await due.locator('time').getAttribute('datetime')).toBe(expiresAt);
      const plan = page.getByRole('note', { name: 'Your agent’s plan' });
      expect(await plan.innerText()).toContain('if no answer reaches your relay by');
      expect(await plan.innerText()).toContain(ADVICE.planned_fallback);
      expect(await plan.locator('time').getAttribute('datetime')).toBe(expiresAt);

      // The phone's clock moves with the others: five minutes on, five fewer are left.
      const minutesLeft = async () =>
        Number(/(\d+) minutes? left/.exec(await due.innerText())?.[1] ?? Number.NaN);
      const leftBefore = await minutesLeft();
      expect(leftBefore).toBeGreaterThanOrEqual(13);
      await clock.advance(5 * MINUTE);
      // Five fewer, or six when a real second carried it over the minute.
      const leftAfter = await until(
        async () => {
          const n = await minutesLeft();
          return n <= leftBefore - 5 ? n : null;
        },
        20_000,
        'the time left to count down by five minutes',
      );
      expect(leftBefore - leftAfter).toBeLessThanOrEqual(6);

      // Nobody answers. Once the deadline passes, the phone shows the relay closed the question, plan and all.
      await pastDeadline(expiresAt);
      await page.getByText('No answer by the deadline').first().waitFor({ timeout: 30_000 });
      await page
        .getByText(
          'Your relay confirmed it, so your agent may now go ahead with its plan. This phone can’t see whether your agent has been told yet, or what it did.',
        )
        .first()
        .waitFor();
      expect(await due.count()).toBe(0);
      expect(await plan.innerText()).toContain(ADVICE.planned_fallback);
      expect(await page.getByRole('button', { name: /^Send (decision|answer)$/ }).count()).toBe(0);

      // The asking pane gets the notice once, byte for byte the frozen one, and get_decision says the plan is due.
      await settle();
      const typed = await typedSince(before);
      const view = await decisionWhen(
        paneA,
        id,
        (r) =>
          r.delivery_status === 'terminal-delivered' &&
          (r.advisory_timeout as { notice?: string } | null)?.notice === 'delivered',
        'the notice recorded as delivered',
      );
      expect(sink.typed.slice(before)).toHaveLength(1);
      expect(typed.map((t) => t.pane)).toEqual(['pane-a']);
      const notice = ADVISORY_TIMEOUT_NOTICE_FIXTURE;
      const injectionId = typed[0]!.injectionId;
      // Each of the fixture's values stands in exactly one place, so none can be left behind unreplaced.
      const swap = (text: string, from: string, to: string) => {
        expect(text.split(from)).toHaveLength(2);
        return text.replace(from, () => to);
      };
      let expected: string = notice.due;
      expected = swap(
        expected,
        `question_id: ${notice.questionId} (q-${notice.alias})`,
        `question_id: ${id} (q-${String(view.alias)})`,
      );
      expected = swap(
        expected,
        `injection_id: ${notice.injectionId}`,
        `injection_id: ${injectionId}`,
      );
      expected = swap(expected, `question: ${notice.question}`, `question: ${question}`);
      expected = swap(expected, `deadline: ${notice.deadline}`, `deadline: ${expiresAt}`);
      expect(typed[0]!.text).toBe(expected);

      const fixture = ADVISORY_TIMEOUT_DECISION_FIXTURE;
      expect(view).toMatchObject({
        ...fixture,
        question_id: id,
        expires_at: expiresAt,
        advisory_timeout: {
          ...fixture.advisory_timeout,
          deadline: expiresAt,
          injection_id: injectionId,
        },
      });
      expect((await relayClient.getQuestion(id)).status).toBe('expired');
    });

    it('a declined advisory question reports declined, not a timeout, even once its deadline passes', async () => {
      const before = sink.typed.length;
      const question = 'Which fixture should the exporter tests use?';
      const { id, expiresAt } = await askAdvice(question);
      await openFromInbox(page, relay.origin, question);
      await page.locator('.ws-head').getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Dismiss question…' }).click();
      await page.getByRole('button', { name: 'Dismiss question' }).click();
      await page
        .getByRole('dialog', { name: 'Dismiss this question?' })
        .waitFor({ state: 'hidden', timeout: 30_000 });
      await page.getByText('Declined by you').first().waitFor({ timeout: 30_000 });

      await until(
        async () => (await relayClient.getQuestion(id)).status === 'cancelled',
        30_000,
        'declined on the relay',
      );
      await typedSince(before);
      const declined = await decisionWhen(
        paneA,
        id,
        (r) => r.status === 'cancelled' && r.delivery_status === 'terminal-delivered',
        'the decline delivered',
      );
      const expectDeclined = (r: Record<string, unknown>) =>
        expect(r).toMatchObject({
          status: 'cancelled',
          closed_reason: 'declined',
          provenance: null,
          choice: null,
          text: '',
          answers: [],
          fallback_due: false,
          advisory_timeout: null,
          reply_mode: 'advisory',
        });
      expectDeclined(declined);
      const typed = sink.typed.slice(before);
      expect(typed.map((t) => t.pane)).toEqual(['pane-a']);
      expect(typed[0]!.text).toContain(`question_id: ${id}`);
      expect(typed[0]!.text).toContain('source: human');
      expect(typed[0]!.text).toContain('status: declined');
      expect(typed[0]!.text).toContain('authorised: no');
      expect(typed[0]!.text).not.toContain('advisory-unanswered');
      expect(typed[0]!.text).not.toContain('disposition:');

      // The deadline it was dismissed before never makes its plan due.
      await pastDeadline(expiresAt);
      await settle();
      expect(sink.typed.slice(before)).toHaveLength(1);
      expectDeclined(await decision(paneA, id));
      expect((await relayClient.getQuestion(id)).status).toBe('cancelled');
    });

    it('a required approval that expires stays unsatisfied and is never fallback_due', async () => {
      const before = sink.typed.length;
      await bridge.pump();
      // Pane C's agent runs the design-review step: the host's gate applies whether or not the agent names it.
      const asked = await call(paneC, 'ask_human', {
        question: APPROVAL.question,
        kind: APPROVAL.kind,
        options: APPROVAL.options,
        expires_in: WINDOW,
      });
      expect(asked.isError, JSON.stringify(asked.structuredContent)).toBeFalsy();
      expect(asked.structuredContent).toMatchObject({
        enforced_requirement: 'human-required',
        reply_mode: 'blocking',
        planned_fallback: null,
      });
      const id = String(asked.structuredContent!.question_id);
      const expiresAt = String(asked.structuredContent!.expires_at);
      // Every view the agent could read on the way, each of which must say no plan is due.
      const views: Record<string, unknown>[] = [];
      const view = async () => {
        const r = await decision(paneC, id);
        views.push(r);
        return r;
      };
      await published(id);
      // What the relay holds is what the host signed: a decision only a person makes, under the gate's policy.
      const signed = (await relayClient.getQuestion(id)).question;
      expect(signed.record).toMatchObject({ requirement: 'human-required', policy_version: 1 });
      expect(signed.record.workflow_gate_id_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(replyModeOf(signed.envelope)).toBe('blocking');
      expect(await view()).toMatchObject({ status: 'open', workflow_gate_id: GATE });

      await openFromInbox(page, relay.origin, APPROVAL.question);
      await page.getByText('Human decision required').first().waitFor({ timeout: 20_000 });
      await page
        .getByText('If no one decides by then, nothing is approved and the step stays blocked.')
        .first()
        .waitFor();
      expect(await page.getByRole('note', { name: 'Your agent’s plan' }).count()).toBe(0);

      await pastDeadline(expiresAt);
      await view();
      await page.getByText('Expired without an answer').first().waitFor({ timeout: 30_000 });
      await page.getByText('Nothing was approved, and the step stays blocked.').first().waitFor();

      await settle();
      const typed = await typedSince(before);
      const expired = await until(
        async () => {
          const r = await view();
          return r.status === 'expired' && r.delivery_status === 'terminal-delivered' ? r : null;
        },
        30_000,
        'the expiry delivered',
        POLL_MS,
      );
      expect(views.map((v) => v.fallback_due)).toEqual(views.map(() => false));
      expect(expired).toMatchObject({
        closed_reason: 'expired',
        requirement: 'human-required',
        workflow_gate_id: GATE,
        reply_mode: 'blocking',
        planned_fallback: null,
        advisory_timeout: null,
        provenance: null,
        choice: null,
        answers: [],
      });
      expect(sink.typed.slice(before)).toHaveLength(1);
      expect(typed.map((t) => t.pane)).toEqual(['pane-c']);
      expect(typed[0]!.text).toContain(`question_id: ${id}`);
      expect(typed[0]!.text).toContain('source: system');
      expect(typed[0]!.text).toContain('status: expired');
      expect(typed[0]!.text).toContain('authorised: no');
      expect(typed[0]!.text).toContain(
        'note: The question expired without an answer. You are NOT authorised to continue the gated step; re-ask or stop and report.',
      );
      expect(typed[0]!.text).not.toContain('advisory-unanswered');
      expect(typed[0]!.text).not.toContain('disposition:');
      expect((await relayClient.getQuestion(id)).status).toBe('expired');
    });

    it('the relay closes questions at their deadlines by its own alarm, with nobody reading them', async () => {
      // Every relay read and write first expires what is overdue, so the outcomes above would hold even if the moved
      // relay never fired an alarm. Here nothing reads: the phone leaves the relay, the bridge only listens on its
      // socket, and nobody settles. The first deadline passes with the move (the alarm the move runs), and its notice
      // arrives while the second is still ahead; the second passes seconds later in real time (the runtime's own
      // alarm, set on the moved clock).
      const before = sink.typed.length;
      await bridge.pump();
      const ask = async (question: string, window: string) => {
        const asked = await call(paneB, 'ask_human', {
          question,
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
          expires_in: window,
        });
        expect(asked.isError, JSON.stringify(asked.structuredContent)).toBeFalsy();
        return {
          id: String(asked.structuredContent!.question_id),
          expiresAt: String(asked.structuredContent!.expires_at),
        };
      };
      const first = await ask('Keep the old importer behind a flag?', WINDOW);
      const second = await ask('Log the importer’s timings?', '905s');
      await published(first.id);
      await published(second.id);
      await page.goto('about:blank');
      const typedFor = (id: string) =>
        sink.typed.slice(before).filter((t) => t.text.includes(`question_id: ${id}`));

      await clock.advance(Math.ceil(Date.parse(first.expiresAt) - clock.now()) + 1_000);
      const secondDue = Date.parse(second.expiresAt);
      expect(secondDue - clock.now()).toBeGreaterThan(2_000);
      await until(async () => typedFor(first.id).length > 0, 30_000, 'the first expiry pushed');
      expect(clock.now()).toBeLessThan(secondDue);
      await until(async () => typedFor(second.id).length > 0, 30_000, 'the second expiry pushed');

      expect(sink.typed.slice(before).map((t) => t.pane)).toEqual(['pane-b', 'pane-b']);
      for (const q of [first, second]) {
        const [typed] = typedFor(q.id);
        expect(typed!.text).toContain('status: expired');
        expect(typed!.text).toContain('authorised: no');
        expect((await relayClient.getQuestion(q.id)).status).toBe('expired');
      }
      expect(problems).toEqual([]);
    });
  },
);
