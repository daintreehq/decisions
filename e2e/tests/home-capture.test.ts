import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
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
 * Captures Home (the list of every question) in every state that carries design weight, for design review:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test home-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. Everything goes through the real seams: a real relay, the real desktop
 * client publishing encrypted questions from two computers and two projects, and the PWA paired through its own UI.
 * It captures 0, 3 and 20 questions at 390×844 in both themes, plus search, filters, offline, tablet, wide and the
 * Ctrl/⌘+K navigator sheet over a question (phone and tablet). Each capture checks what it claims to show before it
 * writes, and the run fails if any expected file is missing, if the sheet's keyboard route (Arrow Down into the results,
 * Escape clears before it closes) breaks, or if the hit boxes around Needs you's heading overlap. HOME_CAPTURE_PORT and
 * HOME_CAPTURE_INSPECTOR_PORT pick the relay's ports. The
 * same spec runs against the earlier list (scope segments, an always-visible search field, select filters) so the
 * before and after pair by name.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.HOME_CAPTURE_PORT ?? 8827);
const INSPECTOR_PORT = Number(process.env.HOME_CAPTURE_INSPECTOR_PORT ?? PORT + 1000);
const PHONE = { width: 390, height: 844 };
const TABLET = { width: 834, height: 1194 };
const WIDE = { width: 1280, height: 820 };

const MAC = 'Greg’s MacBook Pro';
const STUDIO = 'Studio Mac mini';

class Sink implements TerminalSink {
  async locate(o: QuestionOrigin): Promise<LocateResult> {
    // One terminal has gone away, so the answer sent to it needs attention on the computer.
    if (o.pane_id === 'p-gone') return { state: 'gone' };
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

/** The decision model answers two questions, so the list holds model answers to review beside the rest. */
const MODEL_ANSWERS: Record<string, string> = {
  'Should the changelog entry': 'changed',
  'Bump the minimum Node': 'yes',
};
const proxy: ProxyEngine = {
  gateAware: true,
  async suggest(input) {
    const hit = Object.keys(MODEL_ANSWERS).find((k) => input.question.startsWith(k));
    if (!hit) return { action: 'abstain', reason: 'low-confidence' };
    return {
      action: 'answer',
      selected_option_ids: [MODEL_ANSWERS[hit]!],
      confidence: 0.74,
      model_id: 'decision-model-bm25 v1',
      prompt_template_version: '1',
      retrieval_reference_ids: [],
      risk_flags: [],
    };
  },
};

describe.skipIf(!OUT || !chromiumPath)('captures of Home, the list of every question', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  const local = new MemoryLocalStore();
  const written: string[] = [];
  const checks: Record<string, unknown> = {};
  const ids: Record<string, string> = {};
  /** Whether this build has the compact list (a baseline capture of the earlier list has not). */
  let compact = false;

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
  /** The page itself, not the sidebar's Recent (which holds the same text). */
  const onHome = (text: string) =>
    page.locator('main').getByText(text).first().waitFor({ timeout: 30_000 });
  const rowCount = () => page.locator('main a.qrow').count();
  const expectRows = async (min: number, what: string) => {
    const n = await rowCount();
    if (n < min) throw new Error(`${what}: expected at least ${min} rows, saw ${n}`);
  };

  const origin = (pane: string, project: string, machine: string): QuestionOrigin => ({
    machine_label: machine,
    host_id: machine === MAC ? 'host_01JC8Z4MQ7' : 'host_01JD2STUDIO',
    pane_id: pane,
    terminal_generation: 1,
    ownership_principal: `principal-${pane}`,
    agent_incarnation: '1',
    agent_kind: 'claude-code',
    agent_session_id: `s-${pane}`,
    project_id: project,
    worktree_id: `wt-${pane}`,
    worktree_root: `/work/${project}`,
    workflow_gate_id: null,
  });
  const ask = async (
    key: string,
    o: QuestionOrigin,
    question: string,
    options: [string, string][] | null,
    extra: Record<string, unknown> = {},
  ) => {
    const input: Record<string, unknown> = {
      question,
      kind: options
        ? options.length === 2 && extra.choice !== true
          ? 'approval'
          : 'choice'
        : 'text',
      options: (options ?? []).map(([id, label]) => ({ id, label })),
      ...extra,
    };
    delete input.choice;
    const r = await bridge.registerQuestion({ origin: o, input });
    ids[key] = r.questionId;
  };
  const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  /** Answer a question through the phone's own UI, as a person would. */
  const answer = async (
    key: string,
    option: RegExp,
    settled = /Typed into the terminal|attention/i,
  ) => {
    await go(`/q/${ids[key]}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await page.getByRole('radio', { name: option }).first().check();
    await page.getByRole('button', { name: /^Send (decision|answer)$/ }).click();
    await page.locator('.ws .receipt').filter({ hasText: settled }).waitFor({ timeout: 30_000 });
  };

  /** Hit boxes in Needs you's head that overlap each other or the first row (none should). */
  const targetOverlaps = (root: string) =>
    page.evaluate((sel) => {
      const scope = document.querySelector(sel)?.querySelector('[data-section="needs"]');
      if (!scope) return ['no Needs you section'];
      const boxes = [
        ...Array.from(scope.querySelectorAll('.qgroup-sort, .jump-link')),
        scope.querySelector('a.qrow'),
      ]
        .filter((el): el is Element => !!el)
        .map((el) => ({ name: el.className || el.tagName, r: el.getBoundingClientRect() }));
      const hits: string[] = [];
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!.r;
          const b = boxes[j]!.r;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 0.5 && h > 0.5)
            hits.push(`${boxes[i]!.name} × ${boxes[j]!.name}: ${Math.round(h)}px`);
        }
      return hits;
    }, root);
  const expectNoOverlaps = async (name: string, root: string) => {
    const hits = await targetOverlaps(root);
    checks.targets ??= {} as Record<string, string[]>;
    (checks.targets as Record<string, string[]>)[name] = hits;
    if (hits.length) throw new Error(`${name}: overlapping targets ${hits.join('; ')}`);
  };

  /* ---- the list's tools, in whichever form this build has ---- */

  const search = async (q: string) => {
    const field = page.locator('main input[type="search"]');
    if (!(await field.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'Search questions' }).click();
    }
    await field.fill(q);
    await settle(400);
  };
  const clearSearch = async () => {
    const clear = page.getByRole('button', { name: /^(Clear search|Close search)$/ }).first();
    if (await clear.isVisible().catch(() => false)) await clear.click();
    await settle(300);
    // A field that is still open and empty closes on Escape.
    if (compact && (await page.locator('main input[type="search"]').isVisible())) {
      await page.locator('main input[type="search"]').press('Escape');
    }
  };
  const openFilterSheet = async () => {
    await page
      .getByRole('button', { name: /^Filter/ })
      .first()
      .click();
    await page.locator('dialog.filter-sheet[open]').waitFor({ timeout: 10_000 });
    await settle(400);
  };
  const closeFilterSheet = async () => {
    await page.locator('dialog.filter-sheet[open]').getByRole('button', { name: 'Done' }).click();
    await until(
      async () => (await page.locator('dialog.filter-sheet[open]').count()) === 0,
      10_000,
      'the filter sheet to close',
    );
  };
  const filterComputer = async (name: string, captureSheet?: string) => {
    if (compact) {
      await openFilterSheet();
      await page.locator('dialog.filter-sheet[open] label.facet-opt', { hasText: name }).click();
      await page
        .locator('dialog.filter-sheet[open] label.facet-opt[data-on]', { hasText: name })
        .waitFor({ timeout: 5_000 });
      if (captureSheet) await shot(captureSheet);
      await closeFilterSheet();
    } else {
      await page.getByLabel('Filter by computer').selectOption(name);
    }
    await settle(300);
  };
  const clearFilters = async () => {
    if (compact) {
      for (;;) {
        const chip = page.getByRole('button', { name: /^Remove filter/ }).first();
        if (!(await chip.isVisible().catch(() => false))) break;
        await chip.click();
      }
    } else {
      const btn = page.getByRole('button', { name: 'Clear filters' }).first();
      if (await btn.isVisible().catch(() => false)) await btn.click();
    }
    await settle(300);
  };
  /** The earlier list showed one scope at a time; the compact one shows every question in sections. */
  const showEverything = async () => {
    if (compact) {
      const later = page.locator('main [data-section]:not([data-section="needs"])').first();
      await later.evaluate((el) => {
        const top = el.getBoundingClientRect().top + window.scrollY - 64;
        window.scrollTo(0, top);
      });
    } else {
      await page.getByRole('button', { name: /^All/ }).first().click();
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    await settle();
  };
  const showNeedsYou = async () => {
    if (!compact)
      await page
        .getByRole('button', { name: /^Needs you/ })
        .first()
        .click();
    await page.evaluate(() => window.scrollTo(0, 0));
  };

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT, INSPECTOR_PORT);
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
    writeFileSync(join(OUT!, 'checks.json'), JSON.stringify({ written, checks }, null, 2));
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('pairs, then captures Home with no questions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-home-'));
    const keyStore = new FileKeyStore(home);
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: MAC,
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
    await page.locator('main .nav-empty, main .home-empty').first().waitFor({ timeout: 30_000 });
    // The earlier list always shows its search field; the compact one keeps it behind a round button.
    compact = (await page.locator('main input[type="search"]').count()) === 0;
    checks.compact = compact;

    await shot('p0-light');
    await theme('dark');
    await shot('p0-dark');
    await theme('light');
    await size(WIDE);
    await settle();
    await shot('w0-light');
    await size(PHONE);
  });

  it('captures Home with three questions, then with nothing that needs you', async () => {
    await ask(
      'sidebar',
      origin('p1', 'daintree', MAC),
      'Approve the compact sidebar for the Agents view?',
      [
        ['approve', 'Approve'],
        ['reject', 'Reject'],
      ],
      { context: 'Design review, round 3. The sidebar collapses to icons below 900px.' },
    );
    await ask(
      'retry',
      origin('p2', 'billing-api', STUDIO),
      'Which retry strategy should the webhook sender use?',
      [
        ['backoff', 'Exponential backoff'],
        ['queue', 'Durable queue + dead letter'],
        ['both', 'Backoff now, queue later'],
      ],
      { expires_at: hours(2.5) },
    );
    await ask(
      'changelog',
      origin('p3', 'billing-api', MAC),
      'Should the changelog entry for the retry change go under “Fixed” or “Changed”?',
      [
        ['fixed', 'Fixed'],
        ['changed', 'Changed'],
      ],
      { requested_requirement: 'proxy-ok', choice: true },
    );
    await bridge.pump();
    expect(await bridge.runProxy(ids.changelog!)).toBe('answered');
    await bridge.pump();

    await go('/');
    await onHome('Approve the compact sidebar');
    await onHome('Which retry strategy');
    await expectRows(2, 'three questions');
    await shot('p3-light');
    await theme('dark');
    await shot('p3-dark');
    await theme('light');

    // Answer both, so nothing needs you and the list is calm.
    await answer('sidebar', /^Approve/);
    await answer('retry', /Exponential backoff/);
    await go('/');
    await page
      .locator('main')
      .getByText(/Nothing needs you/)
      .first()
      .waitFor({ timeout: 30_000 });
    await shot('p3-clear-light');
    await theme('dark');
    await shot('p3-clear-dark');
    await theme('light');
  });

  it('captures Home with twenty questions across two computers and two projects', async () => {
    // Created first so it has passed its expiry by the time the list is captured.
    const expiresAt = Date.now() + 62_000;
    await ask(
      'expired',
      origin('p4', 'daintree', STUDIO),
      'Publish the draft release notes to the docs site now?',
      [
        ['yes', 'Publish'],
        ['no', 'Not yet'],
      ],
      { expires_at: new Date(expiresAt).toISOString() },
    );
    await ask(
      'withdrawn',
      origin('p5', 'billing-api', STUDIO),
      'Drop the legacy /v1/invoices endpoint in this release?',
      [
        ['drop', 'Drop it'],
        ['keep', 'Keep it one more release'],
      ],
    );
    await ask(
      'export',
      origin('p-gone', 'billing-api', MAC),
      'Retry the failed invoice export for October now?',
      [
        ['yes', 'Retry now'],
        ['no', 'Wait for the nightly run'],
      ],
    );
    await ask(
      'canopy',
      origin('p6', 'daintree', MAC),
      'Rename “Canopy” to “Inbox” in the sidebar?',
      [
        ['yes', 'Yes, rename'],
        ['no', 'Keep Canopy'],
      ],
    );
    await ask(
      'node',
      origin('p7', 'daintree', STUDIO),
      'Bump the minimum Node version to 22 in the engines field?',
      [
        ['yes', 'Bump to 22'],
        ['no', 'Stay on 20'],
      ],
      { requested_requirement: 'proxy-ok' },
    );
    await ask(
      'loglevel',
      origin('p8', 'billing-api', STUDIO),
      'Log webhook payloads at info or debug level?',
      [
        ['info', 'Info'],
        ['debug', 'Debug'],
      ],
      { choice: true },
    );
    await ask(
      'migration',
      origin('p9', 'daintree', STUDIO),
      'The migration guide mentions v2 in three places and v3 in one. Which version should it describe, and should the v2 steps move to an appendix?',
      null,
      { expires_at: hours(50) },
    );
    await ask(
      'tokens',
      origin('p10', 'daintree', MAC),
      'Regenerate the theme tokens from Daintree’s latest themes before the release branch is cut?',
      [
        ['yes', 'Regenerate'],
        ['no', 'Leave them'],
      ],
    );
    await ask(
      'ratelimit',
      origin('p11', 'billing-api', STUDIO),
      'Raise the webhook rate limit from 50 to 200 requests per minute for the partner gateway?',
      [
        ['yes', 'Raise to 200'],
        ['no', 'Keep 50'],
      ],
      { expires_at: hours(1.4) },
    );
    await ask(
      'idempotency',
      origin('p12', 'billing-api', MAC),
      'Keep idempotency keys for 24 hours or 7 days?',
      [
        ['24h', '24 hours'],
        ['7d', '7 days'],
      ],
      { choice: true },
    );
    await ask(
      'shortcuts',
      origin('p13', 'daintree', STUDIO),
      'Ship the keyboard shortcuts sheet in 0.4 or hold it for 0.5?',
      [
        ['now', 'Ship in 0.4'],
        ['later', 'Hold for 0.5'],
      ],
      { choice: true },
    );
    await ask(
      'wording',
      origin('p14', 'daintree', MAC),
      'Use “Worktree” or “Workspace” in the onboarding copy?',
      [
        ['worktree', 'Worktree'],
        ['workspace', 'Workspace'],
      ],
      { choice: true },
    );
    await ask(
      'split',
      origin('p15', 'billing-api', MAC),
      'Split the invoices table migration into two deploys so the backfill can run between them?',
      [
        ['yes', 'Split it'],
        ['no', 'One deploy'],
      ],
    );
    await ask(
      'branch',
      origin('p16', 'daintree', STUDIO),
      'Delete the stale feature/rail branch after merging #48?',
      [
        ['yes', 'Delete it'],
        ['no', 'Keep it'],
      ],
    );
    await ask(
      'rounding',
      origin('p17', 'billing-api', STUDIO),
      'Which currency rounding mode should refunds use?',
      [
        ['half-even', 'Banker’s rounding (half to even)'],
        ['half-up', 'Half up'],
        ['down', 'Always down'],
      ],
    );
    await ask(
      'empty-copy',
      origin('p18', 'daintree', MAC),
      'What should the empty state say when no agents are running?',
      null,
    );
    await ask(
      'flaky',
      origin('p19', 'billing-api', MAC),
      'Quarantine the flaky webhook signature test until the clock-skew fix lands?',
      [
        ['yes', 'Quarantine it'],
        ['no', 'Leave it running'],
      ],
    );
    await bridge.pump();
    expect(await bridge.runProxy(ids.node!)).toBe('answered');
    await bridge.cancelQuestion(ids.withdrawn!);
    await bridge.pump();
    expect(Object.keys(ids).length).toBe(20);

    // Three answered by the person, one of them to a terminal that has gone away.
    await answer('canopy', /Keep Canopy/);
    await answer('loglevel', /^Info/);
    await answer('export', /Retry now/, /attention/i);
    await bridge.pump();

    const wait = expiresAt + 2_000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);

    await go('/');
    await onHome('Raise the webhook rate limit');
    await expectRows(8, 'twenty questions');
    await shot('p20-light');
    await expectNoOverlaps('p20-light', 'main');
    await theme('dark');
    await shot('p20-dark');
    await theme('light');
    checks.rowsOnFirstScreen = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('main a.qrow')).filter((r) => {
          const b = r.getBoundingClientRect();
          return b.top >= 0 && b.bottom <= window.innerHeight;
        }).length,
    );

    // Everything else: the earlier list's All scope, or the later sections of the compact list.
    await showEverything();
    await shot('p20-rest-light');
    await theme('dark');
    await shot('p20-rest-dark');
    await theme('light');
    await showNeedsYou();

    // Search.
    await search('webhook');
    await onHome('Raise the webhook rate limit');
    await shot('p20-search-light');
    await clearSearch();

    // Filter by computer: the sheet (compact list only), then the active filter.
    await filterComputer(STUDIO, compact ? 'p20-filter-sheet-light' : undefined);
    await onHome('Raise the webhook rate limit');
    await shot('p20-filtered-light');
    await theme('dark');
    if (compact) {
      await openFilterSheet();
      await shot('p20-filter-sheet-dark');
      await closeFilterSheet();
    }
    await shot('p20-filtered-dark');
    await theme('light');

    // Scroll position and the filter survive opening a question and coming back.
    await page.evaluate(() => window.scrollTo(0, 240));
    await settle(200);
    const before = await page.evaluate(() => window.scrollY);
    const target = page.locator('main a.qrow').nth(4);
    const targetId = await target.getAttribute('data-row-id');
    await target.click();
    await page.waitForURL((u) => u.pathname === `/q/${targetId}`, { timeout: 15_000 });
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 15_000 });
    await page.locator('main a.qrow').first().waitFor({ timeout: 15_000 });
    await settle(300);
    checks.restore = {
      before,
      after: await page.evaluate(() => window.scrollY),
      filterKept: compact
        ? (await page.getByRole('button', { name: /^Remove filter/ }).count()) > 0
        : (await page.getByRole('button', { name: /^Computer:|Studio Mac mini/ }).count()) > 0,
    };
    await clearFilters();
    await page.evaluate(() => window.scrollTo(0, 0));

    // Tablet.
    await size(TABLET);
    await go('/');
    await onHome('Raise the webhook rate limit');
    await shot('t20-light');

    // Wide: the list beside a calm pane, then beside the question chosen from it.
    await size(WIDE);
    await go('/');
    await onHome('Raise the webhook rate limit');
    await shot('w20-light');
    await theme('dark');
    await shot('w20-dark');
    await theme('light');
    await page.locator('main a.qrow', { hasText: 'Raise the webhook rate limit' }).first().click();
    await page.waitForURL((u) => u.pathname === `/q/${ids.ratelimit}`, { timeout: 15_000 });
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await shot('w20-question-light');

    // Ctrl/⌘+K over a question below 1100px: the Questions & answers sheet, from the bottom on phones and from the
    // left on tablets, with its search focused and the current question highlighted.
    const openSheet = async () => {
      await page.keyboard.press('ControlOrMeta+k');
      await page.locator('dialog.nav-sheet[open] a.qrow').first().waitFor({ timeout: 10_000 });
      await settle(400);
    };
    const closeSheet = async () => {
      await page.keyboard.press('Escape');
      await until(
        async () => (await page.locator('dialog.nav-sheet[open]').count()) === 0,
        10_000,
        'the navigator sheet to close',
      );
    };
    await size(PHONE);
    await go(`/q/${ids.ratelimit}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await openSheet();
    if ((await page.locator('dialog.nav-sheet[open] .qrow[aria-current="page"]').count()) !== 1)
      throw new Error('the sheet does not mark the current question');
    await shot('p20-sheet-light');
    await expectNoOverlaps('p20-sheet-light', 'dialog.nav-sheet[open]');
    await theme('dark');
    await shot('p20-sheet-dark');
    await theme('light');
    await page.locator('dialog.nav-sheet[open] input[type="search"]').fill('webhook');
    await page
      .locator('dialog.nav-sheet[open] a.qrow', { hasText: 'Log webhook payloads' })
      .waitFor({ timeout: 10_000 });
    await shot('p20-sheet-search-light');
    // The keyboard route: Arrow Down leaves the search for the first result, and Escape there clears the query
    // (back in the search) before a second Escape closes the sheet.
    const sheetSearch = page.locator('dialog.nav-sheet[open] input[type="search"]');
    await sheetSearch.press('ArrowDown');
    const onRow = await page.evaluate(
      () => !!document.activeElement?.matches('dialog.nav-sheet a.qrow'),
    );
    await page.keyboard.press('Escape');
    await settle(300);
    checks.sheetKeys = {
      arrowDownReachesRow: onRow,
      escapeKeepsSheet: (await page.locator('dialog.nav-sheet[open]').count()) === 1,
      escapeClearsQuery: (await sheetSearch.inputValue().catch(() => 'closed')) === '',
    };
    if (!Object.values(checks.sheetKeys as Record<string, boolean>).every(Boolean))
      throw new Error(`sheet keyboard route: ${JSON.stringify(checks.sheetKeys)}`);
    await closeSheet();
    await size(TABLET);
    await settle();
    await openSheet();
    await shot('t20-sheet-light');
    await theme('dark');
    await shot('t20-sheet-dark');
    await theme('light');
    await closeSheet();
    await size(PHONE);

    // Offline, with an answer queued on this device.
    await go('/');
    await onHome('Raise the webhook rate limit');
    await context.setOffline(true);
    await page
      .locator('.conn[data-state="off"], .conn-line[data-state="off"], .home-offline')
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 });
    // The question at the top, so the queued answer is in view beside the offline state.
    await page.locator('main a.qrow', { hasText: 'Raise the webhook rate limit' }).first().click();
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await page
      .getByRole('radio', { name: /Raise to 200/ })
      .first()
      .check();
    await page.getByRole('button', { name: /^Send (decision|answer)$/ }).click();
    await page
      .locator('.ws .receipt')
      .filter({ hasText: /Queued/ })
      .waitFor({ timeout: 15_000 });
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 15_000 });
    await page.locator('main a.qrow').first().waitFor({ timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page
      .locator('main')
      .getByText(/^Queued/)
      .first()
      .waitFor({ timeout: 15_000 });
    await shot('p20-offline-light');
    await expectNoOverlaps('p20-offline-light', 'main');
    await theme('dark');
    await shot('p20-offline-dark');
    await theme('light');
    if (compact) {
      // The answer waiting to leave this phone, in its own section.
      await page
        .locator('main [data-section="sending"]')
        .evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 64));
      await shot('p20-sending-light');
    }
    await context.setOffline(false);

    const expected = compact ? 28 : 25;
    expect(written.length).toBe(expected);
  });
});
