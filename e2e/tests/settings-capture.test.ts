import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from 'playwright-core';
import {
  DecisionsBridge,
  FileKeyStore,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  approveCandidate,
  claimRelay,
  createPairingInvite,
  revokeAndRotate,
  type LocateResult,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Captures Settings in every state that carries design weight, for design review:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test settings-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. A real relay, the real desktop client as owner, and the PWA paired
 * through its own UI, plus a tablet paired beside it and a third device paired then revoked, so Devices shows every
 * group. The index and each section on a phone in both themes, a narrow phone, and the wide split; Quiet hours at
 * rest, dirty, invalid, saving failed, failing to load, the leave guard and saved; Dictation unconfigured and
 * configured (the relay's info answer reports provider keys for display only; nothing contacts a provider) and the
 * microphone test live on Chromium's fake device; the device sheet, the unpair dialog and the shortcuts sheet. Each
 * capture checks what the screen says before it writes, and the run fails if any expected file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
// This surface's ports: the relay and its inspector, both inside 8990-8999.
const PORT = Number(process.env.SETTINGS_CAPTURE_PORT ?? 8990);
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 640 };
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

describe.skipIf(!OUT || !chromiumPath)('captures of Settings', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  let keyStore: FileKeyStore;
  const local = new MemoryLocalStore();
  const written: string[] = [];

  const settle = async (ms = 450) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(ms);
  };
  /** Writes `name` only once `marker` is on screen after the settle; a missing marker fails the run. */
  const shot = async (name: string, marker: Locator, opts: { full?: boolean } = {}) => {
    await settle();
    if (!(await marker.first().isVisible()))
      throw new Error(`capture ${name}: expected content is not on screen`);
    const path = join(OUT!, `${name}.png`);
    await page.screenshot({ path, fullPage: !!opts.full });
    if (!existsSync(path) || statSync(path).size < 1_500)
      throw new Error(`capture ${name} is empty`);
    written.push(name);
  };
  const theme = (scheme: 'light' | 'dark') => page.emulateMedia({ colorScheme: scheme });
  const go = async (path: string) => {
    await page.goto(relay.origin + path);
    await page.locator('#main').waitFor({ timeout: 30_000 });
  };
  const heading = (name: string) => page.getByRole('heading', { name, exact: true });
  const indexReady = async () => {
    await page.locator('[data-section-row="quiet-hours"]').waitFor({ timeout: 30_000 });
    // Every summary that has a value to show has shown it.
    await until(
      async () =>
        (await page.locator('.s-index [data-section-row] .value:empty').count()) === 0 ||
        (await page.locator('.s-split').count()) > 0,
      20_000,
      'index summaries',
    );
  };
  const quietReady = async () => {
    await page.getByLabel('Quiet hours', { exact: true }).waitFor({ timeout: 30_000 });
  };
  const themeArt = () =>
    page.waitForFunction(() =>
      Array.from(document.querySelectorAll<HTMLImageElement>('.theme-art img')).every(
        (i) => i.complete,
      ),
    );
  const devicesReady = async () => {
    await heading('Computers').waitFor({ timeout: 30_000 });
    await heading('Revoked').waitFor({ timeout: 30_000 });
  };
  /** The relay's info answer reporting provider keys, for display only. */
  const withVoiceKeys = () =>
    page.route('**/api/v1/info', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        response: res,
        json: { ...body, voice: { xai: true, anthropic: true, openai: true } },
      });
    });
  const dictationOn = async () => {
    await withVoiceKeys();
    await go('/settings/dictation');
    const sw = page.getByRole('switch', { name: 'Dictation' });
    await sw.waitFor({ timeout: 30_000 });
    if (!(await sw.isChecked())) {
      await sw.click();
      await page.getByRole('dialog').waitFor();
      await page.getByRole('button', { name: /turn on dictation/i }).click();
    }
    await page.getByText('Speech to text', { exact: true }).waitFor();
  };

  /** Pairs a fresh browser context as another device, through the app's own pairing screen. */
  const pairAnother = async (label: string, viewport: { width: number; height: number }) => {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'allow', locale: 'en-GB' });
    const p = await ctx.newPage();
    const invite = await createPairingInvite(client, 'phone');
    await p.goto(invite.url);
    const name = p.getByLabel(/name/i);
    if (await name.count()) await name.first().fill(label);
    await p.getByRole('button', { name: 'Pair this device' }).click();
    await p.getByText('Check that this matches your computer').waitFor({ timeout: 20_000 });
    const cand = await until(
      async () =>
        (await client.pendingPairings()).pending.find((x) => x.pairing_id === invite.pairingId),
      20_000,
      'pending pairing',
    );
    await approveCandidate(client, cand);
    await p.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
    return { ctx, page: p, deviceId: cand.device_id as string | undefined };
  };

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT, PORT + 1);
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      // A fake microphone (a steady tone) so the microphone test runs for real.
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
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

  it('pairs devices and captures every section', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-settings-'));
    keyStore = new FileKeyStore(home);
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
      resolver: { resolve: async () => null },
    });
    await bridge.start();

    // This phone, paired through its own UI.
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

    // A tablet beside it, and a third device paired and then revoked, so every Devices group has a row.
    const tablet = await pairAnother('Studio iPad', { width: 820, height: 1180 });
    const old = await pairAnother('Old Pixel 6', PHONE);
    const list = await client.devices();
    const oldId = list.devices.find(
      (d) => !d.revoked_at && d.device_id !== identity.config.deviceId && d.label.includes('Pixel'),
    )?.device_id;
    const revokeId =
      oldId ??
      list.devices.filter((d) => d.device_id !== identity.config.deviceId && !d.revoked_at).at(-1)!
        .device_id;
    await revokeAndRotate(client, keyStore, revokeId);
    await old.ctx.close();
    await tablet.ctx.close();

    // A couple of saved questions, so the unpair dialog has something to count.
    const origin = (pane: string, project: string): QuestionOrigin => ({
      machine_label: 'Greg’s MacBook Pro',
      host_id: 'host_1',
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
    await bridge.registerQuestion({
      origin: origin('p1', 'canopy'),
      input: { question: 'Ship the compact sidebar behind a flag?', kind: 'text' },
    });
    await bridge.registerQuestion({
      origin: origin('p2', 'billing-api'),
      input: { question: 'Drop the legacy /v1/invoices endpoint in this release?', kind: 'text' },
    });
    await page.getByText('Ship the compact sidebar').first().waitFor({ timeout: 30_000 });

    for (const t of ['light', 'dark'] as const) {
      await theme(t);
      await page.setViewportSize(PHONE);

      // Index.
      await go('/settings');
      await indexReady();
      await shot(`index-${t}`, heading('Settings'), { full: true });

      // Appearance.
      await go('/settings/appearance');
      await themeArt();
      await shot(`appearance-${t}`, page.locator('.theme-card.on'));

      // Notifications.
      await go('/settings/notifications');
      await page.locator('.s-value').first().waitFor();
      await until(
        async () => (await page.locator('.s-value').first().textContent()) !== 'Checking…',
        15_000,
        'notification status',
      );
      await shot(`notifications-${t}`, heading('Notifications'));

      // Quiet hours: at rest, dirty, invalid.
      await go('/settings/quiet-hours');
      await quietReady();
      await shot(`quiet-rest-${t}`, page.getByLabel('Quiet hours', { exact: true }), {
        full: true,
      });
      await page.getByLabel('Quiet hours', { exact: true }).check();
      await page.getByText('Unsaved changes').waitFor();
      await shot(`quiet-dirty-${t}`, page.getByText('Unsaved changes'));
      await page.getByLabel('Until').fill('22:00');
      await page
        .getByText(/can’t start and end at the same time/)
        .first()
        .waitFor();
      await shot(`quiet-invalid-${t}`, page.getByText(/can’t start and end/), { full: true });
      await page.getByLabel('Until').fill('07:00');
      await page.getByRole('button', { name: 'Discard' }).click();

      // Dictation, configured.
      await dictationOn();
      await shot(`dictation-on-${t}`, page.getByText('Speech to text', { exact: true }), {
        full: true,
      });
      await page.unroute('**/api/v1/info');

      // Devices and a device's sheet.
      await go('/settings/devices');
      await devicesReady();
      await shot(`devices-${t}`, heading('Revoked'), { full: true });
      await page.locator('.s-device', { hasText: 'MacBook' }).first().click();
      await page.locator('.fingerprint span').first().waitFor();
      await shot(`device-sheet-${t}`, page.locator('.fingerprint span'));
      await page.keyboard.press('Escape');

      // Privacy.
      await go('/settings/privacy');
      await page.locator('.s-flow').first().waitFor();
      await shot(`privacy-${t}`, heading('Privacy & security'), { full: true });

      // About.
      await go('/settings/about');
      await shot(`about-${t}`, heading('About & help'), { full: true });
    }
    await theme('light');

    // Phone, light only: the states that are one-offs.
    await go('/settings/dictation');
    await heading('Dictation').waitFor();
    await shot('dictation-unconfigured-light', page.getByText('Test microphone'), { full: true });
    await context.grantPermissions(['microphone'], { origin: relay.origin });
    await page.getByRole('button', { name: 'Test microphone' }).click();
    await page
      .getByText(/Listening|Sound is reaching/)
      .first()
      .waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1200);
    await shot('dictation-mic-live-light', page.getByText(/stops in/), { full: true });
    await page.getByRole('button', { name: 'Stop' }).click();
    await page.getByText(/microphone works|No sound reached/).waitFor({ timeout: 10_000 });
    await shot('dictation-mic-done-light', page.getByText(/microphone works|No sound reached/));
    await context.clearPermissions();

    // Quiet hours: the leave guard, then saved, then a save that fails, then a load that fails.
    await go('/settings/quiet-hours');
    await quietReady();
    await page.getByLabel('Quiet hours', { exact: true }).check();
    await page.getByText('Unsaved changes').waitFor();
    await page.locator('.s-back').click();
    await page.getByRole('dialog', { name: 'Save your changes?' }).waitFor();
    await shot('quiet-leave-light', page.getByRole('dialog', { name: 'Save your changes?' }));
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await page.route('**/api/v1/settings', (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 503, json: { error: 'unavailable' } })
        : route.fallback(),
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Couldn’t save to your relay').waitFor({ timeout: 20_000 });
    await shot('quiet-save-error-light', page.getByText('Couldn’t save to your relay'));
    await page.unroute('**/api/v1/settings');
    // After a failure the bar's Save offers to try again.
    await page.getByRole('button', { name: /^(Try again|Save)$/ }).click();
    await page.getByText('Saved on your relay').waitFor({ timeout: 20_000 });
    await shot('quiet-saved-light', page.getByText('Saved on your relay'));
    await page.route('**/api/v1/settings', (route) =>
      route.fulfill({ status: 503, json: { error: 'unavailable' } }),
    );
    await go('/settings/quiet-hours');
    await page
      .getByText('Couldn’t load these settings from your relay')
      .waitFor({ timeout: 20_000 });
    await shot('quiet-load-error-light', page.getByText('Couldn’t load these settings'));
    await page.unroute('**/api/v1/settings');

    // Sheets and dialogs.
    await go('/settings/privacy');
    await page.getByRole('button', { name: 'Unpair…' }).click();
    await page
      .getByRole('dialog')
      .getByText(/saved question/)
      .waitFor();
    await shot('unpair-dialog-light', page.getByRole('dialog').getByText(/saved question/));
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await go('/settings/about');
    await page.getByRole('button', { name: /Keyboard shortcuts/ }).click();
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
    await shot('shortcuts-light', page.getByRole('dialog', { name: 'Keyboard shortcuts' }));
    await page.keyboard.press('Escape');

    // A narrow phone.
    await page.setViewportSize(NARROW);
    await go('/settings');
    await indexReady();
    await shot('narrow-index-light', heading('Settings'), { full: true });
    await go('/settings/quiet-hours');
    await quietReady();
    // Quiet hours were saved on above, so the edit here is the review reminder.
    await page.getByLabel('Remind me to review model answers').click();
    await page.getByText('Unsaved changes').waitFor();
    await shot('narrow-quiet-dirty-light', page.getByText('Unsaved changes'));
    await page.getByRole('button', { name: 'Discard' }).click();

    // Wide: the index beside the open section.
    await page.setViewportSize(WIDE);
    for (const t of ['light', 'dark'] as const) {
      await theme(t);
      await go('/settings');
      await themeArt();
      await shot(`wide-appearance-${t}`, page.locator('.s-split .theme-card.on'));
      await go('/settings/quiet-hours');
      await quietReady();
      await page.getByLabel('Remind me to review model answers').click();
      await page.getByText('Unsaved changes').waitFor();
      await shot(`wide-quiet-dirty-${t}`, page.getByText('Unsaved changes'));
      await page.getByRole('button', { name: 'Discard' }).click();
      await go('/settings/privacy');
      await page.locator('.s-flow').first().waitFor();
      await shot(`wide-privacy-${t}`, page.locator('.s-split .s-flow'));
    }
    await go('/settings/devices');
    await devicesReady();
    await shot('wide-devices-dark', heading('Revoked'));
    await theme('light');
    await page.setViewportSize(PHONE);

    const expected = [
      ...['light', 'dark'].flatMap((t) => [
        `index-${t}`,
        `appearance-${t}`,
        `notifications-${t}`,
        `quiet-rest-${t}`,
        `quiet-dirty-${t}`,
        `quiet-invalid-${t}`,
        `dictation-on-${t}`,
        `devices-${t}`,
        `device-sheet-${t}`,
        `privacy-${t}`,
        `about-${t}`,
        `wide-appearance-${t}`,
        `wide-quiet-dirty-${t}`,
        `wide-privacy-${t}`,
      ]),
      'dictation-unconfigured-light',
      'dictation-mic-live-light',
      'dictation-mic-done-light',
      'quiet-leave-light',
      'quiet-save-error-light',
      'quiet-saved-light',
      'quiet-load-error-light',
      'unpair-dialog-light',
      'shortcuts-light',
      'narrow-index-light',
      'narrow-quiet-dirty-light',
      'wide-devices-dark',
    ];
    const missing = expected.filter((n) => !existsSync(join(OUT!, `${n}.png`)));
    expect(missing).toEqual([]);
    expect(written.length).toBe(expected.length);
  });
});
