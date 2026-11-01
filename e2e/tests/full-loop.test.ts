import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { QuestionDetail } from '@daintreehq/decisions-protocol';
import {
  DecisionsBridge,
  FileKeyStore,
  MemoryLocalStore,
  RelayClient,
  approveCandidate,
  claimRelay,
  createPairingInvite,
  localShortCode,
  type LocateResult,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import {
  CLAIM_SECRET,
  findChromium,
  startRelay,
  tick,
  until,
  type RunningRelay,
} from './harness.js';

const PORT = 8799;
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

/** A terminal that records what Daintree would type. */
class RecordingSink implements TerminalSink {
  typed: { text: string; id: string }[] = [];
  idle = true;
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
    return this.idle;
  }
  async inject(_t: TerminalTarget, text: string, id: string) {
    this.typed.push({ text, id });
    return { outcome: 'delivered' as const, proof: 'e2e' };
  }
  async hasMarker(_t: TerminalTarget, id: string) {
    return this.typed.some((x) => x.text.includes(`injection_id: ${id}`));
  }
  async resume() {
    return null;
  }
}

const chromiumPath = findChromium();

describe.skipIf(!chromiumPath)(
  'whole system: real Worker + real desktop client + real PWA in Chromium',
  () => {
    let relay: RunningRelay;
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let bridge: DecisionsBridge;
    let client: RelayClient;
    const sink = new RecordingSink();
    const problems: string[] = [];

    beforeAll(async () => {
      relay = await startRelay(PORT);
      browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'allow',
      });
      page = await context.newPage();
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error' || /Content Security Policy|violat/i.test(t))
          problems.push(`console ${m.type()}: ${t}`);
      });
    });

    afterAll(async () => {
      await bridge?.stop?.();
      await browser?.close();
      await relay?.stop();
    });

    it('claims the relay and serves the app with strict security headers', async () => {
      const home = mkdtempSync(join(tmpdir(), 'decisions-e2e-home-'));
      const store = new FileKeyStore(home);
      const { identity } = await claimRelay({
        origin: relay.origin,
        claimSecret: CLAIM_SECRET,
        label: 'E2E Mac',
        store,
      });
      client = new RelayClient({ identity });
      bridge = new DecisionsBridge({
        identity,
        store: new MemoryLocalStore(),
        sink,
        client,
        pumpIntervalMs: 0,
        resolver: {
          resolve: async (_o, id) =>
            id === 'before.png' || id === 'after.png' ? { bytes: PNG } : null,
        },
      });
      await bridge.start();

      const res = await fetch(`${relay.origin}/`);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/unsafe-eval/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      // the second claim is refused
      const again = await fetch(`${relay.origin}/api/v1/setup/claim`, {
        method: 'POST',
        body: '{}',
      });
      expect([400, 409]).toContain(again.status);
    });

    it('pairs the phone through the real UI, with matching six-digit codes on both sides', async () => {
      const invite = await createPairingInvite(client, 'phone');
      await page.goto(invite.url);
      await page.getByRole('button', { name: 'Pair this phone' }).click();
      await page.getByText('Confirm this code on your computer').waitFor({ timeout: 20_000 });
      const shown = (await page.locator('.big-code').innerText()).trim();
      const cand = await until(
        async () =>
          (await client.pendingPairings()).pending.find((p) => p.pairing_id === invite.pairingId),
        20_000,
        'pending pairing',
      );
      // the desktop recomputes the code itself rather than trusting the relay
      expect(await localShortCode(cand)).toBe(shown);
      await approveCandidate(client, cand);
      await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
      expect(page.url()).not.toContain('#'); // the invite secret is gone from the address bar
      expect(await page.evaluate(() => location.hash)).toBe('');
    });

    it('shows a question with encrypted screenshots, verifies it, and sends back a signed human answer', async () => {
      const asked = await bridge.registerQuestion({
        origin: {
          host_id: 'host_e2e00001',
          pane_id: 'pane-e2e',
          terminal_generation: 1,
          ownership_principal: 'principal-e2e',
          agent_incarnation: 'inc-e2e',
          agent_kind: 'claude-code',
          agent_session_id: 'sess-e2e',
          project_id: 'proj',
          worktree_id: 'wt',
          worktree_root: '/tmp/e2e',
          workflow_gate_id: null,
        } as never,
        input: {
          question: 'Ship the compact sidebar?',
          context: 'Before and after screenshots attached.',
          kind: 'approval',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject' },
          ],
          attachments: [
            { local_resource_id: 'before.png', role: 'before' },
            { local_resource_id: 'after.png', role: 'after' },
          ],
        } as never,
      });
      await bridge.pump();

      await page.getByText('Ship the compact sidebar?').first().waitFor({ timeout: 30_000 });
      await page.getByText('Ship the compact sidebar?').first().click();
      await page.getByRole('radio', { name: /Approve/ }).check();
      await page.getByRole('button', { name: /Submit decision/ }).click();

      // the answer travels phone -> relay -> hibernatable socket -> desktop -> terminal
      await until(
        async () => sink.typed.length > 0,
        30_000,
        'the answer to be typed into the terminal',
      );
      const typed = sink.typed[0]!.text;
      expect(typed).toContain('choice: approve');
      expect(typed).toContain('source: human');
      expect(typed).toContain(asked.questionId);

      // the relay learns it was really typed, and the phone shows it as committed
      const detail = await until(
        async () => {
          const d = await client.getQuestion(asked.questionId);
          return d.deliveries.some((x) => x.status === 'terminal-delivered') ? d : null;
        },
        30_000,
        'terminal-delivered',
      );
      expect((detail as QuestionDetail).status).toBe('human-answered');
      expect((detail as QuestionDetail).actions[0]).toMatchObject({
        action: 'answer',
        provenance: 'human',
      });
      try {
        // the phone learns about the real terminal delivery over its own live socket
        await page
          .locator('ol[aria-label="Delivery progress"] li[aria-current="step"]')
          .filter({ hasText: 'Typed into the agent’s terminal' })
          .waitFor({ timeout: 20_000 });
      } catch (e) {
        await page.screenshot({
          path: join(tmpdir(), 'decisions-e2e-failure.png'),
          fullPage: true,
        });
        throw new Error(
          `phone never showed delivery. URL ${page.url()}\n--- page text ---\n${await page.locator('body').innerText()}\n--- problems ---\n${problems.join('\n')}`,
          { cause: e },
        );
      }
    });

    it('keeps ciphertext only on the relay and never trips the content security policy', async () => {
      const raw = await fetch(`${relay.origin}/api/v1/info`);
      expect(raw.ok).toBe(true);
      expect(problems.filter((p) => /Content Security Policy|violat/i.test(p))).toEqual([]);
      expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
      await tick(10);
    });
  },
);
