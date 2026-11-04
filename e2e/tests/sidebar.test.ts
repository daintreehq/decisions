import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
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
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

const PORT = 8823;
const chromiumPath = findChromium();

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
    return { outcome: 'delivered' as const, proof: 'e2e' };
  }
  async hasMarker() {
    return false;
  }
  async resume() {
    return null;
  }
}

const origin = (pane: string, project: string): QuestionOrigin => ({
  machine_label: 'E2E Mac',
  host_id: 'host_e2e',
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

describe.skipIf(!chromiumPath)('the app shell: a menu button and a sidebar, no bars', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let page: Page;
  let bridge: DecisionsBridge;
  const ids: Record<string, string> = {};
  const sheet = () => page.locator('dialog.sidebar-sheet[open]');
  const menu = () => page.getByRole('button', { name: /^Menu/ });

  const openSidebar = async () => {
    await menu().click();
    await sheet().waitFor({ timeout: 10_000 });
  };
  const closed = () =>
    until(async () => (await sheet().count()) === 0, 10_000, 'the sidebar to close');

  beforeAll(async () => {
    relay = await startRelay(PORT);
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'allow',
      hasTouch: true,
    });
    page = await context.newPage();

    const store = new FileKeyStore(mkdtempSync(join(tmpdir(), 'decisions-sidebar-e2e-')));
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'E2E Mac',
      store,
    });
    const client = new RelayClient({ identity });
    bridge = new DecisionsBridge({
      identity,
      keyStore: store,
      store: new MemoryLocalStore(),
      sink: new Sink(),
      client,
      pumpIntervalMs: 0,
      resolver: { resolve: async () => null },
    });
    await bridge.start();
    const invite = await createPairingInvite(client, 'phone');
    await page.goto('about:blank');
    await page.goto(invite.url);
    await page.getByRole('button', { name: 'Pair this device' }).click();
    const cand = await until(
      async () =>
        (await client.pendingPairings()).pending.find((p) => p.pairing_id === invite.pairingId),
      20_000,
      'pending pairing',
    );
    await approveCandidate(client, cand);
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });

    for (const [key, pane, project, question] of [
      ['older', 'p1', 'billing-api', 'Which retry strategy should the webhook sender use?'],
      ['newer', 'p2', 'daintree', 'Approve the compact sidebar for the Agents view?'],
    ] as const) {
      const r = await bridge.registerQuestion({
        origin: origin(pane, project),
        input: {
          question,
          kind: 'approval',
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
      });
      ids[key] = r.questionId;
    }
    await bridge.pump();
    // The closed sidebar holds the same text in its Recent list, so look for it on the page itself.
    await page.goto(relay.origin + '/');
    await page
      .locator('main')
      .getByText('Approve the compact sidebar')
      .waitFor({ timeout: 30_000 });
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('renders no top bar or tab bar on a phone, on any screen', async () => {
    for (const path of ['/', '/history', '/settings', `/q/${ids.newer}`]) {
      await page.goto(relay.origin + path);
      await page.locator('#main').waitFor();
      await menu().waitFor();
      // Anything pinned to the top or bottom edge across the width is a bar.
      const bars = await page.evaluate(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        return Array.from(document.querySelectorAll<HTMLElement>('body *'))
          .filter((el) => {
            if (el.closest('dialog')) return false;
            const cs = getComputedStyle(el);
            if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            const atEdge = r.top <= 1 || r.bottom >= vh - 1;
            return r.width >= vw * 0.9 && r.height > 0 && atEdge;
          })
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
      });
      expect(bars, path).toEqual([]);
      expect(await page.locator('.topbar, .tabbar').count(), path).toBe(0);
    }
  });

  it('names the menu button, labels the sidebar dialog, and moves focus in and back', async () => {
    await page.goto(relay.origin + '/');
    await menu().waitFor();
    expect(await menu().getAttribute('aria-expanded')).toBe('false');
    await openSidebar();
    const dialog = page.getByRole('dialog', { name: 'Daintree' });
    await dialog.waitFor();
    expect(
      await page.evaluate(() => !!document.activeElement?.closest('dialog.sidebar-sheet')),
    ).toBe(true);
    expect(
      await dialog.getByRole('navigation', { name: 'Main' }).getByRole('link').allInnerTexts(),
    ).toEqual(expect.arrayContaining([expect.stringContaining('Home'), 'History', 'Settings']));
    await page.keyboard.press('Escape');
    await closed();
    await until(
      async () => page.evaluate(() => document.activeElement?.id === 'menu-button'),
      5_000,
      'focus to return to the menu button',
    );
    expect(await menu().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the sidebar, goes to Settings and comes back', async () => {
    await page.goto(relay.origin + '/');
    await openSidebar();
    await sheet().getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL((u) => u.pathname === '/settings');
    await closed();
    await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
    await openSidebar();
    expect(await sheet().getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe(
      'page',
    );
    await sheet().getByRole('link', { name: /^Home/ }).click();
    await page.waitForURL((u) => u.pathname === '/');
    await closed();
  });

  it('opens a recent question from the sidebar', async () => {
    await page.goto(relay.origin + '/');
    await openSidebar();
    const rows = sheet().locator('.side-recent a');
    // Newest first.
    expect(await rows.first().innerText()).toContain('Approve the compact sidebar');
    await rows.filter({ hasText: 'Which retry strategy' }).click();
    await page.waitForURL((u) => u.pathname === `/q/${ids.older}`);
    await closed();
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await openSidebar();
    expect(await sheet().locator('.side-recent a[aria-current="page"]').innerText()).toContain(
      'Which retry strategy',
    );
    await page.keyboard.press('Escape');
    await closed();
  });

  it('closes on Back before it navigates, on the dimmed edge, and on a left swipe', async () => {
    await page.goto(relay.origin + '/');
    await openSidebar();
    await sheet().getByRole('link', { name: 'History' }).click();
    await page.waitForURL((u) => u.pathname === '/history');
    await closed();

    await openSidebar();
    await page.goBack();
    await closed();
    expect(new URL(page.url()).pathname).toBe('/history');
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/');

    // The dimmed edge, to the right of the panel.
    await openSidebar();
    await page.mouse.click(380, 420);
    await closed();
    expect(new URL(page.url()).pathname).toBe('/');

    // A left swipe across the panel.
    await openSidebar();
    await page.evaluate(async () => {
      const body = document.querySelector<HTMLElement>('dialog.sidebar-sheet[open] .side')!;
      const fire = (type: string, x: number) =>
        body.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            clientX: x,
            clientY: 400,
          }),
        );
      fire('pointerdown', 260);
      for (let x = 250; x >= 60; x -= 30) {
        fire('pointermove', x);
        await new Promise((r) => setTimeout(r, 16));
      }
      fire('pointerup', 60);
    });
    await closed();
    expect(new URL(page.url()).pathname).toBe('/');
  });

  it('is a persistent column with no menu button at 1100px and up', async () => {
    // An overlay left open when the window widens does not come back when it narrows again.
    await page.goto(relay.origin + '/');
    await openSidebar();
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.locator('aside.sidebar').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await menu().waitFor();
    expect(await sheet().count()).toBe(0);
    expect(await menu().getAttribute('aria-expanded')).toBe('false');

    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(relay.origin + '/');
    await page.locator('aside.sidebar').waitFor();
    expect(await page.locator('.menu-fab').count()).toBe(0);
    await page
      .locator('aside.sidebar')
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'History' })
      .click();
    await page.waitForURL((u) => u.pathname === '/history');
    await page.setViewportSize({ width: 390, height: 844 });
  });
});
