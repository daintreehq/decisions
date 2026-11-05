import { mkdtempSync } from 'node:fs';
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
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';
import { FAKE_MIC_ARGS, mockVoice, type VoiceScript } from './voice-mock.js';

/**
 * The answer composer, end to end: a real relay, the real desktop client and the PWA in Chromium. Answers are typed
 * and sent from the composer, options picked from it, dictation started by a tap and by holding (the mic, and the
 * empty field) with real pointer events, and a draft left and found again. The speech provider is scripted at the
 * network seam (voice-mock.ts) over Chromium's fake microphone.
 */
const chromiumPath = findChromium();
const PORT = 8845;

class RecordingSink implements TerminalSink {
  typed: string[] = [];
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
  async inject(_t: TerminalTarget, text: string, _id: string) {
    this.typed.push(text);
    return { outcome: 'delivered' as const, proof: 'e2e' };
  }
  async hasMarker() {
    return false;
  }
  async resume() {
    return null;
  }
}

describe.skipIf(!chromiumPath)('the answer composer', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  const sink = new RecordingSink();
  const ids: Record<string, string> = {};
  const problems: string[] = [];
  let voice: VoiceScript = { words: [] };

  const openId = async (key: string) => {
    await page.goto(`${relay.origin}/q/${ids[key]}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
  };
  const composer = () => page.locator('.dock .composer');
  const field = () => page.locator('.dock .composer-field textarea');
  const mic = () => page.locator('.dock').getByRole('button', { name: /^Dictate /i });
  const stop = () => page.locator('.dock').getByRole('button', { name: 'Stop dictation' });
  const fieldHas = (text: string) =>
    until(
      async () => (await field().inputValue()).includes(text),
      20_000,
      `the field to hold “${text}”`,
    );
  const typedHas = (text: string) =>
    until(
      async () => sink.typed.some((t) => t.includes(text)),
      30_000,
      `“${text}” in the terminal`,
    );
  /** Holds an actionable target while `during` runs, then releases as a finger would. */
  const hold = async (selector: string, during: () => Promise<void>) => {
    const target = page.locator(selector).first();
    // Raw mouse events do not wait for layout stability or check that the target receives the press.
    await target.hover();
    const box = await target.boundingBox();
    if (!box) throw new Error(`${selector} is not on screen`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      await during();
    } finally {
      await page.mouse.up();
    }
  };

  beforeAll(async () => {
    relay = await startRelay(PORT);
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      args: FAKE_MIC_ARGS,
    });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block',
      locale: 'en-GB',
    });
    page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await mockVoice(context, page, () => voice);

    const home = mkdtempSync(join(tmpdir(), 'decisions-composer-e2e-'));
    const keyStore = new FileKeyStore(home);
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'E2E Mac',
      store: keyStore,
    });
    client = new RelayClient({ identity });
    bridge = new DecisionsBridge({
      identity,
      keyStore,
      store: new MemoryLocalStore(),
      sink,
      client,
      pumpIntervalMs: 0,
      resolver: { resolve: async () => null },
    });
    await bridge.start();
    const invite = await createPairingInvite(client, 'phone');
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

    const origin = (pane: string): QuestionOrigin => ({
      machine_label: 'E2E Mac',
      host_id: 'host_e2e_composer',
      pane_id: pane,
      terminal_generation: 1,
      ownership_principal: `principal-${pane}`,
      agent_incarnation: '1',
      agent_kind: 'claude-code',
      agent_session_id: `s-${pane}`,
      project_id: 'composer',
      worktree_id: `wt-${pane}`,
      worktree_root: '/work/composer',
      workflow_gate_id: null,
    });
    const ask = async (key: string, input: Record<string, unknown>, pane = key) => {
      ids[key] = (await bridge.registerQuestion({ origin: origin(pane), input })).questionId;
    };
    // A phone that has only just paired can miss what is asked in its first moments, so ask a first question until
    // the phone shows it, and only then the rest.
    for (let attempt = 0; ; attempt++) {
      await ask(
        'typed',
        { question: 'Which port should the dev server use?', kind: 'text', options: [] },
        `typed-${attempt}`,
      );
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
    await ask('choice', {
      question: 'Ship the drawer layout behind a flag?',
      kind: 'approval',
      options: [
        { id: 'flag', label: 'Behind a flag' },
        { id: 'now', label: 'Ship it to everyone' },
      ],
    });
    await ask('detailed', {
      question: 'Which rollout strategy should we use?',
      kind: 'choice',
      options: [
        { id: 'canary', label: 'Canary', description: 'Start with one region and monitor errors.' },
        { id: 'all', label: 'Everywhere', description: 'Update every region together.' },
      ],
    });
    await ask('voice', { question: 'What should the 429 body say?', kind: 'text', options: [] });
    await ask('draft', { question: 'Name the new retry setting?', kind: 'text', options: [] });
    await bridge.pump();
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('types an answer inline and sends it from the composer', async () => {
    await openId('typed');
    // The field is the composer's own: no editor opens, and Send appears once there is something to send.
    await expect(
      page.locator('.dock').getByRole('button', { name: 'Send answer' }).count(),
    ).resolves.toBe(0);
    // Focusing a short message keeps the reference app's compact, single-row input.
    const resting = await composer().boundingBox();
    await page.locator('.dock .composer-field').click();
    await page.locator('.composer[data-rows="one"]').waitFor();
    const focused = await composer().boundingBox();
    expect(resting!.height).toBeLessThanOrEqual(60);
    expect(Math.abs(focused!.height - resting!.height)).toBeLessThanOrEqual(1);
    const micBefore = await mic().boundingBox();
    await field().fill('Use 5173, the Vite default.');
    const micAfter = await mic().boundingBox();
    expect(micBefore).not.toBeNull();
    expect(micAfter).not.toBeNull();
    expect(Math.abs(micAfter!.y - micBefore!.y)).toBeLessThanOrEqual(1);
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await typedHas('Use 5173, the Vite default.');
    await page.locator('.ws').getByText('Use 5173, the Vite default.').first().waitFor();
    await expect(composer().count()).resolves.toBe(0);
  });

  it('picks an option and adds a note from the composer, and Send says what it sends', async () => {
    await openId('choice');
    const chip = page.locator('.dock').getByRole('radio', { name: 'Behind a flag' });
    await chip.click();
    await expect(chip.getAttribute('aria-checked')).resolves.toBe('true');
    // Short choices appear once, in the dock, and selection alone never submits.
    await expect(page.locator('.ws-body').getByRole('radio').count()).resolves.toBe(0);
    await expect(page.getByRole('radio', { name: 'Behind a flag' }).count()).resolves.toBe(1);
    expect(sink.typed.some((t) => t.includes('choice: flag'))).toBe(false);
    await field().fill('Default it off for a week.');
    await page.locator('.dock').getByRole('button', { name: 'Send decision' }).click();
    await typedHas('Default it off for a week.');
    expect(sink.typed.find((t) => t.includes('Default it off'))).toContain('choice: flag');
  });

  it('keeps described choices in the question and sends the selected card from the compact dock', async () => {
    await openId('detailed');
    await expect(page.locator('.dock').getByRole('radio').count()).resolves.toBe(0);
    await page
      .locator('.ws-body')
      .getByRole('radio', { name: /Canary/ })
      .check();
    await expect(
      page.getByText('Start with one region and monitor errors.').isVisible(),
    ).resolves.toBe(true);
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await typedHas('choice: canary');
  });

  it('grows for wrapped words and returns to a compact bar when cleared', async () => {
    await openId('draft');
    await field().fill(
      'Keep the retry budget configurable and document how it applies to each request.\nInclude an example for the default value.',
    );
    await page.locator('.composer[data-rows="two"]').waitFor();
    const writing = await composer().boundingBox();
    expect(writing!.height).toBeGreaterThan(60);
    expect(writing!.height).toBeLessThan(220);
    await field().fill('');
    await page.locator('.composer[data-rows="one"]').waitFor();
    await page.setViewportSize({ width: 320, height: 700 });
    expect((await composer().boundingBox())!.height).toBeLessThanOrEqual(60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.setViewportSize({ width: 390, height: 844 });
  });

  it('dictates with a tap to start and a tap to stop', async () => {
    voice = {
      words: [{ afterMs: 200, text: 'Tell the client to slow down.', final: true }],
    };
    await openId('voice');
    await mic().click();
    // First use asks before the microphone opens.
    await page.getByRole('button', { name: 'Enable and start dictation' }).click();
    await stop().waitFor({ timeout: 20_000 });
    await fieldHas('Tell the client to slow down.');
    await stop().click();
    await mic().waitFor({ timeout: 20_000 });
    await expect(field().inputValue()).resolves.toContain('Tell the client to slow down.');
  });

  it('dictates while the mic, or the empty field, is held, and letting go stops', async () => {
    await openId('voice');
    // Restoring the preceding dictation adds Send and moves the mic; wait before measuring its position.
    await fieldHas('Tell the client to slow down.');
    // The relay's voice configuration loads separately from the cached question and draft.
    await page.locator('.dock textarea[placeholder="Type an answer"]').waitFor();
    voice = { words: [{ afterMs: 150, text: 'Include a retry after header.', final: true }] };
    await hold('.dock .dictate-btn', async () => {
      await stop().waitFor({ timeout: 20_000 });
      await fieldHas('Include a retry after header.');
    });
    await mic().waitFor({ timeout: 20_000 });
    await expect(mic().getAttribute('aria-pressed')).resolves.toBe('false');

    await field().fill('');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    voice = { words: [{ afterMs: 150, text: 'Say when to try again.', final: true }] };
    await hold('.dock .composer-hold', async () => {
      await stop().waitFor({ timeout: 20_000 });
      await fieldHas('Say when to try again.');
    });
    await mic().waitFor({ timeout: 20_000 });
    // Letting go never sends: the words wait in the field for Send.
    expect(sink.typed.some((t) => t.includes('Say when to try again.'))).toBe(false);
    await page.waitForTimeout(900);
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await typedHas('Say when to try again.');
  });

  it('shows microphone permission failures visibly above the compact empty input', async () => {
    await openId('draft');
    await field().fill('');
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('Denied for this check', 'NotAllowedError');
      };
    });
    await mic().click();
    const error = page.locator('.dock .lane[role="alert"]');
    await error.getByText('Microphone access is blocked.').waitFor();
    const errorBox = (await error.boundingBox())!;
    expect(errorBox.height).toBeGreaterThan(20);
    expect(errorBox.y).toBeGreaterThan(0);
    expect(errorBox.y + errorBox.height).toBeLessThan(844);
    await expect(page.locator('.composer[data-rows="one"]').count()).resolves.toBe(1);
  });

  it('keeps a draft when the person leaves the question and comes back', async () => {
    await openId('draft');
    await field().fill('retry_budget, in seconds');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page
      .locator('.dock')
      .getByText('Saved on this device')
      .waitFor({ state: 'attached', timeout: 10_000 });
    await page.goto(`${relay.origin}/`);
    await page.locator('#main').waitFor();
    await openId('draft');
    await fieldHas('retry_budget, in seconds');
    await page.reload();
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await fieldHas('retry_budget, in seconds');
    expect(problems).toEqual([]);
  });
});
