import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type WebSocketRoute } from 'playwright-core';
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

const PORT = 8811;
const chromiumPath = findChromium();
/** Questions asked before the phone's socket reaches the relay; at least one more follows, pushed live. */
const BEFORE = 13;

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
    return { outcome: 'delivered' as const, proof: 'e2e' };
  }
  async hasMarker() {
    return false;
  }
  async resume() {
    return null;
  }
}

const origin = (pane: string): QuestionOrigin => ({
  machine_label: 'E2E Mac',
  host_id: 'host_e2e',
  pane_id: pane,
  terminal_generation: 1,
  ownership_principal: `principal-${pane}`,
  agent_incarnation: '1',
  agent_kind: 'claude-code',
  agent_session_id: `s-${pane}`,
  project_id: 'daintree',
  worktree_id: `wt-${pane}`,
  worktree_root: '/work/daintree',
  workflow_gate_id: null,
});

const text = (i: number) => `Question ${i + 1} of the burst: approve the change?`;

/** A ledger event frame the relay sent the phone, and whether the phone's first `sync` had reached the relay. */
interface Seen {
  seq: number;
  type: string;
  questionId: string | null;
  afterSync: boolean;
}

describe.skipIf(!chromiumPath)('a phone that has just paired keeps every question', () => {
  let relay: RunningRelay;
  let browser: Browser;
  let page: Page;
  let bridge: DecisionsBridge;
  const ids: string[] = [];
  const seen: Seen[] = [];
  /** What the gate in front of the phone saw: its sockets, and the first `sync` it held. */
  const gate = { sockets: 0, held: null as { after: number; text: string } | null };

  /** The question rows on the page itself (the sidebar holds some of the same questions). */
  const shownIds = () =>
    page
      .locator('main .navigator[data-presentation="page"] a.qrow[data-row-id]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-row-id')!));
  /** Waits until every question is listed, taking any held behind "N new questions" the way a person would. */
  const showsEvery = async (what: string) => {
    let shown = new Set<string>();
    try {
      await until(
        async () => {
          const pill = page.locator('main .nav-new');
          if (await pill.isVisible().catch(() => false)) await pill.click();
          shown = new Set(await shownIds());
          return ids.every((id) => shown.has(id));
        },
        30_000,
        what,
      );
    } catch (e) {
      const missing = ids.filter((id) => !shown.has(id)).length;
      throw new Error(`${what}: the phone lists ${ids.length - missing} of ${ids.length}`, {
        cause: e,
      });
    }
  };

  beforeAll(async () => {
    relay = await startRelay(PORT);
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    // No service worker: every request the phone makes goes through the routes below.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block',
    });
    page = await context.newPage();

    // Stand between the phone and the relay. The phone asks for its first socket ticket once its first HTTP catch-up
    // is done; that request waits until the questions asked meanwhile are on the relay, so they can reach the phone
    // only in its socket's replay. The socket then goes to the relay at once, but its first `sync` is held while a
    // later question is pushed to it live, ahead of that replay: the gap a phone otherwise hits by chance. Until the
    // `sync` goes, the phone cannot read the ledger over HTTP either, so the replay is its only way to those questions.
    let ticketAsked = false;
    let releaseTicket = () => {};
    const ticketReleased = new Promise<void>((r) => (releaseTicket = r));
    await page.route(/\/api\/v1\/socket-ticket/, async (route) => {
      if (!ticketAsked) {
        ticketAsked = true;
        await ticketReleased;
      }
      await route.continue();
    });
    let syncSent = false;
    await page.route(/\/api\/v1\/events/, (route) =>
      ticketAsked && !syncSent ? route.abort() : route.continue(),
    );
    let relaySide: WebSocketRoute | null = null;
    let hello = false;
    let releaseSync = () => {};
    await page.routeWebSocket(/\/api\/v1\/socket/, (phone) => {
      gate.sockets++;
      if (relaySide) {
        phone.connectToServer(); // any later socket goes straight through
        return;
      }
      const server = (relaySide = phone.connectToServer());
      releaseSync = () => server.send(gate.held!.text);
      phone.onMessage((m) => {
        if (!syncSent && !gate.held && typeof m === 'string' && m.startsWith('{')) {
          const f = JSON.parse(m) as { t: string; after?: number };
          if (f.t === 'sync') {
            gate.held = { after: f.after ?? -1, text: m };
            return;
          }
        }
        server.send(m);
      });
      server.onMessage((m) => {
        if (typeof m === 'string') {
          const f = JSON.parse(m) as {
            t: string;
            event?: { seq: number; event_type: string; question_id: string | null };
          };
          if (f.t === 'hello') hello = true;
          if (f.t === 'event' && f.event)
            seen.push({
              seq: f.event.seq,
              type: f.event.event_type,
              questionId: f.event.question_id,
              afterSync: syncSent,
            });
        }
        phone.send(m);
      });
    });

    const store = new FileKeyStore(mkdtempSync(join(tmpdir(), 'decisions-sync-replay-e2e-')));
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'E2E Mac',
      store,
    });
    const client = new RelayClient({ identity });
    bridge = new DecisionsBridge({
      identity,
      keyStore: store,
      store: new MemoryLocalStore(),
      sink: new Sink(),
      client,
      pumpIntervalMs: 0,
      resolver: { resolve: async () => null },
    });
    await bridge.start();
    const invite = await createPairingInvite(client, 'phone');
    await page.goto(invite.url);
    await page.getByRole('button', { name: 'Pair this device' }).click();
    const cand = await until(
      async () =>
        (await client.pendingPairings()).pending.find((p) => p.pairing_id === invite.pairingId),
      20_000,
      'pending pairing',
    );
    await approveCandidate(client, cand);
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });

    const ask = async (i: number) => {
      const r = await bridge.registerQuestion({
        origin: origin(`p${i}`),
        input: {
          question: text(i),
          kind: 'approval',
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
      });
      ids.push(r.questionId);
    };
    // `registerQuestion` starts a pump in the background and `pump()` hands back one already running, so pump until
    // the relay really holds the question.
    const published = (id: string) =>
      until(
        async () => {
          await bridge.pump();
          return client.getQuestion(id).then(
            () => true,
            () => false,
          );
        },
        30_000,
        `question ${id} on the relay`,
      );

    await until(async () => ticketAsked, 30_000, 'the phone to ask for a socket');
    for (let i = 0; i < BEFORE; i++) await ask(i);
    for (const id of ids) await published(id);
    releaseTicket();
    // The relay has registered the socket; the phone's `sync` stays held.
    await until(async () => hello && gate.held !== null, 30_000, "the phone's socket and sync");

    // The last question is pushed to the phone live, before the relay has handled its `sync`. One committed in the
    // first moments after the relay accepts the socket is not always pushed (the replay still carries it), so ask
    // until one is...
    for (let pushed = false; !pushed;) {
      if (ids.length >= BEFORE + 5) throw new Error('the relay never pushed a question live');
      await ask(ids.length);
      const id = ids.at(-1)!;
      await published(id);
      pushed = await until(
        async () => seen.some((s) => s.questionId === id && s.type === 'decision.created'),
        3_000,
        'a question pushed live',
      ).then(
        () => true,
        () => false,
      );
    }
    // ...and only then is the replay of everything before it sent.
    syncSent = true;
    releaseSync();
  });

  afterAll(async () => {
    await bridge?.stop?.();
    await browser?.close();
    await relay?.stop();
  });

  it('shows every question, including those the relay replayed after a later one was pushed live', async () => {
    await showsEvery('every question in the burst');
    // The run really took the path the bug lived on: the last question arrived live, ahead of a replay that held
    // earlier questions, which the phone did not hold when it asked for that replay, on its only socket.
    const created = seen.filter((s) => s.type === 'decision.created');
    const live = created.find((s) => s.questionId === ids.at(-1) && !s.afterSync)!;
    const replayed = created.filter((s) => s.afterSync && s.seq < live.seq);
    expect(new Set(replayed.map((s) => s.questionId))).toEqual(new Set(ids.slice(0, -1)));
    expect(created.every((s) => s.seq > gate.held!.after)).toBe(true);
    expect(gate.sockets).toBe(1);
    expect(new Set(await shownIds())).toEqual(new Set(ids));
  });

  it('keeps every question in its cache across a reload, with the relay out of reach', async () => {
    // Nothing can be fetched again: whatever the phone lists after the reload comes from its own ledger cache.
    await page.route(/\/api\/v1\/(events|socket-ticket)/, (r) => r.abort());
    await page.reload();
    await showsEvery('every question after a reload');
    expect(new Set(await shownIds())).toEqual(new Set(ids));
    const cached = await page.evaluate(
      () =>
        new Promise<string[]>((done, fail) => {
          const open = indexedDB.open('daintree-decisions');
          open.onerror = () => fail(open.error);
          open.onsuccess = () => {
            const all = open.result.transaction('events').objectStore('events').getAll();
            all.onerror = () => fail(all.error);
            all.onsuccess = () =>
              done(
                (all.result as { event_type: string; question_id: string | null }[])
                  .filter((e) => e.event_type === 'decision.created')
                  .map((e) => e.question_id!),
              );
          };
        }),
    );
    expect(new Set(cached)).toEqual(new Set(ids));
  });
});
