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
  currentEpochKey,
  paneIdentityOf,
  type Identity,
  type LocateResult,
  type ProxyEngine,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { buildSignedMessage, encryptEnvelope, newId, nowIso } from '@daintreehq/decisions-crypto';
import {
  API_PREFIX,
  MESSAGE_RECORD_TYPE,
  MessageBody,
  PROTOCOL_VERSION,
} from '@daintreehq/decisions-protocol';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Captures a question's thread after it is answered, for design review: follow-ups from the phone with their receipts,
 * the agent's messages (one waiting on a reply), the follow-up composer, a follow-up queued offline, one that needs
 * attention, Home and the sidebar showing a question that needs a reply, a model answer (Confirm and Overrule), and
 * a thread mixing the person's follow-ups from the phone and from the computer with the agent's:
 *   pnpm build && DESIGN_CAPTURE_DIR=/some/dir pnpm --filter @daintreehq/decisions-e2e test follow-ups-capture
 * Skipped unless DESIGN_CAPTURE_DIR is set. Everything goes through the real seams: a real relay, the real desktop
 * bridge with follow-ups on (it types them into the sink and posts the agent's messages), and the PWA paired through
 * its own UI. Each capture checks what it claims to show before it writes, and the run fails if any file is missing.
 */
const OUT = process.env.DESIGN_CAPTURE_DIR;
const chromiumPath = findChromium();
const PORT = Number(process.env.FOLLOW_UPS_CAPTURE_PORT ?? 8851);
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 820 };

/**
 * Pane p3's host is offline (what reaches it waits on the computer). A pane in `gone` has closed: what reaches it
 * needs attention. Pane p5 closes after its answer is typed, so a later follow-up is the one that needs attention.
 */
class Sink implements TerminalSink {
  typed: { pane: string; text: string }[] = [];
  gone = new Set<string>();
  async locate(o: QuestionOrigin): Promise<LocateResult> {
    if (o.pane_id === 'p3') return { state: 'host-offline' };
    if (this.gone.has(o.pane_id)) return { state: 'gone' };
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
  async inject(t: TerminalTarget, text: string, _id: string) {
    this.typed.push({ pane: t.paneId, text });
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
        'You filed the last three behaviour changes that were not bug fixes under “Changed”.',
      risk_flags: [],
    };
  },
};

describe.skipIf(!OUT || !chromiumPath)('captures of follow-ups in a question thread', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bridge: DecisionsBridge;
  let client: RelayClient;
  let identity: Identity;
  const sink = new Sink();
  const local = new MemoryLocalStore();
  const written: string[] = [];
  const ids: Record<string, string> = {};
  const origins: Record<string, QuestionOrigin> = {};

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
  const sees = async (text: string | RegExp) => {
    await page.locator('.ws').getByText(text).first().waitFor({ timeout: 30_000 });
  };
  const field = () => page.locator('.dock .composer-field textarea');
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  /** Scrolls the thread to its end, where the latest messages are. */
  const toEnd = async () => {
    await page.evaluate(() => {
      const b = document.querySelector('.ws-body');
      if (b) b.scrollTop = b.scrollHeight;
    });
    await settle(400);
  };
  const sendFollowUp = async (text: string) => {
    await field().fill(text);
    await blur();
    await page
      .locator('.dock')
      .getByRole('button', { name: /^Send (follow-up|reply)$/ })
      .click({ timeout: 15_000 });
    // The bubble in the thread, saved on the relay (the field's own text would match too early).
    await page
      .locator('.ws .msg.out', { hasText: text })
      .locator('.receipt')
      .filter({ hasNotText: /Queued|Sending/ })
      .first()
      .waitFor({ timeout: 15_000 });
  };
  const agentSays = async (key: string, text: string, expectsReply: boolean) => {
    await bridge.postMessage(
      { question_id: ids[key], text, expects_reply: expectsReply },
      paneIdentityOf(origins[key]!),
    );
    await bridge.pump();
  };
  /**
   * The person's follow-up sent on the computer: the owner desktop signs a human message for them (docs/protocol.md
   * section 16). The desktop library cannot send one yet, so this seals and signs it with the same crypto it uses for
   * the agent's messages. The relay takes one only once the asking desktop (this bridge, the owner) has declared
   * `owner-desktop-messages-v1`; the declaration goes back to the bridge's own once it is committed. The bridge does
   * not accept the message yet either, so it is never typed: its receipt stays at the relay.
   */
  const computerSays = async (key: string, text: string) => {
    const questionId = ids[key]!;
    const at = Date.now();
    const messageId = newId(at);
    const envelope = await encryptEnvelope({
      epochKey: currentEpochKey(identity),
      installationId: identity.config.installationId,
      questionId,
      recordId: messageId,
      recordType: MESSAGE_RECORD_TYPE,
      revision: 0,
      senderDeviceId: identity.config.deviceId,
      purpose: 'message-content',
      plaintext: { content_version: 1, side: 'human', text, images: [] },
    });
    const message = await buildSignedMessage({
      installationId: identity.config.installationId,
      questionId,
      messageId,
      side: 'human',
      signerDeviceId: identity.config.deviceId,
      signingKey: identity.keys.signing.privateKey,
      envelope,
      createdAt: nowIso(at),
    });
    await client.socketTicket([...bridge.features, 'owner-desktop-messages-v1']);
    try {
      await client.request('POST', `${API_PREFIX}/questions/${questionId}/messages`, {
        body: MessageBody.parse({
          protocol_version: PROTOCOL_VERSION,
          idempotency_key: newId(),
          message,
        }),
      });
    } finally {
      await client.socketTicket(bridge.features);
    }
    await bridge.pump();
  };

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
    // A render error is a broken capture, not a state: say what it was.
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

  it('pairs, asks and answers, and builds threads in both directions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'decisions-follow-ups-'));
    const keyStore = new FileKeyStore(home);
    ({ identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'Greg’s MacBook Pro',
      store: keyStore,
    }));
    client = new RelayClient({ identity });
    bridge = new DecisionsBridge({
      identity,
      keyStore,
      store: local,
      sink,
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
      origins[key] = o;
    };

    await ask('thread', origin('p1', 'daintree'), {
      question: 'Rename “Canopy” to “Inbox” in the sidebar?',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Yes, rename' },
        { id: 'no', label: 'Keep Canopy' },
      ],
    });
    await ask('asking', origin('p2', 'billing-api', 'codex'), {
      question: 'Which retry limit should the webhook sender use?',
      kind: 'choice',
      options: [
        { id: '3', label: '3 attempts' },
        { id: '5', label: '5 attempts' },
        { id: '8', label: '8 attempts' },
      ],
    });
    await ask('held', origin('p3', 'customer-onboarding-service', 'gemini'), {
      question: 'Which version should the migration guide describe?',
      kind: 'text',
      options: [],
    });
    await ask('gone', origin('p5', 'billing-api'), {
      question: 'Merge the webhook retry branch into main now that CI is green?',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Merge it' },
        { id: 'no', label: 'Hold for review' },
      ],
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
    await ask('fresh', origin('p7', 'docs-site'), {
      question: 'Publish the draft release notes to the docs site now?',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Publish' },
        { id: 'no', label: 'Not yet' },
      ],
    });
    await ask('mixed', origin('p8', 'daintree'), {
      question: 'Run the staging database migration before tonight’s deploy?',
      kind: 'approval',
      options: [
        { id: 'yes', label: 'Run it' },
        { id: 'no', label: 'Wait until tomorrow' },
      ],
    });
    await bridge.pump();
    expect(await bridge.runProxy(ids.proxy!)).toBe('answered');
    await bridge.pump();
    await go('/');
    await page.getByText('Rename “Canopy” to “Inbox”').first().waitFor({ timeout: 30_000 });

    // The thread: an answer, two follow-ups, and the agent's reply (which asks nothing).
    await openId('thread');
    await page
      .getByRole('radio', { name: /Yes, rename/ })
      .first()
      .check();
    await field().fill('Inbox reads better in the sidebar.');
    await blur();
    await page.getByRole('button', { name: 'Send decision' }).click();
    await sees('Typed into the terminal');
    // Once the answer is on its way, the composer takes follow-ups.
    await page
      .locator('.dock textarea[placeholder="Add a follow-up"]')
      .waitFor({ timeout: 15_000 });
    await sendFollowUp('Also rename the route from /canopy to /inbox, with a redirect.');
    await sendFollowUp('And update the screenshot in the docs.');
    await until(
      async () => sink.typed.filter((t) => t.text.includes('FOLLOW-UP')).length >= 2,
      30_000,
      'both follow-ups typed',
    );
    await agentSays(
      'thread',
      'Done: the sidebar says Inbox, /canopy redirects to /inbox, and the docs screenshot is updated.',
      false,
    );

    // A question answered, then the agent asks something back.
    await openId('asking');
    await page
      .getByRole('radio', { name: /5 attempts/ })
      .first()
      .check();
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await sees('Typed into the terminal');
    await agentSays(
      'asking',
      'Should the 5 attempts back off exponentially (1 s, 2 s, 4 s…) or at a fixed 30 s interval?',
      true,
    );

    // A follow-up to a computer that is offline: received, never typed yet.
    await openId('held');
    await field().fill('Describe v3 only. Move the v2 steps to an appendix.');
    await blur();
    await page.locator('.dock').getByRole('button', { name: 'Send answer' }).click();
    await sees('Received by your computer');
    await sendFollowUp('Link the appendix from the intro too.');

    // The answer is typed, then the pane closes: the follow-up after it needs attention.
    await openId('gone');
    await page
      .getByRole('radio', { name: /Merge it/ })
      .first()
      .check();
    await page.locator('.dock').getByRole('button', { name: 'Send decision' }).click();
    await sees('Typed into the terminal');
    sink.gone.add('p5');
    await sendFollowUp('Squash the commits when you merge.');
    await page
      .locator('.ws .msg.out.flagged', { hasText: 'Squash the commits' })
      .waitFor({ timeout: 30_000 });

    // One thread, three voices: the person on the phone, the agent asking back, and the person replying on the
    // computer, which takes the question out of Needs you.
    await openId('mixed');
    await page
      .getByRole('radio', { name: /Run it/ })
      .first()
      .check();
    await page.locator('.dock').getByRole('button', { name: 'Send decision' }).click();
    await sees('Typed into the terminal');
    await sendFollowUp('Take a snapshot of the staging database first.');
    await until(
      async () => sink.typed.some((t) => t.text.includes('Take a snapshot')),
      30_000,
      'the phone follow-up typed',
    );
    await agentSays(
      'mixed',
      'Snapshot taken. Should I also pause the nightly import while the migration runs?',
      true,
    );
    await openId('mixed');
    await sees('Waiting for your reply');
    await computerSays('mixed', 'Yes, pause it, and turn it back on once the migration finishes.');
    await agentSays(
      'mixed',
      'Paused. I’ll turn the nightly import back on after the migration and let you know.',
      false,
    );
  });

  it('captures each state on a phone, in both themes', async () => {
    // The thread with an answer, two follow-ups and the agent's reply.
    await openId('thread');
    await sees('Done: the sidebar says Inbox');
    await until(
      async () => (await page.locator('.ws .msg.out .receipt').count()) >= 1,
      15_000,
      'receipts',
    );
    await toEnd();
    await shot('f-thread-light');
    await theme('dark');
    await toEnd();
    await shot('f-thread-dark');
    await theme('light');

    // The follow-up composer with words in it.
    await field().fill('One more thing: keep the old icon for now.');
    await blur();
    await page.locator('.dock').getByRole('button', { name: 'Send follow-up' }).waitFor();
    await shot('f-composer-typed-light');
    await field().fill('');
    await blur();

    // The More menu of an answered question: no Change answer.
    await page.locator('.ws-head').getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'View activity' }).waitFor();
    expect(await page.getByRole('menuitem', { name: /Change answer/ }).count()).toBe(0);
    await shot('f-menu-light');
    await page.keyboard.press('Escape');

    // The agent is waiting on a reply.
    await openId('asking');
    await sees('Waiting for your reply');
    await toEnd();
    await shot('f-asking-light');
    await theme('dark');
    await toEnd();
    await shot('f-asking-dark');
    await theme('light');

    // Home: the question is back in Needs you, with the agent's message as its line.
    await go('/');
    await page
      .locator('main a.qrow', { hasText: 'Which retry limit' })
      .getByText(/Codex:/)
      .waitFor({ timeout: 30_000 });
    await shot('f-home-light');
    await theme('dark');
    await shot('f-home-dark');
    await theme('light');

    // The sidebar's needs-you dot on it.
    await page.locator('.menu-fab').click();
    await page.locator('dialog.sidebar-sheet[open]').waitFor({ timeout: 10_000 });
    await page
      .locator('dialog.sidebar-sheet[open] .side-q', { hasText: 'Which retry limit' })
      .locator('.side-q-state .agent-state[data-tone="waiting"]')
      .waitFor({ timeout: 10_000 });
    await shot('f-sidebar-light');
    await page.keyboard.press('Escape');
    await settle(300);

    // Received by the computer, waiting to be typed.
    await openId('held');
    await page
      .locator('.ws .msg.out', { hasText: 'Link the appendix from the intro too.' })
      .waitFor({ timeout: 30_000 });
    await toEnd();
    await shot('f-held-light');

    // A follow-up that needs attention.
    await openId('gone');
    await page
      .locator('.ws .msg.out.flagged')
      .filter({ hasText: 'Squash the commits' })
      .waitFor({ timeout: 30_000 });
    await toEnd();
    await shot('f-attention-light');
    await theme('dark');
    await toEnd();
    await shot('f-attention-dark');
    await theme('light');

    // Offline: a follow-up queued on this device.
    await openId('thread');
    await context.setOffline(true);
    await page.waitForTimeout(500);
    await field().fill('Ship it behind the flag first.');
    await blur();
    await page.locator('.dock').getByRole('button', { name: 'Send follow-up' }).click();
    await page
      .locator('.ws .msg.out .receipt')
      .filter({ hasText: /Queued/ })
      .waitFor({ timeout: 15_000 });
    await toEnd();
    await shot('f-queued-offline-light');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page
      .locator('.ws .msg.out', { hasText: 'Ship it behind the flag first.' })
      .locator('.receipt')
      .filter({ hasText: /Saved on your relay|Received by your computer|Typed into the terminal/ })
      .waitFor({ timeout: 30_000 });

    // A model answer still to review: Confirm and Overrule, unchanged.
    await openId('proxy');
    await page
      .locator('.ws')
      .getByRole('button', { name: 'Overrule' })
      .waitFor({ timeout: 30_000 });
    await shot('f-model-review-light');

    // An open question: the composer still sends the answer.
    await openId('fresh');
    await page
      .getByRole('radio', { name: /Publish/ })
      .first()
      .waitFor({ timeout: 30_000 });
    await shot('f-open-light');
  });

  it('captures a thread mixing phone, computer and agent follow-ups', async () => {
    await openId('mixed');
    await sees('Paused. I’ll turn the nightly import back on');
    const labels = () => page.locator('.ws .msg.out .bubble-label').allTextContents();
    await until(
      async () => (await labels()).includes('Follow-up on Greg’s MacBook Pro'),
      15_000,
      'the follow-up from the computer, as the person’s',
    );
    // Each voice as itself: the answer and a follow-up from the phone, one from the computer, the agent's twice.
    expect(await labels()).toEqual(['Your answer', 'Follow-up', 'Follow-up on Greg’s MacBook Pro']);
    expect(await page.locator('.ws .msg.out', { hasText: 'Yes, pause it' }).count()).toBe(1);
    // Never shown as unverified, and the reply from the computer answered the agent: no longer waiting on the person.
    expect(await page.locator('.ws').getByText('could not be verified').count()).toBe(0);
    expect(await page.locator('.ws').getByText('Waiting for your reply').count()).toBe(0);
    await page
      .locator('.dock textarea[placeholder="Add a follow-up"]')
      .waitFor({ timeout: 15_000 });
    await toEnd();
    await shot('f-mixed-light');
    await theme('dark');
    await toEnd();
    await shot('f-mixed-dark');
    await theme('light');

    // Its receipt starts at the relay: it never passed through a phone.
    const computerReceipt = page
      .locator('.ws .msg.out', { hasText: 'Yes, pause it' })
      .locator('.receipt-button');
    await computerReceipt.click();
    const steps = await page
      .locator('.ws .msg.out', { hasText: 'Yes, pause it' })
      .locator('.stepper li')
      .allTextContents();
    expect(steps[0]).toMatch(/^Saved on your relay/);
    expect(steps.some((s) => s.startsWith('Queued on this device'))).toBe(false);
    await toEnd();
    await shot('f-mixed-receipt-light');
    await computerReceipt.click();

    // The activity names where each follow-up came from.
    await page.locator('.ws-head').getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'View activity' }).click();
    await page
      .getByText('You sent a follow-up on Greg’s MacBook Pro')
      .first()
      .waitFor({ timeout: 15_000 });
    await page.getByText('You sent a follow-up', { exact: true }).first().waitFor();
    await shot('f-mixed-activity-light');
    await page.keyboard.press('Escape');
    await settle(300);

    // Home: answered and replied to, so it is not in Needs you.
    await go('/');
    await page
      .locator('main a.qrow', { hasText: 'Run the staging database migration' })
      .waitFor({ timeout: 30_000 });
    expect(
      await page
        .locator('main section[data-section="needs"] a.qrow', {
          hasText: 'Run the staging database migration',
        })
        .count(),
    ).toBe(0);
    await shot('f-mixed-home-light');

    await page.setViewportSize(WIDE);
    await openId('mixed');
    await sees('Paused. I’ll turn the nightly import back on');
    await toEnd();
    await shot('w-mixed-light');
    await page.setViewportSize(PHONE);
  });

  it('captures the wide layout', async () => {
    await page.setViewportSize(WIDE);
    await openId('thread');
    await sees('Done: the sidebar says Inbox');
    await toEnd();
    await shot('w-thread-light');
    await theme('dark');
    await openId('asking');
    await sees('Waiting for your reply');
    await toEnd();
    await shot('w-asking-dark');
    await theme('light');
    await page.setViewportSize(PHONE);

    const expected = [
      'f-thread-light',
      'f-thread-dark',
      'f-composer-typed-light',
      'f-menu-light',
      'f-asking-light',
      'f-asking-dark',
      'f-home-light',
      'f-home-dark',
      'f-sidebar-light',
      'f-held-light',
      'f-attention-light',
      'f-attention-dark',
      'f-queued-offline-light',
      'f-model-review-light',
      'f-open-light',
      'f-mixed-light',
      'f-mixed-dark',
      'f-mixed-receipt-light',
      'f-mixed-activity-light',
      'f-mixed-home-light',
      'w-mixed-light',
      'w-thread-light',
      'w-asking-dark',
    ];
    const missing = expected.filter((n) => !existsSync(join(OUT!, `${n}.png`)));
    expect(missing).toEqual([]);
    expect(written.length).toBe(expected.length);
  });
});
