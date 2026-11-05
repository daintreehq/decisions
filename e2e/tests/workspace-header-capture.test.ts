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
  paneIdentityOf,
  type LocateResult,
  type ProxyEngine,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Captures the question screen's header in every state that carries design weight, for design review:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test workspace-header-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. A real relay, the real desktop client publishing questions, pane
 * snapshots and agent messages, and the PWA paired through its own UI. The header is shown at rest (project over
 * computer, with and without Back), once the question has scrolled away (the excerpt over "project · computer", the
 * answer in force or the model's answer), with long names, its menu open and its title focused, on a phone, a
 * narrow phone, a tablet and beside the sidebar column. The scroll-driven swap is captured twice: as a sweep of
 * scroll offsets around the point the title changes, and as frozen frames of the change itself (every running
 * animation paused and stepped through time), in both directions and under reduced motion. Each capture checks
 * what the header says before it writes, and the
 * run fails if any expected file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
// This surface's ports: the relay and its inspector, both inside 8930-8939.
const PORT = Number(process.env.HEADER_CAPTURE_PORT ?? 8930);
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 640 };
const TABLET = { width: 820, height: 1000 };
const WIDE = { width: 1280, height: 820 };
const FRAMES = [0, 30, 60, 90, 120, 160, 200, 260];

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

/** Answers the changelog question, and passes on everything else. */
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

/** A plausible desktop screen, so the question's screenshots have something real to show. */
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

describe.skipIf(!OUT || !chromiumPath)('captures of the question header', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  const local = new MemoryLocalStore();
  const images = new Map<string, Uint8Array>();
  const written: string[] = [];
  const ids: Record<string, string> = {};
  const origins: Record<string, QuestionOrigin> = {};

  const settle = async (ms = 450) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(ms);
  };
  const check = (name: string, path: string) => {
    if (!existsSync(path) || statSync(path).size < 1_500)
      throw new Error(`capture ${name} is empty`);
    written.push(name);
  };
  /** The whole screen. */
  const shot = async (name: string) => {
    await settle();
    const path = join(OUT!, `${name}.png`);
    await page.screenshot({ path });
    check(name, path);
  };
  /** The header's band, including the fade beneath it on a phone. */
  const headShot = async (name: string, wait = 450) => {
    if (wait) await settle(wait);
    const box = await page.locator('.ws-head').boundingBox();
    if (!box) throw new Error(`no header for ${name}`);
    const vw = page.viewportSize()!.width;
    const path = join(OUT!, `${name}.png`);
    await page.screenshot({
      path,
      clip: { x: 0, y: 0, width: vw, height: Math.ceil(box.y + box.height + 28) },
    });
    check(name, path);
  };
  const theme = (scheme: 'light' | 'dark') => page.emulateMedia({ colorScheme: scheme });
  const go = async (path: string) => {
    await page.goto(relay.origin + path);
    await page.locator('#main').waitFor({ timeout: 30_000 });
  };
  /**
   * Opens `key` straight from its id, as a notification would (so no Back), at the top of its thread (the app
   * restores where the person last was, which may be scrolled).
   */
  const openId = async (key: string) => {
    await go(`/q/${ids[key]}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await page.locator('.ws-head .ws-title').waitFor({ timeout: 30_000 });
    await settle(300);
    await scrollTo(0);
    await page.locator('.ws-head .ws-origin').waitFor({ timeout: 30_000 });
  };
  /** Opens `key` from Home's list, so the header offers Back. */
  const openFromHome = async (key: string, rowText: string) => {
    await go('/');
    await page.getByText(rowText).first().click();
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await page.locator('.ws-head .ws-back').waitFor({ timeout: 30_000 });
    await settle(300);
    await scrollTo(0);
    void key;
  };
  const filesReady = async () => {
    const stage = page.locator('.fx-inline-stage .fs-slide.is-active img');
    if ((await page.locator('.fx-inline-stage').count()) === 0) return;
    await stage.waitFor({ timeout: 30_000 });
    await until(
      async () =>
        (await page.locator('.fx-thumb img').count()) === (await page.locator('.fx-thumb').count()),
      30_000,
      'every thumbnail to load',
    );
  };
  /** Opens the context disclosure, so the question is long enough to scroll its heading away. */
  const expandContext = async () => {
    await page.evaluate(() => {
      document
        .querySelectorAll<HTMLDetailsElement>('.ws-body details.msg-context')
        .forEach((d) => (d.open = true));
    });
    await settle(200);
  };
  const scrollTo = (top: number) =>
    page.evaluate((t) => {
      const b = document.querySelector('.ws-body');
      if (b) b.scrollTop = t === -1 ? b.scrollHeight : t;
    }, top);
  const toEnd = async () => {
    await expandContext();
    await scrollTo(-1);
  };
  /** Waits until the header's title says `text` (rest or excerpt), so a capture never shows a half-swapped state. */
  const headSays = async (text: string | RegExp, excerpt: boolean) => {
    let last = '';
    await until(
      async () => {
        const state = await page.evaluate(() => {
          const t = document.querySelector('.ws-head .ws-title');
          return t
            ? { text: t.textContent ?? '', excerpt: t.getAttribute('data-excerpt') === 'true' }
            : null;
        });
        last = JSON.stringify(state);
        if (!state || state.excerpt !== excerpt) return false;
        return typeof text === 'string' ? state.text.includes(text) : text.test(state.text);
      },
      15_000,
      `the header to say ${String(text)} (it says ${last})`,
    ).catch((e: Error) => {
      throw new Error(`${e.message}; last seen ${last}`);
    });
  };
  /** The heading's offset inside the thread, so the sweep brackets the point the title changes. */
  const headingSpan = () =>
    page.evaluate(() => {
      const b = document.querySelector('.ws-body')!;
      const h = document.querySelector('#q-title')!;
      const top = h.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop;
      return { top, height: h.getBoundingClientRect().height };
    });
  /** Header bands at scroll offsets from rest, either side of the swap, to well past it. */
  const sweep = async (prefix: string) => {
    await expandContext();
    await scrollTo(0);
    await settle(300);
    const { top, height } = await headingSpan();
    // The title changes once the heading's last line has passed under the header (on a phone the thread runs
    // beneath it), so the sweep brackets that offset.
    const head = await page.evaluate(() => document.querySelector('.ws-head')!.clientHeight);
    const swap = Math.max(16, Math.ceil(top + height - head));
    const offsets = [0, Math.max(4, swap - 40), swap - 8, swap + 8, swap + 40, swap + 100];
    for (const [i, y] of offsets.entries()) {
      await scrollTo(y);
      await headShot(`${prefix}-${String(i).padStart(2, '0')}-y${y}`, 500);
    }
    await scrollTo(0);
  };
  /**
   * The swap itself, frozen: scrolls just past the heading, pauses every animation the instant the title changes,
   * then steps them through time. With no animation at all, every frame is the end state.
   */
  const freezeSwap = async (prefix: string, direction: 'away' | 'back') => {
    await expandContext();
    const { top, height } = await headingSpan();
    const past = Math.ceil(top + height + 24);
    await scrollTo(direction === 'away' ? 0 : past);
    await settle(500);
    await page.evaluate(
      ({ y, wantExcerpt }) =>
        new Promise<void>((done) => {
          const title = document.querySelector('.ws-head .ws-title')!;
          const b = document.querySelector('.ws-body')!;
          const freeze = () => {
            for (const a of document.getAnimations()) a.pause();
            done();
          };
          const mo = new MutationObserver(() => {
            if ((title.getAttribute('data-excerpt') === 'true') === wantExcerpt) {
              mo.disconnect();
              // One frame for React's commit to start any transitions, then hold them.
              requestAnimationFrame(freeze);
            }
          });
          mo.observe(title, { attributes: true, subtree: true, childList: true });
          b.scrollTop = y;
          setTimeout(() => {
            mo.disconnect();
            freeze();
          }, 3_000);
        }),
      { y: direction === 'away' ? past : 0, wantExcerpt: direction === 'away' },
    );
    for (const t of FRAMES) {
      await page.evaluate((ms) => {
        for (const a of document.getAnimations()) a.currentTime = ms;
      }, t);
      await headShot(`${prefix}-t${String(t).padStart(3, '0')}`, 0);
    }
    await page.evaluate(() => {
      for (const a of document.getAnimations()) a.play();
    });
  };

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT, PORT + 1);
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
      hasTouch: true,
    });
    page = await context.newPage();
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('pairs and asks the questions the header is shown over', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-header-'));
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
      followUps: true,
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
      pumpIntervalMs: 0,
      resolver: { resolve: async (_o, id) => (images.has(id) ? { bytes: images.get(id)! } : null) },
      snapshots: { minIntervalMs: 200, onRefresh: async () => undefined },
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

    const origin = (
      pane: string,
      project: string,
      machine = 'Greg’s MacBook Pro',
      agent = 'claude-code',
    ): QuestionOrigin => ({
      machine_label: machine,
      host_id: `host_${machine.length}`,
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
      origins[key] = o;
      const r = await bridge.registerQuestion({ origin: o, input });
      ids[key] = r.questionId;
    };
    const shots = [
      { local_resource_id: 'before.png', role: 'before' },
      { local_resource_id: 'after.png', role: 'after' },
    ];

    await ask('proxy', origin('p6', 'billing-api', 'Build server', 'codex'), {
      question: 'Should the changelog entry for the retry change go under “Fixed” or “Changed”?',
      context:
        'The retry change alters behaviour for every partner: failed webhooks are now retried five times instead of three, with backoff.',
      kind: 'choice',
      requested_requirement: 'proxy-ok',
      options: [
        { id: 'fixed', label: 'Fixed', description: 'It corrects the retry limit we documented' },
        {
          id: 'changed',
          label: 'Changed',
          description: 'It is a behaviour change partners will see',
        },
      ],
      attachments: shots,
    });
    await ask(
      'long',
      origin('p3', 'customer-onboarding-service-platform', 'Greg’s Mac Studio (office)'),
      {
        question:
          'The migration guide mentions v2 in three places and v3 in one. Which version should it describe, and should the v2 steps move to an appendix that the introduction links to?',
        context:
          'v3 shipped to every tenant last month; 4% of accounts still run v2 clients. The guide is linked from the onboarding email, so the first screen is what most people read.\n\nThe appendix would keep the v2 steps word for word.',
        kind: 'choice',
        options: [
          { id: 'v3', label: 'Describe v3 only', description: 'Move the v2 steps to an appendix' },
          { id: 'both', label: 'Describe both', description: 'Keep v2 inline with a note' },
          { id: 'v2', label: 'Describe v2 only', description: 'Hold v3 until the release' },
        ],
        attachments: shots,
      },
    );
    await ask('rename', origin('p4', 'daintree'), {
      question: 'Rename “Canopy” to “Inbox” in the sidebar?',
      context:
        'Three people asked what Canopy meant in the last week. Inbox matches the desktop app.',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Yes, rename' },
        { id: 'no', label: 'Keep Canopy' },
      ],
    });
    await ask('choice', origin('p1', 'daintree'), {
      question: 'Which layout should the Agents view use below 900px?',
      context:
        'Design review, round 3. Both layouts keep every shortcut. The compact sidebar collapses to icons with tooltips; the drawer hides the sidebar until the menu button is pressed.\n\nThe compact sidebar keeps the agent list one glance away but costs 64px of every row. The drawer gives the rows the full width and adds one tap to switch agents.\n\nBefore and after screenshots are attached. ⌘B still toggles the sidebar in both, and the drawer remembers whether it was open.',
      kind: 'choice',
      requested_requirement: 'proxy-ok',
      options: [
        {
          id: 'compact',
          label: 'Compact sidebar',
          description: 'Icons with tooltips, always visible',
        },
        { id: 'drawer', label: 'Drawer', description: 'Hidden until the menu button is pressed' },
        { id: 'keep', label: 'Keep the full sidebar' },
      ],
      attachments: shots,
    });
    await bridge.pump();
    // The bridge may already have run the engine on it while pumping.
    expect(['answered', 'skipped']).toContain(await bridge.runProxy(ids.proxy!));
    expect(['abstained', 'skipped']).toContain(await bridge.runProxy(ids.choice!));
    await bridge.pump();
    for (const key of ['choice', 'rename', 'proxy', 'long']) {
      expect(
        await bridge.publishSnapshot(ids[key]!, {
          agentState: key === 'rename' ? 'waiting' : 'working',
          waitingReason: key === 'rename' ? 'question' : null,
          paneTitle: 'Claude Code',
          terminal: ['⏺ Reading the sidebar component', '  ⎿  Read 214 lines'],
        }),
      ).toBe('queued');
    }

    // The rename is answered through the dock, then the agent carries on in the thread.
    await openId('rename');
    await page
      .getByRole('radio', { name: /Yes, rename/ })
      .first()
      .check();
    await page.locator('.dock .composer-field textarea').fill('Inbox reads better in the sidebar.');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.getByRole('button', { name: /^Send (decision|answer)$/ }).click({ timeout: 15_000 });
    await page
      .locator('.ws')
      .getByText(/Delivered to the agent’s terminal|Typed into the terminal/)
      .first()
      .waitFor({ timeout: 30_000 });
    for (const text of [
      'Renamed in the sidebar, the navigator and the empty state. The command palette still says Canopy in two places; I’ll take those next.',
      'The command palette is done too. I left the analytics event names alone (they are keyed as canopy_opened) so dashboards keep working; the display name is Inbox everywhere a person can see it.',
      'Tests pass: 214 in the sidebar suite, 38 in the navigator suite. Two snapshot tests changed, both only in the label.',
      'Done. Seven files changed. The changelog entry reads “Canopy is now Inbox”.',
      'I also checked the docs site: the getting-started page and the keyboard shortcuts table both said Canopy. Both now say Inbox, in the same commit.',
      'One more: the onboarding tour mentions Canopy on its third card. Rename it there too, or leave the tour for the docs pass?',
    ]) {
      await bridge.postMessage(
        { question_id: ids.rename, text, expects_reply: text.startsWith('One more') },
        paneIdentityOf(origins.rename!),
      );
      await bridge.pump();
    }
    await page
      .locator('.ws')
      .getByText(/onboarding tour mentions Canopy/)
      .waitFor({ timeout: 30_000 });
  });

  it('captures the header on a phone', async () => {
    for (const t of ['light', 'dark'] as const) {
      await theme(t);
      // At rest, reached from Home: Back, project over computer, terminal and More.
      await openFromHome('choice', 'Which layout should the Agents view');
      await filesReady();
      await headSays('daintree', false);
      await shot(`p-rest-${t}`);
      await headShot(`h-rest-back-${t}`);
      // Scrolled away, unanswered: the excerpt over project · computer.
      await toEnd();
      await headSays('Which layout should the Agents view', true);
      await shot(`p-scrolled-open-${t}`);
      await headShot(`h-scrolled-open-${t}`);
      if (t === 'light') {
        await sweep(`s-open-${t}`);
        await freezeSwap(`f-away-${t}`, 'away');
        await freezeSwap(`f-back-${t}`, 'back');
        // Reduced motion: the title is replaced at once, never two on top of each other.
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await freezeSwap(`f-reduced-${t}`, 'away');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
      }

      // Answered, with the agent's follow-ups below: the answer in force stays in view.
      await openId('rename');
      await filesReady();
      await headSays('daintree', false);
      await headShot(`h-rest-noback-${t}`);
      await toEnd();
      await headSays('You: Yes, rename', true);
      await shot(`p-scrolled-answered-${t}`);
      await headShot(`h-scrolled-answered-${t}`);
      if (t === 'light') await sweep(`s-answered-${t}`);

      // The model's answer, from another computer.
      await openId('proxy');
      await filesReady();
      await toEnd();
      await headSays('Model: Changed', true);
      await headShot(`h-scrolled-model-${t}`);

      // Long names and a long question.
      await openId('long');
      await filesReady();
      await headSays('customer-onboarding', false);
      await headShot(`h-rest-long-${t}`);
      await toEnd();
      await headSays('The migration guide', true);
      await headShot(`h-scrolled-long-${t}`);
    }
    await theme('light');

    // The overflow menu open.
    await openId('choice');
    await page.locator('.ws-more').click();
    await page.getByRole('menuitem').first().waitFor({ timeout: 10_000 });
    await shot('p-menu-open-light');
    await page.keyboard.press('Escape');

    // The excerpt focused from the keyboard.
    await toEnd();
    await headSays('Which layout', true);
    // Focused, then reached again by Tab, so the browser shows its keyboard focus ring.
    await page.locator('.ws-excerpt').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('ws-excerpt');
    await headShot('h-scrolled-focus-light');
  });

  it('captures the header on a narrow phone, a tablet and beside the sidebar column', async () => {
    await page.setViewportSize(NARROW);
    await openId('long');
    await filesReady();
    await headSays('customer-onboarding', false);
    await headShot('n-rest-long-light');
    await toEnd();
    await headSays('The migration guide', true);
    await headShot('n-scrolled-long-light');
    await openId('rename');
    await toEnd();
    await headSays('You: Yes, rename', true);
    await headShot('n-scrolled-answered-light');

    await page.setViewportSize(TABLET);
    await openId('rename');
    await filesReady();
    await headSays('daintree', false);
    await headShot('t-rest-light');
    await toEnd();
    await headSays('You: Yes, rename', true);
    await headShot('t-scrolled-answered-light');

    await page.setViewportSize(WIDE);
    for (const t of ['light', 'dark'] as const) {
      await theme(t);
      await openId('rename');
      await filesReady();
      await headSays('daintree', false);
      await shot(`w-rest-${t}`);
      await toEnd();
      await headSays('You: Yes, rename', true);
      await shot(`w-scrolled-answered-${t}`);
    }
    await theme('light');
    await page.setViewportSize(PHONE);

    const expected = [
      ...['light', 'dark'].flatMap((t) => [
        `p-rest-${t}`,
        `h-rest-back-${t}`,
        `p-scrolled-open-${t}`,
        `h-scrolled-open-${t}`,
        `h-rest-noback-${t}`,
        `p-scrolled-answered-${t}`,
        `h-scrolled-answered-${t}`,
        `h-scrolled-model-${t}`,
        `h-rest-long-${t}`,
        `h-scrolled-long-${t}`,
        `w-rest-${t}`,
        `w-scrolled-answered-${t}`,
      ]),
      ...FRAMES.flatMap((f) => [
        `f-away-light-t${String(f).padStart(3, '0')}`,
        `f-back-light-t${String(f).padStart(3, '0')}`,
        `f-reduced-light-t${String(f).padStart(3, '0')}`,
      ]),
      'p-menu-open-light',
      'h-scrolled-focus-light',
      'n-rest-long-light',
      'n-scrolled-long-light',
      'n-scrolled-answered-light',
      't-rest-light',
      't-scrolled-answered-light',
    ];
    const missing = expected.filter((n) => !existsSync(join(OUT!, `${n}.png`)));
    expect(missing).toEqual([]);
    // Plus the two six-frame sweeps.
    expect(written.length).toBe(expected.length + 12);
  });
});
