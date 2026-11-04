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
import { FAKE_MIC_ARGS, mockVoice, type VoiceScript } from './voice-mock.js';

/**
 * Captures the answer composer in every state that carries design weight, for design review:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test composer-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. A real relay, the real desktop client publishing encrypted questions, the
 * PWA paired through its own UI, and answers sent through the composer. Dictation runs the app's real capture path
 * against Chromium's fake microphone, with the provider scripted at the network seam (voice-mock.ts). The on-screen
 * keyboard is simulated the way a phone reports it: the visual viewport shrinks by the keyboard's height while a field
 * has focus, and a keyboard-shaped panel is drawn over the space it would take. Each capture checks what it claims to
 * show before it writes, and the run fails if any expected file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.COMPOSER_CAPTURE_PORT ?? 8843);
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 820 };
const KEYBOARD = 336;

/** Pane p3's host is offline, so an answer to it waits on the computer. */
class Sink implements TerminalSink {
  async locate(o: QuestionOrigin): Promise<LocateResult> {
    if (o.pane_id === 'p3') return { state: 'host-offline' };
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

/** A plausible desktop screen, so the screenshots in the question have something real to show. */
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

describe.skipIf(!OUT || !chromiumPath)('captures of the answer composer', () => {
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
  let voice: VoiceScript = { words: [] };

  const settle = async (ms = 500) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(ms);
  };
  const shot = async (name: string, ms?: number) => {
    await settle(ms);
    const path = join(OUT!, `${name}.png`);
    await page.screenshot({ path });
    if (!existsSync(path) || statSync(path).size < 2_000)
      throw new Error(`capture ${name} is empty`);
    written.push(name);
  };
  const theme = (scheme: 'light' | 'dark') => page.emulateMedia({ colorScheme: scheme });
  const go = async (path: string) => {
    await page.goto(relay.origin + path);
    await page.locator('#main').waitFor({ timeout: 30_000 });
  };
  const openId = async (key: string) => {
    await go(`/q/${ids[key]}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
  };
  const sees = async (text: string | RegExp, scope = '.ws') => {
    await page.locator(scope).getByText(text).first().waitFor({ timeout: 30_000 });
  };
  const filesReady = async () => {
    await page.locator('.fx-inline-stage .fs-slide.is-active img').waitFor({ timeout: 30_000 });
    await until(
      async () =>
        (await page.locator('.fx-thumb img').count()) === (await page.locator('.fx-thumb').count()),
      30_000,
      'every thumbnail to load',
    );
  };
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const field = () => page.locator('.dock .composer-field textarea').first();
  /** Puts the caret in the answer field the way a person would: one tap on it. */
  const focusField = async () => {
    await page.locator('.dock .composer-field').first().click();
    await page.locator('.dock .composer-field textarea:focus').first().waitFor();
  };
  const typeDraft = async (text: string, keepOpen = false) => {
    await focusField();
    await field().fill(text);
    if (!keepOpen) await blur();
  };
  /** Raises or lowers the simulated on-screen keyboard (the field must already have focus to raise it). */
  const keyboard = (up: boolean) =>
    page.evaluate(
      ({ up, h }) => {
        const w = window as unknown as { __kb: number };
        w.__kb = up ? h : 0;
        document.getElementById('fake-kb')?.remove();
        if (up) {
          const kb = document.createElement('div');
          kb.id = 'fake-kb';
          kb.setAttribute('aria-hidden', 'true');
          const rows = [10, 9, 9, 4]
            .map(
              (n, r) =>
                `<div style="display:flex;gap:6px;justify-content:center;margin:${r ? 11 : 8}px 4px 0">${Array.from(
                  { length: n },
                  (_, i) =>
                    `<span style="height:42px;flex:${r === 3 && i === 2 ? 5 : 1};max-width:${r === 3 && i === 2 ? 'none' : '34px'};background:${r === 3 && i !== 2 ? '#acb0bb' : '#fff'};border-radius:5px;box-shadow:0 1px 0 #898a8d"></span>`,
                ).join('')}</div>`,
            )
            .join('');
          kb.innerHTML = `<div style="height:44px;border-bottom:1px solid #c3c6cc"></div>${rows}`;
          Object.assign(kb.style, {
            position: 'fixed',
            left: '0',
            right: '0',
            bottom: '0',
            height: `${h}px`,
            background: '#d1d4da',
            zIndex: '2147483647',
            pointerEvents: 'none',
          });
          document.documentElement.appendChild(kb);
        }
        window.visualViewport?.dispatchEvent(new Event('resize'));
      },
      { up, h: KEYBOARD },
    );
  const dictate = () =>
    page
      .locator('.dock')
      .getByRole('button', { name: /^(Dictate|Hold to dictate)/ })
      .first();
  const stopDictation = () =>
    page.locator('.dock').getByRole('button', { name: 'Stop dictation' }).first();
  const sendButton = () =>
    page.locator('.dock').getByRole('button', { name: /^Send (decision|answer|correction)$/ });

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT);
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      args: FAKE_MIC_ARGS,
    });
    images.set('before.png', await mockUi(browser, 'before'));
    images.set('after.png', await mockUi(browser, 'after'));
    context = await browser.newContext({
      viewport: PHONE,
      deviceScaleFactor: 2,
      colorScheme: 'light',
      // Routes see every request the page makes; a service worker would hide some of them.
      serviceWorkers: 'block',
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      hasTouch: true,
    });
    // The keyboard simulation: the visual viewport loses the keyboard's height, as on a phone.
    await context.addInitScript(() => {
      const P = (globalThis as unknown as { VisualViewport?: { prototype: object } }).VisualViewport
        ?.prototype;
      const d = P && Object.getOwnPropertyDescriptor(P, 'height');
      if (!P || !d?.get) return;
      const get = d.get;
      Object.defineProperty(P, 'height', {
        configurable: true,
        get(this: unknown) {
          return (get.call(this) as number) - ((window as unknown as { __kb?: number }).__kb ?? 0);
        },
      });
    });
    page = await context.newPage();
    await mockVoice(context, page, () => voice);
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('pairs and asks a realistic set of questions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-composer-'));
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
      policy: new PolicyRegistry({ proxyAllowlisted: false }),
      pumpIntervalMs: 0,
      followUps: true,
      resolver: { resolve: async (_o, id) => (images.has(id) ? { bytes: images.get(id)! } : null) },
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
    // The phone has finished setting up once Home settles on its empty state; the computer asks after that.
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
    const yesNo = (yes: string, no: string) => [
      { id: 'yes', label: yes },
      { id: 'no', label: no },
    ];

    // A phone that has only just paired can miss what is asked in its first moments, so ask a first question until
    // the phone shows it, and only then the rest.
    for (let attempt = 0; ; attempt++) {
      await ask('answered', origin(`p4-${attempt}`, 'daintree'), {
        question: 'Rename “Canopy” to “Inbox” in the sidebar?',
        kind: 'approval',
        options: yesNo('Yes, rename', 'Keep Canopy'),
      });
      await bridge.pump();
      const seen = await until(
        async () => (await page.locator('main a.qrow').count()) > 0,
        10_000,
        'a first question',
      )
        .then(() => true)
        .catch(() => false);
      if (seen) break;
      if (attempt === 5) throw new Error('the phone never showed a question');
    }
    await ask('send', origin('p3', 'billing-api', 'codex'), {
      question: 'Should the webhook retry limit stay at five attempts, or drop to three?',
      kind: 'text',
      options: [],
    });
    await ask('dictate', origin('p10', 'edge-api'), {
      question: 'What should the 429 response body say when a client is rate limited?',
      kind: 'text',
      options: [],
    });
    await ask('gate', origin('p9', 'billing-api'), {
      question: 'Rotate the production webhook signing secret tonight?',
      context:
        'The current secret was in a log line that reached the shared error tracker on Monday. Rotating invalidates it for every partner at once; each has a 24-hour grace window with the old secret.',
      kind: 'approval',
      requested_requirement: 'human-required',
      options: yesNo('Rotate tonight', 'Wait for the weekly window'),
    });
    await ask('text', origin('p2', 'customer-onboarding-service', 'gemini'), {
      question:
        'The migration guide mentions v2 in three places and v3 in one. Which version should it describe, and should the v2 steps move to an appendix?',
      kind: 'text',
      options: [],
    });
    await ask('choice', origin('p1', 'daintree'), {
      question: 'Which layout should the Agents view use below 900px?',
      context:
        'Design review, round 3. Both layouts keep every shortcut. The compact sidebar collapses to icons with tooltips; the drawer hides the sidebar until the menu button is pressed.\n\nBefore and after screenshots are attached. `⌘B` still toggles the sidebar in both.',
      kind: 'choice',
      expires_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      options: [
        {
          id: 'compact',
          label: 'Compact sidebar',
          description: 'Icons with tooltips, always visible',
        },
        {
          id: 'drawer',
          label: 'Drawer',
          description: 'Hidden until the menu button is pressed',
        },
        { id: 'keep', label: 'Keep the full sidebar' },
      ],
      attachments: [
        { local_resource_id: 'before.png', role: 'before' },
        { local_resource_id: 'after.png', role: 'after' },
      ],
    });
    await bridge.pump();
    await go('/');
    await page
      .getByText('Which layout should the Agents view')
      .first()
      .waitFor({ timeout: 30_000 });

    // One answer already delivered, so the follow-up composer after it can be captured.
    await openId('answered');
    await page
      .getByRole('radio', { name: /Yes, rename/ })
      .first()
      .check();
    await sendButton().click({ timeout: 15_000 });
    await sees(/Delivered to the agent’s terminal|Typed into the terminal/);
  });

  it('captures a text answer: empty, typing with the keyboard up, and a long draft', async () => {
    await openId('text');
    await sees('The migration guide mentions');
    await shot('p-text-empty-light');
    await theme('dark');
    await shot('p-text-empty-dark');
    await theme('light');

    await typeDraft('Describe v3 only.', true);
    await keyboard(true);
    await shot('p-text-keyboard-light', 700);
    await keyboard(false);
    await typeDraft(
      'Describe v3 only. Move the v2 steps to an appendix and link it from the intro, so anyone still on v2 can find them.\n\nThe v2 screenshots can go; the appendix only needs the commands.',
    );
    await sees('Saved on this device');
    await shot('p-text-draft-light');
  });

  it('captures a choice: nothing chosen, chosen with a note, the keyboard up, and an approval', async () => {
    await openId('choice');
    await filesReady();
    await shot('p-choice-empty-light');
    await page
      .getByRole('radio', { name: /Compact sidebar/ })
      .first()
      .check();
    await typeDraft('Keep ⌘B working in both.');
    await sendButton().waitFor();
    await shot('p-choice-selected-light');
    await theme('dark');
    await shot('p-choice-selected-dark');
    await theme('light');
    await focusField();
    await keyboard(true);
    await shot('p-choice-keyboard-light', 700);
    await keyboard(false);
    await blur();

    await openId('gate');
    await sees('Rotate the production webhook signing secret tonight?');
    await page
      .getByRole('radio', { name: /Rotate tonight/ })
      .first()
      .check();
    await blur();
    await page.locator('.dock').getByRole('button', { name: 'Send decision' }).waitFor();
    await shot('p-approval-selected-light');
  });

  it('captures dictation: starting, then live words arriving', async () => {
    await openId('dictate');
    await sees('What should the 429 response body say');
    voice = {
      readyAfterMs: 6_000,
      words: [
        {
          afterMs: 300,
          text: 'Say that the client is sending too many requests,',
          final: true,
        },
        { afterMs: 1_100, text: 'and give the retry after time in', final: false },
      ],
    };
    await dictate().click();
    const consent = page.getByRole('button', { name: 'Enable and start dictation' });
    await consent.waitFor({ timeout: 10_000 });
    await consent.click();
    await sees(/Starting microphone/);
    await shot('p-dictate-starting-light', 300);
    // Locked words are in the field itself; the words still being recognised trail them.
    await until(
      async () => (await field().inputValue()).includes('too many requests'),
      30_000,
      'locked words in the field',
    );
    await sees('retry after time in', '.dock');
    await shot('p-dictate-recording-light', 300);
    await theme('dark');
    await shot('p-dictate-recording-dark', 300);
    await theme('light');
    await stopDictation().click();
    await dictate().waitFor({ timeout: 15_000 });
  });

  it('captures a follow-up and a sent answer', async () => {
    await openId('answered');
    await sees(/Delivered to the agent’s terminal|Typed into the terminal/);
    // The answer is final: what comes after it is a follow-up.
    await typeDraft('Inbox collides with the mail integration’s name, so check with Sam first.');
    await page.locator('.dock').getByRole('button', { name: 'Send follow-up' }).waitFor();
    await shot('p-follow-up-light');

    await openId('send');
    await typeDraft('Drop it to three. Five retries kept a dead endpoint busy for an hour.');
    await sendButton().click();
    await sees('Received by your computer');
    await shot('p-sent-light');
  });

  it('captures the wide layout beside the sidebar column', async () => {
    await page.setViewportSize(WIDE);
    await openId('choice');
    await filesReady();
    await sendButton().waitFor();
    await shot('w-choice-selected-light');
    await page.setViewportSize(PHONE);

    const expected = [
      'p-text-empty-light',
      'p-text-empty-dark',
      'p-text-keyboard-light',
      'p-text-draft-light',
      'p-choice-empty-light',
      'p-choice-selected-light',
      'p-choice-selected-dark',
      'p-choice-keyboard-light',
      'p-approval-selected-light',
      'p-dictate-starting-light',
      'p-dictate-recording-light',
      'p-dictate-recording-dark',
      'p-follow-up-light',
      'p-sent-light',
      'w-choice-selected-light',
    ];
    const missing = expected.filter((n) => !existsSync(join(OUT!, `${n}.png`)));
    expect(missing).toEqual([]);
    expect(written.length).toBe(expected.length);
  });
});
