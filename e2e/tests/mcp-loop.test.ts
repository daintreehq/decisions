import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  DecisionsBridge,
  FileKeyStore,
  MemoryLocalStore,
  RelayClient,
  TokenMapAuthenticator,
  approveCandidate,
  claimRelay,
  createPairingInvite,
  localShortCode,
  startDecisionsMcpServer,
  type LocateResult,
  type QuestionOrigin,
  type RunningMcp,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

const PORT = 8797;
const MOUNT = '/mcp/decisions';
const TOKEN_A = 'pane-a-bearer-0123456789abcdefABCDEF';
const TOKEN_B = 'pane-b-bearer-0123456789abcdefABCDEF';

const origin = (pane: string): QuestionOrigin =>
  ({
    host_id: 'host_mcp0001',
    pane_id: pane,
    terminal_generation: 1,
    ownership_principal: `principal-${pane}`,
    agent_incarnation: `inc-${pane}`,
    agent_kind: 'claude-code',
    agent_session_id: `sess-${pane}`,
    project_id: 'proj',
    worktree_id: 'wt',
    worktree_root: '/tmp/mcp-e2e',
    workflow_gate_id: null,
  }) as QuestionOrigin;

/** One terminal per pane, recording what Daintree would type into each. */
class PaneSink implements TerminalSink {
  typed: { pane: string; text: string }[] = [];
  async locate(o: QuestionOrigin): Promise<LocateResult> {
    return {
      state: 'alive',
      target: {
        hostId: o.host_id,
        paneId: o.pane_id,
        terminalGeneration: o.terminal_generation,
        ownershipPrincipal: o.ownership_principal,
        agentIncarnation: o.agent_incarnation,
        agentSessionId: o.agent_session_id,
        worktreeId: o.worktree_id,
      },
    };
  }
  async isIdle() {
    return true;
  }
  async inject(t: TerminalTarget, text: string) {
    this.typed.push({ pane: t.paneId, text });
    return { outcome: 'delivered' as const, proof: 'e2e' };
  }
  async hasMarker(t: TerminalTarget, id: string) {
    return this.typed.some((x) => x.pane === t.paneId && x.text.includes(`injection_id: ${id}`));
  }
  async resume() {
    return null;
  }
}

type ToolResult = {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'decisions-e2e-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

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
      });
      await bridge.start();

      // Mounted the way Daintree mounts it: its own route, panes resolved from the bearer alone.
      const auth = new TokenMapAuthenticator();
      auth.register(TOKEN_A, origin('pane-a'));
      auth.register(TOKEN_B, origin('pane-b'));
      mcp = await startDecisionsMcpServer({ bridge, authenticator: auth, path: MOUNT });
      paneA = await connect(mcp.url, TOKEN_A);
      paneB = await connect(mcp.url, TOKEN_B);

      const invite = await createPairingInvite(relayClient, 'phone');
      await page.goto(invite.url);
      await page.getByRole('button', { name: 'Pair this phone' }).click();
      await page.getByText('Confirm this code on your computer').waitFor({ timeout: 20_000 });
      const shown = (await page.locator('.big-code').innerText()).trim();
      const cand = await until(
        async () =>
          (await relayClient.pendingPairings()).pending.find(
            (p) => p.pairing_id === invite.pairingId,
          ),
        20_000,
        'pending pairing',
      );
      expect(await localShortCode(cand)).toBe(shown);
      await approveCandidate(relayClient, cand);
      await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
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

    const call = async (c: Client, name: string, args: Record<string, unknown>) =>
      (await c.callTool({ name, arguments: args })) as ToolResult;

    /** Opens a question from the inbox, as a person would the first time. */
    const openFromInbox = async (text: string) => {
      await page.goto(`${relay.origin}/`);
      await page.getByText(text).first().waitFor({ timeout: 30_000 });
      await page.getByText(text).first().click();
    };

    it('negotiates with the SDK client and lists the three tools with their annotations', async () => {
      expect(paneA.getServerVersion()?.name).toBe('daintree-decisions');
      expect(paneA.getInstructions()).toMatch(/ask_human/);
      const { tools } = await paneA.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(Object.keys(byName)).toEqual(['ask_human', 'get_decision', 'cancel_question']);
      expect(byName.get_decision!.annotations?.readOnlyHint).toBe(true);
      expect(byName.ask_human!.annotations).toMatchObject({
        destructiveHint: false,
        openWorldHint: false,
      });
    });

    let qid = '';

    it('ask_human returns at once; the phone answers; the answer is typed into the asking pane only', async () => {
      const asked = await call(paneA, 'ask_human', {
        question: 'Use optimistic updates for the todo list?',
        context: 'The list re-renders on every keystroke today.',
        options: [
          { id: 'yes', label: 'Yes, optimistic' },
          { id: 'no', label: 'No, wait for the server' },
        ],
        correlation_id: 'todo-optimistic',
      });
      expect(asked.isError).toBeFalsy();
      qid = String(asked.structuredContent!.question_id);
      expect(asked.structuredContent).toMatchObject({ enforced_requirement: 'human-required' });
      expect(asked.content[0]!.text).toMatch(/^Asked as q-\d+\. End your turn now/);

      // the same correlation id from the same pane is the same question, not a second one
      const again = await call(paneA, 'ask_human', {
        question: 'Use optimistic updates for the todo list?',
        options: [
          { id: 'yes', label: 'Yes, optimistic' },
          { id: 'no', label: 'No, wait for the server' },
        ],
        correlation_id: 'todo-optimistic',
      });
      expect(again.structuredContent!.question_id).toBe(qid);
      await bridge.pump();

      const before = await call(paneA, 'get_decision', { question_id: qid });
      expect(before.structuredContent).toMatchObject({ status: 'open', provenance: null });

      await openFromInbox('Use optimistic updates for the todo list?');
      await page.getByRole('radio', { name: /Yes, optimistic/ }).check();
      await page.getByRole('button', { name: /Submit/ }).click();

      await until(async () => sink.typed.length > 0, 30_000, 'the answer to be typed');
      expect(sink.typed.map((t) => t.pane)).toEqual(['pane-a']);
      expect(sink.typed[0]!.text).toContain('choice: yes');
      expect(sink.typed[0]!.text).toContain('source: human');
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

    it("a correction on the phone reaches the agent with the human's reason", async () => {
      const typedBefore = sink.typed.length;
      // answered questions leave the inbox; open it where History links to it
      await page.goto(`${relay.origin}/q/${qid}`);
      await page.getByText('Change this answer').click();
      await page.getByRole('radio', { name: /No, wait for the server/ }).check();
      await page
        .getByLabel(/Why are you changing it/)
        .fill('Conflicts are too common on shared lists');
      await page.getByRole('button', { name: 'Send correction' }).first().click();
      await page.getByRole('dialog').getByRole('button', { name: 'Send correction' }).click();

      await until(async () => sink.typed.length > typedBefore, 30_000, 'the correction');
      const typed = sink.typed.at(-1)!;
      expect(typed.pane).toBe('pane-a');
      expect(typed.text).toContain('CORRECTS an earlier answer');
      expect(typed.text).toContain('choice: no');
      expect(typed.text).toContain('reason: Conflicts are too common on shared lists');

      const view = await call(paneA, 'get_decision', { question_id: qid });
      expect(view.structuredContent).toMatchObject({ choice: 'no', revision: 2 });
      const answers = view.structuredContent!.answers as { reason: string; correction: boolean }[];
      expect(answers.at(-1)).toMatchObject({
        correction: true,
        reason: 'Conflicts are too common on shared lists',
      });
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
      await page.getByText('Your agent withdrew this question').waitFor({ timeout: 20_000 });
      // a withdrawn question is never typed into anyone's terminal, even once the desktop has caught up
      await bridge.catchUp();
      await bridge.delivery.drain();
      expect(sink.typed.some((t) => t.text.includes(id))).toBe(false);
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

      await openFromInbox('Show completed todos by default?');
      await page.getByRole('radio', { name: /Hide them/ }).check();
      await page.getByRole('button', { name: /Submit/ }).click();

      await until(async () => sink.typed.length > typedBefore, 30_000, "pane B's answer");
      const typed = sink.typed.slice(typedBefore);
      expect(typed.map((t) => t.pane)).toEqual(['pane-b']);
      expect(typed[0]!.text).toContain(id);
      expect(typed[0]!.text).toContain('choice: hide');
      // and pane A still sees only its own question
      expect((await call(paneA, 'get_decision', { question_id: id })).isError).toBe(true);
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
