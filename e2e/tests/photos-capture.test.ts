import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
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
  type LocateResult,
  type PhoneImageFile,
  type PhoneImageStore,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';
import { drawPhotos, type PhotoFile } from './photo-fixtures.js';

/**
 * Captures photo attaching, for design review: `+` in the composer and its sheet (Take photo, Choose photos), the
 * composer with thumbnails, the limit, photos uploading with their progress, an upload that stopped, one queued
 * offline, sent answers and follow-ups with their photos, the viewer, and the wide layout (composer and thread):
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test photos-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. Everything goes through the real seams: a real relay, the real desktop
 * bridge with a photo store (it fetches, decrypts and checks each photo), and the PWA paired through its own UI, with
 * photos chosen through the real file chooser. Each capture checks what it claims to show before it writes, and the
 * run fails if any file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.PHOTOS_CAPTURE_PORT ?? 8863);
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 820 };

class Sink implements TerminalSink {
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
    return { outcome: 'delivered' as const, proof: 'shot' };
  }
  async hasMarker() {
    return false;
  }
  async resume() {
    return null;
  }
}

/** The host's photo store: keeps what it was handed and says where it "wrote" it. */
class Photos implements PhoneImageStore {
  stored: PhoneImageFile[] = [];
  async store(image: PhoneImageFile) {
    this.stored.push(image);
    return {
      path: `/tmp/decisions-photos/${image.attachmentId}.${image.mime === 'image/png' ? 'png' : 'jpg'}`,
    };
  }
}

describe.skipIf(!OUT || !chromiumPath)('captures of photos in the composer and thread', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  let files: Record<string, PhotoFile>;
  const sink = new Sink();
  const photos = new Photos();
  const local = new MemoryLocalStore();
  const written: string[] = [];
  const ids: Record<string, string> = {};

  const settle = async (ms = 500) => {
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
  const go = async (path: string) => {
    await page.goto(relay.origin + path);
    await page.locator('#main').waitFor({ timeout: 30_000 });
  };
  const openId = async (key: string) => {
    await go(`/q/${ids[key]}`);
    await page.locator('.ws .dock').waitFor({ timeout: 30_000 });
  };
  const field = () => page.locator('.dock .composer-field textarea');
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const toEnd = async () => {
    await page.evaluate(() => {
      const b = document.querySelector('.ws-body');
      if (b) b.scrollTop = b.scrollHeight;
    });
    await settle(400);
  };
  const plus = () => page.locator('.dock').getByRole('button', { name: 'Add photos' });
  /** `+`, then Choose photos in the sheet, then the chooser: the real way in on a phone. */
  const choose = async (list: PhotoFile[]) => {
    await plus().click();
    const sheet = page.locator('dialog.attach-sheet[open]');
    await sheet.waitFor({ timeout: 10_000 });
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      sheet.getByRole('button', { name: /Choose photos/ }).click(),
    ]);
    await chooser.setFiles(list);
  };
  const trayReady = async (n: number) => {
    await until(
      async () => (await page.locator('.dock .tray-photo.is-ready').count()) === n,
      30_000,
      `${n} photos ready in the tray`,
    );
  };
  const sentPhotos = async (text: string, n: number) => {
    await until(
      async () =>
        (await page
          .locator('.ws .msg.out', { hasText: text })
          .locator('.photo-cell.is-ready:not(.is-going)')
          .count()) === n,
      45_000,
      `${n} sent photos with "${text}"`,
    );
  };
  const throttle = (bytesPerSecond: number) =>
    cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: bytesPerSecond,
    });

  beforeAll(async () => {
    mkdirSync(OUT!, { recursive: true });
    relay = await startRelay(PORT);
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      // A camera to list, so a phone offers Take photo.
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
      isMobile: true,
    });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[console] ${m.text()}`);
    });
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('pairs, asks, and sends photos with answers and follow-ups', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-photos-'));
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
      sink,
      client,
      followUps: true,
      phoneImages: photos,
      policy: new PolicyRegistry({ proxyAllowlisted: false }),
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
    files = await drawPhotos(page);

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
    await ask('router', origin('p1', 'home-network'), {
      question: 'What does the label on the back of the router say? I need the exact model number.',
      kind: 'text',
      options: [],
    });
    await ask('board', origin('p2', 'daintree'), {
      question: 'Rename “Canopy” to “Inbox” in the sidebar?',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Yes, rename' },
        { id: 'no', label: 'Keep Canopy' },
      ],
    });
    await ask('proof', origin('p3', 'docs-site', 'codex'), {
      question: 'Is the printed proof of the 0.4 release notes ready to publish?',
      kind: 'choice',
      options: [
        { id: 'ship', label: 'Publish it' },
        { id: 'fix', label: 'Needs changes' },
      ],
    });
    await ask('flaky', origin('p4', 'billing-api'), {
      question: 'What does the checkout screen show when the card is declined?',
      kind: 'text',
      options: [],
    });
    await ask('offline', origin('p5', 'billing-api'), {
      question: 'Which receipt layout did the client approve on paper?',
      kind: 'text',
      options: [],
    });
    await ask('fresh', origin('p6', 'home-network'), {
      question: 'Where is the spare access point mounted now?',
      kind: 'text',
      options: [],
    });
    await bridge.pump();
    await go('/');
    await page.getByText('What does the label on the back').first().waitFor({ timeout: 30_000 });

    // An answer that is photos and words, typed into the terminal with the photos' paths.
    await openId('router');
    await plus().waitFor({ timeout: 30_000 });
    await choose([files.router!, files.whiteboard!]);
    await trayReady(2);
    await field().fill('Model RAX50v2. The serial is on the second photo too.');
    await blur();
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await sentPhotos('Model RAX50v2', 2);
    await until(
      async () => {
        await bridge.pump();
        return sink.typed.some((t) => t.includes('Model RAX50v2'));
      },
      30_000,
      'the answer typed',
    );
    expect(photos.stored.length).toBe(2);

    // A decision, then a follow-up that is only a photo.
    await openId('board');
    await page
      .getByRole('radio', { name: /Yes, rename/ })
      .first()
      .check();
    await page.locator('.dock').getByRole('button', { name: 'Send decision' }).click();
    await page
      .locator('.dock textarea[placeholder="Add a follow-up"]')
      .waitFor({ timeout: 15_000 });
    await choose([files.whiteboard!]);
    await trayReady(1);
    await page.locator('.dock').getByRole('button', { name: 'Send follow-up' }).click();
    await until(
      async () =>
        (await page.locator('.ws .msg.out .photo-cell.is-ready:not(.is-going)').count()) >= 1,
      45_000,
      'the follow-up photo sent',
    );
    await field().fill('All four screens from the design review.');
    await blur();
    await choose([files.proof!, files.screenshot!, files.router!, files.whiteboard!]);
    await trayReady(4);
    await page.locator('.dock').getByRole('button', { name: 'Send follow-up' }).click();
    await sentPhotos('All four screens', 4);
    await until(
      async () => {
        await bridge.pump();
        return photos.stored.length >= 7;
      },
      30_000,
      'every photo stored on the host',
    );
  });

  it('captures each state on a phone, in both themes', async () => {
    // The composer at rest: `+` at its leading edge.
    await openId('proof');
    await plus().waitFor({ timeout: 30_000 });
    await shot('p-composer-rest-light');

    // The sheet: Take photo and Choose photos.
    await plus().click();
    await page.locator('dialog.attach-sheet[open]').waitFor({ timeout: 10_000 });
    expect(
      await page
        .locator('dialog.attach-sheet')
        .getByRole('button', { name: /Take photo/ })
        .count(),
    ).toBe(1);
    await shot('p-sheet-light');
    await theme('dark');
    await shot('p-sheet-dark');
    await theme('light');
    await page.keyboard.press('Escape');
    await page
      .locator('dialog.attach-sheet[open]')
      .waitFor({ state: 'detached', timeout: 5_000 })
      .catch(() => undefined);
    await settle(300);

    // The composer with thumbnails, a choice and a note.
    await page
      .getByRole('radio', { name: /Needs changes/ })
      .first()
      .check();
    await choose([files.proof!, files.screenshot!, files.whiteboard!]);
    await trayReady(3);
    await field().fill('Typo circled on page one.');
    await blur();
    await shot('p-tray-light');
    await theme('dark');
    await shot('p-tray-dark');
    await theme('light');

    // Past the limit: four go in, and the lane says what didn't.
    await choose([files.router!, files.proof!]);
    await trayReady(4);
    await page.locator('.dock .composer-lane', { hasText: /weren’t added|wasn’t added/ }).waitFor();
    await shot('p-limit-light');

    // Removing one: Undo is offered.
    await page.locator('.dock').getByRole('button', { name: 'Remove photo 4 of 4' }).click();
    await page.locator('.dock .composer-lane', { hasText: 'Photo removed' }).waitFor();
    await shot('p-removed-light');

    // Sending on a slow uplink: each photo's progress on the outgoing message.
    await throttle(48 * 1024);
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await page
      .locator('.ws .msg.out .photo-progress[aria-valuenow]')
      .first()
      .waitFor({ timeout: 30_000 });
    await until(
      async () => {
        const v = await page
          .locator('.ws .msg.out .photo-progress[aria-valuenow]')
          .first()
          .getAttribute('aria-valuenow');
        return Number(v) >= 30 && Number(v) <= 80;
      },
      60_000,
      'an upload part-way',
    );
    await toEnd();
    await shot('p-uploading-light');
    await theme('dark');
    await shot('p-uploading-dark');
    await theme('light');
    await throttle(-1);
    await sentPhotos('Typo circled', 3);

    // The sent answer with its photos, received and typed.
    await page
      .locator('.ws .msg.out', { hasText: 'Typo circled' })
      .locator('.receipt')
      .filter({ hasText: /Typed into the terminal|Received by your computer|Saved on your relay/ })
      .waitFor({ timeout: 30_000 });
    await bridge.pump();
    await toEnd();
    await shot('p-sent-answer-light');

    // The answer of photos and words, typed into the terminal.
    await openId('router');
    await sentPhotos('Model RAX50v2', 2);
    await page.getByText('Typed into the terminal').first().waitFor({ timeout: 30_000 });
    await toEnd();
    await shot('p-router-answer-light');
    await theme('dark');
    await toEnd();
    await shot('p-router-answer-dark');
    await theme('light');

    // A follow-up of one photo and one of four, with words.
    await openId('board');
    await sentPhotos('All four screens', 4);
    await toEnd();
    await shot('p-follow-ups-light');
    await theme('dark');
    await toEnd();
    await shot('p-follow-ups-dark');
    await theme('light');

    // The viewer, from a sent photo.
    await page
      .locator('.ws .msg.out', { hasText: 'All four screens' })
      .locator('.photo-tile')
      .first()
      .click();
    await page.locator('.fx-viewer').waitFor({ timeout: 10_000 });
    await settle(600);
    await shot('p-viewer-dark-stage-light');
    await page.keyboard.press('Escape');
    await settle(300);

    // An upload that stops part-way: the words and photos stay, with Try again.
    await openId('flaky');
    let dropped = 0;
    await context.route('**/api/v1/attachments/*/content', async (route) => {
      if (route.request().method() === 'PUT' && dropped < 50) {
        dropped++;
        await route.abort('connectionreset');
      } else await route.continue();
    });
    await choose([files.screenshot!]);
    await trayReady(1);
    await field().fill('This is what it shows after tapping Pay.');
    await blur();
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await page
      .locator('.ws .msg.out .msg-trouble')
      .getByRole('button', { name: 'Try again' })
      .waitFor({ timeout: 30_000 });
    await toEnd();
    await shot('p-interrupted-light');
    await context.unroute('**/api/v1/attachments/*/content');
    await page
      .locator('.ws .msg.out .msg-trouble')
      .getByRole('button', { name: 'Try again' })
      .click();
    await sentPhotos('after tapping Pay', 1);

    // Offline: the answer and its photo wait on this device.
    await openId('offline');
    await context.setOffline(true);
    await page.waitForTimeout(400);
    await choose([files.proof!]);
    await trayReady(1);
    await field().fill('The two-column one, signed on the second page.');
    await blur();
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await page
      .locator('.ws .msg.out .receipt')
      .filter({ hasText: /Queued/ })
      .waitFor({ timeout: 15_000 });
    await toEnd();
    await shot('p-offline-light');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await sentPhotos('two-column one', 1);
  });

  it('captures the wide layout', async () => {
    await page.setViewportSize(WIDE);
    await openId('fresh');
    await choose([files.whiteboard!, files.router!]);
    await trayReady(2);
    await field().fill('Both photos are from this morning.');
    await blur();
    await shot('w-composer-tray-light');
    await field().fill('');
    await page.locator('.dock').getByRole('button', { name: 'Remove photo 2 of 2' }).click();
    await page.locator('.dock').getByRole('button', { name: 'Remove photo 1 of 1' }).click();
    await blur();
    await openId('board');
    await sentPhotos('All four screens', 4);
    await toEnd();
    await shot('w-thread-light');
    await theme('dark');
    await toEnd();
    await shot('w-thread-dark');
    await theme('light');
    await page.setViewportSize(PHONE);

    const expected = [
      'p-composer-rest-light',
      'p-sheet-light',
      'p-sheet-dark',
      'p-tray-light',
      'p-tray-dark',
      'p-limit-light',
      'p-removed-light',
      'p-uploading-light',
      'p-uploading-dark',
      'p-sent-answer-light',
      'p-router-answer-light',
      'p-router-answer-dark',
      'p-follow-ups-light',
      'p-follow-ups-dark',
      'p-viewer-dark-stage-light',
      'p-interrupted-light',
      'p-offline-light',
      'w-composer-tray-light',
      'w-thread-light',
      'w-thread-dark',
    ];
    const missing = expected.filter((n) => !existsSync(join(OUT!, `${n}.png`)));
    expect(missing).toEqual([]);
    expect(written.length).toBe(expected.length);
  });
});
