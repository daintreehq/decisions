import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  type InjectResult,
  type LocateResult,
  type ProxyEngine,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Captures History (the day-grouped list, its modes and search, the record pane or sheet, and the activity timeline
 * with revisions, corrections and delivery) in every state that carries design weight, for design review:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e exec vitest run tests/history-capture.test.ts
 * Skipped unless DESIGN_CAPTURE_DIR is set. Everything goes through the real seams: a real relay, the real desktop
 * client publishing encrypted questions, and the PWA paired and answering through its own UI. The desktop client
 * signs some of its records on a clock set back by days (its relay requests keep real time), so History has real
 * earlier days to group. Each capture checks what it claims to show before it writes; the run fails if a file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.HISTORY_CAPTURE_PORT ?? 8984);
const PHONE = { width: 390, height: 844 };
const TABLET = { width: 834, height: 1194 };
const WIDE = { width: 1280, height: 820 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The real clock, captured before any test fakes Date: relay requests are checked against it. */
const realNow = Date.now.bind(Date);

/**
 * Runs desktop work with this process's Date set back by `offset`, so the records it signs (questions, model
 * answers, withdrawals) carry an earlier time. Only Date is faked; timers and the relay client's clock stay real.
 */
async function backdated<T>(offset: number, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(realNow() + offset);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

/** Types everything, except into the deploy pane, where the outcome is unknown (a delivery that needs a look). */
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
  async inject(t: TerminalTarget, _text: string, _id: string): Promise<InjectResult> {
    if (t.paneId === 'p8') return { outcome: 'ambiguous', reason: 'pane closed mid-type' };
    return { outcome: 'delivered', proof: 'shot' };
  }
  async hasMarker() {
    return false;
  }
  async resume() {
    return null;
  }
}

/** The decision model answers the questions named here and leaves the rest to the person. */
const MODEL_ANSWERS: [string, string, number][] = [
  ['Which retry strategy', 'backoff', 0.68],
  ['Should the changelog entry', 'changed', 0.81],
  ['Regenerate the theme tokens', 'regen', 0.77],
  ['Cache the avatar images', 'yes', 0.72],
];
const proxy: ProxyEngine = {
  gateAware: true,
  async suggest(input) {
    const hit = MODEL_ANSWERS.find(([q]) => input.question.startsWith(q));
    if (!hit) return { action: 'abstain', reason: 'low-confidence' };
    return {
      action: 'answer',
      selected_option_ids: [hit[1]],
      confidence: hit[2],
      model_id: 'decision-model-bm25 v1',
      prompt_template_version: '1',
      retrieval_reference_ids: [],
      risk_flags: [],
    };
  },
};

describe.skipIf(!OUT || !chromiumPath)('captures of History', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  const local = new MemoryLocalStore();
  const written: string[] = [];
  const ids: Record<string, string> = {};

  const settle = async (ms = 450) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(ms);
  };
  const shot = async (name: string, opts: { full?: boolean } = {}) => {
    await settle();
    const path = join(OUT!, `${name}.png`);
    await page.screenshot({ path, fullPage: !!opts.full });
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
  const sees = (text: string | RegExp, scope = 'body') =>
    page.locator(scope).getByText(text).first().waitFor({ timeout: 30_000 });
  const row = (text: string) => page.locator('.hrow', { hasText: text }).first();
  /** Opens a record from the list and waits for its timeline in the pane or the sheet. */
  const openRecord = async (text: string, wide: boolean) => {
    await row(text).click();
    const scope = wide ? '.history-record' : 'dialog.record-sheet[open]';
    await page.locator(`${scope} .timeline`).waitFor({ timeout: 30_000 });
    await page.locator(`${scope} .record-q`, { hasText: text }).waitFor({ timeout: 10_000 });
    await settle(500);
  };
  const closeSheet = async () => {
    await page.keyboard.press('Escape');
    await until(
      async () => (await page.locator('dialog.record-sheet[open]').count()) === 0,
      10_000,
      'record sheet to close',
    );
  };
  const mode = async (label: 'Decisions' | 'All activity') => {
    await page.locator('.history-modes').getByRole('button', { name: label }).click();
    await until(
      async () =>
        (await page
          .locator('.history-modes')
          .getByRole('button', { name: label })
          .getAttribute('aria-pressed')) === 'true',
      5_000,
      `${label} mode`,
    );
  };
  const search = async (q: string) => {
    await page.getByRole('searchbox', { name: 'Search history' }).fill(q);
    await page.waitForTimeout(400);
  };
  const decision = async (key: string, check: (d: Record<string, unknown> | null) => boolean) =>
    until(
      async () => {
        await bridge.pump();
        const d = (await bridge.getDecision(ids[key]!)) as Record<string, unknown> | null;
        return check(d) ? d : null;
      },
      30_000,
      `the ${key} decision`,
    );

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT, PORT + 1);
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
    if (OUT) {
      const missing = EXPECTED.filter((n) => !existsSync(join(OUT, `${n}.png`)));
      if (missing.length) throw new Error(`history captures missing: ${missing.join(', ')}`);
    }
  });

  it('pairs, then captures History with nothing in it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-history-'));
    const keyStore = new FileKeyStore(home);
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'Greg’s MacBook Pro',
      store: keyStore,
    });
    // Requests keep real time (the relay checks it); the records this client signs follow Date (see backdated).
    const client = new RelayClient({ identity, now: realNow });
    bridge = new DecisionsBridge({
      identity,
      keyStore,
      store: local,
      sink: new Sink(),
      client,
      proxy,
      followUps: true,
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
      pumpIntervalMs: 0,
      resolver: { resolve: async () => null },
      now: () => Date.now(),
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
    await page
      .getByText(/^(No questions yet\.|Nothing needs you right now\.)$/)
      .waitFor({ timeout: 30_000 });

    await go('/history');
    await sees('No decisions yet.');
    await shot('p-empty-light');
    await size(WIDE);
    await sees('No decisions yet.');
    await shot('w-empty-light');
    await size(PHONE);
  });

  it('captures the list, its modes, search and the records on a phone', async () => {
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
    /** Runs the decision model (a pump may already have run it, which reports skipped). */
    const model = async (key: string) => {
      const r = await bridge.runProxy(ids[key]!);
      if (r === 'abstained') throw new Error(`the model abstained on ${key}`);
      await bridge.pump();
    };
    const yesNo = (yes: string, no: string, ids2: [string, string] = ['yes', 'no']) => [
      { id: ids2[0], label: yes },
      { id: ids2[1], label: no },
    ];

    // Four days ago: one withdrawn, one model answer nobody reviewed.
    await backdated(-4 * DAY - 2 * HOUR, async () => {
      await ask('legacy', origin('p7', 'billing-api'), {
        question: 'Drop the legacy /v1/invoices endpoint in this release?',
        context: 'Three partner integrations still call it; all have a v2 migration ticket open.',
        kind: 'approval',
        options: yesNo('Drop it', 'Keep it one more release'),
      });
      await ask('tokens', origin('p9', 'design-tokens', 'codex'), {
        question:
          'Regenerate the theme tokens from Daintree’s latest themes before the release branch is cut?',
        kind: 'approval',
        requested_requirement: 'proxy-ok',
        options: yesNo('Regenerate', 'Leave them', ['regen', 'leave']),
      });
      await bridge.pump();
    });
    await backdated(-4 * DAY - HOUR, async () => {
      await model('tokens');
      await bridge.cancelQuestion(ids.legacy!);
      await bridge.pump();
    });

    // Yesterday: model answers (one later corrected, one later confirmed, one left to review), one withdrawn.
    await backdated(-DAY - 5 * HOUR, async () => {
      await ask('retry', origin('p2', 'billing-api'), {
        question: 'Which retry strategy should the webhook sender use?',
        context:
          'Failures are mostly 502s from the partner gateway. Exponential backoff is simplest; a queue with dead-lettering is more work but survives restarts.',
        kind: 'choice',
        requested_requirement: 'proxy-ok',
        options: [
          {
            id: 'backoff',
            label: 'Exponential backoff',
            description: 'Up to 5 tries over ~30 min',
          },
          { id: 'queue', label: 'Durable queue + dead letter', description: 'Survives restarts' },
          { id: 'both', label: 'Backoff now, queue later' },
        ],
      });
      await ask('changelog', origin('p6', 'billing-api', 'codex'), {
        question: 'Should the changelog entry for the retry change go under “Fixed” or “Changed”?',
        kind: 'choice',
        requested_requirement: 'proxy-ok',
        options: [
          { id: 'fixed', label: 'Fixed' },
          { id: 'changed', label: 'Changed' },
        ],
      });
      await ask('avatars', origin('p5', 'customer-onboarding-service', 'gemini'), {
        question: 'Cache the avatar images on the edge for 24 hours?',
        kind: 'approval',
        requested_requirement: 'proxy-ok',
        options: yesNo('Cache them', 'Serve them fresh'),
      });
      await ask('flag', origin('p4', 'daintree'), {
        question:
          'Turn on the new onboarding checklist for everyone, or keep it behind the beta flag?',
        kind: 'choice',
        options: [
          { id: 'all', label: 'Everyone' },
          { id: 'beta', label: 'Beta flag only' },
        ],
      });
      await bridge.pump();
    });
    await backdated(-DAY - 4 * HOUR, () => model('retry'));
    await backdated(-DAY - 3 * HOUR, () => model('changelog'));
    await backdated(-DAY - 2 * HOUR, () => model('avatars'));
    await backdated(-DAY - HOUR, async () => {
      await bridge.cancelQuestion(ids.flag!);
      await bridge.pump();
    });

    // Today: the person answers, corrects and confirms through the PWA; one delivery goes wrong; one expires.
    await ask('rename', origin('p1', 'daintree'), {
      question: 'Rename “Canopy” to “Inbox” in the sidebar?',
      kind: 'approval',
      options: yesNo('Yes, rename', 'Keep Canopy'),
    });
    await ask('deploy', origin('p8', 'billing-api'), {
      question: 'Deploy the webhook fix to production now, or wait for the Monday window?',
      kind: 'choice',
      options: [
        { id: 'now', label: 'Deploy now' },
        { id: 'monday', label: 'Wait for Monday' },
      ],
    });
    await ask('guide', origin('p3', 'customer-onboarding-service', 'gemini'), {
      question:
        'The migration guide mentions v2 in three places and v3 in one. Which version should it describe, and should the v2 steps move to an appendix?',
      kind: 'text',
      options: [],
    });
    await ask('notes', origin('p10', 'daintree'), {
      question: 'Publish the draft release notes to the website?',
      kind: 'approval',
      options: yesNo('Publish', 'Not yet'),
      expires_at: new Date(Date.now() + 65_000).toISOString(),
    });
    await bridge.pump();

    const composer = page.locator('.dock .composer-field textarea');
    const send = page
      .locator('.dock')
      .getByRole('button', { name: /^Send (decision|answer|correction)$/ });
    const openQ = async (key: string) => {
      await go(`/q/${ids[key]}`);
      await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    };

    // The rename, answered with a note, then a follow-up that a search for "redirect" finds.
    await openQ('rename');
    await page
      .getByRole('radio', { name: /Yes, rename/ })
      .first()
      .check();
    await composer.fill('Inbox reads better in the sidebar, and it matches the docs.');
    await send.click();
    await page
      .locator('.ws .receipt')
      .filter({ hasText: 'Typed into the terminal' })
      .waitFor({ timeout: 30_000 });
    // Reopened, the dock offers the follow-up field once the answer has left the outbox.
    await openQ('rename');
    await page
      .locator('.dock textarea[placeholder="Add a follow-up"]')
      .waitFor({ timeout: 30_000 });
    await composer.fill('Also redirect /canopy to /inbox so old links keep working.');
    await page.locator('.dock').getByRole('button', { name: 'Send follow-up' }).click();
    await page
      .locator('.ws .msg.out', { hasText: 'redirect /canopy' })
      .waitFor({ timeout: 30_000 });

    // The migration guide, answered in words long enough to wrap and clip.
    await openQ('guide');
    await composer.fill(
      'Describe v3 only. Move the v2 steps to an appendix titled “Upgrading from v2”, keep the three v2 screenshots there, and link it from the first paragraph so nobody on v2 gets lost.',
    );
    await send.click();
    await decision('guide', (d) => !!d && d.provenance === 'human');

    // The deploy, whose delivery cannot be confirmed.
    await openQ('deploy');
    await page
      .getByRole('radio', { name: /Wait for Monday/ })
      .first()
      .check();
    await send.click();
    await decision('deploy', (d) => !!d && d.provenance === 'human');

    // The retry strategy: the model said backoff yesterday; the person overrules it with a reason.
    await openQ('retry');
    await page.locator('.ws').getByRole('button', { name: 'Overrule' }).click();
    await page
      .getByRole('radio', { name: /Durable queue/ })
      .first()
      .check();
    await page
      .locator('.dock')
      .getByRole('textbox', { name: 'Reason for the change' })
      .fill('Restarts drop in-flight retries with backoff alone; the partner retries for a day.');
    await page.locator('.dock').getByRole('button', { name: 'Send correction' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send correction' }).click();
    await decision('retry', (d) => !!d && d.choice === 'queue');

    // The changelog: the model answer, confirmed.
    await openQ('changelog');
    await page.locator('.ws').getByRole('button', { name: 'Confirm answer' }).click();
    await sees('Confirmed the model answer', '.ws');

    // Wait out the short-lived question's expiry.
    await until(
      async () => {
        await go('/history');
        return (await row('Publish the draft release notes').count()) > 0;
      },
      90_000,
      'the release-notes question to expire into History',
    );

    // Phone: Decisions, then All activity, then search.
    await go('/history');
    await sees('Rename “Canopy”', '.history-list');
    await sees('Drop the legacy', '.history-list');
    await sees('Delivery issue', '.history-list');
    await shot('p-decisions-light');
    await shot('p-decisions-full-light', { full: true });
    await mode('All activity');
    await sees('Cache the avatar images', '.history-list');
    await shot('p-all-full-light', { full: true });
    await mode('Decisions');
    await search('redirect');
    await sees('Matched a message', '.history-list');
    await shot('p-search-light');
    await search('zebra crossing');
    await sees('No matches in questions saved on this device.');
    await shot('p-search-none-light');
    await page.locator('.nav-empty').getByRole('button', { name: 'Clear search' }).click();
    await sees('Rename “Canopy”', '.history-list');

    // Phone records, as sheets.
    await openRecord('Which retry strategy', false);
    await shot('p-record-correction-light');
    await page.locator('dialog.record-sheet .hist-record').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await shot('p-record-correction-end-light');
    await theme('dark');
    await page.locator('dialog.record-sheet .hist-record').evaluate((el) => {
      el.scrollTop = 0;
    });
    await shot('p-record-correction-dark');
    await theme('light');
    await closeSheet();
    await openRecord('Deploy the webhook fix', false);
    await page.locator('dialog.record-sheet .tl-delivery summary').first().click();
    await page.locator('dialog.record-sheet .tl-steps').first().waitFor();
    await shot('p-record-delivery-light');
    await closeSheet();
    await openRecord('Rename “Canopy”', false);
    await shot('p-record-answered-light');
    await closeSheet();
    await openRecord('Should the changelog entry', false);
    await shot('p-record-confirmed-light');
    await closeSheet();
    await openRecord('Publish the draft release notes', false);
    await shot('p-record-expired-light');
    await closeSheet();
    await openRecord('Drop the legacy', false);
    await shot('p-record-withdrawn-light');
    await closeSheet();
    await theme('dark');
    await settle();
    await shot('p-decisions-dark');
    await theme('light');
  });

  it('captures the tablet sheet and the wide split', async () => {
    await size(TABLET);
    await go('/history');
    await sees('Rename “Canopy”', '.history-list');
    await openRecord('Which retry strategy', false);
    await shot('t-record-correction-light');
    await closeSheet();

    await size(WIDE);
    await go('/history');
    await sees('Choose a decision');
    await shot('w-choose-light');
    await openRecord('Which retry strategy', true);
    await shot('w-record-correction-light');
    await openRecord('Should the changelog entry', true);
    await shot('w-record-confirmed-light');
    await openRecord('Deploy the webhook fix', true);
    await page.locator('.history-record .tl-delivery summary').first().click();
    await shot('w-record-delivery-light');
    await mode('All activity');
    await sees('Cache the avatar images', '.history-list');
    await openRecord('Cache the avatar images', true);
    await shot('w-record-review-light');
    await mode('Decisions');
    await theme('dark');
    await openRecord('Which retry strategy', true);
    await shot('w-record-correction-dark');
    await openRecord('Publish the draft release notes', true);
    await shot('w-record-expired-dark');
    await theme('light');
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await sees(/Offline/, '.history-controls');
    await shot('w-offline-light');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    expect(written).toEqual(expect.arrayContaining(EXPECTED));
  });
});

const EXPECTED = [
  'p-empty-light',
  'w-empty-light',
  'p-decisions-light',
  'p-decisions-full-light',
  'p-all-full-light',
  'p-search-light',
  'p-search-none-light',
  'p-record-correction-light',
  'p-record-correction-end-light',
  'p-record-correction-dark',
  'p-record-delivery-light',
  'p-record-answered-light',
  'p-record-confirmed-light',
  'p-record-expired-light',
  'p-record-withdrawn-light',
  'p-decisions-dark',
  't-record-correction-light',
  'w-choose-light',
  'w-record-correction-light',
  'w-record-confirmed-light',
  'w-record-delivery-light',
  'w-record-review-light',
  'w-record-correction-dark',
  'w-record-expired-dark',
  'w-offline-light',
];
