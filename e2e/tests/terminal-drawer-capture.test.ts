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
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Captures the chat's terminal button and the terminal drawer it opens, for design review:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test terminal-drawer-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. Everything goes through the real seams: a real relay, the real desktop
 * client publishing encrypted questions and pane snapshots (and answering the phone's refresh requests, except for
 * the questions whose computer plays asleep), and the PWA paired through its own UI. The states: working, waiting at
 * its prompt, waiting on a question, exited, a long line wrapping, stale (a refresh nobody answers), asking again
 * from stale (the card must not move), not shared, no snapshot yet, refreshing, and the drawer beside the chat on a
 * wide screen. Each capture checks what it claims to show before it writes, and the run fails if any expected file is
 * missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.TERMINAL_CAPTURE_PORT ?? 8857);
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

const WORKING = [
  '⏺ I’ll switch the webhook sender to exponential backoff and run the suite.',
  '',
  '⏺ Update(src/webhooks/sender.ts)',
  '  ⎿  Updated src/webhooks/sender.ts with 18 additions and 6 removals',
  '',
  '⏺ Bash(pnpm --filter billing-api test webhooks)',
  '  ⎿  > billing-api@2.14.0 test /work/billing-api',
  '     > vitest run webhooks',
  '',
  '      RUN  v4.1.2 /work/billing-api',
  '',
  '      ✓ tests/webhooks/sign.test.ts (12 tests) 41ms',
  '      ✓ tests/webhooks/payload.test.ts (9 tests) 18ms',
  '      ✓ tests/webhooks/sender.test.ts (21 tests) 312ms',
  '      ✓ tests/webhooks/retry.test.ts (14 tests) 1.2s',
  '      ✓ tests/webhooks/dead-letter.test.ts (7 tests) 88ms',
  '',
  '      Test Files  5 passed (5)',
  '           Tests  63 passed (63)',
  '        Duration  2.31s',
  '',
  '⏺ All 63 webhook tests pass. Now checking the integration suite against',
  '  the staging queue.',
  '',
  '⏺ Bash(pnpm --filter billing-api test:integration -- --grep webhook)',
  '  ⎿  Running…',
  '',
  '✻ Running the integration suite… (1m 12s · ↓ 2.4k tokens · esc to interrupt)',
];

const PROMPT = [
  '⏺ The backoff change is in and the suite passes. I asked you which retry',
  '  strategy to use for failed deliveries; I’ll wait for your answer before',
  '  touching the queue code.',
  '',
  '  Options I gave:',
  '  1. Exponential backoff (what’s implemented now)',
  '  2. Durable queue + dead letter',
  '',
  '╭────────────────────────────────────────────╮',
  '│ >                                          │',
  '╰────────────────────────────────────────────╯',
  '  ? for shortcuts',
];

const QUESTION = [
  '⏺ Before I rename anything I need a decision on the sidebar copy.',
  '',
  '⏺ decisions - ask_human (MCP)(question: "Rename “Canopy” to “Inbox” in the',
  '  sidebar?", kind: "approval")',
  '  ⎿  Question sent to your phone (q_01JC9…)',
  '     Waiting for an answer. I’ll carry on when it arrives.',
];

const EXITED = [
  '⏺ Regenerated the theme tokens and committed them on design-tokens/regen.',
  '',
  '  Total cost:            $0.84',
  '  Total duration (API):  3m 41s',
  '  Total code changes:    214 lines added, 198 lines removed',
  '',
  '$ exit',
  '',
  '[Process exited with code 0]',
];

const LONG = [
  '⏺ Bash(pnpm --filter customer-onboarding-service test)',
  '  ⎿  FAIL  tests/migrations/v3-guide.test.ts > links > every link in the guide resolves',
  '     AssertionError: expected [ …(2) ] to deeply equal []',
  '     - Expected',
  '     + Received',
  '     + "https://docs.example.com/customer-onboarding/migrations/v2-to-v3/appendix-a-legacy-webhook-signatures#rotating-secrets-without-downtime"',
  '     + "https://docs.example.com/customer-onboarding/migrations/v2-to-v3/steps/03-backfill-the-tenant-settings-table-before-the-cutover"',
  '      ❯ tests/migrations/v3-guide.test.ts:48:31',
  '      ❯ /work/customer-onboarding-service/node_modules/.pnpm/vitest@4.1.2_@types+node@22.10.1/node_modules/vitest/dist/chunks/runBaseTests.js:211:9',
  '',
  '⏺ Two links point at v2 pages that moved. I asked whether the guide should',
  '  describe v2 or v3 before I fix them.',
];

describe.skipIf(!OUT || !chromiumPath)('captures of the chat’s terminal drawer', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  const local = new MemoryLocalStore();
  const written: string[] = [];
  const ids: Record<string, string> = {};
  /** What each answering question's desktop publishes, again, when the phone asks for a fresh snapshot. */
  const live = new Map<string, PaneSnapshotInput>();
  /** Refresh requests the desktop answered, per question id. */
  const answered = new Map<string, number>();

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
  const go = async (key: string) => {
    await page.goto(`${relay.origin}/q/${ids[key]}`);
    await page.locator('.ws .ws-head').waitFor({ timeout: 30_000 });
    await page.locator('#terminal-button').waitFor({ timeout: 30_000 });
  };
  const drawer = (docked = false) => (docked ? '.term-dock' : 'dialog.term-drawer[open]');
  /**
   * The relay lets a phone ask for six refreshes a minute; each drawer opening asks once. Waits until another
   * request fits, so every capture shows what a person opening the drawer would see.
   */
  const asked: number[] = [];
  const budget = async () => {
    for (;;) {
      const now = Date.now();
      const recent = asked.filter((t) => now - t < 62_000);
      if (recent.length < 6) break;
      await page.waitForTimeout(Math.max(250, recent[0]! + 62_000 - now));
    }
    asked.push(Date.now());
  };
  const open = async (docked = false, asks = true) => {
    if (asks) await budget();
    await page.locator('#terminal-button').click();
    await page.locator(drawer(docked)).waitFor({ timeout: 10_000 });
  };
  const close = async () => {
    await page.keyboard.press('Escape');
    await until(
      async () => (await page.locator('dialog.term-drawer[open], .term-dock').count()) === 0,
      10_000,
      'the drawer to close',
    );
  };
  /** Waits for the drawer to show a snapshot in this state and freshness. */
  const expectSnapshot = (state: string, freshness: string, docked = false) =>
    page
      .locator(
        `${drawer(docked)} .term-status[data-state="${state}"][data-freshness="${freshness}"]`,
      )
      .waitFor({ timeout: 30_000 })
      .catch(async () => {
        const seen = await page
          .locator(`${drawer(docked)} .term-status, ${drawer(docked)} .term-empty`)
          .evaluateAll((els) =>
            els.map(
              (el) =>
                `${el.className}:${el.getAttribute('data-state') ?? el.getAttribute('data-kind')}/${el.getAttribute('data-freshness') ?? el.getAttribute('data-asking')}`,
            ),
          );
        throw new Error(`drawer is not ${state}/${freshness}; seen ${seen.join(' ') || 'nothing'}`);
      });
  /** Opens the drawer and waits until the desktop has answered the refresh it asked for. */
  const openFresh = async (key: string, state: string, docked = false) => {
    const before = answered.get(ids[key]!) ?? 0;
    await open(docked);
    await until(
      async () => (answered.get(ids[key]!) ?? 0) > before,
      20_000,
      `a refresh request for ${key}`,
    );
    await expectSnapshot(state, 'fresh', docked);
    await expectAtEnd(docked);
  };
  /** The lines open scrolled to the newest one. */
  const expectAtEnd = (docked = false) =>
    until(
      async () =>
        page
          .locator(`${drawer(docked)} .term-screen`)
          .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2),
      5_000,
      'the terminal to be scrolled to its last line',
    );

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

  it('captures every state of the terminal button and drawer', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-terminal-'));
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
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
      pumpIntervalMs: 0,
      resolver: { resolve: async () => null },
      snapshots: {
        minIntervalMs: 200,
        // The desktop reads the pane again and publishes; questions without a live pane play a sleeping computer.
        onRefresh: async ({ questionId }) => {
          const input = live.get(questionId);
          if (!input) return;
          await bridge.publishSnapshot(questionId, { ...input, observedAt: new Date() });
          answered.set(questionId, (answered.get(questionId) ?? 0) + 1);
        },
      },
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
    await page.getByText('No questions yet.').waitFor({ timeout: 30_000 });

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
    const choice = (question: string) => ({
      question,
      kind: 'choice',
      options: [
        { id: 'a', label: 'Exponential backoff' },
        { id: 'b', label: 'Durable queue + dead letter' },
      ],
    });
    await ask(
      'working',
      origin('p1', 'billing-api'),
      choice('Which retry strategy should the webhook sender use?'),
    );
    await ask(
      'waiting',
      origin('p2', 'billing-api'),
      choice('Keep exponential backoff for failed deliveries, or move them to a durable queue?'),
    );
    await ask('question', origin('p3', 'daintree'), {
      question: 'Rename “Canopy” to “Inbox” in the sidebar?',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Yes, rename' },
        { id: 'no', label: 'Keep Canopy' },
      ],
    });
    await ask('exited', origin('p4', 'design-tokens'), {
      question:
        'Regenerate the theme tokens from Daintree’s latest themes before the release branch is cut?',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Regenerate' },
        { id: 'no', label: 'Leave them' },
      ],
    });
    await ask('long', origin('p5', 'customer-onboarding-service', 'claude-code'), {
      question:
        'The migration guide mentions v2 in three places and v3 in one. Which version should it describe?',
      kind: 'text',
      options: [],
    });
    await ask('stale', origin('p6', 'release-scripts'), {
      question: 'Tag the release candidate from main, or wait for the docs PR to land?',
      kind: 'choice',
      options: [
        { id: 'now', label: 'Tag it now' },
        { id: 'wait', label: 'Wait for the docs PR' },
      ],
    });
    await ask('unshared', origin('p7', 'docs-site'), {
      question: 'Publish the self-hosting guide with the screenshots from the redesign?',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Publish' },
        { id: 'no', label: 'Hold it' },
      ],
    });
    await ask('none', origin('p8', 'billing-api', 'codex'), {
      question: 'Should the changelog entry for the retry change go under “Fixed” or “Changed”?',
      kind: 'choice',
      options: [
        { id: 'fixed', label: 'Fixed' },
        { id: 'changed', label: 'Changed' },
      ],
    });
    await bridge.pump();

    const snap = (
      agentState: string,
      paneTitle: string,
      terminal: string[],
      waitingReason: PaneSnapshotInput['waitingReason'] = null,
    ): PaneSnapshotInput => ({ agentState, waitingReason, paneTitle, terminal });
    live.set(ids.working!, snap('working', 'Claude Code · Webhook retries', WORKING));
    live.set(ids.waiting!, snap('waiting', 'Claude Code · Webhook retries', PROMPT, 'prompt'));
    live.set(ids.question!, snap('waiting', 'Claude Code · Sidebar copy', QUESTION, 'question'));
    live.set(ids.exited!, snap('exited', 'Claude Code · Design tokens', EXITED));
    live.set(ids.long!, snap('working', 'Claude Code · Migration guide', LONG));
    for (const [id, input] of live) expect(await bridge.publishSnapshot(id, input)).toBe('queued');
    // The release computer published once and has gone to sleep since: it never answers a refresh.
    expect(
      await bridge.publishSnapshot(
        ids.stale!,
        snap('working', 'Claude Code · Release candidate', [
          '⏺ Bash(pnpm release:check)',
          '  ⎿  ✓ versions agree across 6 packages',
          '     ✓ changelog has an entry for 0.4.0',
          '     … checking the docs PR status',
        ]),
      ),
    ).toBe('queued');
    // Sharing is off on the docs computer; the changelog question's desktop never published (like 0.3.0).
    await bridge.clearSnapshots(ids.unshared!);

    for (const t of ['light', 'dark'] as const) {
      await theme(t);
      // The chat, with the button's dot showing the agent working (its desktop publishes as the pane changes).
      expect(
        await bridge.publishSnapshot(ids.working!, {
          ...live.get(ids.working!)!,
          observedAt: new Date(),
        }),
      ).toBe('queued');
      await go('working');
      await page
        .locator('#terminal-button .ws-terminal-dot[data-tone="working"][data-fresh="fresh"]')
        .waitFor({ timeout: 30_000 });
      await shot(`p-chat-${t}`);

      await openFresh('working', 'working');
      await shot(`p-working-${t}`);
      await close();
      // Back closes the drawer, never the chat.
      if (t === 'light') {
        await open();
        await page.goBack();
        await until(
          async () => (await page.locator('dialog.term-drawer[open]').count()) === 0,
          10_000,
          'Back to close the drawer',
        );
        expect(new URL(page.url()).pathname).toBe(`/q/${ids.working}`);
      }

      await go('waiting');
      await openFresh('waiting', 'waiting');
      await shot(`p-waiting-${t}`);
      await close();

      if (t === 'light') {
        await go('question');
        await openFresh('question', 'waiting');
        await shot('p-question-light');
        await close();
      }

      await go('exited');
      await openFresh('exited', 'exited');
      await shot(`p-exited-${t}`);
      await close();

      await go('long');
      await openFresh('long', 'working');
      await shot(`p-long-${t}`);
      await close();

      // Stale: the refresh the drawer asks for on opening goes unanswered past its deadline.
      await go('stale');
      await open();
      await expectSnapshot('working', 'refreshing');
      if (t === 'light') await shot('p-refreshing-light');
      await expectSnapshot('working', 'stale');
      await shot(`p-stale-${t}`);
      if (t === 'light') {
        // Asking again keeps the last word on the old snapshot in place, so the lines do not move on the tap.
        const top = () =>
          page.locator(`${drawer()} .term-screen`).evaluate((el) => el.getBoundingClientRect().top);
        const before = await top();
        await budget();
        await page.locator(`${drawer()} .term-status .term-refresh`).click();
        await expectSnapshot('working', 'refreshing');
        await page.locator(`${drawer()} .term-status .term-note`).waitFor({ timeout: 5_000 });
        expect(await top()).toBe(before);
        await shot('p-stale-asking-light');
      }
      await close();

      await go('unshared');
      await open(false, false);
      await page.locator(`${drawer()} .term-empty[data-kind="off"]`).waitFor({ timeout: 30_000 });
      await shot(`p-unshared-${t}`);
      await close();

      await go('none');
      await open();
      // The drawer asks; the desktop never published and does not answer, so the ask runs out.
      await page
        .locator(`${drawer()} .term-empty[data-phase="asking"]`)
        .waitFor({ timeout: 10_000 });
      await page
        .locator(`${drawer()} .term-empty[data-phase="unanswered"]`)
        .waitFor({ timeout: 30_000 });
      await shot(`p-none-${t}`);
      await close();
    }

    // Wide: the drawer sits beside the chat, and the chat stays usable.
    await page.setViewportSize(WIDE);
    await theme('dark');
    await go('working');
    await openFresh('working', 'working', true);
    await shot('w-docked-dark');
    await theme('light');
    await shot('w-docked-light');
    await close();
    await page.setViewportSize(PHONE);

    expect(written.length).toBe(21);
    // The relay's refresh cap (six a minute) paces the openings, and stale needs its 15 s deadline twice.
  }, 600_000);
});
