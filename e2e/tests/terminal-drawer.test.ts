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
  type PaneSnapshotInput,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { API_PREFIX } from '@daintreehq/decisions-protocol';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * The chat's terminal drawer against the real relay and desktop client: the phone reads the asking pane's snapshot,
 * asks the desktop for a fresh one on opening, marks it stale when the desktop does not answer, says when sharing is
 * off, and closes on Back before the chat does.
 */
const PORT = 8841;
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

const FIXTURE: PaneSnapshotInput = {
  agentState: 'waiting',
  waitingReason: 'prompt',
  paneTitle: 'Claude Code · Webhook retries',
  terminal: ['$ pnpm test webhooks', ' ✓ 63 passed', '> Which retry strategy should I use?'],
};

describe.skipIf(!chromiumPath)('terminal drawer', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let page: Page;
  let bridge: DecisionsBridge;
  const ids: Record<string, string> = {};
  /** Questions whose desktop answers refresh requests (the rest play a sleeping computer). */
  const awake = new Set<string>();
  const refreshes: string[] = [];

  const go = async (key: string) => {
    await page.goto(`${relay.origin}/q/${ids[key]}`);
    await page.locator('#terminal-button').waitFor({ timeout: 30_000 });
  };
  const drawer = () => page.locator('dialog.term-drawer[open]');
  const openDrawer = async () => {
    await page.locator('#terminal-button').click();
    await drawer().waitFor({ timeout: 10_000 });
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

    const home = mkdtempSync(join(tmpdir(), 'decisions-terminal-e2e-'));
    const keyStore = new FileKeyStore(home);
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'E2E Mac',
      store: keyStore,
    });
    const client = new RelayClient({ identity });
    bridge = new DecisionsBridge({
      identity,
      keyStore,
      store: new MemoryLocalStore(),
      sink: new Sink(),
      client,
      pumpIntervalMs: 0,
      snapshots: {
        minIntervalMs: 200,
        onRefresh: async ({ questionId }) => {
          refreshes.push(questionId);
          if (awake.has(questionId))
            await bridge.publishSnapshot(questionId, { ...FIXTURE, observedAt: new Date() });
        },
      },
    });
    await bridge.start();

    const invite = await createPairingInvite(client, 'phone');
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

    for (const [key, pane] of [
      ['shared', 'p1'],
      ['asleep', 'p2'],
      ['unshared', 'p3'],
    ] as const) {
      const r = await bridge.registerQuestion({
        origin: origin(pane, 'billing-api'),
        input: { question: `Terminal drawer question (${key})?`, kind: 'text', options: [] },
      });
      ids[key] = r.questionId;
    }
    await bridge.pump();
    awake.add(ids.shared!);
    expect(await bridge.publishSnapshot(ids.shared!, FIXTURE)).toBe('queued');
    expect(await bridge.publishSnapshot(ids.asleep!, FIXTURE)).toBe('queued');
    await bridge.clearSnapshots(ids.unshared!);
    // The desktop queues and spaces its sends: wait until the relay holds each snapshot, so a test's own refresh
    // request never meets the first publication still on its way.
    const onRelay = (id: string, sharing: 'on' | 'off') =>
      until(
        async () => {
          const r = await client.request<{ snapshot: { record: { sharing: string } } | null }>(
            'GET',
            `${API_PREFIX}/questions/${id}/snapshot`,
          );
          return r.snapshot?.record.sharing === sharing;
        },
        20_000,
        `the relay to hold the ${sharing === 'on' ? 'shared' : 'sharing-off'} snapshot`,
      );
    await onRelay(ids.shared!, 'on');
    await onRelay(ids.asleep!, 'on');
    await onRelay(ids.unshared!, 'off');
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('opens the drawer and shows the fixture snapshot', async () => {
    await go('shared');
    await openDrawer();
    await drawer()
      .getByRole('heading', { name: /Claude Code · Webhook retries/ })
      .waitFor();
    await drawer().getByText('Waiting at its prompt', { exact: true }).waitFor({ timeout: 20_000 });
    const lines = drawer().getByRole('region', { name: 'Last terminal lines' });
    await lines.getByText('Which retry strategy should I use?', { exact: false }).waitFor();
    // Scrolled to the newest line, and the lines are text, not controls.
    expect(await lines.locator('button, a, input, textarea').count()).toBe(0);
    await page.keyboard.press('Escape');
    await until(async () => (await drawer().count()) === 0, 10_000, 'the drawer to close');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal-button');
  });

  it('asks the desktop for a fresh snapshot when it opens', async () => {
    await go('shared');
    const before = refreshes.filter((id) => id === ids.shared).length;
    await openDrawer();
    await until(
      async () => refreshes.filter((id) => id === ids.shared).length > before,
      20_000,
      'a refresh request',
    );
    await drawer().locator('.term-status[data-freshness="fresh"]').waitFor({ timeout: 20_000 });
    await page.keyboard.press('Escape');
  });

  it('marks the snapshot stale when the desktop does not answer', async () => {
    await go('asleep');
    await openDrawer();
    await drawer().getByText('Asking…').waitFor({ timeout: 10_000 });
    // The relay's refresh deadline is 15 s; past it the last snapshot stays, marked stale with its age.
    await drawer()
      .getByText(/^Stale/)
      .waitFor({ timeout: 30_000 });
    await drawer()
      .getByText(/as of /)
      .waitFor();
    await drawer().getByText('Which retry strategy should I use?', { exact: false }).waitFor();
    expect(await page.locator('#terminal-button').getAttribute('aria-label')).toMatch(
      /^Terminal, agent waiting at its prompt, stale, as of /,
    );
    await page.keyboard.press('Escape');
  });

  it('says when terminal sharing is off on the computer', async () => {
    await go('unshared');
    // The button's name follows the snapshot, which the page reads once it has loaded.
    await until(
      async () =>
        (await page.locator('#terminal-button').getAttribute('aria-label')) ===
        'Terminal, not shared',
      20_000,
      'the button to say sharing is off',
    );
    await openDrawer();
    await drawer().getByRole('heading', { name: 'Not shared' }).waitFor({ timeout: 20_000 });
    await drawer()
      .getByText(/Terminal sharing is off on E2E Mac/)
      .waitFor();
    expect(
      await drawer()
        .locator('.term-title')
        .evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe('none');
    await drawer().getByRole('button', { name: /Close/ }).click();
    await until(
      async () => (await drawer().count()) === 0,
      10_000,
      'the drawer to close after a tap',
    );
    expect(
      await page.locator('#terminal-button').evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe('none');
    // Keyboard users still have a visible, neutral focus indicator after dismissal.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    expect(
      await page.locator('#terminal-button').evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe('solid');
  });

  it('closes on Back before leaving the chat', async () => {
    await go('shared');
    await openDrawer();
    await page.goBack();
    await until(async () => (await drawer().count()) === 0, 10_000, 'Back to close the drawer');
    expect(new URL(page.url()).pathname).toBe(`/q/${ids.shared}`);
    await page.locator('.ws .ws-head').waitFor();
  });
});
