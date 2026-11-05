import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
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
  type ProxyEngine,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';
import { FAKE_MIC_ARGS, mockVoice } from './voice-mock.js';

/**
 * Captures the shared modal layers, the workspace Sheet (a bottom sheet on phones, a centred panel from 720 px) and
 * the Dialog, in every place they carry design weight, for design review:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test sheets-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. A real relay, the real desktop client publishing encrypted questions (one
 * answered by the model, so it can be overruled), and the PWA paired through its own UI. The states: question
 * details, activity, the dictation consent sheet (also at 320 px), the send and discard confirmations of a
 * correction, the keyboard shortcuts and device sheets, and the dictation disclosure, unpair and leave-guard dialogs,
 * on a phone and on a wide screen, in both colour schemes where it matters. One confirmation is opened from the
 * keyboard, so its first focus shows. Each capture checks what it claims to show before it writes, and the run fails
 * if any expected file is missing. Ports stay inside 8970–8979 (SHEETS_CAPTURE_PORT, and the next one up for the
 * relay's inspector).
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.SHEETS_CAPTURE_PORT ?? 8971);
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 320, height: 640 };
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

/** Answers the changelog question, so the phone has a model answer to overrule; passes on everything else. */
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
        'You filed the last three behaviour changes that were not bug fixes under “Changed”.',
      risk_flags: [],
    };
  },
};

describe.skipIf(!OUT || !chromiumPath)('captures of sheets and dialogs', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  const local = new MemoryLocalStore();
  const written: string[] = [];
  const ids: Record<string, string> = {};

  const settle = async (ms = 600) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(ms);
  };
  /** Writes a capture only once an open modal with this accessible name is on screen and has finished entering. */
  const shot = async (name: string, dialog: string | RegExp) => {
    const d = page
      .getByRole('dialog', { name: dialog })
      .or(page.getByRole('alertdialog', { name: dialog }));
    await d.first().waitFor({ timeout: 20_000 });
    await settle();
    const box = await d.first().boundingBox();
    if (!box || box.height < 60) throw new Error(`capture ${name}: the dialog is not on screen`);
    if (!written.length) {
      // What the scrim actually computes to, so a review can tell a faint token from an unpainted blur.
      const backdrop = await page.evaluate(() => {
        const open = document.querySelector('dialog[open]');
        if (!open) return null;
        const s = getComputedStyle(open, '::backdrop');
        return { background: s.backgroundColor, backdropFilter: s.backdropFilter };
      });
      writeFileSync(join(OUT!, 'backdrop.json'), JSON.stringify(backdrop));
    }
    const path = join(OUT!, `${name}.png`);
    await page.screenshot({ path });
    if (!existsSync(path) || statSync(path).size < 2_000)
      throw new Error(`capture ${name} is empty`);
    written.push(name);
  };
  const closed = async () => {
    await until(
      async () =>
        (await page.locator('dialog[open]:not(.sidebar-sheet):not(.term-drawer)').count()) === 0,
      10_000,
      'the modal to close',
    );
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
  const sees = async (text: string | RegExp) => {
    await page.locator('.ws').getByText(text).first().waitFor({ timeout: 30_000 });
  };
  const more = async (item: string) => {
    await page.locator('.ws-head').getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  const dictate = () =>
    page
      .locator('.dock')
      .getByRole('button', { name: /^(Dictate|Hold to dictate)/ })
      .first();

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT, PORT + 1);
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      args: FAKE_MIC_ARGS,
    });
    context = await browser.newContext({
      viewport: PHONE,
      deviceScaleFactor: 2,
      colorScheme: 'light',
      serviceWorkers: 'block',
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      hasTouch: true,
    });
    page = await context.newPage();
    await mockVoice(context, page, () => ({ words: [] }));
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('pairs and asks a realistic set of questions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-sheets-'));
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

    for (let attempt = 0; ; attempt++) {
      await ask('text', origin(`p2-${attempt}`, 'customer-onboarding-service', 'gemini'), {
        question:
          'The migration guide mentions v2 in three places and v3 in one. Which version should it describe, and should the v2 steps move to an appendix?',
        context:
          'Two links in the guide point at v2 pages that moved during the docs restructure. Fixing them depends on which version the guide is meant to describe.',
        kind: 'text',
        options: [],
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
    await ask('proxy', origin('p6', 'billing-api', 'codex'), {
      question: 'Should the changelog entry for the retry change go under “Fixed” or “Changed”?',
      context:
        'The retry change replaces the fixed five-second delay with exponential backoff. It fixes the duplicate deliveries partners reported, but it also changes timing anyone relying on the old delay will notice.',
      kind: 'choice',
      requested_requirement: 'proxy-ok',
      options: [
        { id: 'fixed', label: 'Fixed' },
        { id: 'changed', label: 'Changed' },
      ],
    });
    await bridge.pump();
    // The bridge may already have run the model on the pump; either way the answer has to reach the phone.
    expect(['answered', 'skipped']).toContain(await bridge.runProxy(ids.proxy!));
    await bridge.pump();
    await go('/');
    await page.getByText('Should the changelog entry').first().waitFor({ timeout: 30_000 });
  });

  it('captures the workspace sheets on a phone', async () => {
    await openId('text');
    await sees('The migration guide mentions');
    await more('Question details');
    await shot('p-details-light', 'Question details');
    await theme('dark');
    await shot('p-details-dark', 'Question details');
    await theme('light');
    await page.keyboard.press('Escape');
    await closed();

    await more('View activity');
    await shot('p-activity-light', 'Activity');
    await page.keyboard.press('Escape');
    await closed();

    await dictate().click();
    await shot('p-consent-light', /Dictation isn’t end-to-end encrypted/);
    await theme('dark');
    await shot('p-consent-dark', /Dictation isn’t end-to-end encrypted/);
    await theme('light');
    await page.getByRole('button', { name: 'Keep typing' }).click();
    await closed();

    await page.setViewportSize(SMALL);
    await dictate().click();
    await shot('s-consent-light', /Dictation isn’t end-to-end encrypted/);
    await page.getByRole('button', { name: 'Keep typing' }).click();
    await closed();
    await page.setViewportSize(PHONE);
  });

  it('captures the correction confirmations on a phone', async () => {
    await openId('proxy');
    await page.locator('.ws').getByRole('button', { name: 'Overrule' }).click();
    await page.getByRole('radio', { name: /Fixed/ }).first().check();
    await page
      .locator('.dock')
      .getByRole('textbox', { name: 'Reason for the change' })
      .fill(
        'It fixes the duplicate deliveries partners reported; the timing change is a side effect.',
      );
    await page.locator('.dock').getByRole('button', { name: 'Send correction' }).click();
    await shot('p-correction-send-light', 'Send this correction?');
    await page.locator('dialog[open]').getByRole('button', { name: 'Keep editing' }).click();
    await closed();

    await page.locator('.correction').getByRole('button', { name: 'Discard' }).click();
    await shot('p-correction-discard-light', 'Discard this correction?');
    await theme('dark');
    await shot('p-correction-discard-dark', 'Discard this correction?');
    await theme('light');
    await page.getByRole('button', { name: 'Keep it' }).click();
    await closed();
  });

  it('captures the settings sheets and dialogs on a phone', async () => {
    await go('/settings/dictation');
    await page.getByRole('heading', { name: 'Dictation' }).waitFor();
    await page.getByRole('switch', { name: 'Dictation' }).click();
    await shot('p-disclosure-light', 'Dictation is not end-to-end encrypted');
    await page.getByRole('button', { name: 'Not now' }).click();
    await closed();

    await go('/settings/privacy');
    await page.getByRole('heading', { name: 'Privacy & security' }).waitFor();
    await page.getByRole('button', { name: 'Unpair…' }).click();
    await page.locator('dialog[open] .s-erase-list li').first().waitFor({ timeout: 20_000 });
    await shot('p-unpair-light', 'Unpair this device?');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await closed();

    await go('/settings/quiet-hours');
    await page.getByLabel('Quiet hours', { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByLabel('Quiet hours', { exact: true }).check();
    await page.getByText('Unsaved changes').waitFor();
    await page.locator('.s-back').click();
    await shot('p-leave-light', 'Save your changes?');
    await page.locator('dialog[open]').getByRole('button', { name: 'Discard' }).click();
    await closed();

    await go('/settings/about');
    await page.getByRole('heading', { name: 'About & help' }).waitFor();
    await page.getByRole('button', { name: /Keyboard shortcuts/ }).click();
    await shot('p-shortcuts-light', 'Keyboard shortcuts');
    await page.keyboard.press('Escape');
    await closed();

    await go('/settings/devices');
    await page.getByRole('heading', { name: 'Computers' }).waitFor({ timeout: 30_000 });
    await page.locator('.s-device').first().click();
    await page.locator('dialog[open] .fingerprint span').first().waitFor();
    await shot('p-device-light', /.+/);
    await page.keyboard.press('Escape');
    await closed();
  });

  it('captures the wide layout', async () => {
    await page.setViewportSize(WIDE);
    await openId('text');
    await sees('The migration guide mentions');
    await more('Question details');
    await shot('w-details-light', 'Question details');
    await page.keyboard.press('Escape');
    await closed();

    await dictate().click();
    await shot('w-consent-light', /Dictation isn’t end-to-end encrypted/);
    await theme('dark');
    await shot('w-consent-dark', /Dictation isn’t end-to-end encrypted/);
    await theme('light');
    await page.getByRole('button', { name: 'Keep typing' }).click();
    await closed();

    // Opened from the keyboard, so the first focus inside the confirmation is visible.
    await openId('proxy');
    const discard = page.locator('.correction').getByRole('button', { name: 'Discard' });
    if (!(await discard.count())) {
      await page.locator('.ws').getByRole('button', { name: 'Overrule' }).click();
    }
    await discard.waitFor({ timeout: 15_000 });
    await discard.focus();
    await page.keyboard.press('Enter');
    await shot('w-correction-discard-light', 'Discard this correction?');
    await page.keyboard.press('Escape');
    await closed();

    await go('/settings/privacy');
    await page.getByRole('heading', { name: 'Privacy & security' }).waitFor();
    await page.getByRole('button', { name: 'Unpair…' }).click();
    await page.locator('dialog[open] .s-erase-list li').first().waitFor({ timeout: 20_000 });
    await shot('w-unpair-light', 'Unpair this device?');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await closed();

    await theme('dark');
    await go('/settings/dictation');
    await page.getByRole('heading', { name: 'Dictation' }).waitFor();
    await page.getByRole('switch', { name: 'Dictation' }).click();
    await shot('w-disclosure-dark', 'Dictation is not end-to-end encrypted');
    await page.getByRole('button', { name: 'Not now' }).click();
    await closed();
    await theme('light');

    await go('/settings/about');
    await page.getByRole('heading', { name: 'About & help' }).waitFor();
    await page.getByRole('button', { name: /Keyboard shortcuts/ }).click();
    await shot('w-shortcuts-light', 'Keyboard shortcuts');
    await page.keyboard.press('Escape');
    await closed();
    await page.setViewportSize(PHONE);

    const expected = [
      'p-details-light',
      'p-details-dark',
      'p-activity-light',
      'p-consent-light',
      'p-consent-dark',
      's-consent-light',
      'p-correction-send-light',
      'p-correction-discard-light',
      'p-correction-discard-dark',
      'p-disclosure-light',
      'p-unpair-light',
      'p-leave-light',
      'p-shortcuts-light',
      'p-device-light',
      'w-details-light',
      'w-consent-light',
      'w-consent-dark',
      'w-correction-discard-light',
      'w-unpair-light',
      'w-disclosure-dark',
      'w-shortcuts-light',
    ];
    const missing = expected.filter((n) => !existsSync(join(OUT!, `${n}.png`)));
    expect(missing).toEqual([]);
    expect(written.length).toBe(expected.length);
  });
});
