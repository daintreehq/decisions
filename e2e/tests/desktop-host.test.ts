import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  DecisionsBridge,
  FileKeyStore,
  MemoryLocalStore,
  MemoryPendingHostStore,
  RelayClient,
  acceptHostEnrollment,
  approveCandidate,
  claimRelay,
  createHostRequest,
  createPairingInvite,
  enrollHost,
  rotateEpoch,
  type Identity,
  type LocateResult,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

const PORT = 8805;

/** A terminal that records what Daintree would type. */
class RecordingSink implements TerminalSink {
  typed: { text: string; id: string }[] = [];
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

const paneOrigin = (hostId: string, paneId: string): QuestionOrigin => ({
  host_id: hostId,
  pane_id: paneId,
  terminal_generation: 1,
  ownership_principal: `principal-${paneId}`,
  agent_incarnation: `inc-${paneId}`,
  agent_kind: 'claude-code',
  agent_session_id: `sess-${paneId}`,
  project_id: 'proj',
  worktree_id: 'wt',
  worktree_root: '/tmp/e2e',
  workflow_gate_id: null,
});

const OPTIONS = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];

const chromiumPath = findChromium();

describe.skipIf(!chromiumPath)(
  'an enrolled desktop-host runs the bridge: real Worker, owner, Host and the PWA in Chromium',
  () => {
    let relay: RunningRelay;
    let browser: Browser;
    let page: Page;
    let owner: {
      identity: Identity;
      client: RelayClient;
      store: FileKeyStore;
      bridge: DecisionsBridge;
    };
    let host: {
      identity: Identity;
      client: RelayClient;
      store: FileKeyStore;
      bridge: DecisionsBridge;
    };
    const ownerSink = new RecordingSink();
    const hostSink = new RecordingSink();
    const tmp = mkdtempSync(join(tmpdir(), 'decisions-e2e-desktop-host-'));
    const problems: string[] = [];

    beforeAll(async () => {
      relay = await startRelay(PORT);
      browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'allow',
      });
      page = await context.newPage();
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    });

    afterAll(async () => {
      await owner?.bridge.stop();
      await host?.bridge.stop();
      await browser?.close();
      await relay?.stop();
      rmSync(tmp, { recursive: true, force: true });
    });

    /** Open a question in the phone's inbox, pick an option and send the signed human answer. */
    async function answerOnPhone(question: string, choice: RegExp): Promise<void> {
      await page.goto(relay.origin + '/');
      const item = page.getByText(question).first();
      await item.waitFor({ timeout: 30_000 });
      await item.click();
      await page.getByRole('radio', { name: choice }).first().check();
      await page.getByRole('button', { name: /^Send (decision|answer)$/ }).click();
    }

    const terminalDelivered = (client: RelayClient, questionId: string) =>
      until(
        async () => {
          const d = await client.getQuestion(questionId);
          return d.deliveries.some((x) => x.status === 'terminal-delivered') ? d : null;
        },
        30_000,
        `terminal delivery of ${questionId}`,
      );

    it('claims the relay, enrolls a Host and pairs a phone', async () => {
      const ownerStore = new FileKeyStore(join(tmp, 'owner'));
      const { identity } = await claimRelay({
        origin: relay.origin,
        claimSecret: CLAIM_SECRET,
        label: 'Owner Mac',
        store: ownerStore,
      });
      const ownerClient = new RelayClient({ identity });

      // Host: its own keys and a request. Owner: certificate and sealed grant. Host: verify and store.
      const hostStore = new FileKeyStore(join(tmp, 'host'));
      const pending = new MemoryPendingHostStore();
      const req = await createHostRequest({ pending, keyStore: hostStore, label: 'Build box' });
      const out = await enrollHost(ownerClient, req.request);
      const hostIdentity = await acceptHostEnrollment({
        response: out.response,
        pending,
        keyStore: hostStore,
      });
      expect(hostIdentity.role).toBe('desktop-host');
      expect(hostIdentity.owner.signingPub).toBe(identity.signingPub);

      // Both run the bridge with their own identity and key store, connected over the live socket.
      const mk = (id: Identity, store: FileKeyStore, sink: RecordingSink) => {
        const client = new RelayClient({ identity: id });
        const bridge = new DecisionsBridge({
          identity: id,
          keyStore: store,
          store: new MemoryLocalStore(),
          sink,
          client,
          pumpIntervalMs: 0,
        });
        return { identity: id, client, store, bridge };
      };
      owner = mk(identity, ownerStore, ownerSink);
      host = mk(hostIdentity, hostStore, hostSink);
      await owner.bridge.start();
      await host.bridge.start();

      const invite = await createPairingInvite(owner.client, 'phone');
      await page.goto(invite.url);
      await page.getByRole('button', { name: 'Pair this device' }).click();
      await page.getByText('Check that this matches your computer').waitFor({ timeout: 20_000 });
      const cand = await until(
        async () =>
          (await owner.client.pendingPairings()).pending.find(
            (p) => p.pairing_id === invite.pairingId,
          ),
        20_000,
        'pending pairing',
      );
      await approveCandidate(owner.client, cand);
      await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
    });

    it("delivers the owner's answer on the owner only, and the Host's answer on the Host only", async () => {
      const ownerQ = await owner.bridge.registerQuestion({
        origin: paneOrigin('host_owner01', 'pane-owner'),
        input: { question: 'Owner: merge the release branch?', options: OPTIONS },
      });
      const hostQ = await host.bridge.registerQuestion({
        origin: paneOrigin('host_remote1', 'pane-host'),
        input: { question: 'Host: deploy the build box?', options: OPTIONS },
      });
      await owner.bridge.pump();
      await host.bridge.pump();
      const created = await host.client.getQuestion(hostQ.questionId);
      expect(created.question.record.originating_device_id).toBe(host.identity.config.deviceId);

      await answerOnPhone('Owner: merge the release branch?', /Approve/);
      await terminalDelivered(owner.client, ownerQ.questionId);
      await answerOnPhone('Host: deploy the build box?', /Reject/);
      await terminalDelivered(host.client, hostQ.questionId);

      await until(async () => hostSink.typed.length > 0, 30_000, 'the Host to type its answer');
      expect(hostSink.typed).toHaveLength(1);
      expect(hostSink.typed[0]!.text).toContain(hostQ.questionId);
      expect(hostSink.typed[0]!.text).toContain('choice: reject');
      expect(hostSink.typed[0]!.text).toContain('source: human');
      expect(ownerSink.typed).toHaveLength(1);
      expect(ownerSink.typed[0]!.text).toContain(ownerQ.questionId);

      // Each device stored every event (its cursor reached the relay's high water) but acted only on its own.
      const high = (await host.client.events(0, 1)).high_water_seq;
      await until(
        async () =>
          (await host.bridge.ctx.store.getCursor()) >= high &&
          (await owner.bridge.ctx.store.getCursor()) >= high,
        20_000,
        'both cursors to reach the high water',
      );
      expect(await host.bridge.ctx.store.getQuestion(ownerQ.questionId)).toBeNull();
      expect(await owner.bridge.ctx.store.getQuestion(hostQ.questionId)).toBeNull();
    });

    it('after a rotation the Host fetches its sealed grant and keeps delivering', async () => {
      await rotateEpoch(owner.client, owner.store);
      // The Host learns of it from the ledger and opens the grant the owner sealed to it.
      await until(
        async () => host.bridge.ctx.identity.currentEpoch === 2,
        30_000,
        'the Host to pick up epoch 2',
      );
      const stored = await host.store.load();
      expect(stored!.epochs.map((e) => e.epoch)).toEqual([1, 2]);
      const ownerNow = await owner.store.load();
      expect(stored!.epochs.find((e) => e.epoch === 2)!.raw).toBe(
        ownerNow!.epochs.find((e) => e.epoch === 2)!.raw,
      );

      const asked = await host.bridge.registerQuestion({
        origin: paneOrigin('host_remote1', 'pane-host-2'),
        input: { question: 'Host: ship after the rotation?', options: OPTIONS },
      });
      await host.bridge.pump();
      const detail = await host.client.getQuestion(asked.questionId);
      expect(detail.question.record.key_epoch).toBe(2);
      expect(detail.question.envelope.key_epoch).toBe(2);

      await answerOnPhone('Host: ship after the rotation?', /Approve/);
      await terminalDelivered(host.client, asked.questionId);
      const typed = await until(
        async () => hostSink.typed.find((t) => t.text.includes(asked.questionId)),
        30_000,
        'the Host to type the answer sent under the new epoch',
      );
      expect(typed.text).toContain('choice: approve');
      expect(ownerSink.typed).toHaveLength(1);
      expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
    });
  },
);
