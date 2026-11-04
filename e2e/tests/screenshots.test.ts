import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
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
  revokeAndRotate,
  type LocateResult,
  type ProxyEngine,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Captures every screen and state of the running phone app, for documentation and design review.
 *   SCREENSHOTS_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test screenshots
 * (DESIGN_CAPTURE_DIR works too.) Skipped unless one of them is set. Needs `pnpm build` first.
 *
 * Everything goes through the real seams: a real relay (wrangler dev), the real desktop client publishing
 * encrypted questions, and the real PWA paired through its own UI. Nothing in the app is mocked.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR ?? process.env.SCREENSHOTS_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.SCREENSHOTS_PORT ?? 8801);
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 820 };
const WIDER = { width: 1440, height: 900 };
const TABLET = { width: 834, height: 1194 };

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

/** Lets the conflict capture have the model answer first, after the phone queued its own answer offline. */
let conflictArmed = false;

/** Answers only the changelog question, so the inbox holds one proxy answer and one abstention. */
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
        retrieval_reference_ids: [],
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

/** Draws a plausible desktop UI so the before/after comparison has something real to show. */
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

/** Renders arbitrary markup as a PNG, for the multi-file gallery fixture. */
async function mockShot(
  browser: Browser,
  size: { width: number; height: number },
  body: string,
): Promise<Uint8Array> {
  const page = await browser.newPage({ viewport: size });
  await page.setContent(
    `<body style="margin:0;font:14px -apple-system,system-ui,sans-serif">${body}</body>`,
  );
  const buf = new Uint8Array(await page.screenshot({ type: 'png' }));
  await page.close();
  return buf;
}

const settingRow = (label: string, value: string) =>
  `<div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #e6e1d8;background:#ffffff"><span>${label}</span><span style="color:#6b6458">${value}</span></div>`;

/** Five different screens for the strip: wide desktop, a tall phone capture, a dialog, a chart, a terminal. */
async function galleryShots(browser: Browser): Promise<Record<string, Uint8Array>> {
  return {
    'g-settings.png': await mockShot(
      browser,
      { width: 1280, height: 800 },
      `<div style="display:flex;height:800px;background:#f6f0e6;color:#1c2028">
        <div style="width:240px;background:#f2e9da;padding:20px;box-sizing:border-box;border-right:1px solid #ddd3c2">
          ${['General', 'Appearance', 'Agents', 'Keyboard', 'Notifications'].map((t, i) => `<div style="padding:10px 12px;border-radius:8px;margin:2px 0;${i === 1 ? 'background:#fff;font-weight:600' : ''}">${t}</div>`).join('')}
        </div>
        <div style="flex:1;padding:32px 40px">
          <div style="font-size:24px;font-weight:700;margin-bottom:20px">Appearance</div>
          <div style="border:1px solid #ddd3c2;border-radius:10px;overflow:hidden;max-width:720px">
            ${settingRow('Theme', 'Match device')}${settingRow('Density', 'Compact')}${settingRow('Sidebar', 'Collapse below 900 px')}${settingRow('Font size', '14 px')}${settingRow('Reduce motion', 'Follow system')}
          </div>
        </div>
      </div>`,
    ),
    'g-phone.png': await mockShot(
      browser,
      { width: 390, height: 1200 },
      `<div style="background:#110d0b;color:#e4e4e7;min-height:1200px;padding:56px 18px 18px;box-sizing:border-box">
        <div style="font-size:26px;font-weight:700;margin-bottom:16px">Agents</div>
        ${Array.from({ length: 9 }, (_, i) => `<div style="background:#1f1b19;border:1px solid #2e2926;border-radius:12px;padding:16px;margin-bottom:12px"><div style="font-weight:600">checkout-${i + 1}</div><div style="color:#a1a1aa;margin-top:6px">${i % 3 === 0 ? 'Waiting for you' : 'Working · 4 files changed'}</div></div>`).join('')}
      </div>`,
    ),
    'g-dialog.png': await mockShot(
      browser,
      { width: 900, height: 560 },
      `<div style="height:560px;display:grid;place-items:center;background-color:#3a3632">
        <div style="width:440px;background:#fff;border-radius:14px;padding:24px;color:#1c2028;box-shadow:0 20px 60px rgba(0,0,0,.35)">
          <div style="font-size:18px;font-weight:700">Delete this workspace?</div>
          <p style="color:#454d56;line-height:1.5">checkout-3 has 2 unsaved changes. They will be lost.</p>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px"><span style="padding:10px 16px;border:1px solid #ccc;border-radius:8px">Cancel</span><span style="padding:10px 16px;background:#aa3931;color:#fff;border-radius:8px">Delete</span></div>
        </div>
      </div>`,
    ),
    'g-chart.png': await mockShot(
      browser,
      { width: 1000, height: 620 },
      `<div style="height:620px;background:#1a1918;color:#e4e4e7;padding:28px;box-sizing:border-box">
        <div style="font-size:18px;font-weight:700;margin-bottom:24px">Webhook retries, last 24 h</div>
        <div style="display:flex;align-items:flex-end;gap:14px;height:440px;border-bottom:1px solid #3f3b38">
          ${[40, 62, 55, 90, 140, 210, 320, 280, 190, 120, 80, 60, 45, 70, 110].map((h) => `<div style="flex:1;height:${h}px;background:#36ce94;border-radius:4px 4px 0 0"></div>`).join('')}
        </div>
      </div>`,
    ),
    'g-terminal.png': await mockShot(
      browser,
      { width: 1100, height: 520 },
      `<pre style="margin:0;height:520px;background:#110d0b;color:#e4e4e7;padding:22px;font:15px/1.6 ui-monospace,Menlo,monospace;box-sizing:border-box">$ pnpm test
 ✓ checkout/cart.test.ts (14)
 ✓ checkout/payment.test.ts (22)
 × checkout/retry.test.ts (3)
   → expected 5 retries, received 3

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 38 passed (39)</pre>`,
    ),
  };
}

describe.skipIf(!OUT || !chromiumPath)('screenshots of the running app', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  let keyStore: FileKeyStore;
  const local = new MemoryLocalStore();
  const images = new Map<string, Uint8Array>();
  const written: string[] = [];
  const ids: Record<string, string> = {};
  const origins: Record<string, QuestionOrigin> = {};

  const settle = async () => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);
  };
  /**
   * A full-page shot grows the viewport to the page height rather than stitching, so fixed and sticky
   * elements (tab bar, action bar) render where they really sit instead of mid-page.
   */
  const shot = async (name: string, opts: { full?: boolean } = {}) => {
    await settle();
    const path = join(OUT!, `${name}.png`);
    const vp = page.viewportSize()!;
    if (opts.full) {
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      if (h > vp.height) {
        await page.setViewportSize({ width: vp.width, height: Math.min(h, 4000) });
        await settle();
      }
    }
    await page.screenshot({ path });
    if (opts.full) await page.setViewportSize(vp);
    written.push(`${name}.png`);
  };
  const theme = async (scheme: 'light' | 'dark') => {
    await page.emulateMedia({ colorScheme: scheme });
  };
  /** The inline gallery shows its active file and every thumbnail has loaded. */
  const filesReady = async () => {
    await page.locator('.fx-inline-stage .fs-slide.is-active img').waitFor({ timeout: 30_000 });
    await until(
      async () =>
        (await page.locator('.fx-thumb img').count()) === (await page.locator('.fx-thumb').count()),
      30_000,
      'every thumbnail to load',
    );
  };
  const open = async (text: string) => {
    await page.goto(relay.origin + '/');
    await page.getByText(text).first().click();
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
  };
  /** Opens a question straight from its id, as a notification would. */
  const openId = async (key: string) => {
    await page.goto(`${relay.origin}/q/${ids[key]}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
  };
  /** Types into the composer's field; unless kept focused, the keyboard goes away again. */
  const typeAnswer = async (text: string, keepOpen = false) => {
    const field = page.locator('.dock .composer-field textarea');
    await field.fill(text);
    if (keepOpen) await field.focus();
    else await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT);
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      // A fake microphone (a steady tone) so dictation and Settings' microphone test run for real.
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    images.set('before.png', await mockUi(browser, 'before'));
    images.set('after.png', await mockUi(browser, 'after'));
    for (const [k, v] of Object.entries(await galleryShots(browser))) images.set(k, v);
    context = await browser.newContext({
      viewport: PHONE,
      deviceScaleFactor: 2,
      colorScheme: 'light',
      serviceWorkers: 'allow',
      locale: 'en-GB',
      timezoneId: 'Europe/London',
    });
    page = await context.newPage();
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('captures the app before and during pairing', async () => {
    await page.goto(relay.origin + '/');
    await page.getByRole('heading', { name: 'Daintree Decisions' }).waitFor();
    await shot('01-welcome');
    await theme('dark');
    await shot('01-welcome-dark');
    await theme('light');
    await page.goto(relay.origin + '/install');
    await shot('02-install', { full: true });
    await page.goto(relay.origin + '/privacy');
    await shot('03-privacy', { full: true });
    await page.goto(relay.origin + '/pair');
    await shot('04-pair-start');
    await page.getByRole('button', { name: 'Paste pairing link' }).click();
    await shot('04-pair-no-invite');
    // The camera is never granted here, which is exactly the scanner's failure state.
    await page.goto(relay.origin + '/pair');
    // The fake media device gives Chromium a camera; take it away again for the scanner's failure state.
    await page.evaluate(() => {
      const md = navigator.mediaDevices;
      const real = md.getUserMedia.bind(md);
      md.getUserMedia = (c) =>
        c?.video ? Promise.reject(new DOMException('No camera', 'NotFoundError')) : real(c);
    });
    await page.getByRole('button', { name: 'Scan pairing code' }).click();
    await page.locator('.scanner [role="alert"]').waitFor({ timeout: 15_000 });
    await shot('04-pair-scan-error');

    const home = mkdtempSync(join(tmpdir(), 'decisions-shot-'));
    keyStore = new FileKeyStore(home);
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
      followUps: true,
      resolver: { resolve: async (_o, id) => (images.has(id) ? { bytes: images.get(id)! } : null) },
    });
    await bridge.start();

    const invite = await createPairingInvite(client, 'phone');
    // The invite is read from the fragment on load, so force a real load rather than a hash change.
    await page.goto('about:blank');
    await page.goto(invite.url);
    await page.getByRole('button', { name: 'Pair this device' }).waitFor();
    await shot('05-pair-invite');
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByText('Check that this matches your computer').waitFor({ timeout: 20_000 });
    await shot('06-pair-code');
    const cand = await until(
      async () =>
        (await client.pendingPairings()).pending.find((p) => p.pairing_id === invite.pairingId),
      20_000,
      'pending pairing',
    );
    await approveCandidate(client, cand);
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
    await page.getByText('Nothing needs you right now.').waitFor({ timeout: 30_000 });
    await shot('07-inbox-empty');
  });

  it('captures a realistic inbox and every question state', async () => {
    // One project (docs-site) comes from a host without a human label, to show the raw-id fallback.
    const origin = (pane: string, project: string, agent = 'claude-code'): QuestionOrigin => ({
      ...(project === 'docs-site' ? {} : { machine_label: 'Greg’s MacBook Pro' }),
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

    // Created first so it has passed its expiry by the time the inbox is captured.
    const expiresAt = Date.now() + 62_000;
    await ask('expired', origin('p8', 'docs-site'), {
      question: 'Publish the draft release notes to the docs site now?',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Publish' },
        { id: 'no', label: 'Not yet' },
      ],
      expires_at: new Date(expiresAt).toISOString(),
    });
    await ask('answered', origin('p4', 'daintree'), {
      question: 'Rename “Canopy” to “Inbox” in the sidebar?',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Yes, rename' },
        { id: 'no', label: 'Keep Canopy' },
      ],
    });
    await ask('cancelled', origin('p7', 'billing-api'), {
      question: 'Drop the legacy /v1/invoices endpoint in this release?',
      kind: 'approval',
      options: [
        { id: 'drop', label: 'Drop it' },
        { id: 'keep', label: 'Keep it one more release' },
      ],
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
    await ask('design', origin('p1', 'daintree'), {
      question: 'Approve the compact sidebar for the Agents view?',
      context:
        'Design review, round 3. The sidebar collapses to icons below 900px. Keyboard shortcuts are unchanged.\n\nBefore and after screenshots are attached. The collapsed state keeps tooltips on every icon, and `⌘B` still toggles it.',
      kind: 'approval',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      attachments: [
        { local_resource_id: 'before.png', role: 'before' },
        { local_resource_id: 'after.png', role: 'after' },
      ],
    });
    await ask('choice', origin('p2', 'billing-api'), {
      question: 'Which retry strategy should the webhook sender use?',
      context:
        'Failures are mostly 502s from the partner gateway. Exponential backoff is simplest; a queue with dead-lettering is more work but survives restarts.',
      kind: 'choice',
      requested_requirement: 'proxy-ok',
      options: [
        {
          id: 'backoff',
          label: 'Exponential backoff',
          description: 'Up to 5 tries over ~30 minutes',
        },
        {
          id: 'queue',
          label: 'Durable queue + dead letter',
          description: 'Survives restarts, more moving parts',
        },
        { id: 'both', label: 'Backoff now, queue later' },
      ],
    });
    await ask('text', origin('p3', 'customer-onboarding-service', 'gemini'), {
      question:
        'The migration guide mentions v2 in three places and v3 in one. Which version should it describe, and should the v2 steps move to an appendix?',
      kind: 'text',
      options: [],
      expires_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    });
    await bridge.pump();
    // The engine answers the changelog question and passes on the retry one ("waiting for you").
    expect(await bridge.runProxy(ids.proxy!)).toBe('answered');
    expect(await bridge.runProxy(ids.choice!)).toBe('abstained');
    await bridge.cancelQuestion(ids.cancelled!);
    await bridge.pump();

    await page.goto(relay.origin + '/');
    await page.getByText('Approve the compact sidebar').first().waitFor({ timeout: 30_000 });
    await page.getByText('Which version should it describe').first().waitFor({ timeout: 30_000 });
    await shot('08-inbox');

    // Answer the rename question through the UI, so one item is answered and delivered.
    await open('Rename “Canopy”');
    await page
      .getByRole('radio', { name: /Yes, rename/ })
      .first()
      .check();
    await shot('30-ws-approval-selected');
    // A note, so History and its timeline show an answer with words in it.
    await typeAnswer('Inbox reads better in the sidebar.');
    await page.getByRole('button', { name: 'Send decision' }).click();
    await page
      .locator('.ws .receipt')
      .filter({ hasText: 'Typed into the terminal' })
      .waitFor({ timeout: 30_000 });
    await shot('15-detail-answered');
    // The answer is final; more is a follow-up. Two of them, then the agent's reply in the same thread.
    for (const words of [
      'Also rename the route from /canopy to /inbox, with a redirect.',
      'And update the screenshot in the docs.',
    ]) {
      await typeAnswer(words);
      await page.getByRole('button', { name: 'Send follow-up' }).click();
      await page
        .locator('.ws .msg.out', { hasText: words })
        .locator('.receipt')
        .filter({ hasNotText: /Queued|Sending/ })
        .first()
        .waitFor({ timeout: 30_000 });
    }
    await bridge.postMessage(
      {
        question_id: ids.answered,
        text: 'Done: the sidebar says Inbox, /canopy redirects to /inbox, and the docs screenshot is updated.',
        expects_reply: false,
      },
      paneIdentityOf(origins.answered!),
    );
    await bridge.pump();
    await page.locator('.ws .msg.note').waitFor({ timeout: 30_000 });
    await page.evaluate(() => {
      const b = document.querySelector('.ws-body');
      if (b) b.scrollTop = b.scrollHeight;
    });
    await shot('16-detail-follow-up');

    await open('Approve the compact sidebar');
    await filesReady();
    await shot('09-detail-approval');
    await shot('09-detail-approval-full', { full: true });
    await page
      .getByRole('radio', { name: /^Approve/ })
      .first()
      .check();
    await shot('10-detail-approval-selected');
    // The README hero: the choice made, a note for the agent, Send in the composer.
    await typeAnswer('Ship it. Keep the tooltips on every icon.');
    await shot('10-detail-approval-note');
    await typeAnswer('');
    await page.getByRole('tab', { name: /^After/ }).click();
    await page.getByRole('button', { name: /Enlarge After/ }).click();
    await page.locator('.fx-viewer .fs-slide.is-active img').waitFor({ timeout: 30_000 });
    await shot('11-dialog-zoom');
    await page.getByRole('button', { name: 'Close viewer' }).click();
    await page.locator('.fx-viewer').waitFor({ state: 'detached' });

    await open('Which retry strategy');
    await shot('12-detail-choice', { full: true });
    await open('Which version should it describe');
    await typeAnswer('Describe v3 only. Move the v2 steps to an appendix');
    await shot('13-detail-text');
    await typeAnswer('');

    // Home lists every question in sections: model answers to review sit below Needs you.
    await page.goto(relay.origin + '/');
    const proxyRow = page.locator('main .qrow', { hasText: 'Should the changelog entry' });
    await proxyRow.waitFor({ timeout: 30_000 });
    await proxyRow.scrollIntoViewIfNeeded();
    await shot('19-inbox-proxy-tab');
    await proxyRow.click();
    await page.locator('.ws .msg.model').waitFor({ timeout: 30_000 });
    await shot('14-detail-proxy', { full: true });

    // Wait out the short-lived question's expiry (usually already past by now).
    const wait = expiresAt + 2_000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    await page.goto(relay.origin + '/');
    const expiredRow = page.locator('main .qrow', { hasText: 'Publish the draft release notes' });
    await expiredRow.waitFor({ timeout: 30_000 });
    await shot('20-inbox-all-tab', { full: true });
    await expiredRow.click();
    await shot('18-detail-expired');
    await page.goto(relay.origin + '/');
    await page.locator('main .qrow', { hasText: 'Drop the legacy' }).click();
    await shot('18-detail-cancelled');
  });

  it('captures history, devices, settings, offline, dark mode and the wide layout', async () => {
    await page.goto(relay.origin + '/history');
    await page.getByText('Rename “Canopy”').first().waitFor({ timeout: 30_000 });
    await shot('21-history');
    await page.goto(relay.origin + '/devices');
    await page.getByRole('heading', { name: 'This device' }).waitFor({ timeout: 30_000 });
    await shot('22-devices');
    await page.goto(relay.origin + '/settings');
    await page.getByRole('link', { name: /Quiet hours & reminders/ }).waitFor();
    await page.locator('[data-section-row="quiet-hours"] .value:not(:empty)').waitFor();
    await shot('23-settings');
    await shot('70-settings-index', { full: true });

    // Appearance: the three theme cards, applied immediately.
    await page.getByRole('link', { name: /Appearance/ }).click();
    await page.getByRole('heading', { name: 'Appearance' }).waitFor();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll<HTMLImageElement>('.theme-art img')).every(
        (i) => i.complete,
      ),
    );
    await shot('71-appearance');
    // A choice is stored before it shows as selected, so waiting for the mark also waits for the write.
    const pickTheme = async (name: string) => {
      await page.getByText(name, { exact: true }).click();
      await page.locator('.theme-card.on .theme-name', { hasText: name }).waitFor();
    };
    await pickTheme('Daintree');
    await shot('71-appearance-daintree');
    await pickTheme('Bondi');
    await shot('71-appearance-bondi');
    await pickTheme('Match device');

    // Dictation, and the microphone test on Chromium's fake device.
    await page.goto(relay.origin + '/settings/dictation');
    await page.getByRole('heading', { name: 'Dictation' }).waitFor();
    await shot('72-dictation', { full: true });
    await context.grantPermissions(['microphone'], { origin: relay.origin });
    await page.getByRole('button', { name: 'Test microphone' }).click();
    await page.getByText(/Listening/).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1200);
    await shot('72-dictation-mic-test', { full: true });
    await page.getByRole('button', { name: 'Stop' }).click();
    await context.clearPermissions();
    // This relay has no provider keys. To show the configured screen, its info answer reports keys for display
    // only; nothing here starts dictation, so no provider is ever contacted.
    await page.route('**/api/v1/info', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        response: res,
        json: { ...body, voice: { xai: true, anthropic: true, openai: true } },
      });
    });
    await page.goto(relay.origin + '/settings/dictation');
    await page.getByRole('switch', { name: 'Dictation' }).click();
    await page.getByRole('dialog').waitFor();
    await shot('72-dictation-consent');
    await page.getByRole('button', { name: /turn on dictation/ }).click();
    await page.getByText('Speech to text', { exact: true }).waitFor();
    await shot('72-dictation-on', { full: true });
    await page.getByRole('switch', { name: 'Dictation' }).click();
    await page.getByText('Speech to text', { exact: true }).waitFor({ state: 'hidden' });
    await page.unroute('**/api/v1/info');

    await page.goto(relay.origin + '/settings/notifications');
    await page.getByRole('heading', { name: 'Notifications' }).waitFor();
    await shot('73-notifications');

    // Quiet hours: loaded, dirty, invalid, the leave guard, then saved.
    await page.goto(relay.origin + '/settings/quiet-hours');
    await page.getByLabel('Quiet hours', { exact: true }).waitFor({ timeout: 30_000 });
    await shot('74-quiet-hours', { full: true });
    await page.getByLabel('Quiet hours', { exact: true }).check();
    await page.getByText('Unsaved changes').waitFor();
    await shot('74-quiet-hours-dirty');
    await shot('74-quiet-hours-dirty-full', { full: true });
    await page.getByLabel('Until').fill('22:00');
    await page
      .getByText(/can’t start and end at the same time/)
      .first()
      .waitFor();
    await shot('74-quiet-hours-invalid', { full: true });
    await page.getByLabel('Until').fill('07:00');
    await page.locator('.s-back').click();
    await page.getByRole('dialog', { name: 'Save your changes?' }).waitFor();
    await shot('74-quiet-hours-leave');
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved on your relay').waitFor({ timeout: 20_000 });
    await shot('74-quiet-hours-saved');

    await page.goto(relay.origin + '/settings/devices');
    await page.getByRole('heading', { name: 'Computers' }).waitFor({ timeout: 30_000 });
    await shot('75-devices', { full: true });
    await page.locator('.s-device').first().click();
    await page.locator('.fingerprint span').first().waitFor();
    await shot('75-device-details');
    await page.keyboard.press('Escape');

    await page.goto(relay.origin + '/settings/privacy');
    await page.getByRole('heading', { name: 'Privacy & security' }).waitFor();
    await shot('76-privacy', { full: true });
    await page.getByRole('button', { name: 'Unpair…' }).click();
    await page
      .getByRole('dialog')
      .getByText(/unsent answer/)
      .waitFor();
    await shot('24-dialog-erase');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await page.goto(relay.origin + '/settings/about');
    await page.getByRole('heading', { name: 'About & help' }).waitFor();
    await shot('77-about');
    await page.getByRole('button', { name: /Keyboard shortcuts/ }).click();
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
    await shot('77-shortcuts');
    await page.keyboard.press('Escape');

    await theme('dark');
    await page.goto(relay.origin + '/settings');
    await page.getByRole('link', { name: /Quiet hours & reminders/ }).waitFor();
    await shot('70-settings-index-dark');
    await page.goto(relay.origin + '/settings/appearance');
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll<HTMLImageElement>('.theme-art img')).every(
        (i) => i.complete,
      ),
    );
    await shot('71-appearance-dark');
    await page.goto(relay.origin + '/settings/quiet-hours');
    await page.getByLabel('Quiet hours', { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByLabel('Remind me to review model answers').click();
    await shot('74-quiet-hours-dirty-dark');
    await page.getByRole('button', { name: 'Discard' }).click();
    await page.goto(relay.origin + '/settings/devices');
    await page.getByRole('heading', { name: 'Computers' }).waitFor({ timeout: 30_000 });
    await page.locator('.s-device').nth(1).click();
    await page.locator('.fingerprint span').first().waitFor();
    await shot('75-device-details-dark');
    await page.keyboard.press('Escape');
    await theme('light');

    // Desktop: the index beside the open section, in both themes.
    await page.setViewportSize(WIDE);
    await page.goto(relay.origin + '/settings');
    await page.getByRole('heading', { name: 'Appearance' }).waitFor();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll<HTMLImageElement>('.theme-art img')).every(
        (i) => i.complete,
      ),
    );
    await shot('78-desktop-settings');
    await page.goto(relay.origin + '/settings/quiet-hours');
    await page.getByLabel('Quiet hours', { exact: true }).waitFor({ timeout: 30_000 });
    await shot('78-desktop-quiet-hours');
    await page.goto(relay.origin + '/settings/devices');
    await page.getByRole('heading', { name: 'Computers' }).waitFor({ timeout: 30_000 });
    await page.locator('.s-device').first().click();
    await page.locator('.fingerprint span').first().waitFor();
    await shot('78-desktop-device-details');
    await page.keyboard.press('Escape');
    await theme('dark');
    await page.goto(relay.origin + '/settings/about');
    await page.getByRole('heading', { name: 'About & help' }).waitFor();
    await shot('78-desktop-about-dark');
    await page.goto(relay.origin + '/install');
    await shot('78-desktop-install-dark');
    await theme('light');
    await page.goto(relay.origin + '/install');
    await shot('78-desktop-install');
    await page.setViewportSize(PHONE);

    await page.goto(relay.origin + '/');
    await page.getByText('Approve the compact sidebar').first().waitFor({ timeout: 30_000 });
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await shot('25-inbox-offline');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await theme('dark');
    await page.goto(relay.origin + '/');
    await page.getByText('Approve the compact sidebar').first().waitFor({ timeout: 30_000 });
    await shot('26-inbox-dark');
    await open('Approve the compact sidebar');
    await filesReady();
    await shot('27-detail-approval-dark', { full: true });
    await page.goto(`${relay.origin}/q/${ids.proxy}`);
    await page.locator('.ws .msg.model').waitFor({ timeout: 30_000 });
    await shot('28-detail-proxy-dark', { full: true });
    await page.goto(relay.origin + '/settings');
    await page.getByRole('link', { name: /Quiet hours & reminders/ }).waitFor();
    await shot('29-settings-dark', { full: true });
    await theme('light');

    await page.setViewportSize(WIDE);
    await open('Approve the compact sidebar');
    await filesReady();
    await shot('30-wide-inbox-detail');
    await page.goto(relay.origin + '/');
    await shot('31-wide-inbox');
    await theme('dark');
    await open('Which retry strategy');
    await shot('32-wide-dark');
    await theme('light');
    await page.setViewportSize(PHONE);
  });

  it('captures the navigator, History records and the desktop rail', async () => {
    const rows = () => page.locator('.navigator .qrow');
    const waitRows = async () => {
      await rows().first().waitFor({ timeout: 30_000 });
    };

    // Phone: the Questions page, search, filter chips and the filtered empty state.
    await page.setViewportSize(PHONE);
    await page.goto(relay.origin + '/');
    await waitRows();
    await shot('60-phone-questions');
    await page.getByRole('button', { name: 'Search questions' }).click();
    await page.getByRole('searchbox', { name: 'Search questions' }).fill('retry');
    await page.locator('main').getByText('Which retry strategy').first().waitFor();
    await page.waitForTimeout(300);
    await shot('60-phone-search');
    await page.getByRole('button', { name: 'Close search' }).click();
    await page.getByRole('button', { name: /^Filter questions/ }).click();
    await page
      .locator('dialog.filter-sheet[open] label.facet-opt', { hasText: 'billing-api' })
      .click();
    await shot('60-phone-filter-sheet');
    await page.locator('dialog.filter-sheet[open]').getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: /Remove filter: Project billing-api/ }).waitFor();
    await shot('60-phone-filter-chip');
    await page.getByRole('button', { name: /Remove filter: Project billing-api/ }).click();
    await waitRows();

    // Phone: open a question from the list, open the navigator over it, then Back restores the list.
    await page.locator('main .qrow', { hasText: 'Which retry strategy' }).click();
    await page.locator('.ws .ws-column').waitFor({ timeout: 30_000 });
    await page.keyboard.press('Control+K');
    await page.locator('dialog.nav-sheet[open] .qrow').first().waitFor();
    await page.locator('dialog.nav-sheet .sheet-title').focus();
    await shot('60-phone-navigator-sheet');
    await page.keyboard.press('Escape');
    await page
      .locator('dialog.nav-sheet[open]')
      .waitFor({ state: 'detached' })
      .catch(() => undefined);
    await page.goBack();
    await waitRows();
    await shot('60-phone-back-restored');

    // Phone: History, grouped; a search that only an earlier answer satisfies; a record with its timeline.
    await page.goto(relay.origin + '/history');
    await page.getByText('Rename “Canopy”').first().waitFor({ timeout: 30_000 });
    await shot('60-phone-history', { full: true });
    await page.getByRole('searchbox', { name: 'Search history' }).fill('redirect');
    await page.getByText('Matched a message').first().waitFor();
    await shot('60-phone-history-search');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await page.locator('.hrow', { hasText: 'Rename “Canopy”' }).click();
    await page.locator('dialog.record-sheet[open] .timeline').waitFor();
    await shot('60-phone-history-record');
    await page.locator('dialog.record-sheet .tl-delivery summary').first().click();
    await shot('60-phone-history-record-delivery');
    await theme('dark');
    await shot('60-phone-history-record-dark');
    await page.keyboard.press('Escape');
    await page.goto(relay.origin + '/');
    await waitRows();
    await shot('60-phone-questions-dark');
    await page.locator('main .qrow', { hasText: 'Should the changelog entry' }).click();
    await page.locator('.ws .ws-column').waitFor({ timeout: 30_000 });
    await page.keyboard.press('Control+K');
    await page.locator('dialog.nav-sheet[open] .qrow').first().waitFor();
    await page.locator('dialog.nav-sheet .sheet-title').focus();
    await shot('60-phone-navigator-sheet-dark');
    await page.keyboard.press('Escape');
    await theme('light');

    // Tablet: one centred surface, top navigation, the navigator as a side sheet, the record from the right.
    await page.setViewportSize(TABLET);
    await page.goto(relay.origin + '/');
    await waitRows();
    await shot('60-tablet-questions');
    await page.locator('main .qrow', { hasText: 'Approve the compact sidebar' }).click();
    await page.locator('.ws .ws-column').waitFor({ timeout: 30_000 });
    await page.keyboard.press('Control+K');
    await page.locator('dialog.nav-sheet[open] .qrow').first().waitFor();
    await page.locator('dialog.nav-sheet .sheet-title').focus();
    await shot('60-tablet-navigator-sheet');
    await page.keyboard.press('Escape');
    await page.goto(relay.origin + '/history');
    await page.locator('.hrow', { hasText: 'Rename “Canopy”' }).click();
    await page.locator('dialog.record-sheet[open] .timeline').waitFor();
    await shot('60-tablet-history-record');
    await page.keyboard.press('Escape');

    // Desktop: the sidebar column beside Home, a question, History with a record, search, offline.
    for (const [vp, tag] of [
      [WIDE, '1280'],
      [WIDER, '1440'],
    ] as const) {
      await page.setViewportSize(vp);
      await page.goto(relay.origin + '/');
      await page.locator('main .qrow').first().waitFor({ timeout: 30_000 });
      await shot(`60-desktop-${tag}-home`);
      await page.locator('main .qrow', { hasText: 'Approve the compact sidebar' }).click();
      await page.locator('.ws .ws-column').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(600);
      await shot(`60-desktop-${tag}-question`);
      await page.goto(relay.origin + '/history');
      await page.locator('.hrow', { hasText: 'Rename “Canopy”' }).click();
      await page.locator('.history-record .timeline').waitFor();
      await shot(`60-desktop-${tag}-history`);
    }
    await page.setViewportSize(WIDE);
    await page.keyboard.press('Control+K');
    await page.keyboard.type('billing');
    await page.waitForTimeout(400);
    await shot('60-desktop-search');
    await page.keyboard.press('Escape');
    await page.goto(relay.origin + '/history');
    await page.locator('.hrow').first().waitFor({ timeout: 30_000 });
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForTimeout(500);
    await shot('60-desktop-offline');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await theme('dark');
    await page.goto(relay.origin + '/');
    await page.locator('main .qrow', { hasText: 'Which retry strategy' }).click();
    await page.locator('.ws .ws-column').waitFor({ timeout: 30_000 });
    await shot('60-desktop-question-dark');
    await page.goto(relay.origin + '/history');
    await page.locator('.hrow', { hasText: 'Rename “Canopy”' }).click();
    await page.locator('.history-record .timeline').waitFor();
    await shot('60-desktop-history-dark');
    // Close the record (a history layer) so nothing pops history under the next navigation.
    await page.keyboard.press('Escape');
    await page.goto(relay.origin + '/');
    await theme('light');
  });

  it('captures files: gallery, viewer, comparison, All files and failures', async () => {
    // Earlier blocks finish at desktop sizes; this one starts on a phone.
    await page.setViewportSize(PHONE);
    const r = await bridge.registerQuestion({
      origin: {
        machine_label: 'Greg’s MacBook Pro',
        host_id: 'host_01JC8Z4MQ7',
        pane_id: 'p9',
        terminal_generation: 1,
        ownership_principal: 'principal-p9',
        agent_incarnation: '1',
        agent_kind: 'claude-code',
        agent_session_id: 's-p9',
        project_id: 'checkout',
        worktree_id: 'wt-p9',
        worktree_root: '/work/checkout',
        workflow_gate_id: null,
      },
      input: {
        question: 'Which of these should I fix before the checkout release?',
        context: 'Five captures from the release candidate.',
        kind: 'choice',
        options: [
          { id: 'retry', label: 'The retry test' },
          { id: 'dialog', label: 'The delete dialog copy' },
        ],
        attachments: [
          { local_resource_id: 'g-settings.png', alt: 'Appearance settings, desktop' },
          { local_resource_id: 'g-phone.png', alt: 'Agents list on a phone' },
          { local_resource_id: 'g-dialog.png', alt: 'Delete dialog' },
          { local_resource_id: 'g-chart.png', alt: 'Webhook retries chart' },
          { local_resource_id: 'g-terminal.png' },
        ],
      },
    });
    ids.gallery = r.questionId;
    await bridge.pump();
    const openGallery = async () => {
      await page.goto(`${relay.origin}/q/${ids.gallery}`);
      await page.locator('.ws .ws-column').waitFor({ timeout: 30_000 });
    };
    const toFiles = async () => {
      await page.evaluate(() => {
        const el = document.querySelector('.fx-files')!;
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 64);
      });
    };
    const viewer = page.locator('.fx-viewer');

    // Phone, light: the five-file strip, a tall capture, All files.
    await openGallery();
    await filesReady();
    await toFiles();
    await shot('50-gallery-strip-phone');
    await page.getByRole('tab', { name: /^Agents list on a phone/ }).click();
    await shot('50-gallery-tall-phone');
    await page.getByRole('button', { name: /All files/ }).click();
    await page.locator('.fx-grid').waitFor();
    await shot('50-allfiles-phone');
    await page.keyboard.press('Escape');
    await page.locator('.fx-grid').waitFor({ state: 'detached' });

    // The before/after approval: inline, viewer at Fit, zoomed, Move, menu, handoff, question, compare.
    await open('Approve the compact sidebar');
    await filesReady();
    await toFiles();
    await shot('50-gallery-phone');
    await page.getByRole('tab', { name: /^After/ }).click();
    await page.getByRole('button', { name: 'Enlarge After' }).click();
    await viewer.locator('.fs-slide.is-active img.is-sized').waitFor({ timeout: 30_000 });
    await shot('50-viewer-fit-phone');
    const box = (await viewer.locator('.fx-viewer-stage').boundingBox())!;
    await page.mouse.dblclick(box.x + box.width * 0.3, box.y + box.height * 0.45);
    await shot('50-viewer-zoomed-phone');
    await viewer.getByRole('button', { name: 'Move', exact: true }).click();
    await viewer.getByRole('button', { name: 'Move right' }).click();
    await shot('50-viewer-move-phone');
    await viewer.getByRole('button', { name: 'Done' }).click();
    await page.keyboard.press('0');
    await viewer.getByRole('button', { name: 'File menu' }).click();
    await page.getByRole('menu').waitFor();
    await shot('50-viewer-menu-phone');
    await page.getByRole('menuitem', { name: 'Download' }).click();
    await page.getByRole('dialog', { name: 'Download this file?' }).waitFor();
    await shot('50-viewer-handoff-phone');
    await page
      .getByRole('dialog', { name: 'Download this file?' })
      .getByRole('button', { name: 'Cancel' })
      .click();
    await viewer.getByRole('button', { name: 'Question', exact: true }).click();
    await page.getByRole('dialog', { name: 'Question', exact: true }).waitFor();
    await shot('50-viewer-question-phone');
    await page.keyboard.press('Escape');
    await viewer.getByRole('button', { name: 'Compare before and after' }).click();
    await page.locator('.fx-compare .fs-slide.is-active img.is-sized').waitFor({ timeout: 30_000 });
    await shot('50-compare-phone');
    await page.locator('.fx-compare').getByRole('button', { name: 'Before', exact: true }).click();
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await shot('50-compare-phone-before-zoomed');
    await page.getByRole('button', { name: 'Close comparison' }).click();
    await viewer.waitFor();
    await page.getByRole('button', { name: 'Close viewer' }).click();
    await viewer.waitFor({ state: 'detached' });

    // Dark.
    await theme('dark');
    await toFiles();
    await shot('50-gallery-phone-dark');
    await page.getByRole('button', { name: /^Enlarge/ }).click();
    await viewer.locator('.fs-slide.is-active img.is-sized').waitFor({ timeout: 30_000 });
    await shot('50-viewer-fit-phone-dark');
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'detached' });
    await theme('light');

    // Failures, on a fresh load: one file will not load, one fails verification, one the relay deleted.
    const order: string[] = [];
    await context.route('**/attachments/*/content', async (route) => {
      const id = /attachments\/([^/]+)\/content/.exec(route.request().url())?.[1] ?? '';
      if (!order.includes(id)) order.push(id);
      const i = order.indexOf(id);
      if (i === 2)
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      if (i === 3) return route.fulfill({ status: 200, body: Buffer.alloc(2048, 7) });
      if (i === 4)
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'not_found', message: 'gone' }),
        });
      return route.continue();
    });
    await openGallery();
    await page.locator('.fx-thumb.is-expired').waitFor({ timeout: 30_000 });
    await page.getByRole('tab', { name: /^Delete dialog/ }).click();
    await toFiles();
    await shot('50-gallery-error-phone');
    await page.getByRole('tab', { name: /^Webhook retries chart/ }).click();
    await shot('50-gallery-unverified-phone');
    await page.getByRole('button', { name: /All files/ }).click();
    await page.locator('.fx-grid').waitFor();
    await shot('50-allfiles-states-phone');
    await page.keyboard.press('Escape');
    await context.unroute('**/attachments/*/content');

    // Wide.
    await page.setViewportSize(WIDE);
    await open('Approve the compact sidebar');
    await filesReady();
    await toFiles();
    await shot('50-gallery-wide');
    await page.getByRole('button', { name: /^Enlarge/ }).click();
    await viewer.locator('.fs-slide.is-active img.is-sized').waitFor({ timeout: 30_000 });
    await shot('50-viewer-wide');
    await viewer.getByRole('button', { name: 'Compare before and after' }).click();
    await page.locator('.fx-compare .fx-pane img.is-sized').nth(1).waitFor({ timeout: 30_000 });
    await shot('50-compare-wide');
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await shot('50-compare-wide-zoomed');
    await theme('dark');
    await shot('50-compare-wide-dark');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await theme('light');
    await openGallery();
    await filesReady();
    await toFiles();
    await shot('50-gallery-strip-wide');
    await page.setViewportSize(PHONE);
  });

  it('captures every workspace state at both sizes in both themes', async () => {
    // A question the model will answer while the phone's own answer waits offline: the conflict.
    const r = await bridge.registerQuestion({
      origin: {
        machine_label: 'Greg’s MacBook Pro',
        host_id: 'host_01JC8Z4MQ7',
        pane_id: 'p9',
        terminal_generation: 1,
        ownership_principal: 'principal-p9',
        agent_incarnation: '1',
        agent_kind: 'claude-code',
        agent_session_id: 's-p9',
        project_id: 'billing-api',
        worktree_id: 'wt-p9',
        worktree_root: '/work/billing-api',
        workflow_gate_id: null,
      },
      input: {
        question: 'Which log level should the retry worker use in production?',
        kind: 'choice',
        requested_requirement: 'proxy-ok',
        options: [
          { id: 'debug', label: 'Debug' },
          { id: 'info', label: 'Info' },
          { id: 'warn', label: 'Warn' },
        ],
      },
    });
    ids.conflict = r.questionId;
    await bridge.pump();

    const sizes: [string, { width: number; height: number }][] = [
      ['p', PHONE],
      ['w', WIDE],
    ];
    for (const [sz, vp] of sizes) {
      await page.setViewportSize(vp);
      for (const scheme of ['light', 'dark'] as const) {
        await theme(scheme);
        const tag = `${sz}-${scheme}`;
        await openId('text');
        await shot(`40-ws-text-empty-${tag}`);
        await typeAnswer('Describe v3 only, and move the v2 steps to an appendix.', true);
        await shot(`40-ws-editor-${tag}`);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await shot(`40-ws-draft-${tag}`);
        await typeAnswer('');
        await openId('choice');
        await page
          .getByRole('radio', { name: /Exponential backoff/ })
          .first()
          .check();
        await shot(`40-ws-choice-selected-${tag}`);
        await openId('design');
        await filesReady();
        await shot(`40-ws-approval-${tag}`);
        await openId('answered');
        await page.locator('.ws .receipt').first().waitFor({ timeout: 30_000 });
        await shot(`40-ws-answered-${tag}`);
        await openId('proxy');
        await page.locator('.ws .msg.model').waitFor({ timeout: 30_000 });
        await shot(`40-ws-model-${tag}`);
        await openId('expired');
        await shot(`40-ws-expired-${tag}`);
        await openId('cancelled');
        await shot(`40-ws-withdrawn-${tag}`);
      }
    }
    await theme('light');
    await page.setViewportSize(PHONE);

    // The conflict: the phone queues its answer offline, the model answers first, the phone reconnects.
    await openId('conflict');
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.getByRole('radio', { name: /^Warn/ }).first().check();
    await page.getByRole('button', { name: 'Send answer' }).click();
    await page.locator('.ws .receipt').first().waitFor({ timeout: 10_000 });
    await shot('40-ws-queued-offline');
    conflictArmed = true;
    // The model passed on it when it was asked; let it look again now.
    await local.setMeta(`proxy:${ids.conflict}`, '');
    expect(await bridge.runProxy(ids.conflict!)).toBe('answered');
    await bridge.pump();
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#ws-conflict').waitFor({ timeout: 30_000 });
    await shot('40-ws-conflict');
    await theme('dark');
    await shot('40-ws-conflict-dark');
    await page.setViewportSize(WIDE);
    await shot('40-ws-conflict-w-dark');
    await theme('light');
    await page.setViewportSize(PHONE);

    // Dictation, through the real app and a fake microphone; the relay's speech and cleanup are stood in for here.
    await context.route('**/api/v1/info', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({
        response: res,
        json: { ...body, voice: { xai: true, anthropic: true, openai: false } },
      });
    });
    await context.route('**/api/v1/voice/session', (route) =>
      route.fulfill({
        json: {
          ticket: 'dGlja2V0dGlja2V0dGlja2V0',
          ws_path: '/api/v1/voice/ws',
          provider: 'xai',
          sample_rate: 16000,
          max_session_ms: 300_000,
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        },
      }),
    );
    let releaseCleanup: () => void = () => undefined;
    await context.route('**/api/v1/voice/correct', async (route) => {
      await new Promise<void>((res) => (releaseCleanup = res));
      await route.fulfill({
        json: {
          model: 'claude-haiku',
          result: {
            corrected_text:
              'Describe v3 only, and move the v2 steps into an appendix at the very end.',
            uncertain_spans: [],
            applied_commands: [],
            warnings: [],
          },
        },
      });
    });
    await context.routeWebSocket('**/api/v1/voice/ws**', (ws) => {
      let frames = 0;
      ws.send(JSON.stringify({ type: 'transcript.created' }));
      ws.onMessage((m) => {
        if (typeof m === 'string') {
          if (m.includes('audio.done')) {
            ws.send(
              JSON.stringify({
                type: 'transcript.partial',
                text: 'at the end',
                is_final: true,
              }),
            );
            ws.send(JSON.stringify({ type: 'transcript.done', text: '' }));
          }
          return;
        }
        frames++;
        if (frames === 4)
          ws.send(
            JSON.stringify({
              type: 'transcript.partial',
              text: 'describe v3 only and move the v2 steps',
              is_final: true,
            }),
          );
        if (frames === 6)
          ws.send(
            JSON.stringify({
              type: 'transcript.partial',
              text: 'into an appendix',
              is_final: true,
            }),
          );
        if (frames === 8)
          ws.send(JSON.stringify({ type: 'transcript.partial', text: 'at the', is_final: false }));
      });
    });
    await page.goto(relay.origin + '/');
    await page.waitForTimeout(800);
    await openId('text');
    await page.getByRole('button', { name: /^Dictate/ }).click();
    await page.getByRole('dialog').waitFor();
    await shot('40-ws-dictation-consent');
    await page.getByRole('button', { name: 'Enable and start dictation' }).click();
    await page.locator('.status.rec').waitFor({ timeout: 15_000 });
    await page.locator('.live-text .interim').waitFor({ timeout: 15_000 });
    await shot('40-ws-recording');
    await theme('dark');
    await shot('40-ws-recording-dark');
    await theme('light');
    await page.getByRole('button', { name: 'Stop dictation' }).click();
    await page.getByText('Tidying wording…').waitFor({ timeout: 15_000 });
    await shot('40-ws-cleaning');
    releaseCleanup();
    await page.locator('.status.review').waitFor({ timeout: 15_000 });
    await shot('40-ws-cleaned');
    await page.setViewportSize(WIDE);
    await shot('40-ws-cleaned-w');
    await page.setViewportSize(PHONE);
    await typeAnswer('');
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  });

  it('captures the revoked phone', async () => {
    const list = await client.devices();
    const phone = list.devices.find((d) => d.role === 'phone' && !d.revoked_at);
    expect(phone).toBeTruthy();
    await revokeAndRotate(client, keyStore, phone!.device_id);
    await page.goto(relay.origin + '/');
    await page.getByText('This device is no longer paired').waitFor({ timeout: 30_000 });
    await shot('33-revoked');
    await theme('dark');
    await shot('33-revoked-dark');
    await theme('light');

    const files = readdirSync(OUT!).filter((f) => f.endsWith('.png'));
    for (const f of written) expect(files).toContain(f);
    expect(new Set(written).size).toBe(written.length);
  });
});
