import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import { ADVISORY_TIMEOUT_DECISION_FIXTURE } from '@daintreehq/decisions-protocol/fixtures';
import {
  ADVISORY_NOTE_FALLBACK_DUE,
  ADVISORY_NOTE_FALLBACK_WITHHELD,
  ADVISORY_NOTE_UNANSWERED,
  DecisionsBridge,
  PolicyRegistry,
  RelayClient,
  TokenMapAuthenticator,
  parseAnswers,
  startDecisionsMcpServer,
  type BridgeOptions,
  type InjectResult,
} from '../src/index.js';
import { FakeSocket, origin, setupBridge, tick } from './helpers.js';

/*
 * An advisory question's deadline passing unanswered (issue #155): the asking agent is told once, in its own notice,
 * whether the plan it stated may now go ahead, through the same identity, intent, proof and attention machinery as an
 * answer. get_decision keeps the deadline, the disposition and how the notice's delivery stands across a restart, and
 * nothing about it is ever an answer, a receipt the relay keeps or a learning example.
 */

const T0 = Date.parse('2026-11-19T10:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const DEADLINE = at(15 * MIN);
const ADVISORY = 'advisory-deadlines-v1';
const PLAN = 'I will use the in-memory fixture.';

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup) await c().catch(() => undefined);
  cleanup = [];
});

type Learned = { questionId: string };

/** A host that delivers advisory outcomes, a relay and a phone that support them, and one advisory question asked. */
async function advised(over: Partial<BridgeOptions> = {}) {
  let now = T0;
  const learned: Learned[] = [];
  const policy = new PolicyRegistry({ advisoryQuestions: true });
  const e = await setupBridge({
    policy,
    now: () => now,
    advisoryDeadlines: true,
    learner: {
      learn: (d) => {
        learned.push(d);
        return { recorded: true } as never;
      },
    },
    ...over,
  });
  e.relay.features = ['thread-messages-v1', ADVISORY];
  e.relay.deviceFeatures.set(e.phone.deviceId, [ADVISORY]);
  await e.bridge.pump();
  const r = await e.bridge.registerQuestion({
    origin: origin(),
    input: {
      question: 'Which fixture?',
      options: [
        { id: 'mem', label: 'In memory' },
        { id: 'disk', label: 'On disk' },
      ],
      expires_in: '15m',
      planned_fallback: PLAN,
    },
  });
  expect(r.replyMode).toBe('advisory');
  await e.bridge.pump();
  cleanup.push(() => e.bridge.stop());
  const qid = r.questionId;
  const desktop = { deviceId: e.identity.config.deviceId, keys: e.identity.keys };
  return {
    ...e,
    qid,
    desktop,
    policy,
    learned,
    setNow: (t: number) => void (now = t),
    get now() {
      return now;
    },
    row: async () => (await e.store.getQuestion(qid))!,
    /** The relay expires the advisory round at its deadline; the bridge reads it a minute later. */
    async expire() {
      e.relay.expiryEvent({ questionId: qid });
      now = T0 + 16 * MIN;
      await e.bridge.catchUp();
    },
    /** Requests that would tell the relay about a delivery of an answer: a receipt or a failure. */
    answerReceipts: () =>
      e.relay.calls.filter(
        (c) => c.path === '/api/v1/deliveries/terminal' || c.path === '/api/v1/deliveries/failed',
      ),
    /** A second bridge on the same store, as after a restart. */
    restart(o: Partial<BridgeOptions> = {}) {
      const again = new DecisionsBridge({
        identity: e.identity,
        store: e.store,
        sink: e.sink,
        client: new RelayClient({
          identity: e.identity,
          fetch: e.relay.fetch,
          sleep: async () => {},
          maxRetries: 0,
        }),
        policy,
        pumpIntervalMs: 0,
        now: () => now,
        advisoryDeadlines: true,
        ...o,
      });
      cleanup.push(() => again.stop());
      return again;
    },
  };
}

/** Wait, a few milliseconds at a time, until `ok` holds (or two seconds pass); the socket applies frames in the background. */
async function until(ok: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await ok()); i++) await tick(10);
}

const blockOf = (text: string) => text.split('\n').slice(1).join('\n');

/** `get_decision` over the HTTP MCP server, as the asking pane calls it. */
async function getDecisionOverMcp(bridge: DecisionsBridge, questionId: string) {
  const auth = new TokenMapAuthenticator();
  auth.register('tok', origin());
  const mcp = await startDecisionsMcpServer({ bridge, authenticator: auth });
  cleanup.push(() => mcp.close());
  return new Promise<{ content: { text: string }[]; structuredContent: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: mcp.port,
          path: '/mcp',
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
        },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(JSON.parse(b).result));
        },
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_decision', arguments: { question_id: questionId } },
        }),
      );
    },
  );
}

describe('the advisory notice', () => {
  it('says the deadline passed unanswered and the plan is due, once, with the question and its deadline', async () => {
    const e = await advised();
    await e.expire();
    expect(e.sink.typed).toHaveLength(1);
    const id = e.sink.typed[0]!.id;
    expect(blockOf(e.sink.typed[0]!.text)).toBe(
      [
        '[DAINTREE DECISION ANSWER]',
        `question_id: ${e.qid} (q-1)`,
        'revision: 0',
        `injection_id: ${id}`,
        'question: Which fixture?',
        'source: system',
        'status: advisory-unanswered',
        `deadline: ${DEADLINE}`,
        'disposition: fallback-due',
        'authorised: no',
        ADVISORY_NOTE_UNANSWERED,
        ADVISORY_NOTE_FALLBACK_DUE,
        '[END DAINTREE DECISION ANSWER]',
      ].join('\n'),
    );
    // Delivered once: later passes type nothing more.
    await e.bridge.pump();
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(1);
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'expired',
      closedReason: 'expired',
      provenance: null,
      choice: null,
      fallbackDue: true,
      replyMode: 'advisory',
      plannedFallback: PLAN,
      deliveryStatus: 'terminal-delivered',
      answers: [],
      advisoryTimeout: {
        revision: 0,
        deadline: DEADLINE,
        disposition: 'fallback-due',
        notice: 'delivered',
        injectionId: id,
        agentAction: 'unobserved',
      },
    });
  });

  it('get_decision reports it in the published shape, after a restart too', async () => {
    const e = await advised();
    await e.expire();
    await e.bridge.stop();
    const again = e.restart();
    await again.start({ socket: false });
    const r = await getDecisionOverMcp(again, e.qid);
    const f = ADVISORY_TIMEOUT_DECISION_FIXTURE;
    // The fixture's question, deadline, plan and injection are its own; everything else is held to it.
    expect(r.structuredContent).toMatchObject({
      ...f,
      question_id: e.qid,
      expires_at: DEADLINE,
      planned_fallback: PLAN,
      advisory_timeout: {
        ...f.advisory_timeout,
        deadline: DEADLINE,
        injection_id: e.sink.typed[0]!.id,
      },
    });
    expect(r.content[0]!.text).toContain(
      'You asked for advice, so the plan you stated (planned_fallback) is yours to carry out',
    );
    // Withheld, the text says the plan may not go ahead.
    const w = await advised();
    w.policy.advisoryQuestions = false;
    await w.expire();
    const withheld = await getDecisionOverMcp(w.bridge, w.qid);
    expect(withheld.structuredContent).toMatchObject({
      fallback_due: false,
      advisory_timeout: { disposition: 'fallback-withheld', notice: 'delivered' },
    });
    expect(withheld.content[0]!.text).toContain(
      'This host does not allow the plan you stated to go ahead on its own',
    );
  });

  it('is never an answer: no relay receipt, no answer in the thread, no learning example', async () => {
    const e = await advised();
    await e.expire();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.answerReceipts()).toEqual([]);
    expect(e.learned).toEqual([]);
    const v = await e.bridge.getDecision(e.qid);
    expect(v.answers).toEqual([]);
    expect(v.thread.filter((t) => t.kind === 'answer')).toEqual([]);
    // Nor when it could not be typed at all.
    const f = await advised();
    f.sink.panes.clear();
    await f.expire();
    expect((await f.row()).delivery_status).toBe('needs-attention');
    expect(f.answerReceipts()).toEqual([]);
  });

  it('withholds the plan when the host policy does not allow advice when the deadline passes', async () => {
    const e = await advised();
    e.policy.advisoryQuestions = false;
    await e.expire();
    expect(e.sink.typed).toHaveLength(1);
    const text = e.sink.typed[0]!.text;
    expect(text).toContain('status: advisory-unanswered');
    expect(text).toContain('disposition: fallback-withheld');
    expect(text).toContain(ADVISORY_NOTE_FALLBACK_WITHHELD);
    expect(text).not.toContain(ADVISORY_NOTE_FALLBACK_DUE);
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      fallbackDue: false,
      advisoryTimeout: { disposition: 'fallback-withheld', notice: 'delivered' },
    });
  });

  it('withholds a plan still waiting for a busy pane once the policy no longer allows advice', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      fallbackDue: true,
      advisoryTimeout: { disposition: 'fallback-due', notice: 'pending', injectionId: null },
    });
    e.policy.advisoryQuestions = false;
    // What get_decision says follows the policy before anything is typed.
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      fallbackDue: false,
      advisoryTimeout: { disposition: 'fallback-withheld', notice: 'pending' },
    });
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('disposition: fallback-withheld');
    expect(parseAnswers((await e.row()).answers_json)[0]).toMatchObject({
      advisory_disposition: 'fallback-withheld',
      delivered: true,
    });
    // Allowing advice again never brings a withheld notice back.
    e.policy.advisoryQuestions = true;
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      fallbackDue: false,
      advisoryTimeout: { disposition: 'fallback-withheld', notice: 'delivered' },
    });
  });

  it('keeps what a typed notice said when the policy changes afterwards', async () => {
    const e = await advised();
    await e.expire();
    e.policy.advisoryQuestions = false;
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      fallbackDue: true,
      advisoryTimeout: { disposition: 'fallback-due', notice: 'delivered' },
    });
  });

  it('is the ordinary expiry on a host that no longer delivers advisory outcomes', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    await e.bridge.stop();
    const again = e.restart({ advisoryDeadlines: false });
    await again.start({ socket: false });
    e.sink.panes.get('pane-1')!.idle = true;
    await again.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('status: expired');
    expect(e.sink.typed[0]!.text).not.toContain('advisory');
    expect(await again.getDecision(e.qid)).toMatchObject({
      status: 'expired',
      fallbackDue: false,
      advisoryTimeout: null,
    });
  });

  it('is never recorded by a host that does not deliver advisory outcomes', async () => {
    const e = await advised();
    await e.bridge.stop();
    const again = e.restart({ advisoryDeadlines: false });
    await again.start({ socket: false });
    e.relay.expiryEvent({ questionId: e.qid });
    e.setNow(T0 + 16 * MIN);
    await again.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('status: expired');
    expect(parseAnswers((await e.row()).answers_json)[0]!.advisory_disposition).toBeUndefined();
    expect((await again.getDecision(e.qid)).advisoryTimeout).toBeNull();
  });

  it('leaves the blocking expiry and the decline exactly as they were', async () => {
    const e = await advised();
    const blocking = await e.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Approve the release?', expires_in: '15m' },
    });
    const declined = await e.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Which name?', expires_in: '15m', planned_fallback: PLAN },
    });
    await e.bridge.pump();
    await e.relay.plainActionEvent({
      questionId: declined.questionId,
      signer: e.phone,
      action: 'cancel',
    });
    e.relay.expiryEvent({ questionId: blocking.questionId });
    e.setNow(T0 + 16 * MIN);
    await e.bridge.catchUp();
    const text = e.sink.typed.map((t) => t.text).join('\n');
    expect(text).toContain(
      'note: The question expired without an answer. You are NOT authorised to continue the gated step; re-ask or stop and report.',
    );
    expect(text).toContain('status: declined');
    expect(text).not.toContain('advisory-unanswered');
    expect((await e.bridge.getDecision(blocking.questionId)).advisoryTimeout).toBeNull();
    expect(await e.bridge.getDecision(declined.questionId)).toMatchObject({
      closedReason: 'declined',
      fallbackDue: false,
      advisoryTimeout: null,
    });
  });
});

describe('where the advisory notice goes', () => {
  it('waits for a busy pane, then is typed once', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    e.sink.injectBehaviour = 'held';
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout?.notice).toBe('pending');
    e.sink.injectBehaviour = 'ok';
    await e.bridge.notifyPaneIdle();
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(1);
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout?.notice).toBe('delivered');
  });

  it('waits while its host is offline and is then typed to the same session', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.hostOffline = true;
    await e.expire();
    expect(e.sink.typed).toHaveLength(0);
    expect((await e.row()).delivery_status).toBe('pending-host');
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout?.notice).toBe('pending');
    e.sink.panes.get('pane-1')!.hostOffline = false;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.target).toMatchObject({ paneId: 'pane-1', agentSessionId: 'sess-1' });
  });

  it('a genuinely gone agent goes to a person, never dropped like a decline', async () => {
    const e = await advised();
    e.sink.panes.clear();
    await e.expire();
    expect(e.sink.typed).toHaveLength(0);
    const row = await e.row();
    expect(row.delivery_status).toBe('needs-attention');
    expect(row.error_code).toBe('pane_gone');
    expect(parseAnswers(row.answers_json)[0]).toMatchObject({ deliver: true, delivered: false });
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout?.notice).toBe('needs-attention');
  });

  it('resumes into the session that asked, and nowhere else', async () => {
    const e = await advised();
    e.sink.panes.clear();
    e.sink.addPane('pane-2', { session: 'sess-1' });
    e.sink.resumeTarget = {
      hostId: origin().host_id,
      paneId: 'pane-2',
      terminalGeneration: 1,
      ownershipPrincipal: 'principal-1',
      agentIncarnation: 'inc-1',
      agentSessionId: 'sess-1',
      worktreeId: origin().worktree_id,
    };
    await e.expire();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.target).toMatchObject({ paneId: 'pane-2', agentSessionId: 'sess-1' });
    expect(e.sink.typed[0]!.text).toContain('disposition: fallback-due');

    // Another session in the same worktree never stated the plan.
    const f = await advised();
    f.sink.panes.clear();
    f.sink.addPane('pane-3', { session: 'sess-other' });
    f.sink.resumeTarget = {
      hostId: origin().host_id,
      paneId: 'pane-3',
      terminalGeneration: 1,
      ownershipPrincipal: 'principal-1',
      agentIncarnation: 'inc-1',
      agentSessionId: 'sess-other',
      worktreeId: origin().worktree_id,
    };
    await f.expire();
    expect(f.sink.typed).toHaveLength(0);
    expect(await f.row()).toMatchObject({
      delivery_status: 'needs-attention',
      error_code: 'resume_wrong_session',
    });
    expect((await f.row()).origin.pane_id).toBe(origin().pane_id);
  });

  it('waits for a socket replay to end: a later event of it may reopen the round', async () => {
    FakeSocket.instances = [];
    const e = await advised({ webSocket: (u) => new FakeSocket(u) });
    e.setNow(T0 + 16 * MIN);
    await e.bridge.start();
    await e.bridge.pump();
    const expired = e.relay.expiryEvent({ questionId: e.qid });
    const reopened = await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: at(60 * MIN),
    });
    await tick(10);
    const ws = FakeSocket.instances.at(-1)!;
    ws.recv({
      t: 'hello',
      protocol_version: PROTOCOL_VERSION,
      device_id: e.identity.config.deviceId,
      role: 'owner-desktop',
      key_epoch: 1,
      high_water: reopened.seq,
      server_time: new Date().toISOString(),
    });
    for (const ev of e.relay.events.filter((x) => x.seq <= expired.seq))
      ws.recv({ t: 'event', event: ev });
    await until(async () => (await e.row()).local_status === 'expired');
    expect((await e.row()).local_status).toBe('expired');
    // The pane going idle mid-replay types nothing.
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    ws.recv({ t: 'event', event: reopened });
    ws.recv({ t: 'caught_up', high_water: reopened.seq, has_more: false });
    await until(async () => (await e.row()).local_status === 'open');
    await tick(30);
    expect((await e.row()).local_status).toBe('open');
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      revision: 1,
      replyMode: 'blocking',
      fallbackDue: false,
      advisoryTimeout: { revision: 0, notice: 'superseded' },
    });
  });
});

describe('a stale advisory notice is never typed', () => {
  it('a reopen while the pane is busy supersedes it', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: at(60 * MIN),
    });
    await e.bridge.catchUp();
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'open',
      revision: 1,
      replyMode: 'blocking',
      plannedFallback: null,
      fallbackDue: false,
      advisoryTimeout: {
        revision: 0,
        deadline: DEADLINE,
        disposition: 'fallback-due',
        notice: 'superseded',
        injectionId: null,
      },
    });
    // The reopened round expires as a blocking one: its notice authorises nothing.
    e.relay.expiryEvent({ questionId: e.qid, revision: 1, at: at(60 * MIN) });
    e.setNow(T0 + 61 * MIN);
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('status: expired');
    expect(e.sink.typed[0]!.text).toContain('You are NOT authorised');
    expect((await e.bridge.getDecision(e.qid)).fallbackDue).toBe(false);
  });

  it('a deletion while the pane is busy supersedes it', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    e.relay.push('decision.deleted', e.qid, null, {});
    await e.bridge.catchUp();
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      fallbackDue: false,
      advisoryTimeout: { notice: 'superseded' },
    });
  });

  it('an answer committed just before the deadline wins, however late it arrives', async () => {
    const e = await advised();
    await e.relay.answerEvent({ questionId: e.qid, phone: e.phone, options: ['disk'] });
    // This desktop hears of it only after its own clock passed the deadline; the relay never expires it.
    e.setNow(T0 + 20 * MIN);
    await e.bridge.catchUp();
    await e.bridge.pump();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('choice: disk');
    expect(e.sink.typed[0]!.text).not.toContain('advisory-unanswered');
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'human-answered',
      choice: 'disk',
      fallbackDue: false,
      advisoryTimeout: null,
    });
  });

  it('a duplicate or replayed expiry adds no second notice, also after a restart', async () => {
    const e = await advised();
    const first = e.relay.expiryEvent({ questionId: e.qid });
    e.relay.expiryEvent({ questionId: e.qid });
    e.setNow(T0 + 16 * MIN);
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    await e.bridge.stop();
    const again = e.restart();
    // The relay sends the same events again, from before the expiry.
    await e.store.setMeta('cursor', String(first.seq - 1));
    await again.start({ socket: false });
    await again.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    const entries = parseAnswers((await e.row()).answers_json);
    expect(entries.filter((x) => x.kind === 'expired')).toHaveLength(1);
    expect((await again.getDecision(e.qid)).advisoryTimeout?.notice).toBe('delivered');
  });
});

describe('a crash around the advisory notice', () => {
  it('before anything was attempted: typed once after the restart, and get_decision says so', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    await e.bridge.stop();
    const again = e.restart();
    await again.start({ socket: false });
    expect(await again.getDecision(e.qid)).toMatchObject({
      fallbackDue: true,
      advisoryTimeout: { disposition: 'fallback-due', notice: 'pending', deadline: DEADLINE },
    });
    e.sink.panes.get('pane-1')!.idle = true;
    await again.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(1);
    expect((await again.getDecision(e.qid)).advisoryTimeout?.notice).toBe('delivered');
  });

  it('after the intent and before the write: uncertain after the restart, never typed again', async () => {
    const e = await advised();
    const inject = e.sink.inject.bind(e.sink);
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    // The process dies with the intent written and nothing typed.
    e.sink.inject = async () => {
      entered();
      return new Promise<InjectResult>(() => {});
    };
    e.relay.expiryEvent({ questionId: e.qid });
    e.setNow(T0 + 16 * MIN);
    void e.bridge.catchUp();
    await reached;
    await e.bridge.stop();
    e.sink.inject = inject;
    const again = e.restart();
    await again.start({ socket: false });
    await again.pump();
    await again.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    const v = await again.getDecision(e.qid);
    expect(v.deliveryStatus).toBe('delivery-uncertain');
    expect(v.advisoryTimeout).toMatchObject({
      notice: 'uncertain',
      injectionId: expect.any(String),
    });
    expect(e.answerReceipts()).toEqual([]);
  });

  it('after the write and before it was recorded: found on screen, delivered, not typed twice', async () => {
    const e = await advised();
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    // The text reaches the terminal, then the process dies before the sink's answer is recorded.
    e.sink.inject = async (t, text, id) => {
      e.sink.typed.push({ target: t, text, id });
      entered();
      return new Promise<InjectResult>(() => {});
    };
    e.relay.expiryEvent({ questionId: e.qid });
    e.setNow(T0 + 16 * MIN);
    void e.bridge.catchUp();
    await reached;
    await e.bridge.stop();
    e.sink.inject = Object.getPrototypeOf(e.sink).inject.bind(e.sink);
    const again = e.restart();
    await again.start({ socket: false });
    await again.pump();
    expect(e.sink.typed).toHaveLength(1);
    expect((await again.getDecision(e.qid)).advisoryTimeout).toMatchObject({
      notice: 'delivered',
      injectionId: e.sink.typed[0]!.id,
    });
    expect(e.answerReceipts()).toEqual([]);
  });

  it('an ambiguous write stays uncertain for its round after a reopen and a restart', async () => {
    const e = await advised();
    e.sink.injectBehaviour = 'ambiguous';
    await e.expire();
    const id = e.sink.typed[0]!.id;
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout).toMatchObject({
      notice: 'uncertain',
      injectionId: id,
    });
    e.sink.injectBehaviour = 'ok';
    await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: at(60 * MIN),
    });
    await e.relay.answerEvent({
      questionId: e.qid,
      phone: e.phone,
      options: ['mem'],
      expectedRevision: 1,
    });
    await e.bridge.catchUp();
    // The new round's answer is not held back by the old round's uncertain write.
    expect(e.sink.typed).toHaveLength(2);
    expect(e.sink.typed[1]!.text).toContain('choice: mem');
    await e.bridge.stop();
    const again = e.restart();
    await again.start({ socket: false });
    expect(await again.getDecision(e.qid)).toMatchObject({
      status: 'human-answered',
      fallbackDue: false,
      advisoryTimeout: { revision: 0, notice: 'uncertain', injectionId: id },
    });
    expect(e.sink.typed).toHaveLength(2);
  });
});
