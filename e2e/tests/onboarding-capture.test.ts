import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from 'playwright-core';
import {
  FileKeyStore,
  RelayClient,
  approveCandidate,
  claimRelay,
  createPairingInvite,
  revokeAndRotate,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Captures onboarding and pairing in every state that carries design weight, for design review:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test onboarding-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. A real relay, the real desktop client creating, declining and approving
 * invitations, and the PWA paired through its own UI on an iPhone (the first device most people pair). It shows the
 * welcome, Install on iPhone and on a desktop, the pairing start with its paste field and a bad link, the scanner
 * starting, live on Chromium's fake camera and blocked, the invitation, the relay being contacted (and slow), the code to
 * compare (also on a narrow phone), a declined pairing, the iOS install nudge on Home, the already-paired page and
 * the revoked lock screen. Each capture checks what the screen says before it writes, and the run fails if any
 * expected file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
// This surface's ports: the relay on 9000 and its inspector on 9001.
const PORT = Number(process.env.ONBOARDING_CAPTURE_PORT ?? 9000);
const INSPECTOR = Number(process.env.ONBOARDING_CAPTURE_INSPECTOR ?? 9001);
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 640 };
const WIDE = { width: 1280, height: 820 };
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const MAC_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

describe.skipIf(!OUT || !chromiumPath)('captures of onboarding and pairing', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let client: RelayClient;
  let keyStore: FileKeyStore;
  const written: string[] = [];

  const settle = async (p: Page = page, ms = 450) => {
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(ms);
  };
  const shot = async (name: string, opts: { full?: boolean; on?: Page } = {}) => {
    const p = opts.on ?? page;
    await settle(p);
    const path = join(OUT!, `${name}.png`);
    const vp = p.viewportSize()!;
    if (opts.full) {
      const h = await p.evaluate(() => document.documentElement.scrollHeight);
      if (h > vp.height) {
        await p.setViewportSize({ width: vp.width, height: Math.min(h, 3000) });
        await settle(p);
      }
    }
    await p.screenshot({ path });
    if (opts.full) await p.setViewportSize(vp);
    if (!existsSync(path) || statSync(path).size < 1_500)
      throw new Error(`capture ${name} is empty`);
    written.push(name);
  };
  const theme = (scheme: 'light' | 'dark', p: Page = page) =>
    p.emulateMedia({ colorScheme: scheme });
  const see = (text: string | RegExp, p: Page = page) =>
    p.getByText(text).first().waitFor({ timeout: 30_000 });
  /** Replaces the camera for the next scan: `never` keeps it starting, otherwise it fails with that error. */
  const camera = (mode: 'never' | 'NotAllowedError') =>
    page.evaluate((m) => {
      const md = navigator.mediaDevices;
      const real = md.getUserMedia.bind(md);
      md.getUserMedia = (c) =>
        c?.video
          ? m === 'never'
            ? new Promise<MediaStream>(() => {})
            : Promise.reject(new DOMException('Blocked', m))
          : real(c);
    }, mode);
  /** Opens an invitation the way a scanned code would: a real load, since the app reads its fragment on load. */
  const openInvite = async (url: string) => {
    await page.goto('about:blank');
    await page.goto(url);
    await page.getByRole('button', { name: 'Pair this device' }).waitFor({ timeout: 30_000 });
  };
  const pending = (pairingId: string) =>
    until(
      async () => (await client.pendingPairings()).pending.find((p) => p.pairing_id === pairingId),
      20_000,
      'pending pairing',
    );

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT, INSPECTOR);
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      // Chromium's fake camera, so the scanner's live state shows a real moving feed.
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    context = await browser.newContext({
      viewport: PHONE,
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
      userAgent: IPHONE_UA,
      colorScheme: 'light',
      serviceWorkers: 'allow',
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      permissions: ['camera'],
    });
    page = await context.newPage();
    const home = mkdtempSync(join(tmpdir(), 'decisions-onboarding-'));
    keyStore = new FileKeyStore(home);
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'Greg’s MacBook Pro',
      store: keyStore,
    });
    client = new RelayClient({ identity });
  });

  afterAll(async () => {
    await browser?.close();
    await relay?.stop();
  });

  it('captures the welcome, Install and the start of pairing', async () => {
    await page.goto(relay.origin + '/');
    await page.getByRole('heading', { name: 'Daintree Decisions' }).waitFor({ timeout: 30_000 });
    await shot('01-welcome-light');
    await theme('dark');
    await shot('01-welcome-dark');
    await theme('light');

    await page.getByRole('link', { name: 'Install the app' }).click();
    await page.getByRole('heading', { name: 'Install Decisions' }).waitFor();
    await see('Add to Home Screen');
    await shot('02-install-ios-light', { full: true });
    await theme('dark');
    await shot('02-install-ios-dark', { full: true });
    await theme('light');

    await page.goto(relay.origin + '/pair');
    await page.getByRole('heading', { name: 'Pair this device' }).waitFor();
    await see('To get notifications on iPhone');
    await shot('03-pair-start-light');
    await theme('dark');
    await shot('03-pair-start-dark');
    await theme('light');

    // From the welcome screen, as a person would: Paste opens the field, focused.
    await page.goto(relay.origin + '/');
    await page.getByRole('button', { name: 'Paste pairing link' }).click();
    await page.getByLabel('Pairing link').waitFor();
    await shot('04-pair-paste-light');
    await page.getByLabel('Pairing link').fill(`${relay.origin}/pair#not-a-pairing-code`);
    await page.getByRole('button', { name: 'Continue' }).click();
    await see('That isn’t a pairing link');
    await shot('04-pair-paste-invalid-light');
  });

  it('captures the scanner starting, live and blocked', async () => {
    await page.goto(relay.origin + '/pair');
    await camera('never');
    await page.getByRole('button', { name: 'Scan pairing code' }).click();
    await see('Starting camera…');
    await shot('05-scan-starting-light');

    await page.goto(relay.origin + '/pair');
    await page.getByRole('button', { name: 'Scan pairing code' }).click();
    await page.locator('.scanner-frame.live').waitFor({ timeout: 20_000 });
    await shot('05-scan-live-light');
    await theme('dark');
    await shot('05-scan-live-dark');
    await theme('light');

    await page.goto(relay.origin + '/pair');
    await camera('NotAllowedError');
    await page.getByRole('button', { name: 'Scan pairing code' }).click();
    await see('Camera access is blocked');
    await shot('05-scan-blocked-light');
  });

  it('captures an invitation, a declined pairing and the code to compare', async () => {
    // Declined on the computer: the phone returns to the start with the reason.
    const declined = await createPairingInvite(client, 'phone');
    await openInvite(declined.url);
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await see('Compare the code');
    await client.rejectPairing((await pending(declined.pairingId)).pairing_id);
    await see('Pairing was declined on your computer');
    await shot('06-pair-declined-light');

    const invite = await createPairingInvite(client, 'phone');
    await openInvite(invite.url);
    await shot('07-pair-invite-light');
    await theme('dark');
    await shot('07-pair-invite-dark');
    await theme('light');

    // Hold the candidate registration, so "Contacting your relay…" stays on screen for its capture.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/v1/pairing/candidates', async (route: Route) => {
      await held;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await see('Contacting your relay…');
    await shot('08-pair-contacting-light');
    // A relay that takes more than five seconds gets a word of explanation.
    await see('Still trying to reach your relay', page);
    await shot('08-pair-slow-light');
    release();
    await see('Compare the code');
    await page.unroute('**/api/v1/pairing/candidates');
    await shot('09-pair-code-light');
    await theme('dark');
    await shot('09-pair-code-dark');
    await theme('light');
    await page.setViewportSize(NARROW);
    await shot('09-pair-code-narrow-light');
    await page.setViewportSize(PHONE);

    await approveCandidate(client, await pending(invite.pairingId));
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
    await page.locator('.nudge').waitFor({ timeout: 30_000 });
    await shot('10-home-ios-nudge-light');
    await theme('dark');
    await shot('10-home-ios-nudge-dark');
    await theme('light');

    await page.goto(relay.origin + '/pair');
    await page.getByRole('heading', { name: 'This device is already paired' }).waitFor();
    await shot('11-already-paired-light');
  });

  it('captures the revoked lock screen', async () => {
    const list = await client.devices();
    const phone = list.devices.find((d) => d.role === 'phone' && !d.revoked_at);
    expect(phone).toBeTruthy();
    await revokeAndRotate(client, keyStore, phone!.device_id);
    await page.goto(relay.origin + '/');
    await page
      .getByRole('heading', { name: 'This device is no longer paired' })
      .waitFor({ timeout: 30_000 });
    await shot('12-revoked-light');
    await theme('dark');
    await shot('12-revoked-dark');
    await theme('light');
  });

  it('captures the welcome and Install on a desktop', async () => {
    const desk = await browser.newContext({
      viewport: WIDE,
      deviceScaleFactor: 1,
      userAgent: MAC_CHROME_UA,
      colorScheme: 'light',
      locale: 'en-GB',
      timezoneId: 'Europe/London',
    });
    const p = await desk.newPage();
    await p.goto(relay.origin + '/');
    await p.getByRole('heading', { name: 'Daintree Decisions' }).waitFor({ timeout: 30_000 });
    await shot('13-welcome-wide-light', { on: p });
    await p.goto(relay.origin + '/install');
    await p.getByRole('heading', { name: 'Install Decisions' }).waitFor();
    await see('Install page as app', p);
    await theme('dark', p);
    await shot('13-install-wide-dark', { on: p });
    await desk.close();

    const expected = [
      '01-welcome-light',
      '01-welcome-dark',
      '02-install-ios-light',
      '02-install-ios-dark',
      '03-pair-start-light',
      '03-pair-start-dark',
      '04-pair-paste-light',
      '04-pair-paste-invalid-light',
      '05-scan-starting-light',
      '05-scan-live-light',
      '05-scan-live-dark',
      '05-scan-blocked-light',
      '06-pair-declined-light',
      '07-pair-invite-light',
      '07-pair-invite-dark',
      '08-pair-contacting-light',
      '08-pair-slow-light',
      '09-pair-code-light',
      '09-pair-code-dark',
      '09-pair-code-narrow-light',
      '10-home-ios-nudge-light',
      '10-home-ios-nudge-dark',
      '11-already-paired-light',
      '12-revoked-light',
      '12-revoked-dark',
      '13-welcome-wide-light',
      '13-install-wide-dark',
    ];
    const missing = expected.filter((n) => !existsSync(join(OUT!, `${n}.png`)));
    expect(missing).toEqual([]);
    expect(written).toEqual(expected);
  });
});
