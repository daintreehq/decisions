import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type Page } from 'playwright-core';
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

const PORT = Number(process.env.SIDEBAR_E2E_PORT ?? 8823);
const chromiumPath = findChromium();
const browserEngine = process.env.E2E_BROWSER === 'webkit' ? webkit : chromium;
const motionDir = process.env.MOTION_CAPTURE_DIR;

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
    if (motionDir) mkdirSync(motionDir, { recursive: true });
    relay = await startRelay(PORT);
    browser = await browserEngine.launch({
      ...(browserEngine === chromium ? { executablePath: chromiumPath! } : {}),
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      // WebKit's test runner can lose its network process during worker-controlled reloads. These checks
      // exercise navigation and gestures; Chromium's full suite also exercises the service worker.
      serviceWorkers: browserEngine === webkit ? 'block' : 'allow',
      hasTouch: true,
      ...(motionDir ? { recordVideo: { dir: motionDir, size: { width: 390, height: 844 } } } : {}),
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
    for (const context of browser?.contexts() ?? []) await context.close();
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

  it('reveals stationary navigation beneath the displaced conversation canvas', async () => {
    await page.goto(relay.origin + `/q/${ids.newer}`);
    await page.locator('.ws .dock').waitFor();
    const draft = page.locator('.composer-input');
    await draft.fill('Keep this draft while browsing recent questions.');
    await openSidebar();
    await until(
      async () =>
        page.evaluate(() => {
          const frame = document.querySelector('.frame')!.getBoundingClientRect();
          const side = document.querySelector('.side-sheet-body')!.getBoundingClientRect();
          return Math.abs(frame.left - side.width) < 1 && side.left === 0;
        }),
      5000,
      'the foreground canvas to uncover the sidebar',
    );
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(document.querySelector('.sidebar-sheet')!, '::backdrop').backgroundColor,
      ),
    ).toBe('rgba(0, 0, 0, 0)');
    expect(
      await page.locator('.shell').evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(
      await page.locator('.side-sheet-body').evaluate((el) => getComputedStyle(el).backgroundColor),
    );
    if (motionDir) await page.screenshot({ path: join(motionDir, 'sidebar-corner.png') });
    // The exposed edge belongs to the conversation; tapping it returns to the same live draft.
    await page.mouse.click(380, 420);
    await closed();
    expect(await draft.inputValue()).toBe('Keep this draft while browsing recent questions.');
    expect(await page.locator('.frame').evaluate((el) => el.getBoundingClientRect().left)).toBe(0);
    await draft.fill('');
  });

  it('slides viewport-sized snapshots without scaling when the outgoing page is taller', async () => {
    await page.goto(relay.origin + '/');
    await page.locator('main .qrow').first().waitFor();
    await page.locator('.questions-page').evaluate((el) => {
      (el as HTMLElement).style.minHeight = '1800px';
    });
    await page.evaluate(() => {
      type Sample = {
        width: number;
        height: number;
        a: number;
        b: number;
        c: number;
        d: number;
        x: number;
        y: number;
      };
      const root = document.documentElement;
      const output: Sample[] = [];
      (window as unknown as { slideFrames: Sample[] }).slideFrames = output;
      const sample = () => {
        const group = getComputedStyle(root, '::view-transition-group(root)');
        const incoming = getComputedStyle(root, '::view-transition-new(root)');
        if (incoming.animationName === 'page-enter') {
          const matrix = new DOMMatrix(
            incoming.transform === 'none' ? undefined : incoming.transform,
          );
          output.push({
            width: parseFloat(group.width),
            height: parseFloat(group.height),
            a: matrix.a,
            b: matrix.b,
            c: matrix.c,
            d: matrix.d,
            x: matrix.e,
            y: matrix.f,
          });
        }
        if (root.dataset.pageMotion) requestAnimationFrame(sample);
      };
      const observer = new MutationObserver(() => {
        if (root.dataset.pageMotion === 'forward') {
          observer.disconnect();
          requestAnimationFrame(sample);
        }
      });
      observer.observe(root, { attributes: true, attributeFilter: ['data-page-motion'] });
    });
    await page.locator('main .qrow').first().click();
    await page.locator('.ws .dock').waitFor();
    await until(
      async () => page.evaluate(() => !document.documentElement.dataset.pageMotion),
      5000,
      'the slide to finish',
    );
    const frames = await page.evaluate(
      () =>
        (
          window as unknown as {
            slideFrames: {
              width: number;
              height: number;
              a: number;
              b: number;
              c: number;
              d: number;
              x: number;
              y: number;
            }[];
          }
        ).slideFrames,
    );
    expect(frames.length).toBeGreaterThan(3);
    for (const frame of frames) {
      expect(frame.width).toBeCloseTo(390, 0);
      expect(frame.height).toBeCloseTo(844, 0);
      expect([frame.a, frame.b, frame.c, frame.d, frame.y]).toEqual([1, 0, 0, 1, 0]);
    }
    expect(frames.some((frame) => frame.x > 40 && frame.x < 350)).toBe(true);
    if (motionDir) await page.screenshot({ path: join(motionDir, 'compact-composer.png') });
  });

  it('animates question navigation in both directions and honors reduced motion', async () => {
    await page.goto(relay.origin + '/');
    await page.locator('main .qrow').first().waitFor();
    await page.evaluate(() => {
      const root = document.documentElement;
      (window as unknown as { routeMotions: string[] }).routeMotions = [];
      new MutationObserver(() => {
        if (root.dataset.pageMotion)
          (window as unknown as { routeMotions: string[] }).routeMotions.push(
            root.dataset.pageMotion,
          );
      }).observe(root, { attributes: true, attributeFilter: ['data-page-motion'] });
    });
    await page.locator('main .qrow').first().click();
    await page.locator('.ws .dock').waitFor();
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/');
    await until(
      async () => page.evaluate(() => !document.documentElement.dataset.pageMotion),
      5000,
      'route motion to finish',
    );
    expect(
      await page.evaluate(() => (window as unknown as { routeMotions: string[] }).routeMotions),
    ).toEqual(expect.arrayContaining(['forward', 'back']));

    await page.emulateMedia({ reducedMotion: 'reduce' });
    try {
      await page.evaluate(() => {
        (window as unknown as { routeMotions: string[] }).routeMotions = [];
      });
      await page.locator('main .qrow').first().click();
      await page.locator('.ws .dock').waitFor();
      await openSidebar();
      await page.keyboard.press('Escape');
      await closed();
      expect(await page.locator('.frame').evaluate((el) => el.getBoundingClientRect().left)).toBe(
        0,
      );
      expect(
        await page.evaluate(() => (window as unknown as { routeMotions: string[] }).routeMotions),
      ).toEqual([]);
    } finally {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
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
