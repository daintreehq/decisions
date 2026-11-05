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
  type PaneSnapshotInput,
  type ProxyEngine,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import {
  CLAIM_SECRET,
  findChromium,
  startRelay,
  tick,
  until,
  type RunningRelay,
} from './harness.js';

/**
 * Captures Home's rows and the sidebar's Recent rows with each asking agent's observed state, for design review:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test agent-state-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. Everything goes through the real seams: a real relay, the real desktop
 * client publishing encrypted questions and pane snapshots, and the PWA paired through its own UI. The mix covers
 * working, waiting and exited agents, stale snapshots (the run waits out the relay's 60 s freshness window), a
 * desktop that does not share its panes, and a question from a desktop that never published a snapshot.
 * DESIGN_BASELINE=1 captures a build without agent states (the same scenes, with nothing extra on the rows).
 * Each capture checks what it claims to show before it writes, and the run fails if any expected file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const BASELINE = process.env.DESIGN_BASELINE === '1';
const chromiumPath = findChromium();
const PORT = Number(process.env.AGENT_STATE_CAPTURE_PORT ?? 8823);
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 820 };
/** The relay's freshness window (`LIMITS.snapshotFreshMs`) plus a margin. */
const STALE_AFTER_MS = 64_000;

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

/** Answers the changelog question only, so the list holds one model answer beside the ones that need a person. */
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
      retrieval_reference_ids: [],
      risk_flags: [],
    };
  },
};

type Fresh = 'fresh' | 'stale';
/** What each question's row should show: an agent state and its freshness, or nothing at all. */
type Expect = { state: string; fresh: Fresh } | null;

describe.skipIf(!OUT || !chromiumPath)(
  'captures of agent state in the question list and sidebar',
  () => {
    let relay: RunningRelay;
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let bridge: DecisionsBridge;
    let client: RelayClient;
    const local = new MemoryLocalStore();
    const written: string[] = [];
    const ids: Record<string, string> = {};
    /** The snapshot each question shows, by key: republished before each group so fresh ones stay fresh. */
    const fresh: Record<string, PaneSnapshotInput> = {};
    const expected: Record<string, Expect> = {};

    const settle = async (ms = 450) => {
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
    const size = (vp: { width: number; height: number }) => page.setViewportSize(vp);
    const go = async (path: string) => {
      await page.goto(relay.origin + path);
      await page.locator('#main').waitFor({ timeout: 30_000 });
    };
    const openSidebar = async () => {
      await page.locator('.menu-fab').click();
      await page.locator('dialog.sidebar-sheet[open]').waitFor({ timeout: 10_000 });
      await settle(500);
    };
    const closeSidebar = async () => {
      await page.keyboard.press('Escape');
      await until(
        async () => (await page.locator('dialog.sidebar-sheet[open]').count()) === 0,
        10_000,
        'sidebar to close',
      );
    };

    /**
     * Checks every listed row inside `scope` against what it should show, retrying while snapshots arrive. A row
     * with no expectation must carry no agent state at all. The sidebar shows fresh states only. Baseline builds have
     * no agent states anywhere.
     */
    const expectRows = async (scope: string, keys: string[]) => {
      const sidebar = /sidebar/.test(scope);
      await until(
        async () => {
          for (const key of keys) {
            const row = page.locator(`${scope} [data-row-id="${ids[key]}"]`).first();
            if ((await row.count()) === 0) return false;
            const marker = row.locator('.agent-state');
            const all = BASELINE ? null : expected[key];
            const want = sidebar && all?.fresh === 'stale' ? null : all;
            if (!want) {
              if ((await marker.count()) !== 0) return false;
              continue;
            }
            if ((await marker.count()) !== 1) return false;
            if ((await marker.getAttribute('data-state')) !== want.state) return false;
            if ((await marker.getAttribute('data-fresh')) !== want.fresh) return false;
          }
          return true;
        },
        30_000,
        `agent states in ${scope} (${keys.join(', ')})`,
      ).catch(async (e) => {
        const seen = await page
          .locator(`${scope} .agent-state`)
          .evaluateAll((els) =>
            els.map(
              (el) =>
                `${el.closest('[data-row-id]')?.getAttribute('data-row-id')}=${el.getAttribute('data-state')}/${el.getAttribute('data-fresh')}`,
            ),
          );
        throw new Error(`${(e as Error).message}; seen: ${seen.join(' ') || 'none'}`);
      });
    };
    /** The sidebar's foot says the socket is live: declaring the snapshot feature must never cost the connection. */
    const expectLive = (scope: string) =>
      page
        .locator(`${scope} .conn-line[data-state="live"]`)
        .waitFor({ timeout: 20_000 })
        .catch(() => {
          throw new Error(`the connection in ${scope} is not live`);
        });
    /** Publishes the fresh snapshots again, so they stay inside the freshness window for the next captures. */
    const refreshFresh = async () => {
      for (const [key, input] of Object.entries(fresh)) {
        expect(await bridge.publishSnapshot(ids[key]!, { ...input, observedAt: new Date() })).toBe(
          'queued',
        );
      }
      // The bridge coalesces and spaces its sends; give them time to reach the relay and the phone.
      await tick(1_500);
    };
    const rowOrder = (scope: string) =>
      page
        .locator(`${scope} [data-row-id]`)
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-row-id')));

    beforeAll(async () => {
      mkdirSync(OUT!, { recursive: true });
      relay = await startRelay(PORT);
      browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
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

    it('captures rows with working, waiting, exited, stale, unshared and unpublished agents', async () => {
      const home = mkdtempSync(join(tmpdir(), 'decisions-agent-state-'));
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
        resolver: { resolve: async () => null },
        // The capture never answers refresh requests: rows do not ask for them.
        snapshots: { onRefresh: async () => undefined, minIntervalMs: 200 },
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
      // Oldest first: the last one asked is the most recent.
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
      await ask('legacy', origin('p5', 'release-scripts'), {
        question: 'Tag the release candidate from main, or wait for the docs PR to land?',
        kind: 'choice',
        options: [
          { id: 'now', label: 'Tag it now' },
          { id: 'wait', label: 'Wait for the docs PR' },
        ],
      });
      await ask('unshared', origin('p8', 'docs-site'), {
        question: 'Publish the self-hosting guide with the screenshots from the redesign?',
        kind: 'approval',
        options: yesNo('Publish', 'Hold it'),
      });
      await ask('tokens', origin('p9', 'design-tokens'), {
        question:
          'Regenerate the theme tokens from Daintree’s latest themes before the release branch is cut?',
        kind: 'approval',
        options: yesNo('Regenerate', 'Leave them'),
      });
      await ask('text', origin('p3', 'customer-onboarding-service', 'gemini'), {
        question:
          'The migration guide mentions v2 in three places and v3 in one. Which version should it describe, and should the v2 steps move to an appendix?',
        kind: 'text',
        options: [],
      });
      await ask('choice', origin('p2', 'billing-api'), {
        question: 'Which retry strategy should the webhook sender use?',
        kind: 'choice',
        options: [
          { id: 'backoff', label: 'Exponential backoff' },
          { id: 'queue', label: 'Durable queue + dead letter' },
        ],
      });
      await ask('rename', origin('p4', 'daintree'), {
        question: 'Rename “Canopy” to “Inbox” in the sidebar?',
        kind: 'approval',
        options: yesNo('Yes, rename', 'Keep Canopy'),
      });
      await ask('design', origin('p1', 'daintree'), {
        question: 'Approve the compact sidebar for the Agents view?',
        context: 'Design review, round 3. The sidebar collapses to icons below 900px.',
        kind: 'approval',
        options: yesNo('Approve', 'Reject'),
      });
      await bridge.pump();
      expect(await bridge.runProxy(ids.proxy!)).toBe('answered');
      await bridge.cancelQuestion(ids.withdrawn!);
      await bridge.pump();

      const snap = (
        agentState: string,
        paneTitle: string,
        waitingReason: PaneSnapshotInput['waitingReason'] = null,
      ): PaneSnapshotInput => ({
        agentState,
        waitingReason,
        paneTitle,
        terminal: ['$ pnpm test', ' ✓ 214 passed', '> Waiting for the person to answer…'],
      });

      // The stale ones go first and are left alone: once the window passes, the relay calls them stale.
      const staleSet: Record<string, PaneSnapshotInput> = {
        text: snap('waiting', 'Claude Code — migration guide', 'prompt'),
        proxy: snap('working', 'Codex — billing-api'),
      };
      for (const [key, input] of Object.entries(staleSet)) {
        expect(await bridge.publishSnapshot(ids[key]!, input)).toBe('queued');
      }
      // A desktop with sharing turned off says so; "legacy" never publishes anything, like a 0.3.0 desktop.
      await bridge.clearSnapshots(ids.unshared!);
      await tick(STALE_AFTER_MS);

      fresh.design = snap('waiting', 'Claude Code — agents view', 'question');
      fresh.choice = snap('working', 'Claude Code — webhooks');
      fresh.tokens = snap('exited', 'Claude Code — design tokens');
      fresh.rename = snap('working', 'Claude Code — sidebar copy');
      Object.assign(expected, {
        design: { state: 'waiting', fresh: 'fresh' },
        choice: { state: 'working', fresh: 'fresh' },
        tokens: { state: 'exited', fresh: 'fresh' },
        rename: { state: 'working', fresh: 'fresh' },
        text: { state: 'waiting', fresh: 'stale' },
        proxy: { state: 'working', fresh: 'stale' },
        unshared: null,
        legacy: null,
        withdrawn: null,
      } satisfies Record<string, Expect>);
      await refreshFresh();

      // Answer the rename question through the UI, so one row is answered by the person.
      await go(`/q/${ids.rename}`);
      await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
      await page
        .getByRole('radio', { name: /Yes, rename/ })
        .first()
        .check();
      await page.getByRole('button', { name: 'Send decision' }).click();
      await page
        .locator('.ws .receipt')
        .filter({ hasText: 'Typed into the terminal' })
        .waitFor({ timeout: 30_000 });

      const needs = ['design', 'choice', 'text', 'tokens', 'unshared', 'legacy'];
      const all = [...needs, 'rename', 'proxy', 'withdrawn'];

      // Phone, light.
      await refreshFresh();
      await go('/');
      await page.getByText('Approve the compact sidebar').first().waitFor({ timeout: 30_000 });
      await expectRows('.navigator', needs);
      await shot('p-home-light');
      await openSidebar();
      await expectRows('dialog.sidebar-sheet[open]', all);
      await expectLive('dialog.sidebar-sheet[open]');
      await shot('p-side-light');
      await closeSidebar();
      // Home lists every question in sections, so the closed ones are further down the same list.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expectRows('.navigator', all);
      await page.evaluate(() => window.scrollTo(0, 280));
      await shot('p-home-all-light');
      await page.evaluate(() => window.scrollTo(0, 0));

      // A state changes while the list is open: the row follows without a reload, and nothing moves.
      await expectRows('.navigator', needs);
      const before = await rowOrder('.navigator');
      fresh.choice = snap('waiting', 'Claude Code — webhooks', 'prompt');
      expected.choice = { state: 'waiting', fresh: 'fresh' };
      await refreshFresh();
      await expectRows('.navigator', needs);
      const after = await rowOrder('.navigator');
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error('the list reordered when an agent state changed');
      await shot('p-home-changed-light');

      // The Questions & answers sheet inside a question (Ctrl/⌘+K) uses the same rows.
      await go(`/q/${ids.design}`);
      await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
      await page.keyboard.press('ControlOrMeta+K');
      await page.locator('.navigator[data-presentation="sheet"]').waitFor({ timeout: 10_000 });
      await expectRows('.navigator[data-presentation="sheet"]', needs);
      await shot('p-sheet-light');
      await page.keyboard.press('Escape');

      // Phone, dark.
      await theme('dark');
      await refreshFresh();
      await go('/');
      await page.getByText('Approve the compact sidebar').first().waitFor({ timeout: 30_000 });
      await expectRows('.navigator', needs);
      await shot('p-home-dark');
      await openSidebar();
      await expectRows('dialog.sidebar-sheet[open]', all);
      await expectLive('dialog.sidebar-sheet[open]');
      await shot('p-side-dark');
      await closeSidebar();

      // Wide: the sidebar is a persistent column beside Home.
      await size(WIDE);
      await refreshFresh();
      await go('/');
      await settle();
      await expectRows('aside.sidebar', all);
      await expectRows('.navigator', needs);
      await expectLive('aside.sidebar');
      await shot('w-home-dark');
      await theme('light');
      await shot('w-home-light');
      await size(PHONE);

      expect(written.length).toBe(9);
    });
  },
);
