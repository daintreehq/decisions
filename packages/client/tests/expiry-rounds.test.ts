import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '@daintreehq/decisions-protocol';
import {
  DecisionsBridge,
  EXPIRY_CLOCK_SKEW_MS,
  PolicyRegistry,
  RelayClient,
  parseAnswers,
  type InjectResult,
} from '../src/index.js';
import { origin, setupBridge } from './helpers.js';

const MIN = 60_000;
const DAY = 86_400_000;

/** A bridge on a clock the test moves, with one published question whose deadline is the 7-day default. */
async function asked() {
  let now = Date.now();
  const env = await setupBridge({ now: () => now });
  const r = await env.bridge.registerQuestion({
    origin: origin(),
    input: {
      question: 'Ship it?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    },
  });
  await env.bridge.pump();
  const qid = r.questionId;
  const desktop = { deviceId: env.identity.config.deviceId, keys: env.identity.keys };
  const deadline = (await env.store.getQuestion(qid))!.expires_at!;
  return {
    ...env,
    qid,
    desktop,
    /** The deadline the question was published with. */
    deadline,
    get now() {
      return now;
    },
    /** Set the bridge's clock to `ms` after (or before) an ISO time. */
    at(iso: string, ms = 0) {
      now = Date.parse(iso) + ms;
    },
    later(iso: string, ms: number) {
      return new Date(Date.parse(iso) + ms).toISOString();
    },
    rejected: async () =>
      (await env.store.listAudit(200))
        .filter((a) => a.event === 'event.rejected')
        .map((a) => a.result),
    row: async () => (await env.store.getQuestion(qid))!,
    /** The owner withdraws the question and reopens it into the next round with a signed deadline. */
    async reopen(round: number, expiresAt: string | null) {
      await env.relay.plainActionEvent({
        questionId: qid,
        signer: desktop,
        action: 'cancel',
        expectedRevision: round - 1,
      });
      await env.relay.plainActionEvent({
        questionId: qid,
        signer: desktop,
        action: 'reopen',
        expectedRevision: round - 1,
        expiresAt,
      });
    },
  };
}

describe('a reopen carries its signed deadline into the stored row', () => {
  it('a reopen to never clears the earlier deadline in storage and get_decision', async () => {
    const e = await asked();
    expect(e.deadline).toBe(new Date(e.now + DEFAULTS.questionExpiryMs).toISOString());
    await e.reopen(1, null);
    await e.bridge.catchUp();
    expect((await e.row()).expires_at).toBeNull();
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'open',
      revision: 1,
      expiresAt: null,
    });
  });

  it('reopened first to a later time and then to never, each signed round is what the bridge reports', async () => {
    const e = await asked();
    const later = e.later(e.deadline, 3 * DAY);
    await e.reopen(1, later);
    await e.bridge.catchUp();
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'open',
      revision: 1,
      expiresAt: later,
    });
    await e.reopen(2, null);
    await e.bridge.catchUp();
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'open',
      revision: 2,
      expiresAt: null,
    });
    expect(await e.rejected()).toEqual([]);
  });
});

describe('only an expiry of the current round, at its signed deadline, closes the question', () => {
  it('an expiry swept late closes the round, and its notice records when the deadline elapsed', async () => {
    const e = await asked();
    e.relay.expiryEvent({ questionId: e.qid, at: e.later(e.deadline, 30 * MIN) });
    e.at(e.deadline, 60 * MIN);
    await e.bridge.catchUp();
    const row = await e.row();
    expect(row.local_status).toBe('expired');
    expect(parseAnswers(row.answers_json)).toMatchObject([
      { kind: 'expired', revision: 0, created_at: e.deadline, delivered: true },
    ]);
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('NOT authorised to continue');
    expect((await e.bridge.getDecision(e.qid)).closedReason).toBe('expired');
  });

  it('an expiry exactly at the deadline is in time', async () => {
    const e = await asked();
    e.relay.expiryEvent({ questionId: e.qid });
    e.at(e.deadline);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('expired');
  });

  it('an expiry the relay dates before the signed deadline is never believed', async () => {
    const e = await asked();
    e.relay.expiryEvent({ questionId: e.qid, at: e.later(e.deadline, -MIN) });
    e.relay.expiryEvent({
      questionId: e.qid,
      at: e.deadline,
      occurredAt: e.later(e.deadline, -MIN),
    });
    e.at(e.deadline, 60 * MIN);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('open');
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.rejected()).toEqual(['expiry-before-deadline', 'expiry-before-deadline']);
  });

  it('a claim dated at the deadline but held well before it here is rejected, and stays rejected', async () => {
    const e = await asked();
    e.relay.expiryEvent({ questionId: e.qid });
    e.at(e.deadline, -10 * MIN);
    await e.bridge.catchUp();
    e.at(e.deadline, 10 * MIN);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('open');
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.rejected()).toEqual(['expiry-before-deadline']);
  });

  it('a claim held just before the deadline here waits, in ledger order, until it has passed', async () => {
    const e = await asked();
    e.relay.expiryEvent({ questionId: e.qid });
    e.at(e.deadline, -EXPIRY_CLOCK_SKEW_MS / 4);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('open');
    expect((await e.store.listAudit(50)).map((a) => a.event)).toContain('event.deferred');
    e.at(e.deadline, 1);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('expired');
    expect(parseAnswers((await e.row()).answers_json)[0]!.created_at).toBe(e.deadline);
    expect(e.sink.typed).toHaveLength(1);
  });

  it("an earlier round's expiry, delivered after both deadlines, never closes the round in force", async () => {
    const e = await asked();
    const later = e.later(e.deadline, 3 * DAY);
    await e.reopen(1, later);
    e.relay.expiryEvent({ questionId: e.qid, revision: 0, at: e.later(later, MIN) });
    e.relay.expiryEvent({ questionId: e.qid, revision: null, at: e.later(later, MIN) });
    e.at(later, 2 * MIN);
    await e.bridge.catchUp();
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'open',
      revision: 1,
      expiresAt: later,
      closedReason: null,
    });
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.rejected()).toEqual(['expiry-for-another-round', 'expiry-for-another-round']);
  });

  it('a round reopened to never cannot expire, whatever the relay dates its claim', async () => {
    const e = await asked();
    await e.reopen(1, null);
    e.relay.expiryEvent({ questionId: e.qid, revision: 1, at: e.later(e.deadline, MIN) });
    e.at(e.deadline, 2 * MIN);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('open');
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.rejected()).toEqual(['expiry-without-deadline']);
  });

  it("an expiry naming another host, a malformed one and a stale one are rejected", async () => {
    const e = await asked();
    e.relay.expiryEvent({ questionId: e.qid, targetHostId: 'h'.repeat(32) });
    e.relay.push('decision.expired', e.qid, 0, { reason: 'expired' });
    e.at(e.deadline, MIN);
    await e.bridge.catchUp();
    // Ahead of an event the row already holds: not the ledger's order.
    const stale = e.relay.expiryEvent({ questionId: e.qid });
    await e.store.updateQuestion(e.qid, { remote_event_seq: stale.seq + 5 });
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('open');
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.rejected()).toEqual([
      'expiry-for-another-host',
      'malformed-event',
      'stale-expiry',
    ]);
  });

  it('a duplicate expiry changes nothing: one entry, one notice', async () => {
    const e = await asked();
    e.relay.expiryEvent({ questionId: e.qid });
    e.relay.expiryEvent({ questionId: e.qid });
    e.at(e.deadline, MIN);
    await e.bridge.catchUp();
    await e.bridge.catchUp();
    expect(parseAnswers((await e.row()).answers_json)).toHaveLength(1);
    expect(e.sink.typed).toHaveLength(1);
  });

  it('a timely answer already in force stays in force when the expiry follows it', async () => {
    const e = await asked();
    await e.relay.answerEvent({ questionId: e.qid, phone: e.phone, options: ['approve'] });
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    e.relay.expiryEvent({ questionId: e.qid, revision: 1 });
    e.at(e.deadline, MIN);
    await e.bridge.catchUp();
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'human-answered',
      choice: 'approve',
      closedReason: null,
    });
    expect(parseAnswers((await e.row()).answers_json).map((a) => a.kind)).toEqual(['answer']);
    expect(e.sink.typed).toHaveLength(1);
  });
});

describe('the create receipt never takes back what the ledger already applied', () => {
  it('an answer applied before the receipt arrives stays the answer in force', async () => {
    const env = await setupBridge();
    env.relay.onCreated = async (qid) => {
      env.relay.onCreated = null;
      await env.relay.answerEvent({ questionId: qid, phone: env.phone, text: 'go' });
      await env.bridge.catchUp();
    };
    const r = await env.bridge.registerQuestion({ origin: origin(), input: { question: 'Ship it?' } });
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'human-answered',
      revision: 1,
      provenance: 'human',
      text: 'go',
    });
    expect(env.sink.typed).toHaveLength(1);
  });
});

describe('closure notices of a superseded round are never typed', () => {
  it('an expiry notice held by a busy pane is withdrawn by a reopen, and the new round still delivers', async () => {
    const e = await asked();
    e.sink.panes.get('pane-1')!.idle = false;
    e.relay.expiryEvent({ questionId: e.qid });
    e.at(e.deadline, MIN);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('expired');
    await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: null,
    });
    await e.bridge.catchUp();
    expect(parseAnswers((await e.row()).answers_json)).toMatchObject([
      { kind: 'expired', revision: 0, deliver: false, delivered: false },
    ]);
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    await e.relay.answerEvent({
      questionId: e.qid,
      phone: e.phone,
      options: ['approve'],
      expectedRevision: 1,
    });
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('revision: 2');
    expect(e.sink.typed[0]!.text).not.toContain('NOT authorised');
  });

  it("a person's decline held by a busy pane is withdrawn by a reopen too", async () => {
    const e = await asked();
    e.sink.panes.get('pane-1')!.idle = false;
    await e.relay.plainActionEvent({ questionId: e.qid, signer: e.phone, action: 'cancel' });
    await e.bridge.catchUp();
    await e.relay.plainActionEvent({ questionId: e.qid, signer: e.desktop, action: 'reopen' });
    await e.bridge.catchUp();
    e.sink.panes.get('pane-1')!.idle = true;
    await e.bridge.notifyPaneIdle();
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'open',
      revision: 1,
      closedReason: null,
    });
  });

  it('a reopen waits for a closure notice already being written, then opens the next round', async () => {
    const e = await asked();
    const inject = e.sink.inject.bind(e.sink);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let writing!: () => void;
    const started = new Promise<void>((r) => (writing = r));
    e.sink.inject = async (t, text, id): Promise<InjectResult> => {
      writing();
      await gate;
      return inject(t, text, id);
    };
    e.relay.expiryEvent({ questionId: e.qid });
    e.at(e.deadline, MIN);
    const first = e.bridge.catchUp();
    await started;
    await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: null,
    });
    const second = e.bridge.catchUp();
    await new Promise((r) => setTimeout(r, 20));
    // The notice was admitted first: the reopen waits for the sink's answer instead of overtaking it.
    expect((await e.row()).local_status).toBe('expired');
    release();
    await Promise.all([first, second]);
    const row = await e.row();
    expect(row).toMatchObject({ local_status: 'open', question_revision: 1, expires_at: null });
    expect(parseAnswers(row.answers_json)).toMatchObject([
      { kind: 'expired', revision: 0, delivered: true },
    ]);
    expect(e.sink.typed).toHaveLength(1);
  });

  it('after a restart, an interrupted write of a notice a reopen withdrew holds nothing back', async () => {
    const e = await asked();
    e.sink.panes.get('pane-1')!.idle = false;
    e.relay.expiryEvent({ questionId: e.qid });
    e.at(e.deadline, MIN);
    await e.bridge.catchUp();
    // What a bridge that crashed mid-write leaves behind: the intent, and no marker in the pane.
    await e.store.putIntent({
      injection_id: 'crashed-intent-0001',
      question_id: e.qid,
      answer_revision: 0,
      message_id: null,
      host_id: 'host-local',
      pane_id: 'pane-1',
      terminal_generation: 1,
      ownership_principal: 'principal-1',
      agent_incarnation: 'inc-1',
      state: 'intent',
      created_at: e.now,
      updated_at: e.now,
    });
    await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: null,
    });
    await e.bridge.catchUp();
    await e.bridge.stop();
    e.sink.panes.get('pane-1')!.idle = true;
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
      policy: new PolicyRegistry(),
      pumpIntervalMs: 0,
      now: () => e.now,
    });
    await again.start({ socket: false });
    await again.pump(); // the one start() runs in the background
    expect((await e.store.getIntent('crashed-intent-0001'))!.state).toBe('abandoned');
    expect((await e.row()).delivery_status).not.toBe('delivery-uncertain');
    await e.relay.answerEvent({
      questionId: e.qid,
      phone: e.phone,
      options: ['approve'],
      expectedRevision: 1,
    });
    await again.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('revision: 2');
    await again.stop();
  });
});

describe('rows reopened before reopens kept their deadline are reconciled from verified history', () => {
  type Env = Awaited<ReturnType<typeof asked>>;
  /** A fresh bridge over the same store and relay, as after an upgrade and a restart. */
  async function restart(e: Env) {
    await e.bridge.stop();
    return new DecisionsBridge({
      identity: e.identity,
      store: e.store,
      sink: e.sink,
      client: new RelayClient({
        identity: e.identity,
        fetch: e.relay.fetch,
        sleep: async () => {},
        maxRetries: 0,
      }),
      policy: new PolicyRegistry(),
      pumpIntervalMs: 0,
      now: () => e.now,
    });
  }
  /** Reopened to `expiresAt`, stored the way an earlier bridge left it: the first round's deadline kept. */
  async function legacy(expiresAt: string | null, before: (e: Env) => Promise<void> = async () => {}) {
    const e = await asked();
    await e.reopen(1, expiresAt);
    await before(e);
    await e.bridge.catchUp();
    await e.store.updateQuestion(e.qid, { expires_at: e.deadline });
    return { ...e, again: await restart(e) };
  }
  const events = async (e: Env) => (await e.store.listAudit(100)).map((a) => a.event);
  const directoryReads = (e: Env) => e.relay.calls.filter((c) => c.path.endsWith('/devices')).length;

  it('the next pass takes the deadline of the verified reopen that started the round', async () => {
    const e = await legacy(null);
    // A later event of the same round (a proxy abstention, say) has moved the row's ledger position on.
    await e.store.updateQuestion(e.qid, { remote_event_seq: 999 });
    await e.again.catchUp();
    expect(await e.again.getDecision(e.qid)).toMatchObject({
      status: 'open',
      revision: 1,
      expiresAt: null,
    });
    expect(await events(e)).toContain('round.reconciled');
    // An expiry against the stale deadline is now one against no deadline at all.
    e.relay.expiryEvent({ questionId: e.qid, revision: 1, at: e.later(e.deadline, MIN) });
    e.at(e.deadline, 2 * MIN);
    await e.again.catchUp();
    expect((await e.row()).local_status).toBe('open');
  });

  it('a reopen to a later time is reconciled to that time', async () => {
    let later = '';
    const e = await legacy(null, async (x) => {
      later = x.later(x.deadline, 2 * DAY);
      await x.reopen(2, later);
    });
    await e.store.updateQuestion(e.qid, { expires_at: e.deadline });
    await e.again.catchUp();
    expect(await e.again.getDecision(e.qid)).toMatchObject({ revision: 2, expiresAt: later });
  });

  it('two verified reopens into the same round are ambiguous: the row is left alone', async () => {
    const e = await legacy(null, async (x) => {
      // The old bridge rejects the second (the question is already open) but keeps it with the rest.
      await x.relay.plainActionEvent({
        questionId: x.qid,
        signer: x.desktop,
        action: 'reopen',
        expectedRevision: 0,
        expiresAt: x.later(x.deadline, DAY),
      });
    });
    await e.again.catchUp();
    expect((await e.row()).expires_at).toBe(e.deadline);
    expect(await events(e)).toContain('round.ambiguous');
    expect(await events(e)).not.toContain('round.reconciled');
  });

  it('a row whose deadline already matches costs no verification', async () => {
    const e = await asked();
    await e.reopen(1, null);
    await e.bridge.catchUp();
    const again = await restart(e);
    const reads = directoryReads(e);
    await again.catchUp();
    expect(directoryReads(e)).toBe(reads);
    expect(await events(e)).not.toContain('round.reconciled');
  });
});
