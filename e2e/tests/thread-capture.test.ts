import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from 'playwright-core';
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
 * Captures the conversation thread for design review: the agent's question, the option cards, the person's replies
 * and their receipts at every delivery stage, the agent's later messages, the conflict card, the system lines, and
 * the loading states.
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test thread-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. Everything goes through the real seams: a real relay, the real desktop
 * client publishing encrypted questions, the PWA paired through its own UI, and answers sent through the dock.
 * Delivery is held or failed by the terminal sink; "Sending…" and the skeleton are held by pausing the app's own
 * requests, never by faking state in the app. Each capture checks what it claims to show before it writes, and the
 * run fails if any expected file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.THREAD_CAPTURE_PORT ?? 8941);
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

/** Lets the conflict capture have the model answer first, after the phone queued its own answer offline. */
let conflictArmed = false;

/** Answers the changelog question with a rationale (and the conflict question once armed); passes on the rest. */
const proxy: ProxyEngine = {
  gateAware: true,
  async suggest(input) {
    if (conflictArmed && input.question.startsWith('Which log level'))
      return {
        action: 'answer',
        selected_option_ids: ['info'],
        confidence: 0.81,
        model_id: 'decision-model-bm25 v1',
        prompt_template_version: '1',
        retrieval_reference_ids: ['r1'],
        risk_flags: [],
      };
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

describe.skipIf(!OUT || !chromiumPath)('captures of the conversation thread', () => {
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
  const origins: Record<string, QuestionOrigin> = {};

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
  const openId = async (key: string) => {
    await go(`/q/${ids[key]}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
  };
  const sees = async (text: string | RegExp) => {
    await page.locator('.ws').getByText(text).first().waitFor({ timeout: 30_000 });
  };
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const toEnd = async () => {
    await page.evaluate(() => {
      const b = document.querySelector('.ws-body');
      if (b) b.scrollTop = b.scrollHeight;
    });
    await settle(500);
  };
  const toTop = async () => {
    await page.evaluate(() => {
      const b = document.querySelector('.ws-body');
      if (b) b.scrollTop = 0;
    });
    await settle(400);
  };
  const filesReady = async () => {
    await page.locator('.fx-inline-stage .fs-slide.is-active img').waitFor({ timeout: 30_000 });
    await until(
      async () =>
        (await page.locator('.fx-thumb img').count()) === (await page.locator('.fx-thumb').count()),
      30_000,
      'every thumbnail to load',
    );
  };
  const typeAnswer = async (text: string) => {
    await page.locator('.dock .composer-field textarea').fill(text);
    await blur();
  };
  const send = () =>
    page.getByRole('button', { name: /^Send (decision|answer)$/ }).click({ timeout: 15_000 });
  const sendFollowUp = async (text: string) => {
    await page.locator('.dock .composer-field textarea').fill(text);
    await blur();
    await page
      .locator('.dock')
      .getByRole('button', { name: /^Send (follow-up|reply)$/ })
      .click({ timeout: 15_000 });
    await page
      .locator('.ws .msg.out', { hasText: text })
      .locator('.receipt')
      .filter({ hasNotText: /Queued|Sending/ })
      .first()
      .waitFor({ timeout: 15_000 });
  };
  const agentSays = async (key: string, text: string, expectsReply: boolean) => {
    await bridge.postMessage(
      { question_id: ids[key], text, expects_reply: expectsReply },
      paneIdentityOf(origins[key]!),
    );
    await bridge.pump();
  };

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
    const home = mkdtempSync(join(tmpdir(), 'decisions-thread-'));
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
      followUps: true,
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
      origins[key] = o;
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
    await ask('conflict', origin('p2', 'billing-api'), {
      question: 'Which log level should the retry worker use in production?',
      kind: 'choice',
      requested_requirement: 'proxy-ok',
      options: [
        { id: 'debug', label: 'Debug' },
        { id: 'info', label: 'Info' },
        { id: 'warn', label: 'Warn' },
      ],
    });
    await ask('sending', origin('p10', 'daintree'), {
      question: 'Ship the new onboarding checklist behind a flag first?',
      kind: 'approval',
      options: yesNo('Behind a flag', 'Ship to everyone'),
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
    expect(['abstained', 'skipped']).toContain(await bridge.runProxy(ids.choice!));
    expect(['abstained', 'skipped']).toContain(await bridge.runProxy(ids.conflict!));
    await bridge.cancelQuestion(ids.withdrawn!);
    await bridge.pump();
    await go('/');
    await page
      .getByText('Which layout should the Agents view')
      .first()
      .waitFor({ timeout: 30_000 });

    // A whole conversation: the answer is typed into the terminal, the agent reports back, the person adds a
    // follow-up, and the agent asks something it is now waiting on.
    await openId('rename');
    await page
      .getByRole('radio', { name: /Yes, rename/ })
      .first()
      .check();
    await typeAnswer('Inbox reads better in the sidebar.');
    await send();
    await sees(/Delivered to the agent’s terminal|Typed into the terminal/);
    await agentSays(
      'rename',
      'Renamed it in the sidebar, the command palette and the onboarding tour. The settings page still says “Canopy notifications”.',
      false,
    );
    await sees('Renamed it in the sidebar');
    await sendFollowUp('Rename that one too, and the docs page.');
    await agentSays(
      'rename',
      'Should the old /canopy route redirect to /inbox, or should it 404 now?',
      true,
    );
    await sees('Should the old /canopy route');

    // Held by the computer that asked (its host is offline).
    await openId('text');
    await typeAnswer(
      'Describe v3 only. Move the v2 steps to an appendix and link it from the intro.',
    );
    await send();
    await sees('Received by your computer');

    // Typed nowhere: the pane it was asked from has closed.
    await openId('problem');
    await page
      .getByRole('radio', { name: /Merge it/ })
      .first()
      .check();
    await send();
    await sees(/Needs attention on your computer/);

    const wait = expiresAt + 2_000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
  });

  it('captures each thread state on a phone', async () => {
    // The open question: sender, question, files, context, the option cards and the deadline.
    await go('/');
    await page.getByText('Which layout should the Agents view').first().click();
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await filesReady();
    await shot('p-open-choice-light');
    await theme('dark');
    await filesReady();
    await shot('p-open-choice-dark');
    await theme('light');
    await toEnd();
    await page
      .getByRole('radio', { name: /Compact sidebar/ })
      .first()
      .check();
    await blur();
    await page.getByRole('button', { name: /^Send (decision|answer)$/ }).waitFor();
    await shot('p-open-choice-selected-light');
    await theme('dark');
    await shot('p-open-choice-selected-dark');
    await theme('light');

    // A human-required approval with its context open.
    await openId('gate');
    await sees('Rotate the production webhook signing secret tonight?');
    await page.locator('.ws .msg-context > summary').first().click();
    await blur();
    await shot('p-gate-context-light');

    // The answer in flight: the relay's reply to the send is held, so "Sending…" is what the app really shows.
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => (release = r));
    const hold = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await held;
      await route.continue().catch(() => {});
    };
    await context.route(`**/questions/${ids.sending}/**`, hold);
    await openId('sending');
    await page
      .getByRole('radio', { name: /Behind a flag/ })
      .first()
      .check();
    await send();
    await sees('Sending…');
    await shot('p-sending-light');
    release!();
    await sees(/Delivered to the agent’s terminal|Typed into the terminal|Saved on your relay/);
    await context.unroute(`**/questions/${ids.sending}/**`, hold);

    // The whole conversation, at its end.
    await openId('rename');
    await sees('Should the old /canopy route');
    await toEnd();
    await shot('p-conversation-end-light');
    await theme('dark');
    await shot('p-conversation-end-dark');
    await theme('light');
    await toTop();
    await shot('p-conversation-top-light');

    // Received by the computer, not yet typed; then its stepper opened.
    await openId('text');
    await sees('Received by your computer');
    await shot('p-received-light');
    await page
      .locator('.ws')
      .getByRole('button', { name: /Received by your computer/ })
      .first()
      .click();
    await page.locator('.ws .stepper:visible').first().waitFor({ timeout: 10_000 });
    await shot('p-received-stepper-light');
    await theme('dark');
    await shot('p-received-stepper-dark');
    await theme('light');

    await openId('problem');
    await sees(/Needs attention on your computer/);
    await shot('p-attention-light');
    await theme('dark');
    await shot('p-attention-dark');
    await theme('light');

    await openId('proxy');
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
    await sees(/Expired without an answer/);
    await shot('p-expired-light');

    await openId('withdrawn');
    await sees('Withdrawn by your agent');
    await theme('dark');
    await shot('p-withdrawn-dark');
    await theme('light');

    // The conflict: the phone queues its answer offline, the model answers first, the phone reconnects.
    await openId('conflict');
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.getByRole('radio', { name: /^Warn/ }).first().check();
    await typeAnswer('Warn keeps the noise down; we can raise it when something breaks.');
    await send();
    await sees(/Queued/);
    await shot('p-queued-offline-light');
    conflictArmed = true;
    await local.setMeta(`proxy:${ids.conflict}`, '');
    expect(await bridge.runProxy(ids.conflict!)).toBe('answered');
    await bridge.pump();
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#ws-conflict').waitFor({ timeout: 30_000 });
    await toEnd();
    await shot('p-conflict-light');
    await theme('dark');
    await shot('p-conflict-dark');
    await theme('light');
  });

  it('captures the loading states', async () => {
    // A question this device has not fetched, while the relay's event feed is held: the skeleton, then
    // "Still loading" after five seconds, then (feed released) the question that is not there.
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => (release = r));
    const hold = async (route: Route) => {
      await held;
      await route.continue().catch(() => {});
    };
    await context.route('**/events**', hold);
    await page.goto(relay.origin + '/q/q_01JCZZZZZZZZZZZZZZZZZZZZZZ');
    await page.locator('.ws[data-state="opening"] .ws-loading').waitFor({ timeout: 30_000 });
    await settle(900);
    await shot('p-skeleton-light');
    await theme('dark');
    await shot('p-skeleton-dark');
    await theme('light');
    await page
      .locator('.ws-slow')
      .getByText('Still loading this question…')
      .waitFor({ timeout: 15_000 });
    await shot('p-loading-slow-light');
    release!();
    await context.unroute('**/events**', hold);
    await page
      .getByRole('heading', { name: 'This question is no longer available' })
      .waitFor({ timeout: 30_000 });
    await shot('p-unavailable-light');
  });

  it('captures the wide layout', async () => {
    await page.setViewportSize(WIDE);
    await openId('rename');
    await sees('Should the old /canopy route');
    await toEnd();
    await shot('w-conversation-light');
    await openId('conflict');
    await page.locator('#ws-conflict').waitFor({ timeout: 30_000 });
    await theme('dark');
    await toEnd();
    await shot('w-conflict-dark');
    await theme('light');
    await openId('choice');
    await filesReady();
    await shot('w-open-choice-light');
    await page.setViewportSize(PHONE);

    const expected = [
      'p-open-choice-light',
      'p-open-choice-dark',
      'p-open-choice-selected-light',
      'p-open-choice-selected-dark',
      'p-gate-context-light',
      'p-sending-light',
      'p-conversation-end-light',
      'p-conversation-end-dark',
      'p-conversation-top-light',
      'p-received-light',
      'p-received-stepper-light',
      'p-received-stepper-dark',
      'p-attention-light',
      'p-attention-dark',
      'p-model-review-light',
      'p-model-review-dark',
      'p-expired-light',
      'p-withdrawn-dark',
      'p-queued-offline-light',
      'p-conflict-light',
      'p-conflict-dark',
      'p-skeleton-light',
      'p-skeleton-dark',
      'p-loading-slow-light',
      'p-unavailable-light',
      'w-conversation-light',
      'w-conflict-dark',
      'w-open-choice-light',
    ];
    const missing = expected.filter((n) => !existsSync(join(OUT!, `${n}.png`)));
    expect(missing).toEqual([]);
    expect(written.length).toBe(expected.length);
  });
});
