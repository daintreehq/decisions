import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  DecisionsBridge,
  MemoryKeyStore,
  type DecisionView,
  type WebSocketLike,
} from '@daintreehq/decisions-client';
import { PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import { FakeRelay, makeIdentity, makePhone } from '../../client/tests/helpers.js';
import { CliError, type Ctx } from '../src/runtime.js';
import { ReceiverLock } from '../src/receiver.js';
import { daemon } from '../src/commands/daemon.js';
import { doctor } from '../src/commands/ops.js';
import {
  OUTCOME_EXIT,
  ask,
  deliveryOf,
  getCmd,
  outcomeOf,
  parseWaitTimeout,
  waitCmd,
  type StopSignal,
} from '../src/commands/ask.js';

const root = mkdtempSync(join(tmpdir(), 'decisions-wait-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ADVISORY = 'advisory-deadlines-v1';
const FAST = { intervalMs: 10, retryBaseMs: 10, retryCapMs: 20 };
const QUICK = { socket: false as const, poll: FAST, tickMs: 10 };
const MIN = 60_000;
const never = () => new Promise<StopSignal>(() => undefined);

let n = 0;

/** A relay with one paired phone, and CLI contexts that share one state directory, as separate processes would. */
async function env(o: { advisory?: boolean } = {}) {
  const identity = await makeIdentity();
  const relay = new FakeRelay(identity);
  await relay.initOwner();
  const phone = await makePhone(identity);
  relay.devices.push(phone.cert);
  if (o.advisory) {
    relay.features = ['thread-messages-v1', ADVISORY];
    relay.deviceFeatures.set(phone.deviceId, [ADVISORY]);
  }
  const keyStore = new MemoryKeyStore();
  await keyStore.save(identity.stored);
  const home = join(root, `h${n++}`);
  const clock = { skew: 0 };
  /** One `decisions` process: its own output, the shared home and keys. */
  const proc = (over: Partial<Ctx> & { onLine?: (l: string) => void } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const calls: string[] = [];
    const ctx: Ctx = {
      home,
      json: over.json ?? true,
      fetch: (async (u: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${new URL(String(u)).pathname}`);
        return relay.fetch(u as string, init);
      }) as typeof fetch,
      keyStore,
      out: (l) => void out.push(l),
      outAcked: async (l) => {
        out.push(l);
        over.onLine?.(l);
      },
      err: (l) => void err.push(l),
      prompt: async () => '',
      env: {},
      now: () => Date.now() + clock.skew,
      readStdin: async () => '',
    };
    const records = () =>
      out.map((l) => JSON.parse(l) as { record: string } & Record<string, unknown>);
    return { ctx, out, err, calls, records };
  };
  const created = () => [...relay.questions.keys()];
  return { identity, relay, phone, home, clock, proc, created };
}

const result = <T extends { record: string }>(records: T[]) =>
  records.find((r) => r.record === 'result')!;

describe('the outcome a wait reports', () => {
  const base: DecisionView = {
    questionId: 'q',
    alias: 1,
    status: 'open',
    publication: 'accepted',
    requirement: 'human-required',
    deliveryStatus: 'desktop-received',
    revision: 0,
    expiresAt: null,
    replyMode: 'blocking',
    plannedFallback: null,
    errorCode: null,
    workflowGateId: null,
    provenance: null,
    answeredOn: null,
    closedReason: null,
    fallbackDue: false,
    advisoryTimeout: null,
    choice: null,
    text: '',
    reviewedDigestsMatch: false,
    answers: [],
    thread: [],
  };
  const v = (o: Partial<DecisionView>): DecisionView => ({ ...base, ...o });
  const timeout = (o: Partial<NonNullable<DecisionView['advisoryTimeout']>> = {}) => ({
    revision: 0,
    deadline: '2026-11-19T10:15:00.000Z',
    disposition: 'fallback-due' as const,
    notice: 'delivered' as const,
    injectionId: 'i',
    writeRefused: false,
    agentAction: 'unobserved' as const,
    ...o,
  });

  it('keeps waiting while the question is open, queued, or its publication is unconfirmed', () => {
    expect(outcomeOf(v({}))).toBeNull();
    expect(outcomeOf(v({ status: 'queued', publication: 'not-sent' }))).toBeNull();
    expect(outcomeOf(v({ status: 'queued', publication: 'possibly-committed' }))).toBeNull();
  });

  it('names every outcome, with its own exit status', () => {
    const cases: [Partial<DecisionView>, string][] = [
      [{ status: 'human-answered', provenance: 'human' }, 'answered'],
      [{ status: 'proxy-answered', provenance: 'proxy' }, 'answered'],
      [{ status: 'cancelled', closedReason: 'declined' }, 'declined'],
      [{ status: 'cancelled', closedReason: 'withdrawn' }, 'withdrawn'],
      [{ status: 'expired', closedReason: 'expired' }, 'expired'],
      [
        {
          status: 'expired',
          closedReason: 'expired',
          replyMode: 'advisory',
          fallbackDue: true,
          advisoryTimeout: timeout(),
        },
        'advisory-expired',
      ],
      [
        {
          status: 'publish-failed',
          publication: 'never-published',
          closedReason: 'never-published',
        },
        'never-published',
      ],
      [
        { status: 'publish-failed', publication: 'refused', errorCode: 'payload_too_large' },
        'refused',
      ],
    ];
    for (const [o, outcome] of cases) expect(outcomeOf(v(o))).toBe(outcome);
    expect(OUTCOME_EXIT).toEqual({
      answered: 0,
      declined: 10,
      withdrawn: 11,
      expired: 12,
      'advisory-expired': 13,
      'never-published': 14,
      refused: 15,
      'wait-timeout': 16,
    });
  });

  it('waits while an advisory plan is not settled, and calls a withheld one a plain expiry', () => {
    const expired = {
      status: 'expired' as const,
      closedReason: 'expired' as const,
      replyMode: 'advisory' as const,
      plannedFallback: 'I will use the in-memory fixture.',
      expiresAt: '2026-11-19T10:15:00.000Z',
    };
    // This computer still reads the relay (a reopen may be on its way): not settled, whatever the notice says.
    for (const notice of ['pending', 'delivered'] as const)
      expect(
        outcomeOf(v({ ...expired, fallbackDue: false, advisoryTimeout: timeout({ notice }) })),
      ).toBeNull();
    // Settled where this process receives; a process that only reads waits for the receiver's notice.
    const due = v({
      ...expired,
      fallbackDue: true,
      advisoryTimeout: timeout({ notice: 'pending' }),
    });
    expect(outcomeOf(due, { receiving: true })).toBe('advisory-expired');
    expect(outcomeOf(due)).toBeNull();
    expect(
      outcomeOf(
        v({ ...expired, fallbackDue: true, advisoryTimeout: timeout({ notice: 'uncertain' }) }),
      ),
    ).toBe('advisory-expired');
    // Nothing written (it needs attention) proves nothing to a process that only reads.
    const unwritten = v({
      ...expired,
      fallbackDue: true,
      advisoryTimeout: timeout({ notice: 'needs-attention' }),
    });
    expect(outcomeOf(unwritten)).toBeNull();
    expect(outcomeOf(unwritten, { receiving: true })).toBe('advisory-expired');
    // Unless the receiver's sink refused a write it admitted: it read the relay before it tried.
    const refused = v({
      ...expired,
      fallbackDue: true,
      advisoryTimeout: timeout({
        notice: 'needs-attention',
        injectionId: null,
        writeRefused: true,
      }),
    });
    expect(outcomeOf(refused)).toBe('advisory-expired');
    expect(deliveryOf(refused, 'advisory-expired')).toBe('needs-attention');
    // Still held where it reads (an event of its question waits to be applied): no outcome yet.
    expect(outcomeOf({ ...refused, fallbackDue: false })).toBeNull();
    // A policy that withholds it now: a plain expiry, from any process.
    expect(
      outcomeOf(
        v({
          ...expired,
          fallbackDue: false,
          advisoryTimeout: timeout({
            disposition: 'fallback-withheld',
            notice: 'needs-attention',
            writeRefused: true,
          }),
        }),
      ),
    ).toBe('expired');
    const withheld = v({
      ...expired,
      advisoryTimeout: timeout({ disposition: 'fallback-withheld', notice: 'pending' }),
    });
    expect(outcomeOf(withheld)).toBe('expired');
    expect(deliveryOf(withheld, 'expired')).toBe('pending');
    // An earlier round's timeout no longer describes a reopened question that expired again.
    const reopened = v({
      ...expired,
      revision: 1,
      replyMode: 'blocking',
      advisoryTimeout: timeout({ revision: 0, notice: 'uncertain' }),
      deliveryStatus: 'terminal-delivered',
    });
    expect(outcomeOf(reopened)).toBe('expired');
    expect(deliveryOf(reopened, 'expired')).toBe('delivered');
  });

  it('keeps the notice apart from the outcome: an uncertain write leaves the answer, and an open question waits', () => {
    const answered = v({
      status: 'human-answered',
      provenance: 'human',
      deliveryStatus: 'delivery-uncertain',
    });
    expect(outcomeOf(answered)).toBe('answered');
    expect(deliveryOf(answered, 'answered')).toBe('uncertain');
    // Reopened after a round whose notice may or may not have been written: still open, still waited for.
    expect(outcomeOf(v({ revision: 1, deliveryStatus: 'delivery-uncertain' }))).toBeNull();
    expect(
      deliveryOf(
        v({ status: 'expired', advisoryTimeout: timeout({ notice: 'needs-attention' }) }),
        'expired',
      ),
    ).toBe('needs-attention');
    expect(deliveryOf(v({ status: 'cancelled' }), 'withdrawn')).toBe('none');
  });

  it('parses --wait-timeout from 1s to 365d, and refuses anything else as a usage error', () => {
    expect(parseWaitTimeout('1s')).toBe(1_000);
    expect(parseWaitTimeout('15m')).toBe(15 * MIN);
    expect(parseWaitTimeout('365d')).toBe(365 * 24 * 60 * MIN);
    expect(parseWaitTimeout('2h')).toBe(120 * MIN);
    for (const bad of ['0s', '366d', '8761h', '1.5m', '10', 'm', '-1s']) {
      const e = (() => {
        try {
          parseWaitTimeout(bad);
        } catch (x) {
          return x;
        }
      })();
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(2);
    }
  });
});

describe('decisions ask', () => {
  it('prints its receipt before anything is sent, with the plan that applies', async () => {
    const e = await env();
    const p = e.proc();
    let receiptFirst: boolean | null = null;
    const inner = p.ctx.fetch;
    p.ctx.fetch = (async (u: unknown, init?: RequestInit) => {
      if (String(u).endsWith('/api/v1/questions') && init?.method === 'POST')
        receiptFirst ??= p.out.length > 0;
      return inner(u as string, init);
    }) as typeof fetch;
    const code = await ask(p.ctx, {}, { question: 'Tabs?', expiresIn: '15m', correlationId: 'c1' });
    expect(code).toBe(0);
    expect(receiptFirst).toBe(true);
    const [asked] = p.records();
    expect(p.out).toHaveLength(1); // nothing else on stdout: no blank line, no hint
    expect(asked).toMatchObject({
      record: 'asked',
      alias: 1,
      status: 'queued',
      duplicate: false,
      enforced_requirement: 'human-required',
      reply_mode: 'blocking',
      requested_expires_at: expect.any(String),
      planned_fallback: null,
    });
    const deadline = Date.parse(asked!.expires_at as string) - Date.now();
    expect(deadline).toBeGreaterThan(14 * MIN);
    expect(deadline).toBeLessThanOrEqual(15 * MIN);
    expect(asked!.instruction).toContain(`decisions wait ${asked!.question_id as string}`);
    expect(e.created()).toEqual([asked!.question_id]);

    // A retry with the same correlation id and request is the same question, with its original deadline.
    const again = e.proc();
    await ask(again.ctx, {}, { question: 'Tabs?', expiresIn: '15m', correlationId: 'c1' });
    expect(again.records()[0]).toMatchObject({
      question_id: asked!.question_id,
      duplicate: true,
      expires_at: asked!.expires_at,
    });
  });

  it('refuses a request the library refuses as a usage error, before asking anything', async () => {
    const e = await env();
    const p = e.proc();
    const both = await ask(
      p.ctx,
      {},
      {
        question: 'q',
        expiresIn: '15m',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ).catch((x: unknown) => x);
    expect(both).toBeInstanceOf(CliError);
    expect((both as CliError).message).toBe(
      'validation_error: expires_in: supply only one of expires_at and expires_in',
    );
    expect((both as CliError).exitCode).toBe(2);
    const loose = await ask(p.ctx, {}, { question: 'q', waitTimeout: '1m' }).catch(
      (x: unknown) => x,
    );
    expect((loose as CliError).exitCode).toBe(2);
    const option = await ask(p.ctx, {}, { question: 'q', option: ['nolabel'] }).catch(
      (x: unknown) => x,
    );
    expect((option as CliError).exitCode).toBe(2);
    const sink = await ask(p.ctx, {}, { question: 'q', sink: 'pipe' }).catch((x: unknown) => x);
    expect((sink as CliError).exitCode).toBe(2);
    expect(p.out).toEqual([]);
    expect(e.created()).toHaveLength(0);
  });

  it('asks for advice from a cold start, reading what the relay and phone support first', async () => {
    const e = await env({ advisory: true });
    const p = e.proc();
    await ask(
      p.ctx,
      {},
      {
        question: 'Which fixture?',
        expiresIn: '15m',
        plannedFallback: "I'll use the in-memory fixture.",
      },
    );
    expect(p.records()[0]).toMatchObject({
      reply_mode: 'advisory',
      planned_fallback: "I'll use the in-memory fixture.",
    });

    const old = await env();
    const q = old.proc();
    const refused = await ask(
      q.ctx,
      {},
      {
        question: 'Which fixture?',
        expiresIn: '15m',
        plannedFallback: "I'll use the in-memory fixture.",
      },
    ).catch((x: unknown) => x);
    expect((refused as CliError).message).toMatch(/^not_supported: relay-unsupported/);
    expect((refused as CliError).exitCode).toBe(1);
    expect(old.created()).toHaveLength(0);

    // A relay that supports advice, and no phone or tablet that can show it.
    const readerless = await env({ advisory: true });
    readerless.relay.deviceFeatures.clear();
    const r = readerless.proc();
    const none = await ask(
      r.ctx,
      {},
      {
        question: 'Which fixture?',
        expiresIn: '15m',
        plannedFallback: "I'll use the in-memory fixture.",
      },
    ).catch((x: unknown) => x);
    expect((none as CliError).message).toMatch(/^not_supported: no-capable-reader/);
    expect(r.out).toEqual([]);
  });
});

describe('decisions ask --wait', () => {
  it('ends with the answer: notices between the receipt and the final result record, exit 0', async () => {
    const e = await env();
    const p = e.proc();
    const done = ask(
      p.ctx,
      {},
      {
        question: 'Ship it?',
        option: ['yes=Yes', 'no=No'],
        wait: true,
        stopped: never(),
        ...QUICK,
      },
    );
    await vi.waitFor(() => expect(e.created()).toHaveLength(1));
    await e.relay.answerEvent({
      questionId: e.created()[0]!,
      phone: e.phone,
      options: ['yes'],
      text: 'Go ahead',
    });
    expect(await done).toBe(0);
    const recs = p.records();
    expect(recs.map((r) => r.record)).toEqual(['asked', 'notice', 'result']);
    expect(recs[1]!.text).toContain('Go ahead');
    expect(recs[2]!.question_id).toBe(recs[0]!.question_id);
    expect(recs[2]).toMatchObject({
      outcome: 'answered',
      exit_code: 0,
      delivery: 'delivered',
      status: 'human-answered',
      provenance: 'human',
      choice: 'yes',
      text: 'Go ahead',
    });
  });

  it('reports a decline (10) and a required expiry across a relay outage (12), never a local guess', async () => {
    const e = await env();
    const declined = e.proc();
    const d = ask(
      declined.ctx,
      {},
      { question: 'Rename it?', wait: true, stopped: never(), ...QUICK },
    );
    await vi.waitFor(() => expect(e.created()).toHaveLength(1));
    await e.relay.plainActionEvent({
      questionId: e.created()[0]!,
      signer: e.phone,
      action: 'cancel',
    });
    expect(await d).toBe(10);
    expect(result(declined.records())).toMatchObject({
      outcome: 'declined',
      closed_reason: 'declined',
      delivery: 'delivered',
    });

    // The relay goes dark, and this computer's clock passes the deadline: the wait does not conclude on its own.
    let dark = false;
    const p = e.proc();
    const inner = p.ctx.fetch;
    p.ctx.fetch = (async (u: unknown, init?: RequestInit) => {
      if (dark && String(u).includes('/api/v1/events')) throw new TypeError('fetch failed');
      return inner(u as string, init);
    }) as typeof fetch;
    const w = ask(
      p.ctx,
      {},
      { question: 'Release?', expiresIn: '2m', wait: true, stopped: never(), ...QUICK },
    );
    let settled = false;
    void w.then(() => (settled = true));
    await vi.waitFor(() => expect(e.created()).toHaveLength(2));
    dark = true;
    e.clock.skew = 3 * MIN;
    await vi.waitFor(() =>
      expect(p.err.join('\n')).toMatch(/HTTP sync failed \(network_error, 3 in a row\)/),
    );
    expect(settled).toBe(false);
    e.relay.expiryEvent({ questionId: e.created()[1]! });
    dark = false;
    expect(await w).toBe(12);
    expect(result(p.records())).toMatchObject({ outcome: 'expired', closed_reason: 'expired' });
    expect(p.err.join('\n')).toMatch(/HTTP sync recovered/);
  });

  it('settles a question that never reached the relay before its deadline (14)', async () => {
    const e = await env();
    // The clock jumps past the deadline while the receipt is written: nothing was sent before it.
    const p = e.proc({
      onLine: (l) => {
        if (l.includes('"record":"asked"')) e.clock.skew = 2 * MIN;
      },
    });
    const code = await ask(
      p.ctx,
      {},
      {
        question: 'Quick one?',
        expiresIn: '61s',
        wait: true,
        stopped: never(),
        ...QUICK,
      },
    );
    expect(code).toBe(14);
    expect(e.created()).toHaveLength(0);
    expect(result(p.records())).toMatchObject({
      outcome: 'never-published',
      publication: 'never-published',
      fallback_due: false,
      delivery: 'delivered',
    });
  });

  it('reports an advisory deadline that passed unanswered as the plan being due (13)', async () => {
    const e = await env({ advisory: true });
    const p = e.proc();
    const w = ask(
      p.ctx,
      {},
      {
        question: 'Which fixture?',
        expiresIn: '15m',
        plannedFallback: "I'll use the in-memory fixture.",
        wait: true,
        stopped: never(),
        ...QUICK,
      },
    );
    await vi.waitFor(() => expect(e.created()).toHaveLength(1));
    e.clock.skew = 16 * MIN;
    e.relay.expiryEvent({ questionId: e.created()[0]! });
    expect(await w).toBe(13);
    const recs = p.records();
    expect(recs.find((r) => r.record === 'notice')!.text).toContain('status: advisory-unanswered');
    expect(result(recs)).toMatchObject({
      outcome: 'advisory-expired',
      fallback_due: true,
      reply_mode: 'advisory',
      planned_fallback: "I'll use the in-memory fixture.",
      delivery: 'delivered',
      advisory_timeout: { disposition: 'fallback-due', notice: 'delivered' },
    });
  });

  it('stops waiting locally on a signal or its timeout, leaving the question live', async () => {
    const e = await env();
    const p = e.proc();
    let interrupt!: (s: StopSignal) => void;
    const stopped = new Promise<StopSignal>((r) => (interrupt = r));
    const w = ask(p.ctx, {}, { question: 'Later?', wait: true, stopped, ...QUICK });
    await vi.waitFor(() => expect(e.created()).toHaveLength(1));
    interrupt('SIGTERM');
    expect(await w).toBe(143);
    const id = e.created()[0]!;
    expect(result(p.records())).toMatchObject({
      outcome: 'interrupted',
      signal: 'SIGTERM',
      exit_code: 143,
      status: 'open',
      delivery: 'none',
    });
    expect(e.relay.calls.some((c) => c.path.includes(id) && c.method !== 'GET')).toBe(false);

    const t = e.proc({ json: false });
    const t0 = Date.now();
    expect(await waitCmd(t.ctx, {}, id, { waitTimeout: '1s', stopped: never(), ...QUICK })).toBe(
      16,
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(t.out.join('\n')).toMatch(
      /Outcome: wait-timeout \(exit 16\)\.\nStopped waiting here after --wait-timeout 1s; nothing was cancelled\. q-1 is open\./,
    );
  });
});

describe('recovering an outcome by ID', () => {
  it('finds an answer another process already delivered, after a restart, without typing it again', async () => {
    const e = await env();
    const asker = e.proc();
    await ask(asker.ctx, {}, { question: 'Merge?', stopped: never() });
    const id = asker.records()[0]!.question_id as string;
    await e.relay.answerEvent({ questionId: id, phone: e.phone, text: 'Yes, merge it' });
    // A listener picks it up and its sink prints it, in its own process.
    const listener = e.proc({ json: false });
    await daemon(listener.ctx, {}, { once: true });
    expect(listener.out.join('\n')).toContain('Yes, merge it');

    // The asker comes back later and waits by ID: the outcome is already settled, so nothing is read from the relay,
    // nothing is typed here, and it does not wait for a tick.
    const later = e.proc();
    expect(await waitCmd(later.ctx, {}, id, { stopped: never(), ...QUICK, tickMs: 60_000 })).toBe(
      0,
    );
    expect(later.calls).toEqual([]);
    expect(later.records().map((r) => r.record)).toEqual(['result']);
    expect(result(later.records())).toMatchObject({
      outcome: 'answered',
      text: 'Yes, merge it',
      delivery: 'delivered',
    });

    const got = e.proc();
    await getCmd(got.ctx, {}, id);
    expect(got.calls).toEqual([]);
    expect(JSON.parse(got.out[0]!)).toMatchObject({
      question_id: id,
      outcome: 'answered',
      status: 'human-answered',
      text: 'Yes, merge it',
    });
    // Another pane's question is unknown here, as it is to get_decision, and waiting for it takes over nothing.
    const other = await getCmd(e.proc().ctx, {}, id, { pane: 'mcp' }).catch((x: unknown) => x);
    expect((other as CliError).message).toBe('not_found: unknown question');
    const reads = e.relay.calls.length;
    const unknown = await waitCmd(e.proc().ctx, {}, 'nope', { stopped: never(), ...QUICK }).catch(
      (x: unknown) => x,
    );
    expect((unknown as CliError).message).toBe('not_found: unknown question');
    expect((unknown as CliError).exitCode).toBe(1);
    expect(e.relay.calls.length).toBe(reads);
  });

  it('only reads while a listener receives, and takes over once that listener stops', async () => {
    const e = await env();
    const listener = e.proc({ json: false });
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    const listening = daemon(
      listener.ctx,
      {},
      {
        socket: false,
        poll: FAST,
        pumpIntervalMs: 20,
        until,
      },
    );
    await vi.waitFor(() => expect(listener.out.join('\n')).toMatch(/Listening for answers/));

    const p = e.proc();
    const w = ask(p.ctx, {}, { question: 'First?', wait: true, stopped: never(), ...QUICK });
    await vi.waitFor(() => expect(e.created()).toHaveLength(1));
    await vi.waitFor(() => expect(p.err.join('\n')).toMatch(/another decisions process receives/));
    await e.relay.answerEvent({ questionId: e.created()[0]!, phone: e.phone, text: 'Answer one' });
    expect(await w).toBe(0);
    // This wait reported the outcome as soon as the shared state held it; the listener's sink gets the notice.
    expect(p.records().map((r) => r.record)).toEqual(['asked', 'result']);
    expect(result(p.records())).toMatchObject({ outcome: 'answered', text: 'Answer one' });
    expect(['pending', 'delivered']).toContain(result(p.records()).delivery);
    await vi.waitFor(() => expect(listener.out.join('\n')).toContain('Answer one'));
    // It only asked: the listener published the question and read the relay.
    expect(p.calls.filter((c) => c === 'POST /api/v1/questions' || c.includes('/events'))).toEqual(
      [],
    );

    const q = e.proc();
    const w2 = ask(q.ctx, {}, { question: 'Second?', wait: true, stopped: never(), ...QUICK });
    await vi.waitFor(() => expect(e.created()).toHaveLength(2));
    expect(q.calls.filter((c) => c.includes('/events'))).toEqual([]);
    release();
    await listening;
    await vi.waitFor(() => expect(q.err.join('\n')).toMatch(/receiving here from now on/));
    await e.relay.answerEvent({ questionId: e.created()[1]!, phone: e.phone, text: 'Answer two' });
    expect(await w2).toBe(0);
    expect(q.records().map((r) => r.record)).toEqual(['asked', 'notice', 'result']);
    expect(listener.out.join('\n')).not.toContain('Answer two');
  });

  it('leaves publishing to a running receiver, and takes it over once that receiver is gone', async () => {
    const e = await env();
    const listener = e.proc({ json: false });
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    const listening = daemon(
      listener.ctx,
      {},
      {
        socket: false,
        poll: FAST,
        pumpIntervalMs: 20,
        until,
      },
    );
    await vi.waitFor(() => expect(listener.out.join('\n')).toMatch(/Listening for answers/));
    const a = e.proc();
    expect(await ask(a.ctx, {}, { question: 'One?', stopped: never() })).toBe(0);
    expect(e.created()).toHaveLength(1);
    expect(a.calls).not.toContain('POST /api/v1/questions');
    // The receiver declared this device's features; an ask that only watches leaves its declaration as it is.
    expect(a.calls).not.toContain('POST /api/v1/socket-ticket');
    release();
    await listening;

    // A receiver that holds the lock and publishes nothing, then exits: this ask takes over and publishes.
    const held = ReceiverLock.forHome(e.home);
    expect(held.tryAcquire()).toBe(true);
    setTimeout(() => held.release(), 300);
    const b = e.proc();
    expect(await ask(b.ctx, {}, { question: 'Two?', stopped: never() })).toBe(0);
    expect(e.created()).toHaveLength(2);
    expect(b.calls).toContain('POST /api/v1/questions');
    // Taking over, it declares this device's features before it sends anything, as the receiver it replaces did.
    expect(b.calls.filter((c) => c === 'POST /api/v1/socket-ticket')).toHaveLength(1);
    expect(b.calls.indexOf('POST /api/v1/socket-ticket')).toBeLessThan(
      b.calls.indexOf('POST /api/v1/questions'),
    );
  });

  it('never lets a declaration the relay does not answer hold its question, or outlast a stop', async () => {
    const e = await env();
    /** One process whose socket tickets the relay never answers: each fails only once its request is aborted. */
    const stalled = () => {
      const p = e.proc();
      const send = p.ctx.fetch;
      p.ctx.fetch = (async (u: unknown, init?: RequestInit) => {
        if (new URL(String(u)).pathname !== '/api/v1/socket-ticket') return send(u as string, init);
        p.calls.push('POST /api/v1/socket-ticket');
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        );
      }) as typeof fetch;
      return p;
    };

    // The declaration gives up within its bound, and the question goes out anyway.
    const a = stalled();
    expect(await ask(a.ctx, {}, { question: 'One?', stopped: never(), declareMs: 50 })).toBe(0);
    expect(e.created()).toHaveLength(1);
    expect(a.calls.indexOf('POST /api/v1/socket-ticket')).toBeLessThan(
      a.calls.indexOf('POST /api/v1/questions'),
    );
    expect(a.err.join('\n')).toMatch(/could not declare this device's features/);

    // Stopped while it declares: nothing more goes out, the declaration ends with the process, and so does its lock.
    const b = stalled();
    let signal!: (s: StopSignal) => void;
    const stopped = new Promise<StopSignal>((r) => (signal = r));
    const pump = vi.spyOn(DecisionsBridge.prototype, 'pump');
    const asking = ask(b.ctx, {}, { question: 'Two?', stopped, declareMs: 60_000 });
    await vi.waitFor(() => expect(b.calls).toContain('POST /api/v1/socket-ticket'));
    signal('SIGINT');
    expect(await asking).toBe(130);
    expect(pump).not.toHaveBeenCalled();
    pump.mockRestore();
    expect(b.calls).not.toContain('POST /api/v1/questions');
    expect(e.created()).toHaveLength(1);
    const next = ReceiverLock.forHome(e.home);
    expect(next.tryAcquire()).toBe(true);
    next.release();
  });

  it('asks once for two asks at once with the same correlation id', async () => {
    const e = await env();
    const [a, b] = [e.proc(), e.proc()];
    const same = { question: 'Tabs?', correlationId: 'once', stopped: never() };
    await Promise.all([ask(a.ctx, {}, same), ask(b.ctx, {}, same)]);
    const ids = [a.records()[0]!.question_id, b.records()[0]!.question_id];
    expect(ids[0]).toBe(ids[1]);
    expect([a.records()[0]!.duplicate, b.records()[0]!.duplicate].sort()).toEqual([false, true]);
    expect(e.created()).toEqual([ids[0]]);
  });

  it('takes the receiver lock only from a process that does not hold it, until that process ends', async () => {
    const e = await env();
    await ask(e.proc().ctx, {}, { question: 'q', stopped: never() });
    const holder = spawn(
      process.execPath,
      [
        '-e',
        "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); process.stdout.write('held'); setInterval(() => {}, 1000);",
        join(e.home, 'receiver.lock'),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
    try {
      const busy = await daemon(e.proc().ctx, {}, { once: true }).catch((x: unknown) => x);
      expect((busy as CliError).message).toMatch(/already receiving for this state directory/);
    } finally {
      holder.kill('SIGKILL');
      await new Promise((r) => holder.once('exit', r));
    }
    // Released by the operating system when the holder died, without any unlock.
    await daemon(e.proc().ctx, {}, { once: true });
  });

  it('runs one receiver per state directory', async () => {
    const e = await env();
    await ask(e.proc().ctx, {}, { question: 'q', stopped: never() });
    const lock = ReceiverLock.forHome(e.home);
    expect(lock.tryAcquire()).toBe(true);
    try {
      const busy = await daemon(e.proc().ctx, {}, { once: true }).catch((x: unknown) => x);
      expect((busy as CliError).message).toMatch(/already receiving for this state directory/);
    } finally {
      lock.release();
    }
    await daemon(e.proc().ctx, {}, { once: true });
  });
});

describe('a late retry refused by a relay that checks the deadline before the receipt (0.8.0)', () => {
  type Env = Awaited<ReturnType<typeof env>>;
  /** Run after each test, passed or failed: every gate opened, then every process stopped. */
  const opens: (() => void)[] = [];
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const f of opens.splice(0)) f();
    for (const f of cleanups.splice(0).reverse()) await f();
  });
  const gate = () => {
    let open!: () => void;
    const shut = new Promise<void>((r) => (open = r));
    opens.push(() => open());
    return { shut, open };
  };
  /** A command that stops as a signal would when the test says so, or when the test ends. */
  const run = (start: (stopped: Promise<StopSignal>) => Promise<number>) => {
    let stop!: (s: StopSignal) => void;
    const done = start(new Promise<StopSignal>((r) => (stop = r)));
    let settled = false;
    void done.then(
      () => (settled = true),
      () => (settled = true),
    );
    cleanups.push(async () => {
      stop('SIGINT');
      await done.catch(() => undefined);
    });
    return { done, stop: () => stop('SIGINT'), settled: () => settled };
  };
  /**
   * Routes a process's requests through `route`: `lose` fails one as a network error before it reaches the relay, a
   * promise holds it until it settles (or fails it as a network error when the process aborts it). Returns every
   * request it saw, in order.
   */
  const intercept = (
    p: ReturnType<Env['proc']>,
    route: (method: string, path: string) => Promise<void> | 'lose' | null,
  ) => {
    const inner = p.ctx.fetch;
    const seen: string[] = [];
    p.ctx.fetch = (async (u: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = new URL(String(u)).pathname;
      seen.push(`${method} ${path}`);
      const r = route(method, path);
      if (r === 'lose') throw new TypeError('fetch failed');
      if (r)
        await new Promise<void>((resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) return reject(new TypeError('fetch failed'));
          signal?.addEventListener('abort', () => reject(new TypeError('fetch failed')), {
            once: true,
          });
          void r.then(resolve);
        });
      return inner(u as string, init);
    }) as typeof fetch;
    return seen;
  };
  /**
   * An `ask --wait` that never reads the relay's events. Its first create reaches the relay (unless `loseFirst`: lost
   * on the way out, so it may have reached the relay as far as it knows); every later one waits for `releaseRetries`.
   */
  const asker = (e: Env, o: { loseFirst?: boolean } = {}) => {
    const p = e.proc();
    const retries = gate();
    let creates = 0;
    const seen = intercept(p, (method, path) => {
      if (path === '/api/v1/events') return 'lose';
      if (method !== 'POST' || path !== '/api/v1/questions') return null;
      creates++;
      if (creates === 1) return o.loseFirst ? 'lose' : null;
      return retries.shut;
    });
    const r = run((stopped) =>
      ask(
        p.ctx,
        {},
        {
          question: 'Deploy?',
          option: ['yes=Yes', 'no=No'],
          expiresIn: '2m',
          wait: true,
          stopped,
          ...QUICK,
        },
      ),
    );
    return { ...r, p, seen, creates: () => creates, releaseRetries: retries.open };
  };
  const status = async (e: Env, id: string) => {
    const g = e.proc();
    await getCmd(g.ctx, {}, id);
    expect(g.calls).toEqual([]);
    return JSON.parse(g.out[0]!) as Record<string, unknown>;
  };
  /** Past the deadline, the relay refuses the create's retry without saying whether it holds the question. */
  const refuseLateRetry = (e: Env) => {
    e.relay.rejectCreate = 400;
    e.clock.skew = 3 * MIN;
  };

  it('has wait read back the late retry the relay refused, and report the answer the relay holds', async () => {
    const e = await env();
    // Committed, its reply lost; the asker's own retry waits until the asker stops, and fails as it does.
    e.relay.dropCreateReply = 1;
    const a = asker(e);
    await vi.waitFor(() => expect(a.creates()).toBe(2));
    const id = e.created()[0]!;
    a.stop();
    expect(await a.done).toBe(130);
    expect(await status(e, id)).toMatchObject({
      outcome: null,
      status: 'queued',
      publication: 'possibly-committed',
    });
    await e.relay.answerEvent({
      questionId: id,
      phone: e.phone,
      options: ['yes'],
      text: 'Ship it',
    });
    e.relay.answerState.set(id, { status: 'human-answered', revision: 1 });

    // Past the deadline, with nothing receiving: `wait` receives, and the relay refuses its retry of the create.
    refuseLateRetry(e);
    const w = e.proc();
    const read = gate();
    const events = gate();
    const seen = intercept(w, (method, path) =>
      method === 'GET' && path === `/api/v1/questions/${id}`
        ? read.shut
        : path === '/api/v1/events'
          ? events.shut
          : null,
    );
    const waiting = run((stopped) => waitCmd(w.ctx, {}, id, { stopped, ...QUICK }));
    await vi.waitFor(() => expect(seen).toContain(`GET /api/v1/questions/${id}`));
    expect(seen.filter((c) => c === 'POST /api/v1/questions')).toHaveLength(1);
    // Refused, and the relay not read back yet: no outcome, here or for `get`.
    expect(await status(e, id)).toMatchObject({
      outcome: null,
      status: 'queued',
      publication: 'possibly-committed',
    });
    expect(waiting.settled()).toBe(false);

    // The relay holds it: only the receipt was lost. The outcome is what its events say.
    read.open();
    await vi.waitFor(async () =>
      expect(await status(e, id)).toMatchObject({
        outcome: null,
        status: 'open',
        publication: 'accepted',
        error_code: null,
      }),
    );
    expect(waiting.settled()).toBe(false);
    events.open();
    expect(await waiting.done).toBe(0);
    expect(w.records().filter((r) => r.record === 'result')).toHaveLength(1);
    expect(result(w.records())).toMatchObject({
      outcome: 'answered',
      status: 'human-answered',
      publication: 'accepted',
      choice: 'yes',
      text: 'Ship it',
    });
    expect(await status(e, id)).toMatchObject({ outcome: 'answered' });
  });

  it('reports the refusal once the relay says it holds no such question', async () => {
    const e = await env();
    const a = asker(e, { loseFirst: true });
    await vi.waitFor(() => expect(a.creates()).toBe(2));
    const id = a.p.records()[0]!.question_id as string;
    expect(await status(e, id)).toMatchObject({ outcome: null, publication: 'possibly-committed' });
    refuseLateRetry(e);
    a.releaseRetries();
    expect(await a.done).toBe(15);
    expect(a.seen.indexOf(`GET /api/v1/questions/${id}`)).toBeGreaterThan(
      a.seen.lastIndexOf('POST /api/v1/questions'),
    );
    expect(e.created()).toEqual([]);
    expect(result(a.p.records())).toMatchObject({
      outcome: 'refused',
      status: 'publish-failed',
      publication: 'refused',
      error_code: 'validation_error',
    });
    expect(await status(e, id)).toMatchObject({ outcome: 'refused' });
  });
});

describe('the standalone flow through decisions mcp', () => {
  it('asks a 15-minute advisory question over MCP, writes the notice to the sink, and recovers it by ID', async () => {
    const e = await env({ advisory: true });
    const notices = join(e.home, 'notices.log');
    const server = e.proc({ json: false });
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    let ready!: (url: string, token: string) => void;
    const up = new Promise<{ url: string; token: string }>(
      (r) => (ready = (url, token) => r({ url, token })),
    );
    const serving = daemon(
      server.ctx,
      {},
      {
        socket: false,
        poll: FAST,
        pumpIntervalMs: 20,
        sink: `file:${notices}`,
        until,
        mcp: { port: 0 },
        onReady: (h) => ready(h.mcp!.url, h.token!),
      },
    );
    const { url, token } = await up;
    const call = async (name: string, args: unknown) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      return (
        (await r.json()) as {
          result: {
            isError?: boolean;
            content: { text: string }[];
            structuredContent: Record<string, unknown>;
          };
        }
      ).result;
    };
    try {
      const asked = await vi
        .waitFor(async () => {
          const r = await call('ask_human', {
            question: 'Which fixture should I use?',
            expires_in: '15m',
            planned_fallback: 'I will use the in-memory fixture.',
            correlation_id: 'fixture-choice',
          });
          // The first ask may come before the background read of what advice needs: it is retried.
          expect(r.isError).toBeFalsy();
          return r;
        })
        .then((r) => {
          // Nothing here types into the agent's terminal: it is told to check back with get_decision.
          expect(r.content[0]!.text).toContain(
            'This host does not type the answer into your terminal',
          );
          expect(r.content[0]!.text).not.toContain('arrives as a new message in this terminal');
          return r.structuredContent;
        });
      expect(asked).toMatchObject({ reply_mode: 'advisory', status: 'queued' });
      const id = asked.question_id as string;
      await vi.waitFor(() => expect(e.created()).toEqual([id]));

      // A wait from another terminal only reads: the server receives for this state directory.
      const waiter = e.proc();
      const waiting = waitCmd(waiter.ctx, {}, id, { pane: 'mcp', stopped: never(), ...QUICK });
      e.clock.skew = 16 * MIN;
      e.relay.expiryEvent({ questionId: id });
      expect(await waiting).toBe(13);
      expect(result(waiter.records())).toMatchObject({
        outcome: 'advisory-expired',
        fallback_due: true,
        planned_fallback: 'I will use the in-memory fixture.',
      });
      // The notice went to the server's sink, the file, not to the waiter or the agent.
      await vi.waitFor(() =>
        expect(readFileSync(notices, 'utf8')).toContain('status: advisory-unanswered'),
      );
      expect(waiter.records().map((r) => r.record)).toEqual(['result']);

      // Neither the tool list nor the instructions promise that anything is typed into the agent's terminal.
      const rpc = async (method: string) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params: {} }),
        });
        return JSON.stringify(((await r.json()) as { result: unknown }).result);
      };
      const tools = await rpc('tools/list');
      const instructions = await rpc('initialize');
      for (const said of [tools, instructions])
        expect(said).not.toMatch(/typed into this terminal|arrives as a new message|arrive here/);
      expect(tools).toContain('call get_decision with its question_id');
      expect(tools).toContain("appear in get_decision's thread");
      expect(instructions).toContain(
        'This host does not type answers into your terminal: when you cannot go further without the answer, call get_decision with its question_id, and check again later if it has none yet.',
      );

      // The agent recovers the same facts with get_decision, and a script with `decisions get --pane mcp`.
      const viaMcp = (await call('get_decision', { question_id: id })).structuredContent;
      expect(viaMcp).toMatchObject({
        status: 'expired',
        fallback_due: true,
        advisory_timeout: { disposition: 'fallback-due', notice: 'delivered' },
      });
      const got = e.proc();
      await getCmd(got.ctx, {}, id, { pane: 'mcp' });
      const viaCli = JSON.parse(got.out[0]!) as Record<string, unknown>;
      expect(viaCli).toMatchObject({ outcome: 'advisory-expired', delivery: 'delivered' });
      const { outcome: _o, delivery: _d, ...fields } = viaCli;
      expect(fields).toEqual(viaMcp);
    } finally {
      release();
      await serving;
    }
  });

  it("reports a due advisory plan from another process while the receiver's sink cannot write its notice", async () => {
    const e = await env({ advisory: true });
    const server = e.proc({ json: false });
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    let ready!: (url: string, token: string) => void;
    const up = new Promise<{ url: string; token: string }>(
      (r) => (ready = (url, token) => r({ url, token })),
    );
    const serving = daemon(
      server.ctx,
      {},
      {
        socket: false,
        poll: FAST,
        pumpIntervalMs: 20,
        // A directory that does not exist: the notice can never be written.
        sink: `file:${join(e.home, 'missing', 'notices.log')}`,
        until,
        mcp: { port: 0 },
        onReady: (h) => ready(h.mcp!.url, h.token!),
      },
    );
    const { url, token } = await up;
    const call = async (name: string, args: unknown) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      return (
        (await r.json()) as {
          result: { isError?: boolean; structuredContent: Record<string, unknown> };
        }
      ).result;
    };
    try {
      const asked = await vi.waitFor(async () => {
        const r = await call('ask_human', {
          question: 'Which fixture should I use?',
          expires_in: '15m',
          planned_fallback: 'I will use the in-memory fixture.',
        });
        expect(r.isError).toBeFalsy();
        return r.structuredContent;
      });
      const id = asked.question_id as string;
      await vi.waitFor(() => expect(e.created()).toEqual([id]));

      const waiter = e.proc();
      const waiting = waitCmd(waiter.ctx, {}, id, {
        pane: 'mcp',
        waitTimeout: '3s',
        stopped: never(),
        ...QUICK,
      });
      // It only reads: the server receives, and its sink is the one that refuses the notice.
      await vi.waitFor(() =>
        expect(waiter.err.join('\n')).toMatch(/another decisions process receives/),
      );
      e.clock.skew = 16 * MIN;
      e.relay.expiryEvent({ questionId: id });
      expect(await waiting).toBe(13);
      expect(waiter.records()).toHaveLength(1);
      expect(result(waiter.records())).toMatchObject({
        outcome: 'advisory-expired',
        exit_code: 13,
        fallback_due: true,
        delivery: 'needs-attention',
        advisory_timeout: { disposition: 'fallback-due', notice: 'needs-attention' },
      });
      expect(waiter.calls.filter((c) => c.includes('/events'))).toEqual([]);

      const viaMcp = (await call('get_decision', { question_id: id })).structuredContent;
      expect(viaMcp).toMatchObject({ status: 'expired', fallback_due: true });
      const got = e.proc();
      await getCmd(got.ctx, {}, id, { pane: 'mcp' });
      const viaCli = JSON.parse(got.out[0]!) as Record<string, unknown>;
      expect(viaCli).toMatchObject({ outcome: 'advisory-expired', delivery: 'needs-attention' });
      const { outcome: _o, delivery: _d, ...fields } = viaCli;
      expect(fields).toEqual(viaMcp);
    } finally {
      release();
      await serving;
    }
  });

  it('writes the notice through an exec sink while the result stays on stdout', async () => {
    const e = await env();
    const copy = join(e.home, 'exec.log');
    const p = e.proc();
    const w = ask(
      p.ctx,
      {},
      {
        question: 'Rebase or merge?',
        wait: true,
        sink: `exec:cat > '${copy}'`,
        stopped: never(),
        ...QUICK,
      },
    );
    await vi.waitFor(() => expect(e.created()).toHaveLength(1));
    await e.relay.answerEvent({ questionId: e.created()[0]!, phone: e.phone, text: 'Rebase' });
    expect(await w).toBe(0);
    expect(readFileSync(copy, 'utf8')).toContain('Rebase');
    expect(p.records().map((r) => r.record)).toEqual(['asked', 'result']);
    expect(result(p.records())).toMatchObject({ outcome: 'answered', delivery: 'delivered' });
  });
});

/** One socket as the relay sees it: it replays from the cursor a `sync` names, then sends each new event as committed. */
class RelaySideSocket implements WebSocketLike {
  readyState = 1;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  /** The highest seq sent, once the client has synced; null before. */
  sent: number | null = null;
  constructor(private readonly relay: FakeRelay) {}
  send(data: string): void {
    if (data === 'ping') return;
    const f = JSON.parse(data) as { t: string; after?: number };
    if (f.t !== 'sync') return;
    const high = this.relay.events.at(-1)?.seq ?? 0;
    for (const event of this.relay.events.filter((ev) => ev.seq > f.after!))
      this.frame({ t: 'event', event });
    this.frame({ t: 'caught_up', high_water: high, has_more: false });
    this.sent = high;
  }
  /** Sends what was committed since the last frame, as the relay broadcasts each event. */
  broadcast(): void {
    if (this.sent === null) return;
    for (const event of this.relay.events.filter((ev) => ev.seq > this.sent!)) {
      this.frame({ t: 'event', event });
      this.sent = event.seq;
    }
  }
  frame(f: unknown): void {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(f) });
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }
}

/**
 * The relay's sockets for this computer's one device: a new socket closes every older one with `replaced` (4409), as
 * the relay does, and each socket says hello, replays and broadcasts.
 */
function relaySockets(e: Awaited<ReturnType<typeof env>>) {
  const opened: RelaySideSocket[] = [];
  const timer = setInterval(() => opened.forEach((s) => s.broadcast()), 5);
  const webSocket = (_url: string): WebSocketLike => {
    for (const old of opened) old.close(4409, 'replaced by a newer connection');
    const s = new RelaySideSocket(e.relay);
    opened.push(s);
    setTimeout(
      () =>
        s.frame({
          t: 'hello',
          protocol_version: PROTOCOL_VERSION,
          device_id: e.identity.config.deviceId,
          role: 'owner-desktop',
          key_epoch: e.relay.epoch,
          high_water: e.relay.events.at(-1)?.seq ?? 0,
          server_time: new Date().toISOString(),
        }),
      0,
    );
    return s;
  };
  /** The sockets the relay still holds open, newest last. */
  const live = () => opened.filter((s) => s.readyState === 1);
  /** Until the newest open socket has replayed to its client. */
  const synced = () =>
    vi.waitFor(() => expect(live().at(-1)?.sent).toBeTypeOf('number'), { timeout: 10_000 });
  return { opened, live, synced, webSocket, close: () => clearInterval(timer) };
}

/** Stops what a test started (waits as a signal would, listeners through `until`) when it ends, however it ends. */
function teardown() {
  const stops: (() => void)[] = [];
  return {
    signal(): Promise<StopSignal> {
      return new Promise<StopSignal>((r) => stops.push(() => r('SIGINT')));
    },
    until(): { until: Promise<void>; stop: () => void } {
      let stop!: () => void;
      const until = new Promise<void>((r) => (stop = r));
      stops.push(stop);
      return { until, stop };
    },
    end: () => stops.forEach((stop) => stop()),
  };
}

describe('a receiver beside decisions doctor', () => {
  it('doctor leaves a socket-mode wait receiving: an answer that arrives afterwards still reaches it', async () => {
    const e = await env();
    const sockets = relaySockets(e);
    const t = teardown();
    try {
      const asker = e.proc();
      await ask(asker.ctx, {}, { question: 'Ship it?', stopped: never() });
      const id = asker.records()[0]!.question_id as string;
      const waiter = e.proc();
      waiter.ctx.webSocket = sockets.webSocket;
      const w = waitCmd(waiter.ctx, {}, id, {
        stopped: t.signal(),
        waitTimeout: '20s',
        tickMs: 10,
      });
      await sockets.synced();

      const doc = e.proc({ json: false });
      doc.ctx.webSocket = sockets.webSocket;
      // This fake relay fails checks unrelated to the socket (health, storage), so doctor reports problems.
      await expect(doctor(doc.ctx, {}, {})).rejects.toThrow(CliError);
      expect(doc.out.join('\n')).toMatch(
        /! websocket +skipped: another decisions process receives for this state directory/,
      );
      // No test ticket re-declared this device's features, and no socket replaced the wait's.
      expect(doc.calls).not.toContain('POST /api/v1/socket-ticket');
      expect(sockets.opened).toHaveLength(1);

      await e.relay.answerEvent({ questionId: id, phone: e.phone, text: 'Ship it' });
      expect(await w).toBe(0);
      expect(result(waiter.records())).toMatchObject({
        outcome: 'answered',
        delivery: 'delivered',
        text: 'Ship it',
      });
    } finally {
      t.end();
      sockets.close();
    }
  }, 30_000);

  it('a wait whose socket another connection replaced stops and says so, and the wait observing takes over', async () => {
    const e = await env();
    const sockets = relaySockets(e);
    const t = teardown();
    try {
      const asker = e.proc();
      await ask(asker.ctx, {}, { question: 'Merge it?', stopped: never() });
      const id = asker.records()[0]!.question_id as string;
      const first = e.proc();
      first.ctx.webSocket = sockets.webSocket;
      const a = waitCmd(first.ctx, {}, id, {
        stopped: t.signal(),
        waitTimeout: '20s',
        tickMs: 10,
      }).then(
        (code) => code,
        (x: unknown) => x as Error,
      );
      await sockets.synced();
      const second = e.proc();
      second.ctx.webSocket = sockets.webSocket;
      const b = waitCmd(second.ctx, {}, id, {
        stopped: t.signal(),
        waitTimeout: '20s',
        tickMs: 10,
      });
      await vi.waitFor(
        () => expect(second.err.join('\n')).toMatch(/another decisions process receives/),
        { timeout: 10_000 },
      );

      // Another connection for this device (an older doctor, say) opens and goes: the first wait's socket is replaced.
      sockets.webSocket('elsewhere').close(1000);
      await e.relay.answerEvent({ questionId: id, phone: e.phone, text: 'Merge it' });
      expect(((await a) as Error).message).toMatch(
        /^stopped waiting: another connection for this device replaced this process's relay socket/,
      );
      // The state directory is free again: the second wait receives, from its stored cursor, what came meanwhile.
      expect(await b).toBe(0);
      expect(second.err.join('\n')).toMatch(
        /the other receiver stopped; receiving here from now on/,
      );
      expect(second.records().map((r) => r.record)).toEqual(['notice', 'result']);
      expect(result(second.records())).toMatchObject({
        outcome: 'answered',
        delivery: 'delivered',
        text: 'Merge it',
      });
      expect(first.records()).toEqual([]);
      expect(sockets.opened).toHaveLength(3);
    } finally {
      t.end();
      sockets.close();
    }
  }, 30_000);

  it('a listener whose socket another connection replaced stops, closes its MCP and frees the state directory; a stop it asked for does not', async () => {
    const e = await env();
    const sockets = relaySockets(e);
    const t = teardown();
    try {
      const listener = e.proc({ json: false });
      listener.ctx.webSocket = sockets.webSocket;
      let ready!: (url: string) => void;
      const up = new Promise<string>((r) => (ready = r));
      const listening = daemon(
        listener.ctx,
        {},
        { until: t.until().until, mcp: { port: 0 }, onReady: (h) => ready(h.mcp!.url) },
      );
      const url = await up;
      await sockets.synced();
      sockets.webSocket('elsewhere').close(1000);
      await expect(listening).rejects.toThrow(
        /stopped listening: another connection for this device replaced this process's relay socket/,
      );
      // Its MCP server is gone with it, and another receiver can take the state directory.
      await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
      const lock = ReceiverLock.forHome(e.home);
      expect(lock.tryAcquire()).toBe(true);
      lock.release();

      // Stopped on request, it ends quietly.
      const again = e.proc({ json: false });
      again.ctx.webSocket = sockets.webSocket;
      const { until, stop } = t.until();
      const done = daemon(again.ctx, {}, { until });
      await sockets.synced();
      stop();
      await done;
      expect(again.err.join('\n')).not.toMatch(/replaced/);
    } finally {
      t.end();
      sockets.close();
    }
  }, 30_000);
});
