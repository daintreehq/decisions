import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
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
  type LocateResult,
  type ProxyEngine,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Captures the app shell (the floating menu button, the sidebar and the wide sidebar column) in every state that
 * carries design weight, for design review:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test sidebar-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. Everything goes through the real seams (a real relay, the real desktop
 * client publishing encrypted questions, the PWA paired through its own UI). Each capture checks what it claims to
 * show before it writes, and the run fails if any expected file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.SIDEBAR_CAPTURE_PORT ?? 8821);
const PHONE = { width: 390, height: 844 };
const TABLET = { width: 834, height: 1194 };
const WIDE = { width: 1280, height: 820 };

class Sink implements TerminalSink {
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
  async inject(_t: TerminalTarget, _text: string, _id: string) {
    return { outcome: 'delivered' as const, proof: 'shot' };
  }
  async hasMarker() {
    return false;
  }
  async resume() {
    return null;
  }
}

/** Answers the changelog question only, so the list holds one model answer beside the ones that need a person. */
const proxy: ProxyEngine = {
  gateAware: true,
  async suggest(input) {
    if (!input.question.startsWith('Should the changelog entry'))
      return { action: 'abstain', reason: 'low-confidence' };
    return {
      action: 'answer',
      selected_option_ids: ['changed'],
      confidence: 0.74,
      model_id: 'decision-model-bm25 v1',
      prompt_template_version: '1',
      retrieval_reference_ids: [],
      risk_flags: [],
    };
  },
};

describe.skipIf(!OUT || !chromiumPath)('captures of the app shell and sidebar', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  const local = new MemoryLocalStore();
  const written: string[] = [];
  const ids: Record<string, string> = {};
  /** Whether this build has the floating menu button (a baseline capture of the old shell has not). */
  let hasMenu = false;

  const settle = async (ms = 450) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(ms);
  };
  const shot = async (name: string) => {
    await settle();
    const path = join(OUT!, `${name}.png`);
    await page.screenshot({ path });
    if (!existsSync(path) || statSync(path).size < 2_000)
      throw new Error(`capture ${name} is empty`);
    written.push(name);
  };
  const theme = (scheme: 'light' | 'dark') => page.emulateMedia({ colorScheme: scheme });
  const size = (vp: { width: number; height: number }) => page.setViewportSize(vp);
  const go = async (path: string) => {
    await page.goto(relay.origin + path);
    await page.locator('#main').waitFor({ timeout: 30_000 });
  };
  /** Opens the sidebar overlay and waits until it has finished sliding in. */
  const openSidebar = async () => {
    await page.locator('.menu-fab').click();
    await page.locator('dialog.sidebar-sheet[open]').waitFor({ timeout: 10_000 });
    await settle(500);
  };
  const closeSidebar = async () => {
    await page.keyboard.press('Escape');
    await page
      .locator('dialog.sidebar-sheet[open]')
      .waitFor({ state: 'detached', timeout: 10_000 })
      .catch(async () => {
        await until(
          async () => (await page.locator('dialog.sidebar-sheet[open]').count()) === 0,
          10_000,
          'sidebar to close',
        );
      });
  };
  const expectRecent = async (n: 'some' | 'none', scope = 'dialog.sidebar-sheet[open]') => {
    const rows = await page.locator(`${scope} .side-recent a`).count();
    if (n === 'some' && rows === 0) throw new Error('the sidebar shows no recent questions');
    if (n === 'none' && rows !== 0)
      throw new Error('the sidebar shows recent questions it should not');
  };

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT);
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    context = await browser.newContext({
      viewport: PHONE,
      deviceScaleFactor: 2,
      colorScheme: 'light',
      serviceWorkers: 'allow',
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      hasTouch: true,
    });
    page = await context.newPage();
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('pairs, then captures the shell with no questions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-sidebar-'));
    const keyStore = new FileKeyStore(home);
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'Greg’s MacBook Pro',
      store: keyStore,
    });
    client = new RelayClient({ identity });
    bridge = new DecisionsBridge({
      identity,
      keyStore,
      store: local,
      sink: new Sink(),
      client,
      proxy,
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
      pumpIntervalMs: 0,
      resolver: { resolve: async () => null },
    });
    await bridge.start();
    const invite = await createPairingInvite(client, 'phone');
    await page.goto('about:blank');
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
    await page.getByText('Nothing needs you right now.').waitFor({ timeout: 30_000 });
    hasMenu = (await page.locator('.menu-fab').count()) > 0;

    await shot('p-empty-closed-light');
    if (hasMenu) {
      await openSidebar();
      await expectRecent('none');
      await shot('p-empty-open-light');
      await theme('dark');
      await shot('p-empty-open-dark');
      await closeSidebar();
      await theme('light');
      await size(TABLET);
      await openSidebar();
      await expectRecent('none');
      await shot('t-empty-open-light');
      await closeSidebar();
    }
    await size(WIDE);
    await settle();
    if (hasMenu) await expectRecent('none', 'aside.sidebar');
    await shot('w-empty-light');
    await size(PHONE);
  });

  it('captures the shell and sidebar with a realistic set of questions', async () => {
    const origin = (pane: string, project: string, agent = 'claude-code'): QuestionOrigin => ({
      machine_label: 'Greg’s MacBook Pro',
      host_id: 'host_01JC8Z4MQ7',
      pane_id: pane,
      terminal_generation: 1,
      ownership_principal: `principal-${pane}`,
      agent_incarnation: '1',
      agent_kind: agent,
      agent_session_id: `s-${pane}`,
      project_id: project,
      worktree_id: `wt-${pane}`,
      worktree_root: `/work/${project}`,
      workflow_gate_id: null,
    });
    const ask = async (key: string, o: QuestionOrigin, input: Record<string, unknown>) => {
      const r = await bridge.registerQuestion({ origin: o, input });
      ids[key] = r.questionId;
    };
    const yesNo = (yes: string, no: string) => [
      { id: 'yes', label: yes },
      { id: 'no', label: no },
    ];
    // Oldest first: the last one asked is the most recent.
    await ask('withdrawn', origin('p7', 'billing-api'), {
      question: 'Drop the legacy /v1/invoices endpoint in this release?',
      kind: 'approval',
      options: yesNo('Drop it', 'Keep it one more release'),
    });
    await ask('proxy', origin('p6', 'billing-api', 'codex'), {
      question: 'Should the changelog entry for the retry change go under “Fixed” or “Changed”?',
      kind: 'choice',
      requested_requirement: 'proxy-ok',
      options: [
        { id: 'fixed', label: 'Fixed' },
        { id: 'changed', label: 'Changed' },
      ],
    });
    await ask('tokens', origin('p9', 'design-tokens'), {
      question:
        'Regenerate the theme tokens from Daintree’s latest themes before the release branch is cut?',
      kind: 'approval',
      options: yesNo('Regenerate', 'Leave them'),
    });
    await ask('text', origin('p3', 'customer-onboarding-service', 'gemini'), {
      question:
        'The migration guide mentions v2 in three places and v3 in one. Which version should it describe, and should the v2 steps move to an appendix?',
      kind: 'text',
      options: [],
    });
    await ask('choice', origin('p2', 'billing-api'), {
      question: 'Which retry strategy should the webhook sender use?',
      kind: 'choice',
      options: [
        { id: 'backoff', label: 'Exponential backoff' },
        { id: 'queue', label: 'Durable queue + dead letter' },
      ],
    });
    await ask('rename', origin('p4', 'daintree'), {
      question: 'Rename “Canopy” to “Inbox” in the sidebar?',
      kind: 'approval',
      options: yesNo('Yes, rename', 'Keep Canopy'),
    });
    await ask('design', origin('p1', 'daintree'), {
      question: 'Approve the compact sidebar for the Agents view?',
      context: 'Design review, round 3. The sidebar collapses to icons below 900px.',
      kind: 'approval',
      options: yesNo('Approve', 'Reject'),
    });
    await bridge.pump();
    expect(await bridge.runProxy(ids.proxy!)).toBe('answered');
    await bridge.cancelQuestion(ids.withdrawn!);
    await bridge.pump();

    await go('/');
    await page.getByText('Approve the compact sidebar').first().waitFor({ timeout: 30_000 });
    await page.getByText('Which version should it describe').first().waitFor({ timeout: 30_000 });

    // Answer the rename question through the UI, so one row is answered by the person.
    await go(`/q/${ids.rename}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await page
      .getByRole('radio', { name: /Yes, rename/ })
      .first()
      .check();
    await page.getByRole('button', { name: 'Send decision' }).click();
    await page
      .locator('.ws .receipt')
      .filter({ hasText: 'Typed into the terminal' })
      .waitFor({ timeout: 30_000 });

    // Phone, light.
    await go('/');
    await page.getByText('Approve the compact sidebar').first().waitFor({ timeout: 30_000 });
    await shot('p-home-closed-light');
    if (hasMenu) {
      await openSidebar();
      await expectRecent('some');
      await shot('p-home-open-light');
      await closeSidebar();
    }
    // The page scrolled, so content passes under the floating button (Home lists every question).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.evaluate(() => window.scrollTo(0, 260));
    await settle();
    if ((await page.evaluate(() => window.scrollY)) < 200) throw new Error('Home did not scroll');
    await shot('p-home-scrolled-light');
    await page.evaluate(() => window.scrollTo(0, 0));
    await go('/history');
    await shot('p-history-closed-light');
    await go('/settings');
    await shot('p-settings-closed-light');
    await go(`/q/${ids.design}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await shot('p-question-closed-light');
    if (hasMenu) {
      await openSidebar();
      await expectRecent('some');
      if (
        (await page
          .locator('dialog.sidebar-sheet[open] .side-recent a[aria-current="page"]')
          .count()) !== 1
      )
        throw new Error('the open question is not marked current in Recent');
      await shot('p-question-open-light');
      await closeSidebar();
    }

    // Phone, dark.
    await theme('dark');
    await go('/');
    await page.getByText('Approve the compact sidebar').first().waitFor({ timeout: 30_000 });
    await shot('p-home-closed-dark');
    if (hasMenu) {
      await openSidebar();
      await shot('p-home-open-dark');
      await closeSidebar();
    }
    await go(`/q/${ids.design}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await shot('p-question-closed-dark');
    await go('/settings');
    await shot('p-settings-closed-dark');
    await theme('light');

    // Offline: the connection state stops being quiet.
    await go('/');
    await context.setOffline(true);
    await page
      .locator('.conn[data-state="off"], .conn-line[data-state="off"]')
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 });
    if (hasMenu) {
      await openSidebar();
      await shot('p-open-offline-light');
      await closeSidebar();
    } else {
      await shot('p-home-offline-light');
    }
    await context.setOffline(false);
    await page
      .locator('.conn[data-state="off"], .conn-line[data-state="off"]')
      .first()
      .waitFor({ state: 'detached', timeout: 30_000 })
      .catch(() => undefined);

    // Tablet.
    await size(TABLET);
    await go('/');
    await page.getByText('Approve the compact sidebar').first().waitFor({ timeout: 30_000 });
    await shot('t-home-closed-light');
    if (hasMenu) {
      await openSidebar();
      await expectRecent('some');
      await shot('t-home-open-light');
      await theme('dark');
      await shot('t-home-open-dark');
      await closeSidebar();
      await theme('light');
    }

    // Wide: the sidebar is a persistent column.
    await size(WIDE);
    await go('/');
    await settle();
    if (hasMenu) await expectRecent('some', 'aside.sidebar');
    await shot('w-home-light');
    await theme('dark');
    await shot('w-home-dark');
    await go(`/q/${ids.design}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await shot('w-question-dark');
    await theme('light');
    await go(`/q/${ids.text}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await shot('w-question-light');
    await go('/settings');
    await shot('w-settings-light');
    await size(PHONE);

    const expected = hasMenu ? 25 : 17;
    expect(written.length).toBe(expected);
  });
});
