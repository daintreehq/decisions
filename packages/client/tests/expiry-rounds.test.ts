import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DEFAULTS, PROTOCOL_VERSION, type LedgerEvent } from '@daintreehq/decisions-protocol';
import {
  DecisionsBridge,
  EXPIRY_CLOCK_SKEW_MS,
  PolicyRegistry,
  RelayClient,
  parseAnswers,
  supersededClosure,
  type InjectResult,
} from '../src/index.js';
import { FakeSocket, origin, setupBridge, tick } from './helpers.js';

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

  it('announces an expiry as an expiry, never as an answer', async () => {
    const e = await asked();
    const seen: [string, string][] = [];
    e.bridge.on('delivered', (id, what) => seen.push([id, what]));
    e.relay.expiryEvent({ questionId: e.qid, at: e.deadline });
    e.at(e.deadline, MIN);
    await e.bridge.catchUp();
    expect(seen).toEqual([[e.qid, 'expiry']]);
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
    e.relay.expiryEvent({
      questionId: e.qid,
      at: e.later(e.deadline, -MIN),
      occurredAt: e.deadline,
    });
    e.at(e.deadline, 60 * MIN);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('open');
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.rejected()).toEqual([
      'expiry-before-deadline',
      'expiry-before-deadline',
      'expiry-before-deadline',
    ]);
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

  it('a claim stored well before the deadline stays early, however late it is first applied', async () => {
    const e = await asked();
    const other = await e.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'And this?' },
    });
    await e.bridge.pump();
    // An event ahead of the claim that cannot be verified yet holds the ledger: the claim is stored, not applied.
    await e.relay.answerEvent({ questionId: other.questionId, phone: e.phone, text: 'yes' });
    e.relay.expiryEvent({ questionId: e.qid });
    e.relay.devicesFail = true;
    e.at(e.deadline, -10 * MIN);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('open');
    e.relay.devicesFail = false;
    e.at(e.deadline, 10 * MIN);
    await e.bridge.catchUp();
    expect((await e.bridge.getDecision(other.questionId)).status).toBe('human-answered');
    expect((await e.row()).local_status).toBe('open');
    expect(await e.rejected()).toEqual(['expiry-before-deadline']);
  });

  it('a claim held just before the deadline here waits, in ledger order, until it has passed', async () => {
    const e = await asked();
    const other = await e.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'And this?' },
    });
    await e.bridge.pump();
    e.relay.expiryEvent({ questionId: e.qid });
    await e.relay.answerEvent({ questionId: other.questionId, phone: e.phone, text: 'yes' });
    e.at(e.deadline, -EXPIRY_CLOCK_SKEW_MS / 4);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('open');
    // Nothing behind it overtakes it.
    expect((await e.bridge.getDecision(other.questionId)).status).toBe('open');
    expect((await e.store.listAudit(50)).map((a) => a.event)).toContain('event.deferred');
    e.at(e.deadline, 1);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('expired');
    expect((await e.bridge.getDecision(other.questionId)).status).toBe('human-answered');
    expect(parseAnswers((await e.row()).answers_json)[0]!.created_at).toBe(e.deadline);
  });

  it('a claim for the reopened round between its two deadlines waits for the later one', async () => {
    const e = await asked();
    const later = e.later(e.deadline, 3 * DAY);
    await e.reopen(1, later);
    e.relay.expiryEvent({ questionId: e.qid, revision: 1, at: e.later(e.deadline, DAY) });
    e.relay.expiryEvent({ questionId: e.qid, revision: 2, at: e.later(later, MIN) });
    e.at(e.deadline, DAY + MIN);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('open');
    expect(e.sink.typed).toHaveLength(0);
    expect(await e.rejected()).toEqual(['expiry-before-deadline', 'expiry-for-another-round']);
    e.relay.expiryEvent({ questionId: e.qid, revision: 1, at: later });
    e.at(later, MIN);
    await e.bridge.catchUp();
    expect((await e.row()).local_status).toBe('expired');
    expect(parseAnswers((await e.row()).answers_json).at(-1)).toMatchObject({
      kind: 'expired',
      revision: 1,
      created_at: later,
    });
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

  it('an expiry naming another host, a malformed one and a stale one are rejected', async () => {
    const e = await asked();
    e.relay.expiryEvent({ questionId: e.qid, targetHostId: 'h'.repeat(32) });
    e.relay.push('decision.expired', e.qid, 0, { reason: 'expired' });
    e.at(e.deadline, MIN);
    await e.bridge.catchUp();
    // Ahead of an event the row already holds: not the ledger's order.
    const stale = e.relay.expiryEvent({ questionId: e.qid });
    await e.store.updateQuestion(e.qid, { remote_event_seq: stale.seq });
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
    let answered = 0;
    env.relay.onCreated = async (qid) => {
      env.relay.onCreated = null;
      answered = (await env.relay.answerEvent({ questionId: qid, phone: env.phone, text: 'go' }))
        .seq;
      await env.bridge.catchUp();
    };
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Ship it?' },
    });
    await env.bridge.pump();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'human-answered',
      revision: 1,
      provenance: 'human',
      text: 'go',
    });
    expect((await env.store.getQuestion(r.questionId))!.remote_event_seq).toBe(answered);
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
    expect(parseAnswers((await e.row()).answers_json)).toMatchObject([
      { kind: 'declined', revision: 0, deliver: true, delivered: false },
    ]);
    await e.relay.plainActionEvent({ questionId: e.qid, signer: e.desktop, action: 'reopen' });
    await e.bridge.catchUp();
    expect(parseAnswers((await e.row()).answers_json)).toMatchObject([
      { kind: 'declined', revision: 0, deliver: false, delivered: false },
    ]);
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
    const delivery = (
      e.bridge as unknown as {
        delivery: { closureWrite(id: string): Promise<void> | null };
      }
    ).delivery;
    const check = delivery.closureWrite.bind(delivery);
    let waits!: () => void;
    const waiting = new Promise<void>((r) => (waits = r));
    delivery.closureWrite = (id) => {
      const w = check(id);
      if (w) waits();
      return w;
    };
    let secondDone = false;
    const second = e.bridge.catchUp().then(() => (secondDone = true));
    try {
      // The notice was admitted first: the reopen finds it being written and waits for the sink's answer.
      await Promise.race([
        waiting,
        second.then(() => Promise.reject(new Error('the reopen did not wait'))),
      ]);
      expect(secondDone).toBe(false);
      expect((await e.row()).local_status).toBe('expired');
    } finally {
      release();
    }
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

describe('a superseded closure notice holds nothing back', () => {
  it('a crash mid-write, then a reopen first applied after the restart, holds nothing back', async () => {
    const e = await asked();
    const inject = e.sink.inject.bind(e.sink);
    // The sink never answers: the process dies with the intent written and nothing typed.
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    e.sink.inject = async () => {
      entered();
      return new Promise<InjectResult>(() => {});
    };
    e.relay.expiryEvent({ questionId: e.qid });
    e.at(e.deadline, MIN);
    void e.bridge.catchUp();
    await reached;
    await e.bridge.stop();
    e.sink.inject = inject;
    // While it was down, the owner reopened the question; the next round's answer follows.
    await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: null,
    });
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
    await again.pump();
    await e.relay.answerEvent({
      questionId: e.qid,
      phone: e.phone,
      options: ['approve'],
      expectedRevision: 1,
    });
    await again.catchUp();
    // Recovery found no marker while the old round was still in force; the reopen then released that write.
    expect((await e.store.listAudit(100)).map((a) => [a.event, a.result])).toEqual(
      expect.arrayContaining([
        ['delivery.attention', 'crash_unreconciled'],
        ['delivery.superseded', 'uncertain'],
      ]),
    );
    expect(await e.store.hasUncertainIntent(e.qid)).toBe(false);
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).toContain('revision: 2');
    await again.stop();
  });

  it("an ambiguous write of an old round's notice stops holding the question once it is reopened", async () => {
    const e = await asked();
    e.sink.injectBehaviour = 'ambiguous';
    e.relay.expiryEvent({ questionId: e.qid });
    e.at(e.deadline, MIN);
    await e.bridge.catchUp();
    expect((await e.row()).delivery_status).toBe('delivery-uncertain');
    expect(await e.store.hasUncertainIntent(e.qid)).toBe(true);
    e.sink.injectBehaviour = 'ok';
    await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: null,
    });
    await e.relay.answerEvent({
      questionId: e.qid,
      phone: e.phone,
      options: ['approve'],
      expectedRevision: 1,
    });
    await e.bridge.catchUp();
    expect(await e.store.hasUncertainIntent(e.qid)).toBe(false);
    expect(e.sink.typed).toHaveLength(2);
    expect(e.sink.typed[1]!.text).toContain('revision: 2');
    expect((await e.row()).delivery_status).toBe('terminal-delivered');
    expect((await e.store.listAudit(100)).map((a) => [a.event, a.result])).toContainEqual([
      'delivery.superseded',
      'uncertain',
    ]);
  });

  it('a reopen still applies when the writes it would release cannot be read', async () => {
    const e = await asked();
    e.store.uncertainIntents = async () => {
      throw new Error('disk unavailable');
    };
    e.relay.expiryEvent({ questionId: e.qid });
    e.at(e.deadline, MIN);
    await e.bridge.catchUp();
    await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: null,
    });
    await e.bridge.catchUp();
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'open',
      revision: 1,
      expiresAt: null,
    });
  });

  it('an intent at a revision that also holds an answer is never taken for a superseded notice', () => {
    const entry = (kind: 'answer' | 'expired', revision: number) => ({
      entry_id: `${kind}-${revision}`,
      kind,
      action: kind === 'answer' ? 'answer' : 'expire',
      revision,
      source: kind === 'answer' ? 'human' : 'system',
      correction: false,
      created_at: new Date().toISOString(),
      deliver: false,
      delivered: false,
      sealed: null,
    });
    const both = JSON.stringify([entry('answer', 1), entry('expired', 1)]);
    expect(
      supersededClosure({ answers_json: both, local_status: 'cancelled', question_revision: 1 }, 1),
    ).toBe(false);
    const notice = JSON.stringify([entry('expired', 1)]);
    expect(
      supersededClosure({ answers_json: notice, local_status: 'open', question_revision: 2 }, 1),
    ).toBe(true);
    // Typed before the reopen, it still names that round's notice and nothing else.
    const typed = JSON.stringify([{ ...entry('expired', 1), delivered: true }]);
    expect(
      supersededClosure({ answers_json: typed, local_status: 'open', question_revision: 2 }, 1),
    ).toBe(true);
    expect(
      supersededClosure({ answers_json: notice, local_status: 'expired', question_revision: 1 }, 1),
    ).toBe(false);
  });

  it('an old closure flag an earlier bridge left behind never keeps a delivered answer from counting', async () => {
    const e = await asked();
    e.sink.panes.get('pane-1')!.idle = false;
    e.relay.expiryEvent({ questionId: e.qid });
    e.at(e.deadline, MIN);
    await e.bridge.catchUp();
    await e.relay.plainActionEvent({ questionId: e.qid, signer: e.desktop, action: 'reopen' });
    await e.bridge.catchUp();
    // What an earlier bridge stored: the reopen applied, the expiry notice still marked to deliver.
    const row = await e.row();
    await e.store.updateQuestion(e.qid, {
      answers_json: JSON.stringify(
        parseAnswers(row.answers_json).map((a) => ({ ...a, deliver: true })),
      ),
    });
    e.sink.panes.get('pane-1')!.idle = true;
    await e.relay.answerEvent({
      questionId: e.qid,
      phone: e.phone,
      options: ['approve'],
      expectedRevision: 1,
    });
    await e.bridge.catchUp();
    expect(e.sink.typed).toHaveLength(1);
    expect(e.sink.typed[0]!.text).not.toContain('NOT authorised');
    expect((await e.row()).delivery_status).toBe('terminal-delivered');
  });

  /** Long enough for a loaded machine; the tests' timeout leaves room for every wait, so a stuck step fails here. */
  const WAIT = { timeout: 2_000, interval: 5 };

  /**
   * A socket the test drives by hand. Every step waits for the state it reads next, never for a fixed time: the
   * socket opens only once its signed ticket request is answered, and applies frames one at a time in the background.
   */
  function handDriven() {
    let ws: FakeSocket | undefined;
    const handled: number[] = [];
    let typedAtLive: number | undefined;
    return {
      /** The bridge's socket factory, so the socket the test reads is the one its own bridge opened. */
      webSocket: (url: string) => (ws = new FakeSocket(url)),
      /** Called before `start()`. The bridge is stopped when the test ends, whatever its outcome. */
      watch({ bridge, sink }: Awaited<ReturnType<typeof setupBridge>>) {
        onTestFinished(() => bridge.stop());
        // Read as the state changes: a notice typed only after `live` is not one the replay's end typed.
        bridge.on('socket', (s) => {
          if (s === 'live') typedAtLive ??= sink.typed.length;
        });
        // The socket reaches this handler through an arrow that looks it up for each frame, so this sees them all.
        const b = bridge as unknown as { onSocketEvent(ev: LedgerEvent): Promise<void> };
        const onEvent = b.onSocketEvent.bind(b);
        b.onSocketEvent = async (ev) => {
          await onEvent(ev);
          handled.push(ev.seq);
        };
      },
      /** The socket `start()` opened, once its ticket request has been answered. */
      async opened(): Promise<FakeSocket> {
        await vi.waitFor(() => expect(ws, 'the socket start() opens').toBeDefined(), WAIT);
        return ws!;
      },
      /** Event frame `seq`, and every frame before it, is stored and applied, and delivered if it would be. */
      handled: (seq: number) =>
        vi.waitFor(() => expect(handled, 'the replayed events handled').toContain(seq), WAIT),
      /** The replay's last segment is caught up, its pump and deliveries finished: how many were typed by then. */
      async ended(): Promise<number> {
        await vi.waitFor(
          () => expect(typedAtLive, 'the socket live after the replay').toBeDefined(),
          WAIT,
        );
        return typedAtLive!;
      },
    };
  }

  it('a socket replay types no closure notice a later event in the same replay replaced', async () => {
    let now = Date.now();
    const socket = handDriven();
    const env = await setupBridge({ now: () => now, webSocket: socket.webSocket });
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Ship it?' },
    });
    await env.bridge.pump();
    const qid = r.questionId;
    const deadline = (await env.store.getQuestion(qid))!.expires_at!;
    const desktop = { deviceId: env.identity.config.deviceId, keys: env.identity.keys };
    now = Date.parse(deadline) + MIN;
    socket.watch(env);
    await env.bridge.start();
    await env.bridge.pump(); // the one start() runs, drained before any replay frame arrives
    const expired = env.relay.expiryEvent({ questionId: qid });
    const reopened = await env.relay.plainActionEvent({
      questionId: qid,
      signer: desktop,
      action: 'reopen',
      expiresAt: null,
    });
    const ws = await socket.opened();
    ws.recv({
      t: 'hello',
      protocol_version: PROTOCOL_VERSION,
      device_id: env.identity.config.deviceId,
      role: 'owner-desktop',
      key_epoch: 1,
      high_water: reopened.seq,
      server_time: new Date().toISOString(),
    });
    for (const ev of env.relay.events.filter((x) => x.seq <= expired.seq))
      ws.recv({ t: 'event', event: ev });
    await socket.handled(expired.seq);
    // Applied, but held while the replay goes on.
    expect((await env.store.getQuestion(qid))!.local_status).toBe('expired');
    expect(env.sink.typed).toHaveLength(0);
    ws.recv({ t: 'event', event: reopened });
    ws.recv({ t: 'caught_up', high_water: reopened.seq, has_more: false });
    expect(await socket.ended()).toBe(0);
    expect((await env.store.getQuestion(qid))!.local_status).toBe('open');
    expect(env.sink.typed).toHaveLength(0);
  }, 10_000);

  it('a closure notice still in force when a replay ends is typed then', async () => {
    let now = Date.now();
    const socket = handDriven();
    const env = await setupBridge({ now: () => now, webSocket: socket.webSocket });
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Ship it?' },
    });
    await env.bridge.pump();
    const deadline = (await env.store.getQuestion(r.questionId))!.expires_at!;
    now = Date.parse(deadline) + MIN;
    socket.watch(env);
    await env.bridge.start();
    await env.bridge.pump(); // the one start() runs, drained before any replay frame arrives
    const expired = env.relay.expiryEvent({ questionId: r.questionId });
    const ws = await socket.opened();
    ws.recv({
      t: 'hello',
      protocol_version: PROTOCOL_VERSION,
      device_id: env.identity.config.deviceId,
      role: 'owner-desktop',
      key_epoch: 1,
      high_water: expired.seq,
      server_time: new Date().toISOString(),
    });
    for (const ev of env.relay.events) ws.recv({ t: 'event', event: ev });
    await socket.handled(expired.seq);
    expect((await env.store.getQuestion(r.questionId))!.local_status).toBe('expired');
    expect(env.sink.typed).toHaveLength(0);
    ws.recv({ t: 'caught_up', high_water: expired.seq, has_more: false });
    // Typed by the replay's end, and once.
    expect(await socket.ended()).toBe(1);
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain('NOT authorised to continue');
  }, 10_000);
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
  async function legacy(
    expiresAt: string | null | ((e: Env) => string | null),
    before: (e: Env) => Promise<void> = async () => {},
  ) {
    const e = await asked();
    await e.reopen(1, typeof expiresAt === 'function' ? expiresAt(e) : expiresAt);
    await before(e);
    await e.bridge.catchUp();
    await e.store.updateQuestion(e.qid, { expires_at: e.deadline });
    // An earlier bridge never searched its history: the flag this test's own bridge set is not there.
    (e.store as unknown as { meta: Map<string, string> }).meta.delete('rounds-reconciled');
    return { ...e, again: await restart(e) };
  }
  const events = async (e: Env) => (await e.store.listAudit(100)).map((a) => a.event);
  const directoryReads = (e: Env) =>
    e.relay.calls.filter((c) => c.path.endsWith('/devices')).length;
  /** The background pass has settled every question and marked the store. */
  const settled = (e: Env) =>
    vi.waitFor(async () => expect(await e.store.getMeta('rounds-reconciled')).not.toBeNull());

  it('the next pass takes the deadline of the verified reopen that started the round', async () => {
    const e = await legacy(null);
    // The row's ledger position is not the reopen's (a proxy abstention in the same round moves it, say).
    const cancel = e.relay.events.find((ev) => ev.event_type === 'decision.cancelled')!;
    await e.store.updateQuestion(e.qid, { remote_event_seq: cancel.seq });
    await e.again.catchUp();
    await settled(e);
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
    expect(await e.rejected()).toEqual(['expiry-without-deadline']);
  });

  it('a reopen whose signature does not verify is no evidence', async () => {
    const e = await legacy(null, async (x) => {
      const reopen = x.relay.events.find((ev) => ev.event_type === 'decision.reopened')!;
      const data = reopen.data as { record: Record<string, unknown> };
      x.relay.push('decision.reopened', x.qid, 1, {
        ...data,
        record: { ...data.record, expires_at: x.later(x.deadline, DAY) },
      });
    });
    await e.store.updateQuestion(e.qid, { expires_at: e.deadline });
    (e.store as unknown as { meta: Map<string, string> }).meta.delete('rounds-reconciled');
    await e.again.catchUp();
    await settled(e);
    expect((await e.row()).expires_at).toBeNull();
    expect(await events(e)).not.toContain('round.ambiguous');
  });

  it('once a store has been searched, a restart does not search it again', async () => {
    const e = await legacy(null);
    await e.again.catchUp();
    await settled(e);
    expect((await e.row()).expires_at).toBeNull();
    await e.store.updateQuestion(e.qid, { expires_at: e.deadline });
    const third = await restart({ ...e, bridge: e.again });
    await third.catchUp();
    await tick(20);
    expect((await e.row()).expires_at).toBe(e.deadline);
  });

  it('a reopen to a later time is reconciled to that time', async () => {
    let later = '';
    const e = await legacy(null, async (x) => {
      later = x.later(x.deadline, 2 * DAY);
      await x.reopen(2, later);
    });
    await e.store.updateQuestion(e.qid, { expires_at: e.deadline });
    await e.again.catchUp();
    await settled(e);
    expect(await e.again.getDecision(e.qid)).toMatchObject({ revision: 2, expiresAt: later });
  });

  it('a row answered after its reopen is reconciled too, its answer untouched', async () => {
    const e = await legacy(null, async (x) => {
      await x.relay.answerEvent({
        questionId: x.qid,
        phone: x.phone,
        options: ['approve'],
        expectedRevision: 1,
      });
    });
    await e.store.updateQuestion(e.qid, { expires_at: e.deadline });
    await e.again.catchUp();
    await settled(e);
    expect(await e.again.getDecision(e.qid)).toMatchObject({
      status: 'human-answered',
      revision: 2,
      choice: 'approve',
      expiresAt: null,
    });
  });

  it('the same signed reopen relayed twice is one reopen, not an ambiguity', async () => {
    const e = await legacy(null, async (x) => {
      const reopen = x.relay.events.find((ev) => ev.event_type === 'decision.reopened')!;
      x.relay.push('decision.reopened', x.qid, 1, reopen.data);
    });
    await e.store.updateQuestion(e.qid, { expires_at: e.deadline });
    await e.again.catchUp();
    await settled(e);
    expect((await e.row()).expires_at).toBeNull();
    expect(await events(e)).not.toContain('round.ambiguous');
  });

  it('while the directory cannot be read, nothing waits: an expiry is judged by what the stored reopen signed', async () => {
    let other = '';
    const e = await legacy(null, async (x) => {
      other = (
        await x.bridge.registerQuestion({ origin: origin(), input: { question: 'And this?' } })
      ).questionId;
      await x.bridge.pump();
    });
    e.relay.expiryEvent({ questionId: e.qid, revision: 1, at: e.later(e.deadline, MIN) });
    e.relay.expiryEvent({ questionId: other });
    e.at(e.deadline, 2 * MIN);
    e.relay.devicesFail = true;
    await e.again.catchUp();
    await vi.waitFor(async () => expect(await events(e)).toContain('rounds.unreconciled'));
    // The row still holds the first round's deadline, but its reopen signed none: the claim is refused, at once.
    expect((await e.row()).expires_at).toBe(e.deadline);
    expect((await e.row()).local_status).toBe('open');
    expect(await e.rejected()).toEqual(['expiry-without-deadline']);
    expect((await e.again.getDecision(other)).status).toBe('expired');
    expect(await e.store.getMeta('rounds-reconciled')).toBeNull();
    // A minute on, with the directory back, the next pass repairs the row.
    e.relay.devicesFail = false;
    e.at(e.deadline, 4 * MIN);
    await e.again.catchUp();
    await settled(e);
    expect((await e.row()).expires_at).toBeNull();
  });

  it('reopens into one round that disagree, a deadline then none, count as none, before and after repair', async () => {
    let later = '';
    const e = await legacy(
      (x) => (later = x.later(x.deadline, DAY)),
      async (x) => {
        // A second signed reopen into the same round, with no deadline: the old bridge refused it, the question being
        // open already, but kept it with the rest.
        await x.relay.plainActionEvent({
          questionId: x.qid,
          signer: x.desktop,
          action: 'reopen',
          expectedRevision: 0,
          expiresAt: null,
        });
      },
    );
    await e.store.updateQuestion(e.qid, { expires_at: e.deadline });
    e.relay.devicesFail = true;
    e.relay.expiryEvent({ questionId: e.qid, revision: 1, at: e.later(later, MIN) });
    e.at(later, 2 * MIN);
    await e.again.catchUp();
    expect((await e.row()).local_status).toBe('open');
    expect(await e.rejected()).toEqual(['transition:invalid_state', 'expiry-without-deadline']);
    e.relay.devicesFail = false;
    e.at(later, 4 * MIN);
    await e.again.catchUp();
    await settled(e);
    expect((await e.row()).expires_at).toBeNull();
  });

  it('a forged earlier claim cannot stand in for a reopen the relay mislabelled', async () => {
    let later = '';
    const e = await legacy(
      (x) => (later = x.later(x.deadline, 2 * DAY)),
      async (x) => {
        const reopen = x.relay.events.find((ev) => ev.event_type === 'decision.reopened')!;
        reopen.question_revision = 99; // its data still says round 1, so the old bridge applied it
        const data = reopen.data as { record: Record<string, unknown> };
        x.relay.push('decision.reopened', x.qid, 1, {
          ...data,
          record: { ...data.record, expires_at: x.later(x.deadline, DAY) },
        });
      },
    );
    await e.store.updateQuestion(e.qid, { expires_at: e.deadline });
    e.relay.devicesFail = true;
    e.relay.expiryEvent({ questionId: e.qid, revision: 1, at: e.later(e.deadline, DAY + MIN) });
    e.at(e.deadline, DAY + 2 * MIN);
    await e.again.catchUp();
    expect((await e.row()).local_status).toBe('open');
    expect((await e.rejected()).at(-1)).toBe('expiry-before-deadline');
    expect(later).not.toBe('');
  });

  it('until a reopened row is repaired, an expiry before its signed later deadline is early', async () => {
    let later = '';
    const e = await legacy(null, async (x) => {
      later = x.later(x.deadline, 2 * DAY);
      await x.reopen(2, later);
    });
    await e.store.updateQuestion(e.qid, { expires_at: e.deadline });
    e.relay.devicesFail = true;
    e.relay.expiryEvent({ questionId: e.qid, revision: 2, at: e.later(e.deadline, MIN) });
    e.at(e.deadline, 2 * MIN);
    await e.again.catchUp();
    expect((await e.row()).local_status).toBe('open');
    expect(await e.rejected()).toEqual(['expiry-before-deadline']);
    e.relay.expiryEvent({ questionId: e.qid, revision: 2, at: later });
    e.at(later, MIN);
    await e.again.catchUp();
    expect((await e.row()).local_status).toBe('expired');
  });

  it('two verified reopens into the same round that disagree give the later deadline, here none', async () => {
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
    await settled(e);
    expect((await e.row()).expires_at).toBeNull();
    expect(await events(e)).toContain('round.ambiguous');
  });

  /** A custom store that cannot read its processed history: `processedEventsOfType` left out. Returns a restore. */
  const withoutHistory = (e: Env) => {
    const s = e.store as unknown as { processedEventsOfType?: unknown };
    s.processedEventsOfType = undefined;
    return () => void delete s.processedEventsOfType;
  };
  const errorsOf = (b: DecisionsBridge) => {
    const errors: Error[] = [];
    b.on('error', (err) => errors.push(err));
    return errors;
  };

  it('a store that cannot read its history says the repair could not run, and repairs once it can', async () => {
    let finite = '';
    const e = await legacy((x) => (finite = x.later(x.deadline, DAY)));
    // Asked with no deadline, reopened with one: the earlier bridge kept none.
    await e.store.updateQuestion(e.qid, { expires_at: null });
    const restore = withoutHistory(e);
    const errors = errorsOf(e.again);
    await e.again.catchUp();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.message).toContain('processedEventsOfType');
    expect(await events(e)).toContain('rounds.unreconciled');
    expect(await e.store.getMeta('rounds-reconciled')).toBeNull();
    expect((await e.row()).expires_at).toBeNull();
    // Said once a run, however many passes follow.
    e.at(new Date(e.now).toISOString(), 2 * MIN);
    await e.again.catchUp();
    await tick(20);
    expect(errors).toHaveLength(1);
    // Once the store can read it, the next start repairs the row, and the relay's expiry closes the question.
    restore();
    const third = await restart({ ...e, bridge: e.again });
    const later = errorsOf(third);
    await third.catchUp();
    await settled(e);
    expect((await e.row()).expires_at).toBe(finite);
    e.relay.expiryEvent({ questionId: e.qid, revision: 1, at: finite });
    e.at(finite, MIN);
    await third.catchUp();
    expect((await e.row()).local_status).toBe('expired');
    expect(later).toEqual([]);
  });

  it('a row whose deadline already matches costs no verification', async () => {
    const e = await asked();
    await e.reopen(1, null);
    await e.bridge.catchUp();
    (e.store as unknown as { meta: Map<string, string> }).meta.delete('rounds-reconciled');
    const again = await restart(e);
    const reads = directoryReads(e);
    await again.catchUp();
    await settled(e);
    expect(directoryReads(e)).toBe(reads);
    expect(await events(e)).not.toContain('round.reconciled');
    expect(await e.store.getMeta('rounds-reconciled')).not.toBeNull();
  });
});
