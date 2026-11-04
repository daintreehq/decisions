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
 * Captures the question screen in every state that carries design weight, for design review:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test question-chat-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. Everything goes through the real seams: a real relay, the real desktop
 * client publishing encrypted questions (with real attachments), the PWA paired through its own UI, and answers
 * sent through the dock. Delivery is held or failed by the terminal sink, never faked in the app. Each capture
 * checks what it claims to show before it writes, and the run fails if any expected file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.QUESTION_CAPTURE_PORT ?? 8831);
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 820 };

/** Pane p3's host is offline (its answer waits on the computer); pane p5 is gone (delivery needs attention). */
class Sink implements TerminalSink {
  async locate(o: QuestionOrigin): Promise<LocateResult> {
    if (o.pane_id === 'p3') return { state: 'host-offline' };
    if (o.pane_id === 'p5') return { state: 'gone' };
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

/** Answers the changelog question with a rationale, and passes on everything else. */
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
      retrieval_reference_ids: ['r1', 'r2', 'r3'],
      rationale:
        'You filed the last three behaviour changes that were not bug fixes under “Changed”, including the retry-limit change in billing-api.',
      risk_flags: [],
    };
  },
};

/** A plausible desktop screen, so the screenshots in the question have something real to show. */
async function mockUi(browser: Browser, variant: 'before' | 'after'): Promise<Uint8Array> {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const wide = variant === 'before';
  await page.setContent(`
    <body style="margin:0;font:14px -apple-system,system-ui,sans-serif;background:#0f1a14;color:#d7efe0">
      <div style="display:flex;height:400px">
        <div style="width:${wide ? 220 : 64}px;background:#13261c;padding:14px;box-sizing:border-box;border-right:1px solid #24402f">
          <div style="font-weight:700;margin-bottom:14px">${wide ? 'Daintree' : 'D'}</div>
          ${['Projects', 'Agents', 'Worktrees', 'Settings']
            .map(
              (t) =>
                `<div style="padding:9px 8px;border-radius:8px;margin:3px 0;background:${t === 'Agents' ? '#1f3d2c' : 'transparent'}">${wide ? t : t[0]}</div>`,
            )
            .join('')}
        </div>
        <div style="flex:1;padding:18px">
          <div style="font-size:18px;font-weight:700;margin-bottom:12px">Agents</div>
          ${[1, 2, 3].map((i) => `<div style="background:#16291f;border:1px solid #24402f;border-radius:10px;padding:12px;margin-bottom:10px">feature/login-${i} <span style="float:right;color:#6fe3a2">working</span></div>`).join('')}
        </div>
      </div>
    </body>`);
  const buf = new Uint8Array(await page.screenshot({ type: 'png' }));
  await page.close();
  return buf;
}

describe.skipIf(!OUT || !chromiumPath)('captures of the question screen', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  const local = new MemoryLocalStore();
  const images = new Map<string, Uint8Array>();
  const written: string[] = [];
  const ids: Record<string, string> = {};

  const settle = async (ms = 500) => {
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
  const go = async (path: string) => {
    await page.goto(relay.origin + path);
    await page.locator('#main').waitFor({ timeout: 30_000 });
  };
  /** The question screen for `key`, opened straight from its id as a notification would. */
  const openId = async (key: string) => {
    await go(`/q/${ids[key]}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
  };
  /** Waits until the question screen shows `text`, so a capture never records a half-loaded state. */
  const sees = async (text: string | RegExp) => {
    await page.locator('.ws').getByText(text).first().waitFor({ timeout: 30_000 });
  };
  /** The inline preview shows its active file and every thumbnail has loaded. */
  const filesReady = async () => {
    await page.locator('.fx-inline-stage .fs-slide.is-active img').waitFor({ timeout: 30_000 });
    await until(
      async () =>
        (await page.locator('.fx-thumb img').count()) === (await page.locator('.fx-thumb').count()),
      30_000,
      'every thumbnail to load',
    );
  };
  /** Types into the composer's field and puts the keyboard away again. */
  const typeAnswer = async (text: string) => {
    await page.locator('.dock .composer-field textarea').fill(text);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };
  const send = () =>
    page.getByRole('button', { name: /^Send (decision|answer)$/ }).click({ timeout: 15_000 });

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT);
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    images.set('before.png', await mockUi(browser, 'before'));
    images.set('after.png', await mockUi(browser, 'after'));
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

  it('pairs and asks a realistic set of questions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-question-'));
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
      resolver: { resolve: async (_o, id) => (images.has(id) ? { bytes: images.get(id)! } : null) },
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

    // Asked first, so it is past its deadline by the time it is captured.
    const expiresAt = Date.now() + 65_000;
    await ask('expired', origin('p8', 'docs-site'), {
      question: 'Publish the draft release notes to the docs site now?',
      kind: 'approval',
      options: yesNo('Publish', 'Not yet'),
      expires_at: new Date(expiresAt).toISOString(),
    });
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
    await ask('rename', origin('p4', 'daintree'), {
      question: 'Rename “Canopy” to “Inbox” in the sidebar?',
      kind: 'approval',
      options: yesNo('Yes, rename', 'Keep Canopy'),
    });
    await ask('problem', origin('p5', 'billing-api'), {
      question: 'Merge the webhook retry branch into main now that CI is green?',
      kind: 'approval',
      options: yesNo('Merge it', 'Hold for review'),
    });
    await ask('text', origin('p3', 'customer-onboarding-service', 'gemini'), {
      question:
        'The migration guide mentions v2 in three places and v3 in one. Which version should it describe, and should the v2 steps move to an appendix?',
      kind: 'text',
      options: [],
    });
    await ask('gate', origin('p9', 'billing-api'), {
      question: 'Rotate the production webhook signing secret tonight?',
      context:
        'The current secret was in a log line that reached the shared error tracker on Monday. Rotating invalidates it for every partner at once; each has a 24-hour grace window with the old secret.',
      kind: 'approval',
      requested_requirement: 'human-required',
      options: yesNo('Rotate tonight', 'Wait for the weekly window'),
    });
    await ask('choice', origin('p1', 'daintree'), {
      question: 'Which layout should the Agents view use below 900px?',
      context:
        'Design review, round 3. Both layouts keep every shortcut. The compact sidebar collapses to icons with tooltips; the drawer hides the sidebar until the menu button is pressed.\n\nBefore and after screenshots are attached. `⌘B` still toggles the sidebar in both.',
      kind: 'choice',
      requested_requirement: 'proxy-ok',
      expires_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      options: [
        {
          id: 'compact',
          label: 'Compact sidebar',
          description: 'Icons with tooltips, always visible',
        },
        {
          id: 'drawer',
          label: 'Drawer',
          description: 'Hidden until the menu button is pressed',
        },
        { id: 'keep', label: 'Keep the full sidebar' },
      ],
      attachments: [
        { local_resource_id: 'before.png', role: 'before' },
        { local_resource_id: 'after.png', role: 'after' },
      ],
    });
    await bridge.pump();
    expect(await bridge.runProxy(ids.proxy!)).toBe('answered');
    // The bridge may already have run the engine on it (it passes either way).
    expect(['abstained', 'skipped']).toContain(await bridge.runProxy(ids.choice!));
    await bridge.cancelQuestion(ids.withdrawn!);
    await bridge.pump();
    await go('/');
    await page
      .getByText('Which layout should the Agents view')
      .first()
      .waitFor({ timeout: 30_000 });

    // Answers through the dock: one delivered, one held by an offline host, one whose pane is gone.
    await openId('rename');
    await page
      .getByRole('radio', { name: /Yes, rename/ })
      .first()
      .check();
    await typeAnswer('Inbox reads better in the sidebar.');
    await send();
    await sees(/Delivered to the agent’s terminal|Typed into the terminal/);

    await openId('text');
    await typeAnswer(
      'Describe v3 only. Move the v2 steps to an appendix and link it from the intro.',
    );
    await send();
    await sees('Received by your computer');

    await openId('problem');
    await page
      .getByRole('radio', { name: /Merge it/ })
      .first()
      .check();
    await send();
    await sees(/Needs attention on your computer/);

    // Wait out the short-lived question's deadline.
    const wait = expiresAt + 2_000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
  });

  it('captures each state on a phone, in both themes', async () => {
    // An open choice, opened from Home (so Back is offered), with screenshots, context and descriptions.
    await go('/');
    await page.getByText('Which layout should the Agents view').first().click();
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await filesReady();
    await shot('p-open-choice-light');
    await theme('dark');
    await filesReady();
    await shot('p-open-choice-dark');
    await theme('light');
    // Scrolled to the end of the thread: the header carries the question's excerpt.
    await page.evaluate(() => {
      const b = document.querySelector('.ws-body');
      if (b) b.scrollTop = b.scrollHeight;
    });
    await settle(700);
    await shot('p-open-choice-scrolled-light');
    await page
      .getByRole('radio', { name: /Compact sidebar/ })
      .first()
      .check();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.getByRole('button', { name: /^Send (decision|answer)$/ }).waitFor();
    await shot('p-open-choice-selected-light');

    // The text answer, saved on the relay and received by the computer, but not yet typed.
    await openId('text');
    await sees('Received by your computer');
    await shot('p-text-delivery-light');
    await theme('dark');
    await shot('p-text-delivery-dark');
    await theme('light');
    await page
      .locator('.ws')
      .getByRole('button', { name: /Received by your computer/ })
      .first()
      .click();
    await page.locator('.ws .stepper:visible').first().waitFor({ timeout: 10_000 });
    await shot('p-text-delivery-stepper-light');

    await openId('problem');
    await sees(/Needs attention on your computer/);
    await shot('p-delivery-problem-light');
    await theme('dark');
    await shot('p-delivery-problem-dark');
    await theme('light');

    await openId('proxy');
    await sees('Changed');
    await page
      .locator('.ws')
      .getByText(/Model answer/)
      .first()
      .waitFor({ timeout: 30_000 });
    await shot('p-model-review-light');
    await theme('dark');
    await shot('p-model-review-dark');
    await theme('light');

    await openId('expired');
    await sees(/expired/i);
    await shot('p-expired-light');
    await theme('dark');
    await shot('p-expired-dark');
    await theme('light');

    await openId('gate');
    await sees('Rotate the production webhook signing secret tonight?');
    await shot('p-gate-light');
    await theme('dark');
    await shot('p-gate-dark');
    await theme('light');

    await openId('withdrawn');
    await sees('Withdrawn by your agent');
    await shot('p-withdrawn-light');

    await openId('rename');
    await sees(/Delivered to the agent’s terminal|Typed into the terminal/);
    await shot('p-answered-light');
  });

  it('captures the wide layout beside the sidebar column', async () => {
    await page.setViewportSize(WIDE);
    await openId('choice');
    await filesReady();
    await shot('w-open-choice-light');
    await theme('dark');
    await openId('proxy');
    await page
      .locator('.ws')
      .getByText(/Model answer/)
      .first()
      .waitFor({ timeout: 30_000 });
    await shot('w-model-review-dark');
    await theme('light');
    await page.setViewportSize(PHONE);

    const expected = [
      'p-open-choice-light',
      'p-open-choice-dark',
      'p-open-choice-scrolled-light',
      'p-open-choice-selected-light',
      'p-text-delivery-light',
      'p-text-delivery-dark',
      'p-text-delivery-stepper-light',
      'p-delivery-problem-light',
      'p-delivery-problem-dark',
      'p-model-review-light',
      'p-model-review-dark',
      'p-expired-light',
      'p-expired-dark',
      'p-gate-light',
      'p-gate-dark',
      'p-withdrawn-light',
      'p-answered-light',
      'w-open-choice-light',
      'w-model-review-dark',
    ];
    const missing = expected.filter((n) => !existsSync(join(OUT!, `${n}.png`)));
    expect(missing).toEqual([]);
    expect(written.length).toBe(expected.length);
  });
});
