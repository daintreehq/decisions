import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import {
  DecisionsBridge,
  FileKeyStore,
  MemoryLocalStore,
  RelayClient,
  approveCandidate,
  claimRelay,
  createPairingInvite,
  type LocateResult,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintree/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Captures real screens of the running app for documentation and review.
 *   SCREENSHOTS_DIR=/some/dir pnpm --filter @daintree/decisions-e2e test screenshots
 * Skipped unless SCREENSHOTS_DIR is set.
 */
const OUT = process.env.SCREENSHOTS_DIR;
const chromiumPath = findChromium();
const PORT = 8801;

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

/** Draws a plausible "UI" so the before/after comparison has something real to show. */
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
  const images = new Map<string, Uint8Array>();
  const ids: string[] = [];

  const shot = async (name: string) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT!, `${name}.png`) });
  };

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT);
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    images.set('before.png', await mockUi(browser, 'before'));
    images.set('after.png', await mockUi(browser, 'after'));
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
      serviceWorkers: 'allow',
    });
    page = await context.newPage();
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('captures the app before pairing and during pairing', async () => {
    await page.goto(relay.origin + '/');
    await shot('01-not-paired');
    await page.goto(relay.origin + '/install');
    await shot('02-install-help');

    const home = mkdtempSync(join(tmpdir(), 'decisions-shot-'));
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'Greg’s MacBook',
      store: new FileKeyStore(home),
    });
    client = new RelayClient({ identity });
    bridge = new DecisionsBridge({
      identity,
      store: new MemoryLocalStore(),
      sink: new Sink(),
      client,
      pumpIntervalMs: 0,
      resolver: { resolve: async (_o, id) => (images.has(id) ? { bytes: images.get(id)! } : null) },
    });
    await bridge.start();

    const invite = await createPairingInvite(client, 'phone');
    await page.goto(invite.url);
    await shot('03-pair-start');
    await page.getByRole('button', { name: 'Pair this phone' }).click();
    await page.getByText('Confirm this code on your computer').waitFor({ timeout: 20_000 });
    await shot('04-pair-confirm-code');
    const cand = await until(
      async () =>
        (await client.pendingPairings()).pending.find((p) => p.pairing_id === invite.pairingId),
      20_000,
      'pending pairing',
    );
    await approveCandidate(client, cand);
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
    await shot('05-inbox-empty');
  });

  it('captures a realistic inbox, a design approval, and the answered state', async () => {
    const origin = (pane: string, project: string): never =>
      ({
        host_id: 'host_screens01',
        pane_id: pane,
        terminal_generation: 1,
        agent_kind: 'claude-code',
        agent_session_id: `s-${pane}`,
        project_id: project,
        worktree_id: `wt-${pane}`,
        worktree_root: `/work/${project}`,
        workflow_gate_id: null,
      }) as never;

    const design = await bridge.registerQuestion({
      origin: origin('p1', 'daintree'),
      input: {
        question: 'Approve the compact sidebar for the Agents view?',
        context:
          'Design review, round 3. The sidebar collapses to icons below 900px. Keyboard shortcuts are unchanged. Before and after screenshots are attached.',
        kind: 'approval',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
        attachments: [
          { local_resource_id: 'before.png', role: 'before' },
          { local_resource_id: 'after.png', role: 'after' },
        ],
      } as never,
    });
    const choice = await bridge.registerQuestion({
      origin: origin('p2', 'billing-api'),
      input: {
        question: 'Which retry strategy should the webhook sender use?',
        context:
          'Failures are mostly 502s from the partner gateway. Exponential backoff is simplest; a queue with dead-lettering is more work but survives restarts.',
        kind: 'choice',
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
      } as never,
    });
    const text = await bridge.registerQuestion({
      origin: origin('p3', 'docs-site'),
      input: {
        question:
          'The migration guide mentions v2 in three places and v3 in one. Which version should it describe?',
        kind: 'text',
        options: [],
      } as never,
    });
    const answered = await bridge.registerQuestion({
      origin: origin('p4', 'daintree'),
      input: {
        question: 'Rename “Canopy” to “Inbox” in the sidebar?',
        kind: 'approval',
        options: [
          { id: 'yes', label: 'Yes, rename' },
          { id: 'no', label: 'Keep Canopy' },
        ],
      } as never,
    });
    ids.push(design.questionId, choice.questionId, text.questionId, answered.questionId);
    await bridge.pump();

    await page.goto(relay.origin + '/');
    await page.getByText('Approve the compact sidebar').first().waitFor({ timeout: 30_000 });
    await page.getByText('Which retry strategy').first().waitFor({ timeout: 30_000 });
    await shot('06-inbox');

    // answer the small one so the inbox shows a resolved item and the detail shows delivery progress
    await page.getByText('Rename “Canopy”').first().click();
    await page.getByRole('radio', { name: /Yes, rename/ }).check();
    await page.getByRole('button', { name: /Submit decision/ }).click();
    await page
      .locator('ol[aria-label="Delivery progress"] li[aria-current="step"]')
      .filter({ hasText: 'Typed into' })
      .waitFor({ timeout: 30_000 });
    await shot('09-answered-delivered');

    await page.goto(relay.origin + '/');
    await page.getByText('Approve the compact sidebar').first().click();
    await page.waitForTimeout(800);
    await shot('07-design-approval');
    await page.getByRole('radio', { name: /Approve/ }).check();
    await shot('08-design-approval-selected');

    await page.goto(relay.origin + '/');
    await page.getByText('Which retry strategy').first().click();
    await page.waitForTimeout(500);
    await shot('10-choice-question');
  });

  it('captures history, devices, settings and dark mode', async () => {
    await page.goto(relay.origin + '/history');
    await shot('11-history');
    await page.goto(relay.origin + '/devices');
    await shot('12-devices');
    await page.goto(relay.origin + '/settings');
    await shot('13-settings');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(relay.origin + '/');
    await page.getByText('Approve the compact sidebar').first().waitFor({ timeout: 30_000 });
    await shot('14-inbox-dark');
    await page.getByText('Approve the compact sidebar').first().click();
    await page.waitForTimeout(800);
    await shot('15-design-approval-dark');
    expect(ids.length).toBe(4);
  });
});
