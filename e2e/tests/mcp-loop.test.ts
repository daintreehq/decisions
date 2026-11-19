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
  RelayClient,
  TokenMapAuthenticator,
  claimRelay,
  startDecisionsMcpServer,
  type RunningMcp,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';
import { PaneSink, callTool, connect, openFromInbox, pairPhone, paneOrigin } from './mcp-agent.js';

const PORT = 8797;
const MOUNT = '/mcp/decisions';
const TOKEN_A = 'pane-a-bearer-0123456789abcdefABCDEF';
const TOKEN_B = 'pane-b-bearer-0123456789abcdefABCDEF';

const chromiumPath = findChromium();

describe.skipIf(!chromiumPath)(
  'agent → MCP (official SDK client) → real Worker → PWA in Chromium → back into the right pane',
  () => {
    let relay: RunningRelay;
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
      relay = await startRelay(PORT);
      browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'allow',
      });
      page = await context.newPage();
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

      keyDir = mkdtempSync(join(tmpdir(), 'decisions-mcp-e2e-'));
      const store = new FileKeyStore(keyDir);
      const { identity } = await claimRelay({
        origin: relay.origin,
        claimSecret: CLAIM_SECRET,
        label: 'MCP E2E Mac',
        store,
      });
      relayClient = new RelayClient({ identity });
      bridge = new DecisionsBridge({
        identity,
        store: new MemoryLocalStore(),
        sink,
        client: relayClient,
        pumpIntervalMs: 0,
        followUps: true,
      });
      await bridge.start();

      // Mounted the way Daintree mounts it: its own route, panes resolved from the bearer alone.
      const auth = new TokenMapAuthenticator();
      auth.register(TOKEN_A, paneOrigin('pane-a'));
      auth.register(TOKEN_B, paneOrigin('pane-b'));
      mcp = await startDecisionsMcpServer({ bridge, authenticator: auth, path: MOUNT });
      paneA = await connect(mcp.url, TOKEN_A);
      paneB = await connect(mcp.url, TOKEN_B);

      await pairPhone(page, relayClient);
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

    const call = callTool;

    it('negotiates with the SDK client and lists the five tools with their annotations', async () => {
      expect(paneA.getServerVersion()?.name).toBe('daintree-decisions');
      expect(paneA.getInstructions()).toMatch(/ask_human/);
      expect(paneA.getInstructions()).toMatch(/send_followup/);
      const { tools } = await paneA.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(Object.keys(byName)).toEqual([
        'ask_human',
        'get_decision',
        'cancel_question',
        'send_followup',
        'get_involvement',
      ]);
      expect(byName.get_decision!.annotations?.readOnlyHint).toBe(true);
      expect(byName.get_involvement!.annotations?.readOnlyHint).toBe(true);
      expect(paneA.getInstructions()).toMatch(/get_involvement/);
      for (const name of ['ask_human', 'send_followup']) {
        expect(byName[name]!.annotations).toMatchObject({
          destructiveHint: false,
          openWorldHint: false,
        });
      }
    });

    let qid = '';

    it('ask_human returns at once; the phone answers; the answer is typed into the asking pane only', async () => {
      const request = {
        question: 'Use optimistic updates for the todo list?',
        context: 'The list re-renders on every keystroke today.',
        options: [
          { id: 'yes', label: 'Yes, optimistic' },
          { id: 'no', label: 'No, wait for the server' },
        ],
        correlation_id: 'todo-optimistic',
      };
      const asked = await call(paneA, 'ask_human', request);
      expect(asked.isError).toBeFalsy();
      qid = String(asked.structuredContent!.question_id);
      expect(asked.structuredContent).toMatchObject({ enforced_requirement: 'human-required' });
      expect(asked.content[0]!.text).toMatch(
        /^Asked as q-\d+\. Carry on with anything that does not depend on the answer/,
      );

      // the same request under the same correlation id from the same pane is the same question, not a second one
      const again = await call(paneA, 'ask_human', request);
      expect(again.structuredContent!.question_id).toBe(qid);
      expect(again.structuredContent).toMatchObject({ duplicate: true });
      await bridge.pump();

      const before = await call(paneA, 'get_decision', { question_id: qid });
      expect(before.structuredContent).toMatchObject({ status: 'open', provenance: null });

      await openFromInbox(page, relay.origin, 'Use optimistic updates for the todo list?');
      await page
        .getByRole('radio', { name: /Yes, optimistic/ })
        .first()
        .check();
      await page.getByRole('button', { name: /^Send (decision|answer)$/ }).click();

      await until(async () => sink.typed.length > 0, 30_000, 'the answer to be typed');
      expect(sink.typed.map((t) => t.pane)).toEqual(['pane-a']);
      expect(sink.typed[0]!.text).toContain('choice: yes');
      expect(sink.typed[0]!.text).toContain('source: human');
      expect(sink.typed[0]!.text).toContain('question: Use optimistic updates for the todo list?');
    });

    it('get_decision passes the SDK’s outputSchema validation and only the asking pane can read it', async () => {
      const mine = await until(
        async () => {
          const r = await call(paneA, 'get_decision', { question_id: qid });
          return r.structuredContent?.status === 'human-answered' ? r : null;
        },
        30_000,
        'human-answered',
      );
      expect(mine.structuredContent).toMatchObject({
        question_id: qid,
        provenance: 'human',
        choice: 'yes',
        reviewed_digests_match: false,
      });

      const theirs = await call(paneB, 'get_decision', { question_id: qid });
      expect(theirs.isError).toBe(true);
      expect(theirs.structuredContent).toEqual({ error: 'not_found' });
      const cancel = await call(paneB, 'cancel_question', { question_id: qid });
      expect(cancel.isError).toBe(true);
    });

    it('a follow-up on the phone reaches the agent as a follow-up, and the answer stays in force', async () => {
      const typedBefore = sink.typed.length;
      // answered questions leave the inbox; open it where History links to it
      await page.goto(`${relay.origin}/q/${qid}`);
      // An answer is final: there is no Change answer, and the composer takes a follow-up instead.
      await page.locator('.ws-head').getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'View activity' }).waitFor();
      expect(await page.getByRole('menuitem', { name: /Change answer/ }).count()).toBe(0);
      await page.keyboard.press('Escape');
      await page
        .locator('.dock')
        .getByRole('textbox', { name: 'Follow-up' })
        .fill('Keep a server round-trip for deletes.');
      await page.locator('.dock').getByRole('button', { name: 'Send follow-up' }).click();

      await until(async () => sink.typed.length > typedBefore, 30_000, 'the follow-up');
      const typed = sink.typed.at(-1)!;
      expect(typed.pane).toBe('pane-a');
      expect(typed.text).toContain('FOLLOW-UP');
      expect(typed.text).toContain('Keep a server round-trip for deletes.');
      expect(typed.text).not.toContain('CORRECTS');

      const view = await call(paneA, 'get_decision', { question_id: qid });
      expect(view.structuredContent).toMatchObject({ choice: 'yes', revision: 1 });
    });

    it('cancel_question withdraws an open question, and the phone shows it as withdrawn', async () => {
      const asked = await call(paneB, 'ask_human', {
        question: 'Rename the Archive tab to Done?',
        kind: 'approval',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      });
      const id = String(asked.structuredContent!.question_id);
      await bridge.pump();
      await page.goto(`${relay.origin}/`);
      await page.getByText('Rename the Archive tab to Done?').first().waitFor({ timeout: 30_000 });

      const cancelled = await call(paneB, 'cancel_question', {
        question_id: id,
        reason: 'not needed',
      });
      expect(cancelled.isError).toBeFalsy();
      await until(
        async () =>
          (await call(paneB, 'get_decision', { question_id: id })).structuredContent?.status ===
          'cancelled',
        30_000,
        'cancelled locally',
      );
      await until(
        async () => (await relayClient.getQuestion(id)).status === 'cancelled',
        30_000,
        'cancelled on the relay',
      );
      await page.goto(`${relay.origin}/q/${id}`);
      await page
        .getByText(/^Withdrawn on /)
        .first()
        .waitFor({ timeout: 20_000 });
      // a withdrawn question is never typed into anyone's terminal, even once the desktop has caught up
      await bridge.catchUp();
      await bridge.delivery.drain();
      expect(sink.typed.some((t) => t.text.includes(id))).toBe(false);
    });

    it('the person dismisses an open question on the phone, and the agent hears it was declined', async () => {
      const typedBefore = sink.typed.length;
      const asked = await call(paneA, 'ask_human', {
        question: 'Bump the lint rules to the strict preset?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      });
      const id = String(asked.structuredContent!.question_id);
      await bridge.pump();
      await openFromInbox(page, relay.origin, 'Bump the lint rules to the strict preset?');
      // This bridge declares person-declines-v1, so the phone offers Dismiss.
      await page.locator('.ws-head').getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Dismiss question…' }).click();
      await page.getByRole('button', { name: 'Dismiss question' }).click();
      // The sheet closes once the decline is sent and synced, and the question reads as declined. Wait for both, as a
      // person would before moving on: the sheet's history entry is unwound asynchronously when it closes.
      await page
        .getByRole('dialog', { name: 'Dismiss this question?' })
        .waitFor({ state: 'hidden', timeout: 30_000 });
      await page.getByText('Declined by you').first().waitFor({ timeout: 30_000 });

      await until(
        async () => (await relayClient.getQuestion(id)).status === 'cancelled',
        30_000,
        'declined on the relay',
      );
      const view = await until(
        async () => {
          const r = await call(paneA, 'get_decision', { question_id: id });
          return r.structuredContent?.status === 'cancelled' ? r : null;
        },
        30_000,
        'declined locally',
      );
      expect(view.structuredContent).toMatchObject({ closed_reason: 'declined', provenance: null });
      await until(async () => sink.typed.length > typedBefore, 30_000, 'the decline notice');
      const notice = sink.typed.at(-1)!;
      expect(notice.pane).toBe('pane-a');
      expect(notice.text).toContain('status: declined');
      expect(notice.text).toContain('authorised: no');
    });

    it('keeps panes apart: the same correlation id is a new question, answered into that pane only', async () => {
      const typedBefore = sink.typed.length;
      const asked = await call(paneB, 'ask_human', {
        question: 'Show completed todos by default?',
        options: [
          { id: 'show', label: 'Show them' },
          { id: 'hide', label: 'Hide them' },
        ],
        correlation_id: 'todo-optimistic', // pane A used it too; it must not return A's question
      });
      const id = String(asked.structuredContent!.question_id);
      expect(id).not.toBe(qid);
      await bridge.pump();

      await openFromInbox(page, relay.origin, 'Show completed todos by default?');
      await page
        .getByRole('radio', { name: /Hide them/ })
        .first()
        .check();
      await page.getByRole('button', { name: /^Send (decision|answer)$/ }).click();

      await until(async () => sink.typed.length > typedBefore, 30_000, "pane B's answer");
      const typed = sink.typed.slice(typedBefore);
      expect(typed.map((t) => t.pane)).toEqual(['pane-b']);
      expect(typed[0]!.text).toContain(id);
      expect(typed[0]!.text).toContain('choice: hide');
      // and pane A still sees only its own question
      expect((await call(paneA, 'get_decision', { question_id: id })).isError).toBe(true);
    });

    it('the person changes their involvement on the phone, and the agent reads it in the same session', async () => {
      const read = async () => (await call(paneA, 'get_involvement', {})).structuredContent!;
      // Nobody has set one: the agent is told to use its normal behaviour.
      const before = await until(
        async () => {
          const r = await read();
          return r.reason === 'not-set' ? r : null;
        },
        30_000,
        'the relay to say nobody has set one',
      );
      expect(before).toMatchObject({ status: 'unavailable', mode: null });

      await page.goto(`${relay.origin}/settings/involvement`);
      await page.locator('input[type="radio"][value="recommend"]').first().check();
      await page.getByLabel('Agents to consult').selectOption('2');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Saved on your relay').first().waitFor({ timeout: 20_000 });

      // The relay's hint reaches the running bridge: no restart, no new session.
      const after = await until(
        async () => {
          const r = await read();
          return r.status === 'available' ? r : null;
        },
        30_000,
        'the new preference',
      );
      expect(after).toMatchObject({
        mode: 'recommend',
        normal_mode: 'recommend',
        consult_count: 2,
        revision: 1,
        override_active: false,
        until: null,
      });

      // The agent's account of its preparation reaches the phone, and changes nothing about who answers.
      const asked = await call(paneA, 'ask_human', {
        question: 'Ship the smaller migration first?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
        preparation: {
          preference_revision: 1,
          agents_consulted: 3,
          outcome: 'agreed',
          summary: 'All three prefer the smaller migration.',
        },
      });
      expect(asked.structuredContent).toMatchObject({ enforced_requirement: 'human-required' });
      await bridge.pump();
      await openFromInbox(page, relay.origin, 'Ship the smaller migration first?');
      await page.getByText('The agent’s account').first().waitFor({ timeout: 20_000 });
      await page.getByText('All three prefer the smaller migration.').first().waitFor();
    });

    it('rejects what an agent must not be able to do over MCP', async () => {
      const bad = await call(paneA, 'ask_human', {
        question: 'Already expired?',
        expires_at: '2020-01-01T00:00:00Z',
      });
      expect(bad.isError).toBe(true);
      expect(bad.structuredContent).toEqual({ error: 'validation_error' });

      // an unknown bearer is refused at the transport, before any tool runs
      await expect(connect(mcp.url, 'not-a-pane-token-0123456789abcdef')).rejects.toThrow();
      expect(problems).toEqual([]);
    });
  },
);
