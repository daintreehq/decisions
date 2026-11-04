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

const PORT = 8829;
const chromiumPath = findChromium();
const MAC = 'E2E MacBook';
const STUDIO = 'E2E Studio';

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

const origin = (pane: string, project: string, machine: string): QuestionOrigin => ({
  machine_label: machine,
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

describe.skipIf(!chromiumPath)('Home: one compact list of every question', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let page: Page;
  let bridge: DecisionsBridge;
  const ids: string[] = [];
  /** What the list holds once set up: every row, and the rows from each computer. */
  let total = 0;
  let fromStudio = 0;
  let fromMac = 0;
  /** Rows on the page itself (the sidebar's Recent holds the same text). */
  const rows = () => page.locator('main a.qrow');
  const rowTexts = () => rows().allInnerTexts();
  const sheet = () => page.locator('dialog.filter-sheet[open]');
  const home = async () => {
    await page.goto(relay.origin + '/');
    await rows().first().waitFor({ timeout: 30_000 });
  };

  beforeAll(async () => {
    relay = await startRelay(PORT);
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'allow',
      hasTouch: true,
    });
    page = await context.newPage();

    const store = new FileKeyStore(mkdtempSync(join(tmpdir(), 'decisions-home-e2e-')));
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: MAC,
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
    await page.getByText('No questions yet.').waitFor({ timeout: 30_000 });

    // Fourteen questions from two computers and two projects: long enough to scroll on a phone.
    const ask = async (i: number, pane: string) => {
      const machine = i % 2 === 0 ? MAC : STUDIO;
      const project = i % 3 === 0 ? 'billing-api' : 'daintree';
      const r = await bridge.registerQuestion({
        origin: origin(pane, project, machine),
        input: {
          question:
            i === 5
              ? 'Which retry strategy should the webhook sender use?'
              : `Question ${i + 1} from ${machine}: approve the change to ${project}?`,
          kind: 'approval',
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
      });
      ids.push(r.questionId);
    };
    // A phone that has only just paired can miss what is asked in its first moments (a sync race outside Home), so
    // ask a first question until the phone shows it, and only then the rest.
    for (let attempt = 0; ; attempt++) {
      await ask(0, `p0-${attempt}`);
      await bridge.pump();
      const seen = await until(async () => (await rows().count()) > 0, 10_000, 'a first question')
        .then(() => true)
        .catch(() => false);
      if (seen) break;
      if (attempt === 5) throw new Error('the phone never showed a question');
    }
    for (let i = 1; i < 14; i++) await ask(i, `p${i}`);
    await bridge.pump();
    await home();
    // Questions that arrive after the first sync are held behind "N new questions" (rows never reshuffle under the
    // finger), so take them in the way a person would.
    await until(
      async () => {
        const pill = page.locator('main .nav-new');
        if (await pill.isVisible().catch(() => false)) await pill.click();
        return (await rows().count()) >= 14;
      },
      30_000,
      'all fourteen questions',
    );
    const texts = await rowTexts();
    total = texts.length;
    fromStudio = texts.filter((t) => t.includes(STUDIO)).length;
    fromMac = texts.filter((t) => t.includes(MAC)).length;
    expect(fromStudio).toBeGreaterThanOrEqual(7);
    expect(fromMac).toBeGreaterThanOrEqual(7);
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('has no headline and no scope segments: the list starts under the round buttons', async () => {
    await home();
    // The page keeps a heading for screen readers, but nothing on screen.
    const h1 = (await page.getByRole('heading', { level: 1, name: 'Questions' }).boundingBox())!;
    expect(h1.width).toBeLessThanOrEqual(1);
    expect(await page.locator('main .seg').count()).toBe(0);
    expect(await page.getByRole('heading', { name: /Needs you/ }).isVisible()).toBe(true);
    const search = page.getByRole('button', { name: 'Search questions' });
    const box = (await search.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeGreaterThan(390 - 32);
    expect(box.y).toBeLessThan(20);
  });

  it('searches, then closes search and returns focus to its button', async () => {
    await home();
    const button = page.getByRole('button', { name: 'Search questions' });
    expect(await button.getAttribute('aria-expanded')).toBe('false');
    await button.click();
    const field = page.getByRole('searchbox', { name: 'Search questions' });
    await until(
      async () => page.evaluate(() => document.activeElement?.getAttribute('type') === 'search'),
      5_000,
      'focus in the search field',
    );
    await field.fill('retry strategy');
    await until(async () => (await rows().count()) === 1, 10_000, 'one match');
    expect((await rowTexts())[0]).toContain('Which retry strategy');
    await page.getByRole('button', { name: 'Close search' }).click();
    await until(async () => (await rows().count()) === total, 10_000, 'the whole list again');
    expect(await field.count()).toBe(0);
    await until(
      async () =>
        page.evaluate(
          () => document.activeElement?.getAttribute('aria-label') === 'Search questions',
        ),
      5_000,
      'focus back on the search button',
    );
  });

  it('filters by computer in a sheet, shows the filter as a chip, and keeps it after a reload', async () => {
    await home();
    await page.getByRole('button', { name: /^Filter questions/ }).click();
    await sheet().waitFor({ timeout: 10_000 });
    expect(await sheet().getByRole('group', { name: 'Computer' }).isVisible()).toBe(true);
    await sheet().locator('label.facet-opt', { hasText: STUDIO }).click();
    expect(
      await sheet()
        .getByRole('radio', { name: new RegExp(STUDIO) })
        .isChecked(),
    ).toBe(true);
    await sheet().getByRole('button', { name: 'Done' }).click();
    await until(async () => (await sheet().count()) === 0, 10_000, 'the sheet to close');
    await until(async () => (await rows().count()) === fromStudio, 10_000, 'the Studio rows');
    for (const t of await rowTexts()) expect(t).toContain(STUDIO);
    const chip = page.getByRole('button', { name: `Remove filter: Computer ${STUDIO}` });
    await chip.waitFor();

    // The filter persists on this device.
    await page.reload();
    await chip.waitFor({ timeout: 30_000 });
    await until(
      async () => (await rows().count()) === fromStudio,
      10_000,
      'still filtered after reload',
    );
  });

  it('clears a filter from its chip', async () => {
    await home();
    const chip = page.getByRole('button', { name: `Remove filter: Computer ${STUDIO}` });
    await chip.waitFor({ timeout: 10_000 });
    await chip.click();
    await until(async () => (await rows().count()) === total, 10_000, 'the whole list again');
    expect(await page.getByRole('button', { name: /^Remove filter/ }).count()).toBe(0);
  });

  it('opens a question, and Back keeps the filters', async () => {
    await home();
    await page.getByRole('button', { name: /^Filter questions/ }).click();
    await sheet().locator('label.facet-opt', { hasText: MAC }).click();
    await sheet().getByRole('button', { name: 'Done' }).click();
    await until(async () => (await rows().count()) === fromMac, 10_000, 'the MacBook rows');
    const row = rows().nth(2);
    const id = await row.getAttribute('data-row-id');
    await row.click();
    await page.waitForURL((u) => u.pathname === `/q/${id}`, { timeout: 15_000 });
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 15_000 });
    await rows().first().waitFor({ timeout: 15_000 });
    expect(
      await page.getByRole('button', { name: `Remove filter: Computer ${MAC}` }).isVisible(),
    ).toBe(true);
    expect(await rows().count()).toBe(fromMac);
    await page.getByRole('button', { name: /^Remove filter/ }).click();
    await until(async () => (await rows().count()) === total, 10_000, 'the whole list again');
  });

  it('opens a question, and Back returns to the same scroll position with focus on the row', async () => {
    await home();
    await page.evaluate(() => window.scrollTo(0, 300));
    await until(async () => (await page.evaluate(() => window.scrollY)) >= 250, 5_000, 'a scroll');
    const before = await page.evaluate(() => window.scrollY);
    const row = rows().nth(7);
    const id = await row.getAttribute('data-row-id');
    await row.click();
    await page.waitForURL((u) => u.pathname === `/q/${id}`, { timeout: 15_000 });
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 15_000 });
    await rows().first().waitFor({ timeout: 15_000 });
    await until(
      async () => Math.abs((await page.evaluate(() => window.scrollY)) - before) <= 2,
      5_000,
      'the scroll position to come back',
    );
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-row-id'))).toBe(id);
  });
});
