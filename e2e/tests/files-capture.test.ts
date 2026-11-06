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
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Captures a question's files, for design review: the inline gallery (a Before | After pair and a five-file
 * strip), loading and failure states, All files, the viewer at Fit and zoomed with its tools, Move, the file menu
 * and the Open/Download explanation, the Question sheet, and comparison (a switch on a phone, side-by-side panes on
 * a wide screen), in both themes:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e exec vitest run tests/files-capture.test.ts
 * Skipped unless DESIGN_CAPTURE_DIR is set. Everything goes through the real seams: a real relay, the real desktop
 * bridge resolving and encrypting each attachment, and the PWA paired through its own UI, once as a phone (touch)
 * and once as a desktop browser (mouse). Each capture checks what it claims to show before it writes, and the run
 * fails if any file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.FILES_CAPTURE_PORT ?? 8960);
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1440, height: 900 };
const LARGE = { width: 1728, height: 1080 };

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

/** Renders markup as a PNG at a given size, so each attachment is a believable screenshot. */
async function render(
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

/** A desktop agents screen, with the sidebar expanded (before) or collapsed to icons (after). */
const agentsUi = (variant: 'before' | 'after') => {
  const wide = variant === 'before';
  const nav = ['Projects', 'Agents', 'Worktrees', 'Reviews', 'Settings'];
  const rows = [
    ['feature/login-redirect', 'Working', '#36ce94', '4 files changed'],
    ['fix/retry-backoff', 'Waiting', '#e0b25c', 'Needs your answer'],
    ['chore/upgrade-vite', 'Idle', '#8b8f94', 'Finished 12 min ago'],
    ['feature/billing-export', 'Working', '#36ce94', '11 files changed'],
    ['fix/sidebar-focus', 'Exited', '#8b8f94', 'Exited with code 1'],
  ];
  return `<div style="display:flex;height:900px;background:#111312;color:#e4e6e4">
    <div style="width:${wide ? 248 : 64}px;background:#161918;padding:18px ${wide ? 14 : 10}px;box-sizing:border-box;border-right:1px solid #262a28">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:22px">
        <div style="width:28px;height:28px;border-radius:7px;background:#36ce94"></div>
        ${wide ? '<div style="font-weight:700;font-size:16px">Daintree</div>' : ''}
      </div>
      ${nav
        .map(
          (t) =>
            `<div style="display:flex;align-items:center;gap:10px;padding:10px;border-radius:8px;margin:2px 0;${t === 'Agents' ? 'background:#232826' : ''}"><div style="width:18px;height:18px;border-radius:4px;border:2px solid ${t === 'Agents' ? '#e4e6e4' : '#7b807d'}"></div>${wide ? `<span style="color:${t === 'Agents' ? '#fff' : '#a9aeab'}">${t}</span>` : ''}</div>`,
        )
        .join('')}
    </div>
    <div style="flex:1;padding:28px 32px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <div style="font-size:22px;font-weight:700">Agents</div>
        <div style="padding:8px 14px;border:1px solid #333836;border-radius:8px;color:#c9cdca">New agent</div>
      </div>
      ${rows
        .map(
          ([b, s, c, d]) =>
            `<div style="display:flex;align-items:center;gap:14px;background:#171a19;border:1px solid #262a28;border-radius:10px;padding:16px 18px;margin-bottom:10px">
              <span style="width:9px;height:9px;border-radius:50%;background:${c}"></span>
              <span style="font-family:ui-monospace,Menlo,monospace;font-size:14px;flex:1">${b}</span>
              <span style="color:#a9aeab;width:200px">${d}</span>
              <span style="color:${c};width:70px;text-align:right">${s}</span>
            </div>`,
        )
        .join('')}
    </div>
  </div>`;
};

const settingRow = (label: string, value: string) =>
  `<div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #e6e1d8;background:#ffffff"><span>${label}</span><span style="color:#6b6458">${value}</span></div>`;

/** Five different screens for a set: wide desktop, a tall phone capture, a dialog, a chart, a terminal. */
async function fixtures(browser: Browser): Promise<Record<string, Uint8Array>> {
  const set: Record<string, Uint8Array> = {
    'before.png': await render(browser, { width: 1440, height: 900 }, agentsUi('before')),
    'after.png': await render(browser, { width: 1440, height: 900 }, agentsUi('after')),
    'g-settings.png': await render(
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
    'g-phone.png': await render(
      browser,
      { width: 390, height: 1400 },
      `<div style="background:#110d0b;color:#e4e4e7;min-height:1400px;padding:56px 18px 18px;box-sizing:border-box">
        <div style="font-size:26px;font-weight:700;margin-bottom:16px">Agents</div>
        ${Array.from({ length: 11 }, (_, i) => `<div style="background:#1f1b19;border:1px solid #2e2926;border-radius:12px;padding:16px;margin-bottom:12px"><div style="font-weight:600">checkout-${i + 1}</div><div style="color:#a1a1aa;margin-top:6px">${i % 3 === 0 ? 'Waiting for you' : 'Working · 4 files changed'}</div></div>`).join('')}
      </div>`,
    ),
    'g-dialog.png': await render(
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
    'g-chart.png': await render(
      browser,
      { width: 1000, height: 620 },
      `<div style="height:620px;background:#1a1918;color:#e4e4e7;padding:28px;box-sizing:border-box">
        <div style="font-size:18px;font-weight:700;margin-bottom:24px">Webhook retries, last 24 h</div>
        <div style="display:flex;align-items:flex-end;gap:14px;height:440px;border-bottom:1px solid #3f3b38">
          ${[40, 62, 55, 90, 140, 210, 320, 280, 190, 120, 80, 60, 45, 70, 110].map((h) => `<div style="flex:1;height:${h}px;background:#36ce94;border-radius:4px 4px 0 0"></div>`).join('')}
        </div>
      </div>`,
    ),
    'g-terminal.png': await render(
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
  // The same five screens again under other names, for the failure and loading questions (their own downloads).
  for (const k of ['g-settings', 'g-phone', 'g-dialog', 'g-chart', 'g-terminal']) {
    set[`x-${k}.png`] = set[`${k}.png`]!;
    set[`l-${k}.png`] = set[`${k}.png`]!;
  }
  return set;
}

const FIVE = (prefix: string) => [
  { local_resource_id: `${prefix}g-settings.png`, alt: 'Appearance settings, desktop' },
  { local_resource_id: `${prefix}g-phone.png`, alt: 'Agents list on a phone' },
  { local_resource_id: `${prefix}g-dialog.png`, alt: 'Delete dialog' },
  { local_resource_id: `${prefix}g-chart.png`, alt: 'Webhook retries chart' },
  { local_resource_id: `${prefix}g-terminal.png` },
];

describe.skipIf(!OUT || !chromiumPath)('captures of a question’s files', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  let images: Record<string, Uint8Array> = {};
  const local = new MemoryLocalStore();
  const written: string[] = [];
  const ids: Record<string, string> = {};
  const contexts: Record<'phone' | 'desk', { context: BrowserContext; page: Page }> = {} as never;

  const settle = async (page: Page, ms = 500) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(ms);
  };
  const shot = async (page: Page, name: string) => {
    await settle(page);
    const path = join(OUT!, `${name}.png`);
    await page.screenshot({ path });
    if (!existsSync(path) || statSync(path).size < 2_000)
      throw new Error(`capture ${name} is empty`);
    written.push(name);
  };
  const theme = (page: Page, scheme: 'light' | 'dark') =>
    page.emulateMedia({ colorScheme: scheme });
  const openId = async (page: Page, key: string) => {
    await page.goto(`${relay.origin}/q/${ids[key]}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
  };
  /** The inline gallery shows its active file and every thumbnail (or the switch) has loaded. */
  const filesReady = async (page: Page) => {
    await page.locator('.fx-inline-stage .fs-slide.is-active img').waitFor({ timeout: 30_000 });
    await until(
      async () =>
        (await page.locator('.fx-thumb img').count()) === (await page.locator('.fx-thumb').count()),
      30_000,
      'every thumbnail to load',
    );
  };
  /** Brings the files into view the way a person scrolls the chat: the stage under the header. */
  const toFiles = async (page: Page) => {
    await page.evaluate(() => {
      const el = document.querySelector('.fx-files');
      const body = document.querySelector('.ws-body');
      if (!el || !body) return;
      body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 72;
    });
    await settle(page, 300);
  };
  const sizedInViewer = (page: Page) =>
    page
      .locator('.fx-viewer .fs-slide.is-active img.is-sized')
      .first()
      .waitFor({ timeout: 30_000 });

  const pair = async (page: Page) => {
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
  };

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT, PORT + 1);
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    images = await fixtures(browser);
    const phone = await browser.newContext({
      viewport: PHONE,
      deviceScaleFactor: 2,
      colorScheme: 'light',
      serviceWorkers: 'allow',
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      hasTouch: true,
      isMobile: true,
    });
    const desk = await browser.newContext({
      viewport: WIDE,
      deviceScaleFactor: 2,
      colorScheme: 'light',
      serviceWorkers: 'allow',
      locale: 'en-GB',
      timezoneId: 'Europe/London',
    });
    for (const [k, context] of [
      ['phone', phone],
      ['desk', desk],
    ] as const) {
      const page = await context.newPage();
      page.on('pageerror', (e) => console.error(`[${k} page error] ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') console.error(`[${k} console] ${m.text()}`);
      });
      contexts[k] = { context, page };
    }
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('pairs a phone and a desktop browser, and asks with files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-files-'));
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
      followUps: true,
      policy: new PolicyRegistry({ proxyAllowlisted: false }),
      pumpIntervalMs: 0,
      resolver: { resolve: async (_o, id) => (images[id] ? { bytes: images[id]! } : null) },
    });
    await bridge.start();
    await pair(contexts.phone.page);
    await pair(contexts.desk.page);

    const origin = (pane: string, project: string): QuestionOrigin => ({
      machine_label: 'Greg’s MacBook Pro',
      host_id: 'host_01JC8Z4MQ7',
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
    const ask = async (key: string, o: QuestionOrigin, input: Record<string, unknown>) => {
      const r = await bridge.registerQuestion({ origin: o, input });
      ids[key] = r.questionId;
    };
    await ask('pair', origin('p1', 'daintree'), {
      question:
        'Approve the compact sidebar? It collapses to icons below 900 px, and every icon keeps its tooltip.',
      context: 'Before and after screenshots of the Agents screen at 1440 × 900.',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Approve' },
        { id: 'no', label: 'Keep it expanded' },
      ],
      attachments: [
        { local_resource_id: 'before.png', role: 'before' },
        { local_resource_id: 'after.png', role: 'after' },
      ],
    });
    await ask('set', origin('p2', 'checkout'), {
      question: 'Which of these should I fix before the checkout release?',
      context: 'Five captures from the release candidate.',
      kind: 'choice',
      options: [
        { id: 'retry', label: 'The retry test' },
        { id: 'dialog', label: 'The delete dialog copy' },
      ],
      attachments: FIVE(''),
    });
    await ask('broken', origin('p3', 'checkout'), {
      question: 'Do these release captures look right to you?',
      kind: 'text',
      options: [],
      attachments: FIVE('x-'),
    });
    await ask('loading', origin('p4', 'billing-api'), {
      question: 'Is the receipt layout in these captures the one the client signed off?',
      kind: 'text',
      options: [],
      attachments: FIVE('l-'),
    });
    await bridge.pump();
  });

  it('captures the phone: gallery, viewer, tools, menu, sheets and comparison', async () => {
    const { page, context } = contexts.phone;
    const viewer = page.locator('.fx-viewer');

    // The Before | After pair inline, in both themes.
    await openId(page, 'pair');
    await filesReady(page);
    await toFiles(page);
    await shot(page, 'p-gallery-pair-light');
    await theme(page, 'dark');
    await shot(page, 'p-gallery-pair-dark');
    await theme(page, 'light');

    // The viewer on After at Fit, both themes.
    await page.getByRole('tab', { name: /^After/ }).click();
    await page.getByRole('button', { name: 'Enlarge After' }).click();
    await sizedInViewer(page);
    const fit = (await viewer.locator('.fx-viewer-stage').boundingBox())!;
    expect(fit.height).toBeGreaterThan(PHONE.height * 0.4);
    await shot(page, 'p-viewer-fit-light');
    await theme(page, 'dark');
    await shot(page, 'p-viewer-fit-dark');
    await theme(page, 'light');

    // Zoomed by a double-tap, then the zoom popover, then Move.
    await page.mouse.dblclick(fit.x + fit.width * 0.3, fit.y + fit.height * 0.45);
    await until(
      async () => /×/.test((await viewer.locator('.fx-zoom-value').textContent()) ?? ''),
      10_000,
      'the viewer zoomed',
    );
    await shot(page, 'p-viewer-zoomed-light');
    // The narrowest phones fold − + and Move into a Zoom popover beside Fit.
    await page.setViewportSize({ width: 360, height: 780 });
    await viewer.getByRole('button', { name: 'Zoom and move' }).click();
    await viewer.locator('.fx-zoom-popover').waitFor();
    await shot(page, 'p-viewer-zoom-menu-light');
    await page.keyboard.press('Escape');
    await viewer.locator('.fx-zoom-popover').waitFor({ state: 'detached' });
    await page.setViewportSize(PHONE);
    await settle(page, 300);
    await viewer.getByRole('button', { name: 'Move', exact: true }).click();
    await viewer.getByRole('button', { name: 'Move right' }).waitFor();
    await viewer.getByRole('button', { name: 'Move right' }).click();
    await shot(page, 'p-viewer-move-light');
    await viewer.getByRole('button', { name: 'Done' }).click();
    await viewer.getByRole('button', { name: /^Fit to screen/ }).click();

    // The file menu, the one-time Download explanation, the Question sheet.
    await viewer.getByRole('button', { name: 'File menu' }).click();
    await page.getByRole('menu').waitFor();
    await shot(page, 'p-viewer-menu-light');
    await page.getByRole('menuitem', { name: 'Download' }).click();
    await page.getByRole('dialog', { name: 'Download this file?' }).waitFor();
    await shot(page, 'p-viewer-handoff-light');
    await page
      .getByRole('dialog', { name: 'Download this file?' })
      .getByRole('button', { name: 'Cancel' })
      .click();
    await viewer.locator('.fx-id-btn').click();
    await page.getByRole('dialog', { name: 'Question', exact: true }).waitFor();
    await shot(page, 'p-viewer-question-light');
    await page.keyboard.press('Escape');
    await page
      .getByRole('dialog', { name: 'Question', exact: true })
      .waitFor({ state: 'detached' });

    // Comparison on a phone: one stage and the Before | After switch, then zoomed on Before.
    await viewer.getByRole('button', { name: 'Compare before and after' }).click();
    await page.locator('.fx-compare .fs-slide.is-active img.is-sized').waitFor({ timeout: 30_000 });
    await shot(page, 'p-compare-after-light');
    await page.locator('.fx-compare').getByRole('button', { name: 'Before', exact: true }).click();
    const cbox = (await page.locator('.fx-compare .fx-viewer-stage').boundingBox())!;
    await page.mouse.dblclick(cbox.x + cbox.width * 0.2, cbox.y + cbox.height * 0.4);
    await shot(page, 'p-compare-before-zoomed-light');
    await theme(page, 'dark');
    await shot(page, 'p-compare-before-zoomed-dark');
    await theme(page, 'light');
    await page.getByRole('button', { name: 'Close comparison' }).click();
    await page.getByRole('button', { name: 'Close viewer' }).click();
    await viewer.waitFor({ state: 'detached' });

    // The five-file set: the strip, a tall capture, the viewer partway through, All files.
    await openId(page, 'set');
    await filesReady(page);
    await toFiles(page);
    await shot(page, 'p-gallery-strip-light');
    await page.getByRole('tab', { name: /^Agents list on a phone/ }).click();
    await shot(page, 'p-gallery-tall-light');
    await theme(page, 'dark');
    await shot(page, 'p-gallery-tall-dark');
    await theme(page, 'light');
    await page.getByRole('tab', { name: /^Delete dialog/ }).click();
    await page.getByRole('button', { name: /^Enlarge/ }).click();
    await sizedInViewer(page);
    await shot(page, 'p-viewer-set-light');
    await page.getByRole('button', { name: 'Close viewer' }).click();
    await viewer.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /All files/ }).click();
    await page.locator('.fx-grid').waitFor();
    await shot(page, 'p-allfiles-light');
    await theme(page, 'dark');
    await shot(page, 'p-allfiles-dark');
    await theme(page, 'light');
    await page.keyboard.press('Escape');
    await page.locator('.fx-grid').waitFor({ state: 'detached' });

    // Loading: the files are held back, so the stage and thumbnails show Preparing.
    let hold = true;
    await context.route('**/attachments/*/content', async (route) => {
      while (hold) await new Promise((r) => setTimeout(r, 100));
      await route.continue().catch(() => undefined);
    });
    await openId(page, 'loading');
    await page
      .locator('.fx-inline-stage .fx-state.is-preparing .fx-state-text')
      .first()
      .waitFor({ timeout: 30_000 });
    await toFiles(page);
    await shot(page, 'p-gallery-preparing-light');
    hold = false;
    await context.unroute('**/attachments/*/content');

    // Failures, on a fresh load: one will not load, one fails verification, one the relay deleted.
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
    await openId(page, 'broken');
    await page.locator('.fx-thumb.is-expired').waitFor({ timeout: 30_000 });
    await page.locator('.fx-thumb.is-unverified').waitFor({ timeout: 30_000 });
    await page.locator('.fx-thumb.is-error').waitFor({ timeout: 30_000 });
    // Which file meets which failure depends on load order, so pick each state by its thumbnail.
    const showState = async (state: 'error' | 'unverified' | 'expired') => {
      await page.locator(`.fx-thumb.is-${state}`).click();
      await page
        .locator(`.fx-inline-stage .fs-slide.is-active .fx-state.is-${state}`)
        .waitFor({ timeout: 10_000 });
    };
    await showState('error');
    await toFiles(page);
    await shot(page, 'p-gallery-error-light');
    await showState('unverified');
    await shot(page, 'p-gallery-unverified-light');
    await theme(page, 'dark');
    await shot(page, 'p-gallery-unverified-dark');
    await theme(page, 'light');
    await showState('expired');
    await shot(page, 'p-gallery-expired-light');
    await page.getByRole('button', { name: /All files/ }).click();
    await page.locator('.fx-grid').waitFor();
    await shot(page, 'p-allfiles-states-light');
    await page.keyboard.press('Escape');
    await context.unroute('**/attachments/*/content');
  });

  it('captures a desktop browser: gallery, viewer, comparison panes, All files', async () => {
    const { page } = contexts.desk;
    const viewer = page.locator('.fx-viewer');

    await openId(page, 'pair');
    await filesReady(page);
    await toFiles(page);
    await shot(page, 'w-gallery-pair-light');
    await page.getByRole('button', { name: /^Enlarge/ }).click();
    await sizedInViewer(page);
    await shot(page, 'w-viewer-light');
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await shot(page, 'w-viewer-zoomed-light');
    await theme(page, 'dark');
    await shot(page, 'w-viewer-zoomed-dark');
    await theme(page, 'light');
    await page.keyboard.press('0');
    await viewer.getByRole('button', { name: 'File menu' }).click();
    await page.getByRole('menu').waitFor();
    await shot(page, 'w-viewer-menu-light');
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
    await settle(page, 300);
    // Escape closes one layer: the menu, never the viewer under it.
    console.log(`FILES-CAPTURE viewer-after-menu-escape=${await viewer.count()}`);
    if (!(await viewer.count())) {
      await page.getByRole('button', { name: /^Enlarge/ }).click();
      await sizedInViewer(page);
    }

    await viewer.getByRole('button', { name: 'Compare before and after' }).click();
    await page.locator('.fx-compare img.is-sized').first().waitFor({ timeout: 30_000 });
    await shot(page, 'w-compare-1440-light');
    // A larger desktop, where the workspace is wide enough for side-by-side panes.
    await page.setViewportSize(LARGE);
    await until(
      async () => (await page.locator('.fx-compare .fx-pane img.is-sized').count()) === 2,
      15_000,
      'side-by-side panes',
    );
    await shot(page, 'w-compare-light');
    await theme(page, 'dark');
    await shot(page, 'w-compare-dark');
    await theme(page, 'light');
    await page.locator('.fx-compare .fx-pane').first().locator('.fx-viewer-stage').focus();
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await shot(page, 'w-compare-zoomed-light');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'detached' });
    await page.setViewportSize(WIDE);

    await openId(page, 'set');
    await filesReady(page);
    await toFiles(page);
    await shot(page, 'w-gallery-strip-light');
    await theme(page, 'dark');
    await shot(page, 'w-gallery-strip-dark');
    await theme(page, 'light');
    await page.getByRole('button', { name: /All files/ }).click();
    await page.locator('.fx-grid').waitFor();
    await shot(page, 'w-allfiles-light');
    await page.keyboard.press('Escape');

    const expected = [
      'p-gallery-pair-light',
      'p-gallery-pair-dark',
      'p-viewer-fit-light',
      'p-viewer-fit-dark',
      'p-viewer-zoomed-light',
      'p-viewer-zoom-menu-light',
      'p-viewer-move-light',
      'p-viewer-menu-light',
      'p-viewer-handoff-light',
      'p-viewer-question-light',
      'p-compare-after-light',
      'p-compare-before-zoomed-light',
      'p-compare-before-zoomed-dark',
      'p-gallery-strip-light',
      'p-gallery-tall-light',
      'p-gallery-tall-dark',
      'p-viewer-set-light',
      'p-allfiles-light',
      'p-allfiles-dark',
      'p-gallery-preparing-light',
      'p-gallery-error-light',
      'p-gallery-unverified-light',
      'p-gallery-unverified-dark',
      'p-gallery-expired-light',
      'p-allfiles-states-light',
      'w-gallery-pair-light',
      'w-viewer-light',
      'w-viewer-zoomed-light',
      'w-viewer-zoomed-dark',
      'w-viewer-menu-light',
      'w-compare-1440-light',
      'w-compare-light',
      'w-compare-dark',
      'w-compare-zoomed-light',
      'w-gallery-strip-light',
      'w-gallery-strip-dark',
      'w-allfiles-light',
    ];
    const missing = expected.filter((n) => !existsSync(join(OUT!, `${n}.png`)));
    expect(missing).toEqual([]);
    expect(written.length).toBe(expected.length);
  });
});
