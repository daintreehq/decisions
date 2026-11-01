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
const PORT = 8801;
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 820 };

class Sink implements TerminalSink {
  async locate(o: QuestionOrigin): Promise<LocateResult> {
    return {
      state: 'alive',
      target: {
        hostId: o.host_id,
        paneId: o.pane_id,
        terminalGeneration: o.terminal_generation,
        agentSessionId: o.agent_session_id,
        worktreeId: o.worktree_id,
      },
    };
  }
  async isIdle() {
    return true;
  }
  async inject(_t: TerminalTarget, _text: string, _id: string) {
    return { ok: true as const, proof: 'shot' };
  }
  async hasMarker() {
    return false;
  }
  async resume() {
    return null;
  }
}

/** Answers only the changelog question, so the inbox holds one proxy answer and one abstention. */
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

describe.skipIf(!OUT || !chromiumPath)('screenshots of the running app', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  let keyStore: FileKeyStore;
  const images = new Map<string, Uint8Array>();
  const written: string[] = [];
  const ids: Record<string, string> = {};

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
  const open = async (text: string) => {
    await page.goto(relay.origin + '/');
    await page.getByText(text).first().click();
    await page.locator('article.detail').waitFor({ timeout: 30_000 });
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
    await page.getByText('Paste the link instead').click();
    await shot('04-pair-no-invite');
    // Headless Chromium has no camera, which is exactly the scanner's failure state.
    await page.goto(relay.origin + '/pair');
    await page.getByRole('button', { name: 'Scan QR code' }).click();
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
      store: new MemoryLocalStore(),
      sink: new Sink(),
      client,
      proxy,
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
      pumpIntervalMs: 0,
      resolver: { resolve: async (_o, id) => (images.has(id) ? { bytes: images.get(id)! } : null) },
    });
    await bridge.start();

    const invite = await createPairingInvite(client, 'phone');
    // The invite is read from the fragment on load, so force a real load rather than a hash change.
    await page.goto('about:blank');
    await page.goto(invite.url);
    await page.getByRole('button', { name: 'Pair this phone' }).waitFor();
    await shot('05-pair-invite');
    await page.getByRole('button', { name: 'Pair this phone' }).click();
    await page.getByText('Confirm this code on your computer').waitFor({ timeout: 20_000 });
    await shot('06-pair-code');
    const cand = await until(
      async () =>
        (await client.pendingPairings()).pending.find((p) => p.pairing_id === invite.pairingId),
      20_000,
      'pending pairing',
    );
    await approveCandidate(client, cand);
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
    await page.getByText('Nothing is waiting on you').waitFor({ timeout: 30_000 });
    await shot('07-inbox-empty');
  });

  it('captures a realistic inbox and every question state', async () => {
    // One project (docs-site) comes from a host without a human label, to show the raw-id fallback.
    const origin = (pane: string, project: string, agent = 'claude-code'): QuestionOrigin => ({
      ...(project === 'docs-site' ? {} : { machine_label: 'Greg’s MacBook Pro' }),
      host_id: 'host_01JC8Z4MQ7',
      pane_id: pane,
      terminal_generation: 1,
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
    await page.getByRole('radio', { name: /Yes, rename/ }).check();
    await page.getByRole('button', { name: /Submit decision/ }).click();
    await page
      .locator('ol[aria-label="Delivery progress"] li[aria-current="step"]')
      .filter({ hasText: 'Typed into' })
      .waitFor({ timeout: 30_000 });
    await shot('15-detail-answered');
    await page.getByRole('button', { name: /Change this answer/ }).click();
    await page.getByRole('radio', { name: /Keep Canopy/ }).check();
    await page.getByLabel('Why are you changing it?').fill('Canopy is the brand name; keep it.');
    await shot('16-detail-override', { full: true });
    await page.getByRole('button', { name: /Send correction/ }).click();
    await page.getByRole('dialog').waitFor();
    await shot('17-dialog-overrule');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await open('Approve the compact sidebar');
    await page.locator('.compare img').nth(1).waitFor({ timeout: 30_000 });
    await shot('09-detail-approval');
    await shot('09-detail-approval-full', { full: true });
    await page.getByRole('radio', { name: /^Approve/ }).check();
    await shot('10-detail-approval-selected');
    await page.getByRole('button', { name: /Enlarge After/ }).click();
    await page.getByRole('dialog').waitFor();
    await shot('11-dialog-zoom');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

    await open('Which retry strategy');
    await shot('12-detail-choice', { full: true });
    await open('Which version should it describe');
    await page
      .getByRole('textbox')
      .first()
      .fill('Describe v3 only. Move the v2 steps to an appendix');
    await shot('13-detail-text', { full: true });

    await page.goto(relay.origin + '/');
    await page.getByRole('button', { name: /Model answers/ }).click();
    await page.getByText('Should the changelog entry').first().waitFor({ timeout: 30_000 });
    await shot('19-inbox-proxy-tab');
    await page.getByText('Should the changelog entry').first().click();
    await page.locator('.card.proxy').waitFor({ timeout: 30_000 });
    await shot('14-detail-proxy', { full: true });

    // Wait out the short-lived question's expiry (usually already past by now).
    const wait = expiresAt + 2_000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    await page.goto(relay.origin + '/');
    await page.getByRole('button', { name: /^All/ }).click();
    await page.getByText('Publish the draft release notes').first().waitFor({ timeout: 30_000 });
    await shot('20-inbox-all-tab', { full: true });
    await page.getByText('Publish the draft release notes').first().click();
    await shot('18-detail-expired');
    await page.goto(relay.origin + '/');
    await page.getByRole('button', { name: /^All/ }).click();
    await page.getByText('Drop the legacy').first().click();
    await shot('18-detail-cancelled');
  });

  it('captures history, devices, settings, offline, dark mode and the wide layout', async () => {
    await page.goto(relay.origin + '/history');
    await page.getByText('Rename “Canopy”').first().waitFor({ timeout: 30_000 });
    await shot('21-history');
    await page.goto(relay.origin + '/devices');
    await page.getByText('This phone', { exact: true }).waitFor({ timeout: 30_000 });
    await shot('22-devices');
    await page.goto(relay.origin + '/settings');
    await page.getByRole('heading', { name: 'Quiet hours and reminders' }).waitFor();
    await page.getByLabel('Quiet hours', { exact: true }).check();
    await shot('23-settings', { full: true });
    await page.getByRole('button', { name: /Unpair this phone/ }).click();
    await page.getByRole('dialog').waitFor();
    await shot('24-dialog-erase');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

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
    await page.locator('.compare img').nth(1).waitFor({ timeout: 30_000 });
    await shot('27-detail-approval-dark', { full: true });
    await page.goto(`${relay.origin}/q/${ids.proxy}`);
    await page.locator('.card.proxy').waitFor({ timeout: 30_000 });
    await shot('28-detail-proxy-dark', { full: true });
    await page.goto(relay.origin + '/settings');
    await shot('29-settings-dark', { full: true });
    await theme('light');

    await page.setViewportSize(WIDE);
    await open('Approve the compact sidebar');
    await page.locator('.compare img').nth(1).waitFor({ timeout: 30_000 });
    await shot('30-wide-inbox-detail');
    await page.goto(relay.origin + '/');
    await shot('31-wide-inbox');
    await theme('dark');
    await open('Which retry strategy');
    await shot('32-wide-dark');
    await theme('light');
    await page.setViewportSize(PHONE);
  });

  it('captures the revoked phone', async () => {
    const list = await client.devices();
    const phone = list.devices.find((d) => d.role === 'phone' && !d.revoked_at);
    expect(phone).toBeTruthy();
    await revokeAndRotate(client, keyStore, phone!.device_id);
    await page.goto(relay.origin + '/');
    await page.getByText('This phone was removed').waitFor({ timeout: 30_000 });
    await shot('33-revoked');

    const files = readdirSync(OUT!).filter((f) => f.endsWith('.png'));
    for (const f of written) expect(files).toContain(f);
    expect(written.length).toBe(37);
  });
});
