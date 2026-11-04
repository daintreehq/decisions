import { describe, expect, it, vi } from 'vitest';
import {
  LIMITS,
  PaneSnapshotBody,
  PaneSnapshotContentV1,
  utf8ByteLength,
  type PaneSnapshotRecord,
} from '@daintreehq/decisions-protocol';
import {
  decryptEnvelope,
  importSigningPublicKey,
  newId,
  verifyRecordAndEnvelope,
} from '@daintreehq/decisions-crypto';
import {
  BRIDGE_FEATURES,
  BridgeError,
  DecisionsBridge,
  PolicyRegistry,
  RelayClient,
  buildSnapshotContent,
  type BridgeOptions,
  type PaneSnapshotInput,
  type SnapshotRefreshRequest,
} from '../src/index.js';
import { FakeSocket, origin, setupBridge } from './helpers.js';

const T0 = Date.parse('2026-11-04T10:00:00.000Z');
/** Not the default (2 s), so a test that passes proves the option is honoured. */
const INTERVAL = 1_500;

const input = (over: Partial<PaneSnapshotInput> = {}): PaneSnapshotInput => ({
  agentState: 'waiting',
  waitingReason: 'question',
  paneTitle: 'claude · api',
  terminal: ['$ npm test', 'All tests passed', '? Ship it'],
  ...over,
});

/** A running bridge with snapshots on, a relay that advertises them, and one published question. */
async function snapshotBridge(over: Partial<BridgeOptions> = {}) {
  let clock = T0;
  const refreshes: SnapshotRefreshRequest[] = [];
  const env = await setupBridge({
    now: () => clock,
    snapshots: { onRefresh: (r) => void refreshes.push(r), minIntervalMs: INTERVAL },
    ...over,
  });
  env.relay.features = ['pane-snapshots-v1'];
  await env.bridge.start({ socket: false });
  const ask = async (pane = 'pane-1') => {
    const r = await env.bridge.registerQuestion({
      origin: origin({ pane_id: pane }),
      input: { question: `Ship ${pane}?` },
    });
    await vi.waitFor(async () => {
      await env.bridge.pump();
      expect((await env.store.getQuestion(r.questionId))!.local_status).toBe('open');
    });
    return r.questionId;
  };
  const qid = await ask();
  /** Move the bridge's clock on and let the publisher look again. */
  const tick = (ms: number) => {
    clock += ms;
    env.bridge.snapshots.kick();
  };
  /** Move the clock on without waking the publisher. */
  const advance = (ms: number) => {
    clock += ms;
  };
  const puts = () => env.relay.calls.filter((c) => c.method === 'PUT');
  /** `n` snapshots accepted and the publisher done with the last reply, so the clock may move on. */
  const sent = (n: number) =>
    vi.waitFor(() => {
      expect(env.relay.snapshots).toHaveLength(n);
      expect(env.bridge.snapshots.busy).toBe(false);
    });
  /** `n` snapshot PUTs attempted, whatever the relay replied, and the reply handled. */
  const attempted = (n: number) =>
    vi.waitFor(() => {
      expect(puts()).toHaveLength(n);
      expect(env.bridge.snapshots.busy).toBe(false);
    });
  /** Nothing more goes out: give any stray send a chance, then count. */
  const quiet = async (n: number) => {
    await new Promise((r) => setTimeout(r, 50));
    expect(env.bridge.snapshots.busy).toBe(false);
    expect(env.relay.snapshots).toHaveLength(n);
  };
  const body = (i: number) => PaneSnapshotBody.parse(env.relay.snapshots[i]!.body);
  const open = async (i: number) => {
    const { record, envelope } = body(i).snapshot;
    const pub = await importSigningPublicKey(env.identity.signingPub);
    expect(await verifyRecordAndEnvelope(record, envelope, pub)).toBe(true);
    if (!envelope) return { record, content: null };
    const raw = await decryptEnvelope(envelope, env.identity.epochs, {
      installationId: env.identity.config.installationId,
      questionId: record.question_id,
      recordType: 'pane.snapshot',
      revision: 0,
      senderDeviceId: env.identity.config.deviceId,
      purpose: 'snapshot-content',
    });
    return { record, content: PaneSnapshotContentV1.parse(raw) };
  };
  const refreshEvent = async (questionId: string, targetHostId?: string, refreshId = newId()) => {
    const q = env.relay.questions.get(questionId)!;
    env.relay.push('decision.snapshot.refresh_requested', questionId, null, {
      refresh_id: refreshId,
      requested_by_device_id: env.phone.deviceId,
      requested_at: new Date(clock).toISOString(),
      deadline_at: new Date(clock + LIMITS.snapshotRefreshTimeoutMs).toISOString(),
      target_host_id: targetHostId ?? q.signed.record.target_host_id,
    });
    await env.bridge.catchUp();
  };
  return {
    ...env,
    qid,
    ask,
    tick,
    advance,
    puts,
    sent,
    attempted,
    quiet,
    body,
    open,
    refreshes,
    refreshEvent,
  };
}

describe('publishing', () => {
  it('sends the snapshot sealed and signed, and a later one replaces it', async () => {
    const s = await snapshotBridge();
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    expect(await s.bridge.publishSnapshot(s.qid, input({ terminal: lines }))).toBe('queued');
    await s.sent(1);
    expect(s.relay.snapshots[0]!.questionId).toBe(s.qid);
    const first = await s.open(0);
    expect(first.record).toMatchObject({
      type: 'pane.snapshot',
      question_id: s.qid,
      question_revision: 0,
      sharing: 'on',
      signer_device_id: s.identity.config.deviceId,
      observed_at: new Date(T0).toISOString(),
    });
    expect(first.content).toMatchObject({
      agent_state: 'waiting',
      waiting_reason: 'question',
      pane_title: 'claude · api',
      observed_at: first.record.observed_at,
    });
    // Capped before it was sealed: the newest 200 lines, whole.
    expect(first.content!.terminal_lines).toEqual(lines.slice(-200));

    s.tick(INTERVAL);
    await s.bridge.publishSnapshot(s.qid, input({ agentState: 'working', terminal: 'building' }));
    await s.sent(2);
    const second = await s.open(1);
    expect(second.record.snapshot_id).not.toBe(first.record.snapshot_id);
    expect(Date.parse(second.record.observed_at)).toBeGreaterThan(
      Date.parse(first.record.observed_at),
    );
    expect(second.content).toMatchObject({
      agent_state: 'working',
      waiting_reason: 'question',
      terminal_lines: ['building'],
    });
    // Nothing of the pane is kept or logged in clear.
    const audit = JSON.stringify(await s.store.listAudit(100));
    expect(audit).not.toContain('claude · api');
    expect(audit).not.toContain('building');
  });

  it('signs for the revision an answer moved the question to', async () => {
    const s = await snapshotBridge();
    await s.relay.answerEvent({ questionId: s.qid, phone: s.phone, text: 'yes' });
    await s.bridge.catchUp();
    expect((await s.store.getQuestion(s.qid))!.local_status).toBe('human-answered');
    expect(await s.bridge.publishSnapshot(s.qid, input())).toBe('queued');
    await s.sent(1);
    expect(s.body(0).snapshot.record.question_revision).toBe(1);
  });

  it('signs again for the relay revision after a revision conflict', async () => {
    const s = await snapshotBridge();
    s.relay.snapshotReplies.push({
      status: 409,
      body: { code: 'revision_conflict', message: 'stale', details: { latest_revision: 1 } },
    });
    await s.bridge.publishSnapshot(s.qid, input());
    await s.attempted(1);
    s.tick(INTERVAL);
    await s.sent(1);
    const refused = s.relay.calls.find((c) => c.method === 'PUT')!.body as PaneSnapshotBody;
    const accepted = s.body(0).snapshot.record;
    expect(refused.snapshot.record.question_revision).toBe(0);
    expect(accepted.question_revision).toBe(1);
    expect(accepted.snapshot_id).not.toBe(refused.snapshot.record.snapshot_id);
    expect(Date.parse(accepted.observed_at)).toBeGreaterThan(
      Date.parse(refused.snapshot.record.observed_at),
    );
  });

  it('resends the same body after a transient failure, since the relay may hold it', async () => {
    const s = await snapshotBridge();
    s.relay.snapshotReplies.push({
      status: 503,
      body: { code: 'temporarily_unavailable', message: 'down' },
    });
    await s.bridge.publishSnapshot(s.qid, input());
    await s.attempted(1);
    s.tick(60_000);
    await s.sent(1);
    const [a, b] = s.relay.calls.filter((c) => c.method === 'PUT');
    expect(b!.body).toEqual(a!.body);
  });

  it('holds a snapshot for a question until it is published, and sends it once the create lands', async () => {
    const s = await snapshotBridge();
    // No jitter: the failed create is due again at once, so it can land before the snapshot's own retry.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      s.relay.down = 1; // the create fails once, so the question stays queued
      const r = await s.bridge.registerQuestion({
        origin: origin({ pane_id: 'pane-2' }),
        input: { question: 'Later?' },
      });
      await s.bridge.pump();
      expect((await s.store.getQuestion(r.questionId))!.local_status).toBe('queued');
      expect(await s.bridge.publishSnapshot(r.questionId, input())).toBe('queued');
      await s.quiet(0);
      // Past the spacing between requests, well before the snapshot's own retry: only the bridge's kick
      // after the create can send it now.
      s.advance(250);
      await s.bridge.pump();
      expect((await s.store.getQuestion(r.questionId))!.local_status).toBe('open');
      await s.sent(1);
      expect(s.relay.snapshots[0]!.questionId).toBe(r.questionId);
    } finally {
      random.mockRestore();
    }
  });

  it('refuses a question another pane asked, as for an unknown one', async () => {
    const s = await snapshotBridge();
    const other = {
      host_id: 'host-local',
      pane_id: 'pane-9',
      terminal_generation: 1,
      ownership_principal: 'principal-1',
      agent_incarnation: 'inc-1',
      agent_session_id: 'sess-1',
      worktree_id: 'wt-1',
    };
    await expect(s.bridge.publishSnapshot(s.qid, input(), other)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(s.bridge.publishSnapshot(newId(), input())).rejects.toMatchObject({
      code: 'not_found',
    });
    await s.quiet(0);
  });
});

describe('coalescing', () => {
  it('sends the first of a burst at once and only the newest at the end', async () => {
    const s = await snapshotBridge();
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'a' }));
    await s.sent(1);
    for (const t of ['b', 'c', 'd']) await s.bridge.publishSnapshot(s.qid, input({ terminal: t }));
    s.tick(INTERVAL - 1);
    await s.quiet(1);
    s.tick(1);
    await s.sent(2);
    await s.quiet(2);
    expect((await s.open(0)).content!.terminal_lines).toEqual(['a']);
    expect((await s.open(1)).content!.terminal_lines).toEqual(['d']);
  });

  it('spaces requests across questions and holds every snapshot back after a rate limit', async () => {
    const s = await snapshotBridge();
    const q2 = await s.ask('pane-2');
    s.relay.snapshotReplies.push({
      status: 429,
      body: { code: 'rate_limited', message: 'slow down', retry_after_ms: 30_000 },
    });
    await s.bridge.publishSnapshot(s.qid, input());
    await s.bridge.publishSnapshot(q2, input());
    await s.attempted(1);
    s.tick(29_000);
    await s.quiet(0);
    s.tick(1_000);
    await s.sent(1);
    // The other question waits out the spacing too.
    await s.quiet(1);
    s.tick(250);
    await s.sent(2);
    // The question that was ready longest goes first, whatever order the questions were seen in.
    expect(s.relay.snapshots.map((x) => x.questionId)).toEqual([q2, s.qid]);
  });

  it('never retries or sleeps inside the relay client: the publisher owns the timing', async () => {
    const s = await snapshotBridge();
    const sleep = vi.fn(async () => {});
    const client = new RelayClient({
      identity: s.identity,
      fetch: s.relay.fetch,
      sleep,
      maxRetries: 3,
    });
    s.relay.snapshotReplies.push({
      status: 503,
      body: { code: 'temporarily_unavailable', message: 'down' },
    });
    await expect(client.putSnapshot(s.qid, {} as PaneSnapshotBody)).rejects.toMatchObject({
      status: 503,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(s.puts()).toHaveLength(1);
  });
});

describe('caps and cutting', () => {
  const at = new Date(T0).toISOString();
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  it('keeps the newest 200 lines', () => {
    const lines = Array.from({ length: 201 }, (_, i) => `${i}`);
    expect(buildSnapshotContent(input({ terminal: lines }), at).terminal_lines).toEqual(
      lines.slice(1),
    );
    expect(
      buildSnapshotContent(input({ terminal: lines.join('\r\n') }), at).terminal_lines,
    ).toEqual(lines.slice(1));
  });

  it('drops whole lines from the oldest end until the text fits 32 KiB', () => {
    // 150 lines of 300 bytes each (two-byte characters): 45 KiB in all.
    const lines = Array.from(
      { length: 150 },
      (_, i) => `${i}`.padEnd(3, '_') + 'é'.repeat(148) + '|',
    );
    const kept = buildSnapshotContent(input({ terminal: lines }), at).terminal_lines;
    expect(kept).toEqual(lines.slice(lines.length - kept.length));
    expect(utf8ByteLength(kept.join('\n'))).toBeLessThanOrEqual(LIMITS.snapshotTerminalBytes);
    const oneMore = lines.slice(lines.length - kept.length - 1);
    expect(utf8ByteLength(oneMore.join('\n'))).toBeGreaterThan(LIMITS.snapshotTerminalBytes);
  });

  it('cuts a newest line too long on its own at a character, keeping its end', () => {
    // A one-byte end puts the 32 KiB boundary inside an emoji, so a byte cut would split one.
    const line = 'start ' + '😀'.repeat(10_000) + '!';
    const [kept, ...rest] = buildSnapshotContent(input({ terminal: line }), at).terminal_lines;
    expect(rest).toEqual([]);
    expect(line.endsWith(kept!)).toBe(true);
    expect(kept!.endsWith('😀!')).toBe(true);
    expect(lone.test(kept!)).toBe(false);
    expect(kept).not.toContain('\ufffd');
    expect(utf8ByteLength(kept!)).toBeLessThanOrEqual(LIMITS.snapshotTerminalBytes);
    // The most whole characters that fit: one more emoji would not.
    expect(utf8ByteLength(kept!) + 4).toBeGreaterThan(LIMITS.snapshotTerminalBytes);
    expect(utf8ByteLength(kept!)).not.toBe(LIMITS.snapshotTerminalBytes);
  });

  it('removes escape sequences and controls, and cuts the title at a character', () => {
    const c = buildSnapshotContent(
      input({
        paneTitle: '\u001b]0;ignored\u0007' + 'a'.repeat(239) + '😀 tail\nmore',
        terminal: '\u001b[31mred\u001b[0m text\u0007\n\u001b[2Kdone\n\n',
      }),
      at,
    );
    expect(c.terminal_lines).toEqual(['red text', 'done']);
    expect(c.pane_title).toBe('a'.repeat(239));
    expect(lone.test(c.pane_title)).toBe(false);
    expect(PaneSnapshotContentV1.safeParse(c).success).toBe(true);
  });

  it('refuses a state that is not a token, and input that is not text', () => {
    expect(() => buildSnapshotContent(input({ agentState: 'Waiting!' }), at)).toThrow(BridgeError);
    expect(() => buildSnapshotContent(input({ waitingReason: 'Some reason' }), at)).toThrow(
      BridgeError,
    );
    expect(() =>
      buildSnapshotContent(input({ terminal: [1, 2] as unknown as string[] }), at),
    ).toThrow(BridgeError);
    // A newer state still passes: phones read it as `unknown`.
    expect(buildSnapshotContent(input({ agentState: 'thinking' }), at).agent_state).toBe(
      'thinking',
    );
  });

  it('refuses an observation too far in the future', async () => {
    const s = await snapshotBridge();
    await expect(
      s.bridge.publishSnapshot(s.qid, input({ observedAt: T0 + LIMITS.requestSkewMs + 1 })),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('refresh requests', () => {
  it('hands the host the question and pane, and sends its answer without waiting out the interval', async () => {
    const s = await snapshotBridge();
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'old' }));
    await s.sent(1);
    await s.refreshEvent(s.qid);
    await vi.waitFor(() => expect(s.refreshes).toHaveLength(1));
    const req = s.refreshes[0]!;
    expect(req).toMatchObject({
      questionId: s.qid,
      requestedByDeviceId: s.phone.deviceId,
      origin: { host_id: 'host-local', pane_id: 'pane-1', terminal_generation: 1 },
    });
    expect(Date.parse(req.deadlineAt) - Date.parse(req.requestedAt)).toBe(
      LIMITS.snapshotRefreshTimeoutMs,
    );
    expect(req.alias).toBe((await s.store.getQuestion(s.qid))!.alias);

    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'fresh' }));
    s.tick(250); // the spacing between requests, well short of the question's interval
    await s.sent(2);
    expect((await s.open(1)).content!.terminal_lines).toEqual(['fresh']);
    // The bridge declared the feature, so the relay sends it the refresh events.
    const events = s.relay.calls.filter((c) => c.path === '/api/v1/events');
    expect(events.every((c) => c.query.includes('features=pane-snapshots-v1'))).toBe(true);
  });

  it('ignores a refresh aimed at another host, and one replayed long after its deadline', async () => {
    const s = await snapshotBridge();
    await s.refreshEvent(s.qid, 'f'.repeat(32));
    const audit = await s.store.listAudit(50);
    expect(audit.some((e) => e.result === 'refresh-for-another-host')).toBe(true);
    const q = s.relay.questions.get(s.qid)!;
    s.relay.push('decision.snapshot.refresh_requested', s.qid, null, {
      refresh_id: newId(),
      requested_by_device_id: s.phone.deviceId,
      requested_at: new Date(T0 - 60 * 60_000).toISOString(),
      deadline_at: new Date(T0 - 60 * 60_000 + 15_000).toISOString(),
      target_host_id: q.signed.record.target_host_id,
    });
    await s.bridge.catchUp();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.refreshes).toHaveLength(0);
  });

  it('a slow or failing host callback never holds up the inbox, and a repeated request is handed over once', async () => {
    const errors: Error[] = [];
    const calls: SnapshotRefreshRequest[] = [];
    let fail!: (e: Error) => void;
    const s = await snapshotBridge({
      snapshots: {
        onRefresh: (r) => {
          calls.push(r);
          return new Promise<void>((_, reject) => (fail = reject));
        },
      },
    });
    s.bridge.on('error', (e) => errors.push(e));
    const refreshId = newId();
    await s.refreshEvent(s.qid, undefined, refreshId);
    await s.refreshEvent(s.qid, undefined, refreshId);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // The capture is still running: an answer arriving now is applied all the same.
    await s.relay.answerEvent({ questionId: s.qid, phone: s.phone, text: 'yes' });
    await s.bridge.catchUp();
    expect((await s.store.getQuestion(s.qid))!.local_status).toBe('human-answered');
    fail(new Error('capture failed'));
    await vi.waitFor(() => expect(errors.map((e) => e.message)).toContain('capture failed'));
    expect(calls).toHaveLength(1);
  });
});

describe('clearing', () => {
  it('replaces the snapshot with a sharing-off record and drops the waiting one', async () => {
    const s = await snapshotBridge();
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'shared' }));
    await s.sent(1);
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'never sent' }));
    const cleared = s.bridge.clearSnapshots(s.qid);
    s.tick(250);
    await cleared;
    await s.sent(2);
    const off = s.body(1).snapshot;
    expect(off.envelope).toBeNull();
    expect(off.record).toMatchObject({ sharing: 'off', envelope_digest: null, question_id: s.qid });
    expect((await s.open(1)).content).toBeNull();
    s.tick(INTERVAL * 2);
    await s.quiet(2);
    // Publishing again shares again.
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'back' }));
    await s.sent(3);
    expect(s.body(2).snapshot.record.sharing).toBe('on');
  });

  it('a snapshot published while a sharing-off record waits supersedes it', async () => {
    const s = await snapshotBridge();
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'a' }));
    await s.sent(1);
    // The off record waits out the spacing between requests; the clock does not move.
    const cleared = s.bridge.clearSnapshots(s.qid);
    await new Promise((r) => setTimeout(r, 10));
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'b' }));
    await cleared;
    s.tick(INTERVAL);
    await s.sent(2);
    await s.quiet(2);
    expect(s.body(1).snapshot.record.sharing).toBe('on');
    expect((await s.open(1)).content!.terminal_lines).toEqual(['b']);
  });

  it('clearing while the bridge is stopped resolves at once, and the record goes out on start', async () => {
    const s = await snapshotBridge();
    await s.bridge.stop();
    await s.bridge.clearSnapshots(s.qid);
    await s.quiet(0);
    await s.bridge.start({ socket: false });
    await s.sent(1);
    expect(s.body(0).snapshot.record).toMatchObject({ sharing: 'off', question_id: s.qid });
  });

  it('clears every open question this device published', async () => {
    const s = await snapshotBridge();
    const q2 = await s.ask('pane-2');
    const cleared = s.bridge.clearSnapshots();
    await vi.waitFor(() => {
      s.tick(250);
      expect(s.relay.snapshots).toHaveLength(2);
    });
    await cleared;
    expect(
      s.relay.snapshots.map((x) => [
        x.questionId,
        (x.body as { snapshot: { record: PaneSnapshotRecord } }).snapshot.record.sharing,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [s.qid, 'off'],
        [q2, 'off'],
      ]),
    );
  });
});

describe('lifecycle', () => {
  it('stops publishing once the question is cancelled', async () => {
    const s = await snapshotBridge();
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'a' }));
    await s.sent(1);
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'waiting' }));
    const desktop = { deviceId: s.identity.config.deviceId, keys: s.identity.keys };
    await s.relay.plainActionEvent({
      questionId: s.qid,
      signer: desktop,
      action: 'cancel',
      status: 'cancelled',
    });
    await s.bridge.catchUp();
    expect((await s.store.getQuestion(s.qid))!.local_status).toBe('cancelled');
    s.tick(INTERVAL * 5);
    await s.quiet(1);
    expect(await s.bridge.publishSnapshot(s.qid, input())).toBe('closed');
    await expect(s.bridge.clearSnapshots(s.qid)).resolves.toBeUndefined();
    s.tick(INTERVAL);
    await s.quiet(1);
  });

  it('drops a waiting snapshot when the question closes, even if it reopens before it was due', async () => {
    const s = await snapshotBridge();
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'a' }));
    await s.sent(1);
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'before the cancel' }));
    const owner = { deviceId: s.identity.config.deviceId, keys: s.identity.keys };
    await s.relay.plainActionEvent({
      questionId: s.qid,
      signer: owner,
      action: 'cancel',
      status: 'cancelled',
    });
    await s.relay.plainActionEvent({ questionId: s.qid, signer: owner, action: 'reopen' });
    await s.bridge.catchUp();
    const row = (await s.store.getQuestion(s.qid))!;
    expect([row.local_status, row.question_revision]).toEqual(['open', 1]);
    s.tick(INTERVAL * 2);
    await s.quiet(1);
    // A capture after the reopen is published, for the reopened revision.
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'after' }));
    await s.sent(2);
    expect(s.body(1).snapshot.record.question_revision).toBe(1);
    expect((await s.open(1)).content!.terminal_lines).toEqual(['after']);
  });

  it('stops publishing once the question is deleted', async () => {
    const s = await snapshotBridge();
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'a' }));
    await s.sent(1);
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'b' }));
    s.relay.push('decision.deleted', s.qid, null, {});
    await s.bridge.catchUp();
    s.tick(INTERVAL * 2);
    await s.quiet(1);
    expect(await s.bridge.publishSnapshot(s.qid, input())).toBe('closed');
  });

  it('keeps observations in order across a restart, even with the clock behind', async () => {
    const s = await snapshotBridge();
    await s.bridge.publishSnapshot(s.qid, input());
    await s.sent(1);
    await s.bridge.stop();
    // A new bridge over the same store, whose clock is a minute behind the last observation.
    const again = new DecisionsBridge({
      identity: s.identity,
      store: s.store,
      sink: s.sink,
      client: s.client,
      policy: new PolicyRegistry(),
      pumpIntervalMs: 0,
      now: () => T0 - 60_000,
      snapshots: {},
    });
    await again.start({ socket: false });
    await again.publishSnapshot(s.qid, input());
    await vi.waitFor(() => expect(s.relay.snapshots).toHaveLength(2));
    expect(s.body(1).snapshot.record.observed_at).toBe(new Date(T0 + 1).toISOString());
    await again.stop();
  });

  it('stops publishing once the question expires', async () => {
    const s = await snapshotBridge();
    s.relay.push('decision.expired', s.qid, 0, { reason: 'expired' });
    await s.bridge.catchUp();
    expect(await s.bridge.publishSnapshot(s.qid, input())).toBe('closed');
    await s.quiet(0);
  });

  it('stops when the relay says the question is closed, until it is reopened', async () => {
    const s = await snapshotBridge();
    s.relay.snapshotReplies.push({ status: 410, body: { code: 'expired', message: 'expired' } });
    await s.bridge.publishSnapshot(s.qid, input());
    await s.attempted(1);
    await vi.waitFor(async () =>
      expect((await s.store.listAudit(20)).some((e) => e.event === 'snapshot.stopped')).toBe(true),
    );
    expect(await s.bridge.publishSnapshot(s.qid, input())).toBe('closed');
    // A new revision (a reopen) lets it publish again.
    await s.store.updateQuestion(s.qid, { question_revision: 2 });
    s.tick(INTERVAL);
    expect(await s.bridge.publishSnapshot(s.qid, input())).toBe('queued');
    await s.sent(1);
  });

  it('leaves no timer or late send behind when the bridge stops', async () => {
    const s = await snapshotBridge();
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'a' }));
    await s.sent(1);
    await s.bridge.publishSnapshot(s.qid, input({ terminal: 'b' }));
    await s.bridge.stop();
    s.tick(INTERVAL * 5);
    await s.quiet(1);
  });
});

describe('opting in', () => {
  it('without `snapshots` the bridge refuses them and does not declare the feature', async () => {
    const { bridge, relay, store } = await setupBridge();
    await bridge.start({ socket: false });
    const r = await bridge.registerQuestion({ origin: origin(), input: { question: 'Q?' } });
    await vi.waitFor(async () => {
      await bridge.pump();
      expect((await store.getQuestion(r.questionId))!.local_status).toBe('open');
    });
    await expect(bridge.publishSnapshot(r.questionId, input())).rejects.toMatchObject({
      code: 'not_configured',
    });
    await expect(bridge.clearSnapshots()).rejects.toMatchObject({ code: 'not_configured' });
    await bridge.catchUp();
    const events = relay.calls.filter((c) => c.path === '/api/v1/events');
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((c) => c.query.includes('pane-snapshots-v1'))).toBe(false);
    expect(bridge.features).toEqual(BRIDGE_FEATURES);
  });

  it('declares the feature on catch-up and on its socket when snapshots are on', async () => {
    FakeSocket.instances = [];
    const env = await setupBridge({ webSocket: (u) => new FakeSocket(u), snapshots: {} });
    const events = vi.spyOn(env.client, 'events');
    await env.bridge.catchUp();
    expect(events.mock.calls[0]![2]).toEqual([...BRIDGE_FEATURES, 'pane-snapshots-v1']);
    await env.bridge.start();
    await vi.waitFor(() =>
      expect(env.relay.calls.some((c) => c.path === '/api/v1/socket-ticket')).toBe(true),
    );
    const ticket = env.relay.calls.find((c) => c.path === '/api/v1/socket-ticket')!;
    expect((ticket.body as { features?: string[] }).features).toEqual(
      [...BRIDGE_FEATURES, 'pane-snapshots-v1'].sort(),
    );
    await env.bridge.stop();
  });

  it('sends nothing to a relay that does not advertise the feature', async () => {
    const s = await snapshotBridge();
    s.relay.features = undefined;
    expect(await s.bridge.publishSnapshot(s.qid, input())).toBe('queued');
    await vi.waitFor(() => expect(s.relay.calls.some((c) => c.path === '/api/v1/info')).toBe(true));
    await s.quiet(0);
    expect(await s.bridge.publishSnapshot(s.qid, input())).toBe('unsupported');
    await expect(s.bridge.clearSnapshots()).resolves.toBeUndefined();
    expect(s.relay.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
