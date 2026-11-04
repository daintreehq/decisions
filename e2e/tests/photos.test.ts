import { mkdtempSync } from 'node:fs';
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
  type PhoneImageFile,
  type PhoneImageStore,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';
import { drawPhotos, GPS_MARKER, hasExif, withGpsExif, type PhotoFile } from './photo-fixtures.js';

/**
 * Photos from the composer, end to end: a real relay, the real desktop bridge with a photo store, and the PWA in
 * Chromium with files chosen through its own file chooser. Photos go with an answer and with a follow-up, can be
 * removed before sending, stop at the limit with the reason said, wait offline with their message, survive an upload
 * that fails and is tried again, reach the host decrypted and verified with their location stripped, and never reach
 * the relay as plaintext. A desktop with no camera opens the chooser straight from `+`.
 */
const chromiumPath = findChromium();
const PORT = 8865;

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

class Photos implements PhoneImageStore {
  stored: PhoneImageFile[] = [];
  async store(image: PhoneImageFile) {
    this.stored.push(image);
    return { path: `/tmp/decisions-photos/${image.attachmentId}.jpg` };
  }
  forQuestion(id: string) {
    return this.stored.filter((s) => s.questionId === id);
  }
}

describe.skipIf(!chromiumPath)('photos from the composer, end to end', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  let files: Record<string, PhotoFile>;
  const sink = new RecordingSink();
  const photos = new Photos();
  const ids: Record<string, string> = {};
  /** Every body the phone streamed to the relay's attachment upload route. */
  const uploads: Buffer[] = [];
  let n = 0;

  const origin = (pane: string): QuestionOrigin => ({
    machine_label: 'e2e-mac',
    host_id: 'host_e2e',
    pane_id: pane,
    terminal_generation: 1,
    ownership_principal: `principal-${pane}`,
    agent_incarnation: '1',
    agent_kind: 'claude-code',
    agent_session_id: `s-${pane}`,
    project_id: 'photos',
    worktree_id: `wt-${pane}`,
    worktree_root: '/work/photos',
    workflow_gate_id: null,
  });
  const ask = async (key: string, input: Record<string, unknown>) => {
    const r = await bridge.registerQuestion({ origin: origin(`p${++n}`), input });
    ids[key] = r.questionId;
    await bridge.pump();
  };
  const open = async (p: Page, key: string) => {
    await p.goto(`${relay.origin}/q/${ids[key]}`);
    await p.locator('.ws .dock').waitFor({ timeout: 30_000 });
    await p
      .locator('.dock')
      .getByRole('button', { name: 'Add photos' })
      .waitFor({ timeout: 30_000 });
  };
  const field = (p: Page) => p.locator('.dock .composer-field textarea');
  /** `+` → Choose photos → the chooser, as on a phone. */
  const choose = async (p: Page, list: PhotoFile[]) => {
    await p.locator('.dock').getByRole('button', { name: 'Add photos' }).click();
    const sheet = p.locator('dialog.attach-sheet[open]');
    await sheet.waitFor({ timeout: 10_000 });
    const [chooser] = await Promise.all([
      p.waitForEvent('filechooser'),
      sheet.getByRole('button', { name: /Choose photos/ }).click(),
    ]);
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles(list);
  };
  const tray = (p: Page, ready: number) =>
    until(
      async () => (await p.locator('.dock .tray-photo.is-ready').count()) === ready,
      30_000,
      `${ready} photos ready`,
    );
  const delivered = (questionId: string, count: number) =>
    until(
      async () => {
        await bridge.pump();
        return photos.forQuestion(questionId).length >= count;
      },
      45_000,
      `${count} photos on the host`,
    );

  beforeAll(async () => {
    relay = await startRelay(PORT);
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      serviceWorkers: 'allow',
    });
    page = await context.newPage();
    page.on('request', (r) => {
      if (r.method() === 'PUT' && /\/api\/v1\/attachments\/[^/]+\/content$/.test(r.url())) {
        const b = r.postDataBuffer();
        if (b) uploads.push(b);
      }
    });

    const keyStore = new FileKeyStore(mkdtempSync(join(tmpdir(), 'decisions-photos-e2e-')));
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'e2e-mac',
      store: keyStore,
    });
    client = new RelayClient({ identity });
    bridge = new DecisionsBridge({
      identity,
      keyStore,
      store: new MemoryLocalStore(),
      sink,
      client,
      followUps: true,
      phoneImages: photos,
      policy: new PolicyRegistry({ proxyAllowlisted: false }),
      pumpIntervalMs: 0,
    });
    await bridge.start();
    await pair(page, 'phone');
    files = await drawPhotos(page);
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  async function pair(p: Page, role: 'phone' | 'tablet') {
    const invite = await createPairingInvite(client, role);
    await p.goto('about:blank');
    await p.goto(invite.url);
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
  }

  it('sends two photos with an answer, typed into the pane with their paths', async () => {
    await ask('two', { question: 'What does the router label say?', kind: 'text', options: [] });
    await open(page, 'two');
    await choose(page, [files.router!, files.whiteboard!]);
    await tray(page, 2);
    await field(page).fill('Model RAX50v2.');
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await delivered(ids.two!, 2);
    const stored = photos.forQuestion(ids.two!);
    expect(stored.map((s) => s.carrier.kind)).toEqual(['answer', 'answer']);
    await until(
      async () => {
        await bridge.pump();
        return sink.typed.find((t) => t.includes('Model RAX50v2.'));
      },
      30_000,
      'the answer typed',
    );
    const typed = sink.typed.find((t) => t.includes('Model RAX50v2.'))!;
    for (const s of stored) expect(typed).toContain(`/tmp/decisions-photos/${s.attachmentId}.jpg`);
    // The bubble shows both, loaded and verified, once the relay has them.
    await until(
      async () =>
        (await page.locator('.ws .msg.out .photo-cell.is-ready:not(.is-going)').count()) === 2,
      30_000,
      'both photos in the bubble',
    );
  });

  it('sends one photo with a follow-up, with no words', async () => {
    await ask('follow', {
      question: 'Ship the sidebar rename?',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Ship it' },
        { id: 'no', label: 'Hold' },
      ],
    });
    await open(page, 'follow');
    await page
      .getByRole('radio', { name: /Ship it/ })
      .first()
      .check();
    await page.locator('.dock').getByRole('button', { name: 'Send decision' }).click();
    await page
      .locator('.dock textarea[placeholder="Add a follow-up"]')
      .waitFor({ timeout: 20_000 });
    await choose(page, [files.whiteboard!]);
    await tray(page, 1);
    await page.locator('.dock').getByRole('button', { name: 'Send follow-up' }).click();
    await delivered(ids.follow!, 1);
    expect(photos.forQuestion(ids.follow!)[0]!.carrier.kind).toBe('message');
  });

  it('removes a photo before sending, with Undo, and sends only what is left', async () => {
    await ask('remove', { question: 'Which shelf is it on?', kind: 'text', options: [] });
    await open(page, 'remove');
    await choose(page, [files.proof!, files.screenshot!]);
    await tray(page, 2);
    await page.locator('.dock').getByRole('button', { name: 'Remove photo 2 of 2' }).click();
    await tray(page, 1);
    await page.locator('.dock .composer-lane', { hasText: 'Photo removed' }).waitFor();
    await page.locator('.dock .composer-lane').getByRole('button', { name: 'Undo' }).click();
    await tray(page, 2);
    await page.locator('.dock').getByRole('button', { name: 'Remove photo 1 of 2' }).click();
    await tray(page, 1);
    await field(page).fill('Top shelf.');
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await delivered(ids.remove!, 1);
    await page.waitForTimeout(500);
    expect(photos.forQuestion(ids.remove!)).toHaveLength(1);
    expect(photos.forQuestion(ids.remove!)[0]!.mime).toBe('image/png');
  });

  it('takes four photos at most, and says what did not fit', async () => {
    await ask('limit', { question: 'Show me every side of the box.', kind: 'text', options: [] });
    await open(page, 'limit');
    await choose(page, [
      files.proof!,
      files.screenshot!,
      files.router!,
      files.whiteboard!,
      files.proof!,
      files.router!,
    ]);
    await tray(page, 4);
    await page
      .locator('.dock .composer-lane', { hasText: 'Up to 4 photos per answer. 2 weren’t added.' })
      .waitFor();
    // `+` stays where it is and says why rather than opening anything.
    const plus = page.locator('.dock').getByRole('button', { name: 'Add photos' });
    expect(await plus.getAttribute('aria-disabled')).toBe('true');
    await page.locator('.dock .composer-lane').getByRole('button', { name: 'Dismiss' }).click();
    await plus.click();
    await page.locator('.dock .composer-lane', { hasText: 'Up to 4 photos per answer.' }).waitFor();
    expect(await page.locator('dialog.attach-sheet[open]').count()).toBe(0);
  });

  it('queues photos offline with their answer, and sends them on reconnect', async () => {
    await ask('offline', { question: 'Which layout did they sign?', kind: 'text', options: [] });
    await open(page, 'offline');
    await context.setOffline(true);
    await choose(page, [files.proof!]);
    await tray(page, 1);
    await field(page).fill('The two-column one.');
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await page
      .locator('.ws .msg.out .receipt')
      .filter({ hasText: /Queued/ })
      .waitFor({ timeout: 15_000 });
    // The words and the photo wait on this device, sealed: nothing has reached the relay.
    expect(photos.forQuestion(ids.offline!)).toHaveLength(0);
    expect(await page.locator('.ws .msg.out', { hasText: 'The two-column one.' }).count()).toBe(1);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await delivered(ids.offline!, 1);
  });

  it('keeps the words through a failed upload, and sends on Try again', async () => {
    await ask('retry', {
      question: 'What does the decline screen say?',
      kind: 'text',
      options: [],
    });
    await open(page, 'retry');
    let failing = true;
    await context.route('**/api/v1/attachments/*/content', async (route) => {
      if (route.request().method() === 'PUT' && failing) await route.abort('connectionreset');
      else await route.continue();
    });
    await choose(page, [files.screenshot!]);
    await tray(page, 1);
    await field(page).fill('Error 402 after tapping Pay.');
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    const bubble = page.locator('.ws .msg.out', { hasText: 'Error 402 after tapping Pay.' });
    await bubble.getByRole('button', { name: 'Try again' }).waitFor({ timeout: 30_000 });
    await bubble.getByText(/The upload stopped\. Your answer is saved on this device/).waitFor();
    expect(photos.forQuestion(ids.retry!)).toHaveLength(0);
    failing = false;
    await context.unroute('**/api/v1/attachments/*/content');
    await bubble.getByRole('button', { name: 'Try again' }).click();
    await delivered(ids.retry!, 1);
    await until(
      async () => {
        await bridge.pump();
        return sink.typed.some((t) => t.includes('Error 402 after tapping Pay.'));
      },
      30_000,
      'the words typed after the retry',
    );
  });

  it('strips a camera’s location from the photo, and uploads only ciphertext', async () => {
    const tagged = withGpsExif(files.whiteboard!.buffer);
    expect(hasExif(tagged)).toBe(true);
    await ask('exif', { question: 'Where was this taken?', kind: 'text', options: [] });
    await open(page, 'exif');
    const before = uploads.length;
    await choose(page, [{ name: 'IMG_5001.JPG', mimeType: 'image/jpeg', buffer: tagged }]);
    await tray(page, 1);
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await delivered(ids.exif!, 1);
    const plain = photos.forQuestion(ids.exif!)[0]!;
    // What reached the agent is the picture alone: no EXIF segment, no GPS, still a JPEG.
    expect(plain.mime).toBe('image/jpeg');
    expect(hasExif(plain.bytes)).toBe(false);
    expect(Buffer.from(plain.bytes).includes(Buffer.from(GPS_MARKER))).toBe(false);
    // And what the relay was sent is ciphertext: not a JPEG, and not the photo's bytes.
    const sent = uploads.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    for (const body of sent) {
      expect(body[0] === 0xff && body[1] === 0xd8).toBe(false);
      expect(body.includes(Buffer.from(plain.bytes.subarray(0, 64)))).toBe(false);
      expect(body.length).toBe(plain.bytes.length + 16);
    }
  });

  it('opens the chooser straight from `+` on a desktop with no camera', async () => {
    await ask('desk', {
      question: 'Attach the screenshot from your desktop.',
      kind: 'text',
      options: [],
    });
    const desk = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const dp = await desk.newPage();
    try {
      await pair(dp, 'tablet');
      await open(dp, 'desk');
      const plus = dp.locator('.dock').getByRole('button', { name: 'Add photos' });
      expect(await plus.getAttribute('aria-haspopup')).toBeNull();
      const [chooser] = await Promise.all([dp.waitForEvent('filechooser'), plus.click()]);
      expect(await dp.locator('dialog.attach-sheet').count()).toBe(0);
      expect(chooser.isMultiple()).toBe(true);
      await chooser.setFiles([files.screenshot!]);
      await until(
        async () => (await dp.locator('.dock .tray-photo.is-ready').count()) === 1,
        30_000,
        'the desktop photo ready',
      );
      await dp.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
      await delivered(ids.desk!, 1);
    } finally {
      await desk.close();
    }
  });
});
