import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import {
  DecisionsBridge,
  FileKeyStore,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  approveCandidate,
  claimRelay,
  createPairingInvite,
  paneIdentityOf,
  type LocateResult,
  type ProxyEngine,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Follow-ups, end to end: a real relay, the real desktop client with follow-ups on, and the PWA in Chromium. An
 * answer is final; what the person says after it is a follow-up message, typed into the asking pane as one and never
 * changing the answer in force. The agent's message that expects a reply brings the question back to Needs you, a
 * follow-up written offline waits on the phone and sends on reconnect, and a model answer can still be overruled.
 */
const chromiumPath = findChromium();
const PORT = 8855;

class RecordingSink implements TerminalSink {
  typed: string[] = [];
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
  async inject(_t: TerminalTarget, text: string, _id: string) {
    this.typed.push(text);
    return { outcome: 'delivered' as const, proof: 'e2e' };
  }
  async hasMarker() {
    return false;
  }
  async resume() {
    return null;
  }
}

/** Answers the changelog question, so there is a model answer to overrule. */
const proxy: ProxyEngine = {
  gateAware: true,
  async suggest(input) {
    if (!input.question.startsWith('Changelog section'))
      return { action: 'abstain', reason: 'low-confidence' };
    return {
      action: 'answer',
      selected_option_ids: ['fixed'],
      confidence: 0.7,
      model_id: 'e2e-model',
      prompt_template_version: '1',
      retrieval_reference_ids: [],
      rationale: 'It reads as a fix.',
      risk_flags: [],
    };
  },
};

describe.skipIf(!chromiumPath)('follow-ups after an answer', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  const sink = new RecordingSink();
  const ids: Record<string, string> = {};
  const origins: Record<string, QuestionOrigin> = {};
  const problems: string[] = [];

  const openId = async (key: string) => {
    await page.goto(`${relay.origin}/q/${ids[key]}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
  };
  const field = () => page.locator('.dock .composer-field textarea');
  const typedHas = (text: string) =>
    until(
      async () => sink.typed.find((t) => t.includes(text)),
      30_000,
      `“${text}” in the terminal`,
    );
  /** The receipt under the outgoing bubble that holds `text`. */
  const receiptOf = (text: string) =>
    page.locator('.ws .msg.out', { hasText: text }).locator('.receipt');
  const answer = async (key: string, option: RegExp, send: string) => {
    await openId(key);
    await page.getByRole('radio', { name: option }).first().check();
    await page.locator('.dock').getByRole('button', { name: send }).click();
    await page
      .locator('.ws .receipt')
      .filter({ hasText: 'Typed into the terminal' })
      .first()
      .waitFor({ timeout: 30_000 });
  };

  beforeAll(async () => {
    relay = await startRelay(PORT);
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block',
      locale: 'en-GB',
    });
    page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

    const home = mkdtempSync(join(tmpdir(), 'decisions-follow-ups-e2e-'));
    const keyStore = new FileKeyStore(home);
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'E2E Mac',
      store: keyStore,
    });
    client = new RelayClient({ identity });
    bridge = new DecisionsBridge({
      identity,
      keyStore,
      store: new MemoryLocalStore(),
      sink,
      client,
      proxy,
      followUps: true,
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
      pumpIntervalMs: 0,
      resolver: { resolve: async () => null },
    });
    await bridge.start();
    const invite = await createPairingInvite(client, 'phone');
    await page.goto(invite.url);
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByText('Check that this matches your computer').waitFor({ timeout: 20_000 });
    const cand = await until(
      async () =>
        (await client.pendingPairings()).pending.find((p) => p.pairing_id === invite.pairingId),
      20_000,
      'pending pairing',
    );
    await approveCandidate(client, cand);
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
    await page.getByText('No questions yet.').waitFor({ timeout: 30_000 });

    const origin = (pane: string): QuestionOrigin => ({
      machine_label: 'E2E Mac',
      host_id: 'host_e2e_follow_ups',
      pane_id: pane,
      terminal_generation: 1,
      ownership_principal: `principal-${pane}`,
      agent_incarnation: '1',
      agent_kind: 'claude-code',
      agent_session_id: `s-${pane}`,
      project_id: 'follow-ups',
      worktree_id: `wt-${pane}`,
      worktree_root: '/work/follow-ups',
      workflow_gate_id: null,
    });
    const ask = async (key: string, input: Record<string, unknown>, pane = key) => {
      origins[key] = origin(pane);
      ids[key] = (await bridge.registerQuestion({ origin: origins[key]!, input })).questionId;
    };
    const yesNo = [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
    // A phone that has only just paired can miss what is asked in its first moments, so ask a first question until
    // the phone shows it, and only then the rest.
    for (let attempt = 0; ; attempt++) {
      await ask(
        'thread',
        { question: 'Rename the Archive tab to Done?', kind: 'approval', options: yesNo },
        `thread-${attempt}`,
      );
      await bridge.pump();
      const seen = await until(
        async () => (await page.locator('main a.qrow').count()) > 0,
        10_000,
        'a first question',
      )
        .then(() => true)
        .catch(() => false);
      if (seen) break;
      if (attempt === 5) throw new Error('the phone never showed a question');
    }
    await ask('asking', {
      question: 'Use the shared retry helper in the webhook sender?',
      kind: 'approval',
      options: yesNo,
    });
    await ask('offline', {
      question: 'Turn on the new sync engine for beta users?',
      kind: 'approval',
      options: yesNo,
    });
    await ask('model', {
      question: 'Changelog section for the retry change: Fixed or Changed?',
      kind: 'choice',
      requested_requirement: 'proxy-ok',
      options: [
        { id: 'fixed', label: 'Fixed' },
        { id: 'changed', label: 'Changed' },
      ],
    });
    await bridge.pump();
    expect(await bridge.runProxy(ids.model!)).toBe('answered');
    await bridge.pump();
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
    expect(problems).toEqual([]);
  });

  it('answers, then sends a follow-up whose receipts advance, and the answer stays in force', async () => {
    await answer('thread', /^Yes/, 'Send decision');
    await page
      .locator('.dock textarea[placeholder="Add a follow-up"]')
      .waitFor({ timeout: 15_000 });
    await field().fill('Rename the route too, with a redirect from the old one.');
    await page.locator('.dock').getByRole('button', { name: 'Send follow-up' }).click();
    // The bubble shows at once, then moves on to what the computer reports.
    await receiptOf('Rename the route too').first().waitFor({ timeout: 15_000 });
    await receiptOf('Rename the route too')
      .filter({ hasText: 'Typed into the terminal' })
      .waitFor({ timeout: 30_000 });
    const typed = await typedHas('Rename the route too, with a redirect from the old one.');
    expect(typed).toContain('FOLLOW-UP');
    expect(typed).not.toContain('CORRECTS');
    // The decision is what it was: same revision, same choice, still the person's.
    const view = await bridge.getDecision(ids.thread!);
    expect(view).toMatchObject({ revision: 1, choice: 'yes', provenance: 'human' });
    expect(
      await page.locator('.ws .msg.out .bubble-label', { hasText: 'Changed answer' }).count(),
    ).toBe(0);
  });

  it('keeps the latest reply above a resizing composer and preserves an earlier reading position', async () => {
    await openId('thread');
    await bridge.postMessage(
      {
        question_id: ids.thread,
        expects_reply: false,
        text: `${'The redirect preserves existing links while the new route takes over.\n\n'.repeat(24)}End of the route update.`,
      },
      paneIdentityOf(origins.thread!),
    );
    await bridge.pump();
    await page
      .locator('.ws .msg.note')
      .getByText('End of the route update.', { exact: true })
      .waitFor();
    await page.locator('.ws-body').evaluate((body) => {
      body.scrollTop = body.scrollHeight;
      body.dispatchEvent(new Event('scroll'));
    });
    const bottomGap = () =>
      page
        .locator('.ws-body')
        .evaluate((body) => body.scrollHeight - body.clientHeight - body.scrollTop);
    await page.setViewportSize({ width: 390, height: 508 });
    await until(async () => (await bottomGap()) < 2, 5000, 'the latest reply above the keyboard');
    await field().fill('Keep the redirect.\nAlso update the navigation.\nAnd the tests.');
    await until(
      async () => (await bottomGap()) < 2,
      5000,
      'the latest reply above the growing draft',
    );
    await page.locator('.ws-body').evaluate((body) => {
      body.scrollTop = 120;
      body.dispatchEvent(new Event('scroll'));
    });
    await page.setViewportSize({ width: 390, height: 450 });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    expect(await page.locator('.ws-body').evaluate((body) => body.scrollTop)).toBeCloseTo(120, 0);
    await field().fill('');
    await page.setViewportSize({ width: 390, height: 844 });
  });

  it('shows an agent message that expects a reply, puts the question back in Needs you, and sends the reply', async () => {
    await answer('asking', /^Yes/, 'Send decision');
    await bridge.postMessage(
      {
        question_id: ids.asking,
        text: 'Should it also retry on 429, or only on 5xx?',
        expects_reply: true,
      },
      paneIdentityOf(origins.asking!),
    );
    await bridge.pump();
    await page
      .locator('.ws .msg.note')
      .getByText('Should it also retry on 429')
      .waitFor({ timeout: 30_000 });
    await page.locator('.ws').getByText('Waiting for your reply').waitFor({ timeout: 15_000 });

    await page.goto(`${relay.origin}/`);
    const needs = page.locator('main [data-section="needs"]');
    await needs
      .locator('a.qrow', { hasText: 'Use the shared retry helper' })
      .getByText('Claude Code:')
      .waitFor({ timeout: 30_000 });

    await openId('asking');
    await page
      .locator('.dock textarea[placeholder="Reply to Claude Code"]')
      .waitFor({ timeout: 15_000 });
    await field().fill('Retry on 429 as well, honouring Retry-After.');
    await page.locator('.dock').getByRole('button', { name: 'Send reply' }).click();
    const typed = await typedHas('Retry on 429 as well, honouring Retry-After.');
    expect(typed).toContain('FOLLOW-UP');
    await until(
      async () => (await page.locator('.ws').getByText('Waiting for your reply').count()) === 0,
      15_000,
      'the agent to stop waiting',
    );

    // Answered by the reply: it leaves Needs you.
    await page.goto(`${relay.origin}/`);
    await page.locator('main a.qrow').first().waitFor({ timeout: 30_000 });
    await until(
      async () =>
        (await needs.locator('a.qrow', { hasText: 'Use the shared retry helper' }).count()) === 0,
      15_000,
      'the question to leave Needs you',
    );
  });

  it('queues a follow-up written offline and sends it on reconnect', async () => {
    await answer('offline', /^Yes/, 'Send decision');
    await context.setOffline(true);
    await field().fill('Only for the internal beta group at first.');
    await page.locator('.dock').getByRole('button', { name: 'Send follow-up' }).click();
    await receiptOf('Only for the internal beta group')
      .filter({ hasText: /Queued/ })
      .waitFor({ timeout: 15_000 });
    expect(sink.typed.some((t) => t.includes('Only for the internal beta group'))).toBe(false);

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await typedHas('Only for the internal beta group at first.');
    await receiptOf('Only for the internal beta group')
      .filter({ hasText: 'Typed into the terminal' })
      .waitFor({ timeout: 30_000 });
  });

  it('never offers to change a human answer', async () => {
    await openId('thread');
    await page.locator('.ws-head').getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'View activity' }).waitFor();
    expect(
      await page.getByRole('menuitem', { name: /Change answer|Resume correction/ }).count(),
    ).toBe(0);
    await page.keyboard.press('Escape');
    expect(await page.locator('.ws').getByRole('button', { name: 'Overrule' }).count()).toBe(0);
    expect(await page.locator('#ws-correction').count()).toBe(0);
  });

  it('still lets the person overrule a model answer', async () => {
    const before = sink.typed.length;
    await openId('model');
    await page.locator('.ws').getByRole('button', { name: 'Overrule' }).click();
    await page
      .getByRole('radio', { name: /Changed/ })
      .first()
      .check();
    await page
      .locator('.dock')
      .getByRole('textbox', { name: 'Reason for the change' })
      .fill('It changes behaviour; it is not a bug fix.');
    await page.locator('.dock').getByRole('button', { name: 'Send correction' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send correction' }).click();
    await until(async () => sink.typed.length > before, 30_000, 'the overrule');
    const view = await bridge.getDecision(ids.model!);
    expect(view).toMatchObject({ choice: 'changed', provenance: 'human' });
  });
});
