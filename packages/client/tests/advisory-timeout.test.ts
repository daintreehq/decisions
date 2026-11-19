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
  ADVISORY_LEDGER_WAIT_MS,
  TokenMapAuthenticator,
  currentDisposition,
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
  it('is announced as an advisory timeout, not an answer', async () => {
    const e = await advised();
    const seen: [string, string][] = [];
    e.bridge.on('delivered', (id, what) => seen.push([id, what]));
    await e.expire();
    expect(seen).toEqual([[e.qid, 'advisory-timeout']]);
  });

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
    // Decided when the expiry was accepted, not only by delivery's later check.
    expect((await e.store.listAudit(100)).map((a) => [a.event, a.result])).toContainEqual([
      'question.expired',
      'advisory:fallback-withheld',
    ]);
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
      advisoryTimeout: {
        disposition: 'fallback-due',
        notice: 'delivered',
        injectionId: e.sink.typed[0]!.id,
      },
    });
  });

  it('never upgrades a withheld notice, and withholds a due one the host no longer allows', () => {
    const allowed = { outcomes: true, allowed: true };
    expect(currentDisposition('fallback-due', allowed)).toBe('fallback-due');
    expect(currentDisposition('fallback-withheld', allowed)).toBe('fallback-withheld');
    expect(currentDisposition('fallback-due', { outcomes: true, allowed: false })).toBe(
      'fallback-withheld',
    );
    expect(currentDisposition('fallback-due', { outcomes: false, allowed: true })).toBe(
      'fallback-withheld',
    );
    expect(currentDisposition(undefined, allowed)).toBeUndefined();
  });

  it('withholds a plan the policy turned off while the write was being admitted', async () => {
    const e = await advised();
    const putIntent = e.store.putIntent.bind(e.store);
    // The host turns advice off while delivery is writing its intent, after it read the policy.
    e.store.putIntent = async (i) => {
      e.policy.advisoryQuestions = false;
      return putIntent(i);
    };
    await e.expire();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('disposition: fallback-withheld');
    expect(e.sink.typed[0]!.text).not.toContain(ADVISORY_NOTE_FALLBACK_DUE);
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      fallbackDue: false,
      advisoryTimeout: { disposition: 'fallback-withheld', notice: 'delivered' },
    });
  });

  it('is the ordinary expiry, withheld and with no receipt, on a host that no longer delivers advisory outcomes', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    await e.bridge.stop();
    const again = e.restart({ advisoryDeadlines: false });
    await again.start({ socket: false });
    await again.catchUp();
    // Before anything is typed, get_decision already says the plan will not go ahead.
    expect(await again.getDecision(e.qid)).toMatchObject({
      fallbackDue: false,
      advisoryTimeout: { disposition: 'fallback-withheld', notice: 'pending' },
    });
    e.sink.injectBehaviour = 'ambiguous';
    e.sink.panes.get('pane-1')!.idle = true;
    await again.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('status: expired');
    expect(e.sink.typed[0]!.text).toContain('You are NOT authorised');
    expect(e.sink.typed[0]!.text).not.toContain('advisory');
    expect(await again.getDecision(e.qid)).toMatchObject({
      status: 'expired',
      fallbackDue: false,
      advisoryTimeout: { disposition: 'fallback-withheld', notice: 'uncertain' },
    });
    // Still no answer receipt or failure report: it was a timeout, not an answer.
    expect(e.answerReceipts()).toEqual([]);
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
    expect(await again.getDecision(e.qid)).toMatchObject({
      replyMode: 'advisory',
      fallbackDue: false,
      advisoryTimeout: null,
    });
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

  it('a follow-up before the deadline never moves the question to another session', async () => {
    const e = await advised({ followUps: true });
    e.sink.panes.clear();
    e.sink.addPane('pane-3', { session: 'sess-other' });
    e.sink.resumeTarget = {
      hostId: origin().host_id,
      paneId: 'pane-3',
      terminalGeneration: 1,
      ownershipPrincipal: 'principal-1',
      agentIncarnation: 'inc-1',
      agentSessionId: 'sess-other',
      worktreeId: origin().worktree_id,
    };
    await e.relay.messageEvent({ questionId: e.qid, signer: e.phone, text: 'Any thoughts?' });
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(0);
    expect((await e.row()).origin).toMatchObject({
      pane_id: origin().pane_id,
      agent_session_id: origin().agent_session_id,
    });
    await e.expire();
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.row()).toMatchObject({
      delivery_status: 'needs-attention',
      error_code: 'resume_wrong_session',
    });
  });

  it('waits after a read of the ledger failed part-way, and is typed once a read gets through', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    // The relay stops answering: what it holds past the expiry is unknown.
    e.relay.down = 1;
    await expect(e.bridge.catchUp()).rejects.toThrow();
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    await e.bridge.pump();
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      fallbackDue: false,
      advisoryTimeout: { notice: 'pending' },
    });
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('disposition: fallback-due');
  });

  it('get_decision does not let the plan go ahead while a notice needing attention waits for the ledger', async () => {
    const e = await advised();
    e.sink.panes.clear();
    await e.expire();
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout?.notice).toBe('needs-attention');
    expect((await e.bridge.getDecision(e.qid)).fallbackDue).toBe(true);
    e.relay.down = 1;
    await expect(e.bridge.catchUp()).rejects.toThrow();
    expect((await e.bridge.getDecision(e.qid)).fallbackDue).toBe(false);
    // A read that never gets through holds it two minutes at most, here too.
    e.setNow(e.now + ADVISORY_LEDGER_WAIT_MS);
    expect((await e.bridge.getDecision(e.qid)).fallbackDue).toBe(true);
  });

  it('a write its sink refused needs a person, and lets the plan go ahead in every process that reads it', async () => {
    const e = await advised();
    e.sink.injectBehaviour = { unavailable: 'rejected' };
    await e.expire();
    expect(e.sink.injectCalls).toBe(1);
    expect(e.sink.typed).toHaveLength(0);
    const row = await e.row();
    expect(row).toMatchObject({
      delivery_status: 'needs-attention',
      error_code: 'inject_rejected',
    });
    expect(parseAnswers(row.answers_json)[0]).toMatchObject({
      write_refused: true,
      delivered: false,
    });
    const due = {
      fallbackDue: true,
      advisoryTimeout: {
        disposition: 'fallback-due',
        notice: 'needs-attention',
        writeRefused: true,
        injectionId: null,
      },
    };
    expect(await e.bridge.getDecision(e.qid)).toMatchObject(due);
    // A bridge on the same store that never reads the relay itself, as another process is, reads the same.
    expect(await e.restart().getDecision(e.qid)).toMatchObject(due);
    // It was admitted once the ledger had settled for its round: a read that fails later takes nothing back.
    e.relay.down = 1;
    await expect(e.bridge.catchUp()).rejects.toThrow();
    expect(await e.bridge.getDecision(e.qid)).toMatchObject(due);
    expect((await getDecisionOverMcp(e.bridge, e.qid)).structuredContent).toMatchObject({
      fallback_due: true,
      advisory_timeout: { disposition: 'fallback-due', notice: 'needs-attention' },
    });
    // Nothing was typed, so it says what the host allows now.
    e.policy.advisoryQuestions = false;
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      fallbackDue: false,
      advisoryTimeout: { disposition: 'fallback-withheld', writeRefused: true },
    });

    // A notice that needs a person without a write being admitted (its pane gone) proves nothing to such a reader.
    const f = await advised();
    f.sink.panes.clear();
    await f.expire();
    expect(f.sink.injectCalls).toBe(0);
    expect(await f.row()).toMatchObject({
      delivery_status: 'needs-attention',
      error_code: 'pane_gone',
    });
    expect(parseAnswers((await f.row()).answers_json)[0]!.write_refused).toBeUndefined();
    expect(await f.bridge.getDecision(f.qid)).toMatchObject({
      fallbackDue: true,
      advisoryTimeout: { notice: 'needs-attention', writeRefused: false },
    });
    expect((await f.restart().getDecision(f.qid)).fallbackDue).toBe(false);
  });

  it('a refused notice still waits for an event of its question stored and not yet applied', async () => {
    const e = await advised();
    e.sink.injectBehaviour = { unavailable: 'rejected' };
    await e.expire();
    expect((await e.bridge.getDecision(e.qid)).fallbackDue).toBe(true);
    // A reopen read past a hole, stored and waiting for the event before it: in this process and every other one.
    e.relay.skipSeq(1);
    const reopened = await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: at(60 * MIN),
    });
    await e.store.insertEvent({
      seq: reopened.seq,
      event_id: reopened.event_id,
      event_type: reopened.event_type,
      json: JSON.stringify(reopened),
      received_at: e.now,
      processed_at: null,
    });
    const held = {
      status: 'expired',
      fallbackDue: false,
      advisoryTimeout: { notice: 'needs-attention', writeRefused: true },
    };
    expect(await e.bridge.getDecision(e.qid)).toMatchObject(held);
    expect(await e.restart().getDecision(e.qid)).toMatchObject(held);
    e.setNow(e.now + 3 * ADVISORY_LEDGER_WAIT_MS);
    expect(await e.restart().getDecision(e.qid)).toMatchObject(held);
    await e.bridge.catchUp();
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'open',
      fallbackDue: false,
      advisoryTimeout: { notice: 'superseded', writeRefused: false },
    });
  });

  it('a refused notice waits while more events wait to be applied than one look reads', async () => {
    const e = await advised();
    e.sink.injectBehaviour = { unavailable: 'rejected' };
    await e.expire();
    expect((await e.restart().getDecision(e.qid)).fallbackDue).toBe(true);
    // Other questions' events fill the look: one of those after it may be this question's reopen.
    for (let i = 0; i < 500; i++)
      await e.store.insertEvent({
        seq: 10_000 + i,
        event_id: `other-${i}`,
        event_type: 'question.created',
        json: JSON.stringify({ question_id: 'another-question' }),
        received_at: e.now,
        processed_at: null,
      });
    expect((await e.restart().getDecision(e.qid)).fallbackDue).toBe(false);
  });

  it('a retry takes the refusal back, and a reopen supersedes a refused notice', async () => {
    const e = await advised();
    e.sink.injectBehaviour = { unavailable: 'rejected' };
    await e.expire();
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout?.writeRefused).toBe(true);
    // Sent again, it waits for its pane like any notice not yet typed, and is then typed once.
    e.sink.injectBehaviour = 'ok';
    e.sink.panes.get('pane-1')!.idle = false;
    await e.bridge.retryDelivery(e.qid);
    expect(e.sink.injectCalls).toBe(1);
    expect(parseAnswers((await e.row()).answers_json)[0]!.write_refused).toBeUndefined();
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout).toMatchObject({
      notice: 'pending',
      writeRefused: false,
    });
    expect((await e.restart().getDecision(e.qid)).fallbackDue).toBe(false);
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.injectCalls).toBe(2);
    expect(e.sink.typed).toHaveLength(1);
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout).toMatchObject({
      notice: 'delivered',
      writeRefused: false,
    });

    const f = await advised();
    f.sink.injectBehaviour = { unavailable: 'rejected' };
    await f.expire();
    expect(f.sink.injectCalls).toBe(1);
    expect(parseAnswers((await f.row()).answers_json)[0]!.write_refused).toBe(true);
    await f.relay.plainActionEvent({
      questionId: f.qid,
      signer: f.desktop,
      action: 'reopen',
      expiresAt: at(60 * MIN),
    });
    await f.bridge.catchUp();
    const reopened = {
      status: 'open',
      revision: 1,
      fallbackDue: false,
      advisoryTimeout: { revision: 0, notice: 'superseded', writeRefused: false },
    };
    expect(await f.bridge.getDecision(f.qid)).toMatchObject(reopened);
    expect(await f.restart().getDecision(f.qid)).toMatchObject(reopened);
  });

  it('reading a question starts no clock: the two-minute hold is timed from when its notice waits', async () => {
    const e = await advised();
    // Polled while open, before this desktop has read the relay in full, as an agent polling get_decision does.
    expect((await e.bridge.getDecision(e.qid)).status).toBe('open');
    e.setNow(e.now + 3 * ADVISORY_LEDGER_WAIT_MS);
    // The first time a notice waits, the hold starts then, not at that earlier read.
    expect(await e.bridge.delivery.ledgerHolds(e.qid)).toBe(true);
    e.setNow(e.now + ADVISORY_LEDGER_WAIT_MS - 1);
    expect(await e.bridge.delivery.ledgerHolds(e.qid)).toBe(true);
    e.setNow(e.now + 1);
    expect(await e.bridge.delivery.ledgerHolds(e.qid)).toBe(false);
  });

  it('waits two minutes at most for a read that does not get through', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    e.relay.down = 1;
    await expect(e.bridge.catchUp()).rejects.toThrow();
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    e.setNow(e.now + ADVISORY_LEDGER_WAIT_MS - 1);
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    e.setNow(e.now + 1);
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(1);
  });

  it('an event of its own question stored and not yet applied holds it however long that lasts', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    // A reopen read past a hole: it waits for the event before it, and so does the notice.
    e.relay.skipSeq(1);
    const reopened = await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: at(60 * MIN),
    });
    await e.store.insertEvent({
      seq: reopened.seq,
      event_id: reopened.event_id,
      event_type: reopened.event_type,
      json: JSON.stringify(reopened),
      received_at: e.now,
      processed_at: null,
    });
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    e.setNow(e.now + 3 * ADVISORY_LEDGER_WAIT_MS);
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    expect((await e.bridge.getDecision(e.qid)).fallbackDue).toBe(false);
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(0);
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout?.notice).toBe('superseded');
  });

  it('an answer typed in the same chunk is not held back with a notice that waits', async () => {
    const e = await advised();
    const other = await e.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Ship it?', expires_in: '1h' },
    });
    await e.bridge.pump();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    await e.relay.answerEvent({ questionId: other.questionId, phone: e.phone, options: [] });
    await e.bridge.catchUp();
    const reopened = await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: at(60 * MIN),
    });
    const putIntent = e.store.putIntent.bind(e.store);
    let stored = false;
    // While the chunk's intents are written, a read stores the advisory question's reopen.
    e.store.putIntent = async (i) => {
      if (!stored) {
        stored = true;
        await e.store.insertEvent({
          seq: reopened.seq,
          event_id: reopened.event_id,
          event_type: reopened.event_type,
          json: JSON.stringify(reopened),
          received_at: e.now,
          processed_at: null,
        });
      }
      return putIntent(i);
    };
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain(`question_id: ${other.questionId}`);
    expect(e.sink.typed[0]!.text).not.toContain('advisory-unanswered');
  });

  it('a socket replay abandoned after an HTTP read reached the end lets it go', async () => {
    FakeSocket.instances = [];
    const e = await advised({ webSocket: (u) => new FakeSocket(u) });
    e.setNow(T0 + 16 * MIN);
    await e.bridge.start();
    await e.bridge.pump();
    const expired = e.relay.expiryEvent({ questionId: e.qid });
    await tick(10);
    const ws = FakeSocket.instances.at(-1)!;
    ws.recv({
      t: 'hello',
      protocol_version: PROTOCOL_VERSION,
      device_id: e.identity.config.deviceId,
      role: 'owner-desktop',
      key_epoch: 1,
      high_water: expired.seq,
      server_time: new Date().toISOString(),
    });
    for (const ev of e.relay.events.filter((x) => x.seq <= expired.seq))
      ws.recv({ t: 'event', event: ev });
    await until(async () => (await e.row()).local_status === 'expired');
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(0);
    // The socket goes away before its replay caught up: the HTTP read already reached the relay's end.
    ws.close(1006, 'gone');
    await until(async () => e.sink.typed.length > 0);
    expect(e.sink.typed).toHaveLength(1);
  });

  it('is typed in the same drain when the ledger settles while that drain types another pane', async () => {
    const e = await advised();
    e.sink.addPane('pane-2', { session: 'sess-2' });
    const other = await e.bridge.registerQuestion({
      origin: origin({ pane_id: 'pane-2', agent_session_id: 'sess-2' }),
      input: { question: 'Ship it?', expires_in: '1h' },
    });
    await e.bridge.pump();
    e.sink.panes.get('pane-1')!.idle = false;
    e.sink.panes.get('pane-2')!.idle = false;
    await e.expire();
    await e.relay.answerEvent({ questionId: other.questionId, phone: e.phone, options: [] });
    await e.bridge.catchUp();
    // An event of the advisory question is stored, not yet applied: its notice waits.
    const message = e.relay.push('decision.snapshot.refresh_requested', e.qid, null, {});
    await e.store.insertEvent({
      seq: message.seq + 1000,
      event_id: 'evt-pending',
      event_type: message.event_type,
      json: JSON.stringify({ ...message, seq: message.seq + 1000 }),
      received_at: e.now,
      processed_at: null,
    });
    // While the same drain types the other pane, the event is applied.
    const isIdle = e.sink.isIdle.bind(e.sink);
    e.sink.isIdle = async (t) => {
      if (t.paneId === 'pane-2') await e.store.markEventProcessed(message.seq + 1000, e.now);
      return isIdle(t);
    };
    e.sink.panes.get('pane-1')!.idle = true;
    e.sink.panes.get('pane-2')!.idle = true;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed.map((t) => t.target.paneId).sort()).toEqual(['pane-1', 'pane-2']);
    expect(e.sink.typed.find((t) => t.target.paneId === 'pane-1')!.text).toContain(
      'status: advisory-unanswered',
    );
  });

  it('a read over HTTP that ends while a socket replay goes on never releases it', async () => {
    FakeSocket.instances = [];
    const e = await advised({ webSocket: (u) => new FakeSocket(u) });
    e.setNow(T0 + 16 * MIN);
    await e.bridge.start();
    await e.bridge.pump();
    const expired = e.relay.expiryEvent({ questionId: e.qid });
    await tick(10);
    const ws = FakeSocket.instances.at(-1)!;
    ws.recv({
      t: 'hello',
      protocol_version: PROTOCOL_VERSION,
      device_id: e.identity.config.deviceId,
      role: 'owner-desktop',
      key_epoch: 1,
      high_water: expired.seq + 1,
      server_time: new Date().toISOString(),
    });
    for (const ev of e.relay.events.filter((x) => x.seq <= expired.seq))
      ws.recv({ t: 'event', event: ev });
    await until(async () => (await e.row()).local_status === 'expired');
    // An HTTP catch-up reads to the relay's end while the socket's replay has not caught up.
    await e.bridge.catchUp();
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    ws.recv({ t: 'caught_up', high_water: expired.seq, has_more: false });
    await until(async () => e.sink.typed.length > 0);
    expect(e.sink.typed).toHaveLength(1);
  });

  it('is typed when a socket replay that brought it ends, with nothing else to wake it', async () => {
    FakeSocket.instances = [];
    const e = await advised({ webSocket: (u) => new FakeSocket(u) });
    e.setNow(T0 + 16 * MIN);
    await e.bridge.start();
    await e.bridge.pump();
    const expired = e.relay.expiryEvent({ questionId: e.qid });
    await tick(10);
    const ws = FakeSocket.instances.at(-1)!;
    ws.recv({
      t: 'hello',
      protocol_version: PROTOCOL_VERSION,
      device_id: e.identity.config.deviceId,
      role: 'owner-desktop',
      key_epoch: 1,
      high_water: expired.seq,
      server_time: new Date().toISOString(),
    });
    for (const ev of e.relay.events.filter((x) => x.seq <= expired.seq))
      ws.recv({ t: 'event', event: ev });
    await until(async () => (await e.row()).local_status === 'expired');
    expect(e.sink.typed).toHaveLength(0);
    ws.recv({ t: 'caught_up', high_water: expired.seq, has_more: false });
    await until(async () => e.sink.typed.length > 0);
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('status: advisory-unanswered');
  });

  it('checks the ledger again at the write: an event stored after the pane was checked holds it', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    const reopened = await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: at(60 * MIN),
    });
    // The pane settles; between the lane's check and the write, a read stores the reopen without applying it yet.
    let checks = 0;
    e.sink.isIdle = async () => {
      if (++checks === 2)
        await e.store.insertEvent({
          seq: reopened.seq,
          event_id: reopened.event_id,
          event_type: reopened.event_type,
          json: JSON.stringify(reopened),
          received_at: e.now,
          processed_at: null,
        });
      return true;
    };
    await e.bridge.notifyPaneIdle();
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(e.sink.typed).toHaveLength(0);
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      revision: 1,
      advisoryTimeout: { notice: 'superseded' },
    });
  });

  it('checks the ledger again after the intent is written: an event stored meanwhile still holds it', async () => {
    const e = await advised();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.expire();
    const reopened = await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: at(60 * MIN),
    });
    const putIntent = e.store.putIntent.bind(e.store);
    // A read stores the reopen outside the delivery lock, while the intent is being written.
    e.store.putIntent = async (i) => {
      await e.store.insertEvent({
        seq: reopened.seq,
        event_id: reopened.event_id,
        event_type: reopened.event_type,
        json: JSON.stringify(reopened),
        received_at: e.now,
        processed_at: null,
      });
      return putIntent(i);
    };
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    // Nothing was written: its intent is closed and holds nothing back.
    expect(await e.store.hasUncertainIntent(e.qid)).toBe(false);
    expect((await e.store.openIntents()).filter((i) => i.state === 'intent')).toEqual([]);
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(0);
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout?.notice).toBe('superseded');
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
    const r = await getDecisionOverMcp(e.bridge, e.qid);
    expect(r.structuredContent).toMatchObject({
      revision: 1,
      fallback_due: false,
      advisory_timeout: { revision: 0, notice: 'superseded' },
    });
    expect(r.content[0]!.text).toContain('you are not authorised to continue the gated step');
    expect(r.content[0]!.text).not.toContain('This host does not allow the plan');
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
    // Even an expiry claim after it (a relay that raced its own sweep) changes nothing.
    e.relay.expiryEvent({ questionId: e.qid });
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('choice: disk');
    expect(e.sink.typed[0]!.text).not.toContain('advisory-unanswered');
    expect(parseAnswers((await e.row()).answers_json).map((x) => x.kind)).toEqual(['answer']);
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

describe('a deletion while the advisory notice is being written', () => {
  it('keeps the uncertainty of a write the sink could not confirm', async () => {
    const e = await advised();
    let answer!: (r: InjectResult) => void;
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    e.sink.inject = async (t, text, id) => {
      e.sink.typed.push({ target: t, text, id });
      entered();
      return new Promise<InjectResult>((r) => (answer = r));
    };
    e.relay.expiryEvent({ questionId: e.qid });
    e.setNow(T0 + 16 * MIN);
    const first = e.bridge.catchUp();
    await reached;
    e.relay.push('decision.deleted', e.qid, null, {});
    const second = e.bridge.catchUp();
    await until(async () => (await e.row()).local_status === 'cancelled');
    answer({ outcome: 'ambiguous', reason: 'enter_dropped' });
    await first;
    await second;
    const id = e.sink.typed[0]!.id;
    expect((await e.bridge.getDecision(e.qid)).advisoryTimeout).toMatchObject({
      notice: 'uncertain',
      injectionId: id,
    });
    await e.bridge.stop();
    const again = e.restart();
    await again.start({ socket: false });
    expect((await again.getDecision(e.qid)).advisoryTimeout).toMatchObject({
      notice: 'uncertain',
      injectionId: id,
    });
    expect(e.sink.typed).toHaveLength(1);
  });

  it('records a write found on screen after a restart as delivered', async () => {
    const e = await advised();
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    e.sink.inject = async (t, text, id) => {
      e.sink.typed.push({ target: t, text, id });
      entered();
      return new Promise<InjectResult>(() => {});
    };
    e.relay.expiryEvent({ questionId: e.qid });
    e.setNow(T0 + 16 * MIN);
    void e.bridge.catchUp();
    await reached;
    // The deletion is applied while the write is in flight; then the process dies before the sink answers.
    e.relay.push('decision.deleted', e.qid, null, {});
    void e.bridge.catchUp();
    await until(async () => (await e.row()).local_status === 'cancelled');
    expect(parseAnswers((await e.row()).answers_json)[0]).toMatchObject({ deliver: false });
    await e.bridge.stop();
    e.sink.inject = Object.getPrototypeOf(e.sink).inject.bind(e.sink);
    const again = e.restart();
    await again.start({ socket: false });
    expect((await again.getDecision(e.qid)).advisoryTimeout).toMatchObject({
      notice: 'delivered',
      injectionId: e.sink.typed[0]!.id,
    });
    expect(e.sink.typed).toHaveLength(1);
  });
});

describe('a deletion and a crash while the advisory notice is being written', () => {
  it('a crash with no marker found keeps the notice uncertain, never superseded', async () => {
    const e = await advised();
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    // The intent is written, then the process dies with nothing found on screen.
    e.sink.inject = async () => {
      entered();
      return new Promise<InjectResult>(() => {});
    };
    e.relay.expiryEvent({ questionId: e.qid });
    e.setNow(T0 + 16 * MIN);
    void e.bridge.catchUp();
    await reached;
    e.relay.push('decision.deleted', e.qid, null, {});
    void e.bridge.catchUp();
    await until(async () => (await e.row()).local_status === 'cancelled');
    await e.bridge.stop();
    e.sink.inject = Object.getPrototypeOf(e.sink).inject.bind(e.sink);
    const again = e.restart();
    await again.start({ socket: false });
    const v = await again.getDecision(e.qid);
    expect(v.advisoryTimeout).toMatchObject({
      notice: 'uncertain',
      injectionId: expect.any(String),
    });
    expect(await e.store.hasUncertainIntent(e.qid)).toBe(false);
    expect(e.sink.typed).toHaveLength(0);
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
    // Nothing has been read from the relay since the restart: a reopen may be waiting there, so neither the terminal
    // nor get_decision lets the plan go ahead yet.
    expect(await again.getDecision(e.qid)).toMatchObject({
      fallbackDue: false,
      advisoryTimeout: { disposition: 'fallback-due', notice: 'pending', deadline: DEADLINE },
    });
    const waiting = await getDecisionOverMcp(again, e.qid);
    expect(waiting.content[0]!.text).toContain('not settled yet');
    e.sink.panes.get('pane-1')!.idle = true;
    await again.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    await again.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    expect((await again.getDecision(e.qid)).fallbackDue).toBe(true);
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
    // What may have been typed said the plan was due: a later policy change, or a person's retry, never rewrites it.
    e.policy.advisoryQuestions = false;
    await e.bridge.retryDelivery(e.qid);
    expect(e.sink.typed).toHaveLength(1);
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      fallbackDue: true,
      advisoryTimeout: { disposition: 'fallback-due', notice: 'uncertain', injectionId: id },
    });
    e.policy.advisoryQuestions = true;
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
