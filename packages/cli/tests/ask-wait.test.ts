import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MemoryKeyStore, type DecisionView } from '@daintreehq/decisions-client';
import { FakeRelay, makeIdentity, makePhone } from '../../client/tests/helpers.js';
import { CliError, type Ctx } from '../src/runtime.js';
import { ReceiverLock } from '../src/receiver.js';
import { daemon } from '../src/commands/daemon.js';
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
    const ctx: Ctx = {
      home,
      json: over.json ?? true,
      fetch: relay.fetch,
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
    return { ctx, out, err, records };
  };
  const created = () => [...relay.questions.keys()];
  return { identity, relay, phone, home, clock, proc, created };
}

const result = (records: { record: string }[]) => records.find((r) => r.record === 'result')!;

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
    expect(new Set(Object.values(OUTCOME_EXIT)).size).toBe(Object.keys(OUTCOME_EXIT).length);
    expect(OUTCOME_EXIT.answered).toBe(0);
  });

  it('waits while an advisory plan is not settled, and calls a withheld one a plain expiry', () => {
    const expired = { status: 'expired' as const, closedReason: 'expired' as const };
    expect(
      outcomeOf(
        v({ ...expired, fallbackDue: false, advisoryTimeout: timeout({ notice: 'pending' }) }),
      ),
    ).toBeNull();
    expect(
      outcomeOf(v({ ...expired, advisoryTimeout: timeout({ disposition: 'fallback-withheld' }) })),
    ).toBe('expired');
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
    for (const bad of ['0s', '366d', '1.5m', '10', 'm', '-1s']) {
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
    expect(await waitCmd(t.ctx, {}, id, { waitTimeout: '1s', stopped: never(), ...QUICK })).toBe(
      16,
    );
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

    // The asker comes back later and waits by ID: the outcome is already settled, and nothing is typed here.
    const later = e.proc();
    expect(await waitCmd(later.ctx, {}, id, { stopped: never(), ...QUICK })).toBe(0);
    expect(later.records().map((r) => r.record)).toEqual(['result']);
    expect(result(later.records())).toMatchObject({
      outcome: 'answered',
      text: 'Yes, merge it',
      delivery: 'delivered',
    });

    const got = e.proc();
    await getCmd(got.ctx, {}, id);
    expect(JSON.parse(got.out[0]!)).toMatchObject({
      question_id: id,
      outcome: 'answered',
      status: 'human-answered',
      text: 'Yes, merge it',
    });
    // Another pane's question is unknown here, as it is to get_decision.
    const other = await getCmd(e.proc().ctx, {}, id, { pane: 'mcp' }).catch((x: unknown) => x);
    expect((other as CliError).message).toBe('not_found: unknown question');
  });

  it('only reads while a listener receives, and takes over once that listener stops', async () => {
    const e = await env();
    const listener = e.proc({ json: false });
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    const listening = daemon(listener.ctx, {}, { socket: false, poll: FAST, until });
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

    const q = e.proc();
    const w2 = ask(q.ctx, {}, { question: 'Second?', wait: true, stopped: never(), ...QUICK });
    await vi.waitFor(() => expect(e.created()).toHaveLength(2));
    release();
    await listening;
    await vi.waitFor(() => expect(q.err.join('\n')).toMatch(/receiving here from now on/));
    await e.relay.answerEvent({ questionId: e.created()[1]!, phone: e.phone, text: 'Answer two' });
    expect(await w2).toBe(0);
    expect(q.records().map((r) => r.record)).toEqual(['asked', 'notice', 'result']);
    expect(listener.out.join('\n')).not.toContain('Answer two');
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
          correlation_id: 'fixture-choice',
        });
        // The first ask may come before the background read of what advice needs: it is retried.
        expect(r.isError).toBeFalsy();
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
