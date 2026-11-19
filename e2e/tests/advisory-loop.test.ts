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
/** A design sign-off the host registered: its questions wait for a decision and are never advisory. */
const GATE = 'design-review/final';
const MINUTE = 60_000;
const WINDOW = '15m';

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
      mcp = await startDecisionsMcpServer({
        bridge,
        authenticator: auth,
        path: MOUNT,
        now: clock.now,
      });
      paneA = await connect(mcp.url, TOKEN_A);
      paneB = await connect(mcp.url, TOKEN_B);
    }, 120_000);

    afterAll(async () => {
      // every step runs even if an earlier one rejects, so Chromium and wrangler always stop
      for (const step of [
        () => paneA?.close(),
        () => paneB?.close(),
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

      await until(async () => sink.typed.length > before, 30_000, 'the answer to be typed');
      const typed = sink.typed.slice(before);
      expect(typed.map((t) => t.pane)).toEqual(['pane-a']);
      expect(typed[0]!.text).toContain(`question_id: ${id}`);
      expect(typed[0]!.text).toContain('source: human');
      expect(typed[0]!.text).toContain('choice: sqlite');
      expect(typed[0]!.text).not.toContain('advisory-unanswered');

      const answered = await until(
        async () => {
          const r = await decision(paneA, id);
          return r.status === 'human-answered' && r.delivery_status === 'terminal-delivered'
            ? r
            : null;
        },
        30_000,
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
      const { id, expiresAt } = await askAdvice(ADVICE.question);
      await openFromInbox(page, relay.origin, ADVICE.question);

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
      const leftAfter = await until(
        async () => {
          const n = await minutesLeft();
          return n < leftBefore ? n : null;
        },
        20_000,
        'the time left to count down',
      );
      expect(leftBefore - leftAfter).toBeGreaterThanOrEqual(5);
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
      const view = await until(
        async () => {
          const r = await decision(paneA, id);
          const timeout = r.advisory_timeout as { notice?: string } | null;
          return r.delivery_status === 'terminal-delivered' && timeout?.notice === 'delivered'
            ? r
            : null;
        },
        30_000,
        'the notice recorded as delivered',
      );
      const typed = sink.typed.slice(before);
      expect(typed.map((t) => t.pane)).toEqual(['pane-a']);
      const notice = ADVISORY_TIMEOUT_NOTICE_FIXTURE;
      const injectionId = typed[0]!.injectionId;
      const expected = notice.due
        .replace(
          `question_id: ${notice.questionId} (q-${notice.alias})`,
          () => `question_id: ${id} (q-${String(view.alias)})`,
        )
        .replace(`injection_id: ${notice.injectionId}`, () => `injection_id: ${injectionId}`)
        .replace(`question: ${notice.question}`, () => `question: ${ADVICE.question}`)
        .replace(`deadline: ${notice.deadline}`, () => `deadline: ${expiresAt}`);
      expect(typed[0]!.text).toBe(expected);

      const fixture = ADVISORY_TIMEOUT_DECISION_FIXTURE;
      expect(view).toMatchObject({
        ...fixture,
        question_id: id,
        expires_at: expiresAt,
        advisory_timeout: { ...fixture.advisory_timeout, deadline: expiresAt, injection_id: injectionId },
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
      const declined = await until(
        async () => {
          const r = await decision(paneA, id);
          return r.status === 'cancelled' && r.delivery_status === 'terminal-delivered' ? r : null;
        },
        30_000,
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
      const asked = await call(paneB, 'ask_human', {
        question: APPROVAL.question,
        kind: APPROVAL.kind,
        options: APPROVAL.options,
        workflow_gate_id: GATE,
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
      await published(id);

      await openFromInbox(page, relay.origin, APPROVAL.question);
      await page
        .getByText('If no one decides by then, nothing is approved and the step stays blocked.')
        .first()
        .waitFor({ timeout: 20_000 });
      expect(await page.getByRole('note', { name: 'Your agent’s plan' }).count()).toBe(0);

      await pastDeadline(expiresAt);
      await page.getByText('Expired without an answer').first().waitFor({ timeout: 30_000 });
      await page.getByText('Nothing was approved, and the step stays blocked.').first().waitFor();

      await settle();
      const expired = await until(
        async () => {
          const r = await decision(paneB, id);
          return r.status === 'expired' && r.delivery_status === 'terminal-delivered' ? r : null;
        },
        30_000,
        'the expiry delivered',
      );
      expect(expired).toMatchObject({
        closed_reason: 'expired',
        requirement: 'human-required',
        workflow_gate_id: GATE,
        reply_mode: 'blocking',
        planned_fallback: null,
        fallback_due: false,
        advisory_timeout: null,
        provenance: null,
        choice: null,
        answers: [],
      });
      const typed = sink.typed.slice(before);
      expect(typed.map((t) => t.pane)).toEqual(['pane-b']);
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
      // relay never fired an alarm. Here nothing reads: the phone waits on Home, the bridge only listens on its
      // socket, and nobody settles. The first deadline passes with the move (the alarm the move runs); the second
      // passes seconds later in real time (the runtime's own alarm, set on the moved clock).
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
      const second = await ask('Log the importer’s timings?', '903s');
      await published(first.id);
      await published(second.id);
      await page.goto(`${relay.origin}/`);

      await clock.advance(Math.ceil(Date.parse(first.expiresAt) - clock.now()) + 1_000);
      expect(Date.parse(second.expiresAt)).toBeGreaterThan(clock.now());
      await until(
        async () => sink.typed.length >= before + 2,
        30_000,
        'both expiries pushed to the bridge',
      );
      const typed = sink.typed.slice(before);
      expect(typed.map((t) => t.pane)).toEqual(['pane-b', 'pane-b']);
      for (const [i, q] of [first, second].entries()) {
        expect(typed[i]!.text).toContain(`question_id: ${q.id}`);
        expect(typed[i]!.text).toContain('status: expired');
        expect(typed[i]!.text).toContain('authorised: no');
        expect((await relayClient.getQuestion(q.id)).status).toBe('expired');
      }
      expect(problems).toEqual([]);
    });
  },
);
