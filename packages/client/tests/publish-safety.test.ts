import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BLOCK_END,
  FileSpool,
  MAX_BLOCK_BYTES,
  MAX_NOTICE_BYTES,
  MemoryLocalStore,
  batchNotices,
  formatAnswerNotice,
  MemorySpool,
} from '../src/index.js';
import { DecisionsBridge, RelayClient } from '../src/index.js';
import { SqliteLocalStore } from '../src/store-sqlite.js';
import { origin, setupBridge, makeIdentity, FakeRelay, FakeSink } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'decisions-pub-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);

describe('D: cancel accounts for a create that may already be on the relay', () => {
  it('a provably unsent create is dropped locally', async () => {
    const env = await setupBridge();
    // register through the publisher so no background publish attempt has started
    const r = await env.bridge.publisher.register(origin(), { question: 'q?' });
    await env.bridge.cancelQuestion(r.questionId);
    expect((await env.store.getQuestion(r.questionId))!.local_status).toBe('cancelled');
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
    expect((await env.store.listAudit(20)).some((a) => a.result === 'never-published')).toBe(true);
  });

  it('after a create whose reply was lost, cancel becomes a REAL cancel (the question is open on the relay)', async () => {
    const env = await setupBridge();
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q?', options: [{ id: 'a', label: 'A' }] },
    });
    env.relay.dropCreateReply = 1; // the relay commits the question; we never see the answer
    await env.bridge.pump();
    expect(env.relay.questions.has(r.questionId)).toBe(true);
    expect((await env.store.getQuestion(r.questionId))!.local_status).toBe('queued');
    await env.bridge.cancelQuestion(r.questionId);
    await env.bridge.pump();
    expect(env.relay.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false); // waits for its create
    expect((await env.store.outboxFor(r.questionId)).map((o) => o.kind).sort()).toEqual([
      'cancel',
      'create',
    ]);
    for (let i = 0; i < 4 && (await env.store.outboxFor(r.questionId)).length > 0; i++) {
      for (const o of await env.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
        await env.store.putOutbox({ ...o, next_attempt_at: 0 });
      await env.bridge.pump();
    }
    const order = env.relay.calls
      .filter((c) => c.method === 'POST' && c.path.includes('/questions'))
      .map((c) => c.path.replace(r.questionId, ':id'));
    expect(order.at(-1)).toBe('/api/v1/questions/:id/cancel');
    expect(order.filter((p) => p === '/api/v1/questions')).toHaveLength(2); // original + idempotent retry
    expect((await env.store.listAudit(50)).some((a) => a.result === 'never-published')).toBe(false);
    expect(await env.store.outboxFor(r.questionId)).toHaveLength(0);
  });
});

describe('D: ownership and correlation are scoped to the complete trusted origin', () => {
  const sameOtherSession = (over: Partial<ReturnType<typeof origin>>) => origin(over);
  it('a new generation, session or worktree reusing the pane id cannot read or cancel the old question', async () => {
    const env = await setupBridge();
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'private?' },
    });
    const own = {
      host_id: 'host-local',
      pane_id: 'pane-1',
      terminal_generation: 1,
      agent_session_id: 'sess-1',
      worktree_id: 'wt-1',
    };
    expect((await env.bridge.getDecision(r.questionId, own)).questionId).toBe(r.questionId);
    for (const stranger of [
      { ...own, terminal_generation: 2 },
      { ...own, agent_session_id: 'sess-2' },
      { ...own, worktree_id: 'wt-2' },
      { ...own, host_id: 'other-host' },
    ]) {
      await expect(env.bridge.getDecision(r.questionId, stranger)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(env.bridge.cancelQuestion(r.questionId, stranger)).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    expect(
      (await env.bridge.listPending(sameOtherSession({ terminal_generation: 2 }))).length,
    ).toBe(0);
  });
  it('a correlation id is not shared between sessions of the same pane', async () => {
    const env = await setupBridge();
    const a = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'approve?', correlation_id: 'wf-1' },
    });
    const b = await env.bridge.registerQuestion({
      origin: origin({ agent_session_id: 'sess-2' }),
      input: { question: 'approve?', correlation_id: 'wf-1' },
    });
    const c = await env.bridge.registerQuestion({
      origin: origin({ terminal_generation: 2 }),
      input: { question: 'approve?', correlation_id: 'wf-1' },
    });
    const d = await env.bridge.registerQuestion({
      origin: origin({ worktree_id: 'wt-9' }),
      input: { question: 'approve?', correlation_id: 'wf-1' },
    });
    expect(new Set([a.questionId, b.questionId, c.questionId, d.questionId]).size).toBe(4);
    const again = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'approve?', correlation_id: 'wf-1' },
    });
    expect(again.questionId).toBe(a.questionId);
  });
});

describe('D: attachments survive a restart with a durable store', () => {
  it('FileSpool stores private files and rejects path-like ids', async () => {
    const dir = join(tmp, 'spool-unit');
    const s = new FileSpool(dir);
    await s.put('abc123', new Uint8Array([1, 2, 3]));
    expect(await s.get('abc123')).toEqual(new Uint8Array([1, 2, 3]));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'abc123')).mode & 0o777).toBe(0o600);
    await s.delete('abc123');
    expect(await s.get('abc123')).toBeNull();
    for (const bad of ['../x', 'a/b', '', '.hidden'])
      await expect(s.put(bad, new Uint8Array(1))).rejects.toThrow(/invalid/);
    expect(readdirSync(dir)).toEqual([]);
  });
  it('a durable store refuses attachments without a durable spool', async () => {
    const store = new SqliteLocalStore(join(tmp, 'nospool.db'));
    const env = await setupBridge({ store, resolver: { resolve: async () => ({ bytes: png }) } });
    await expect(
      env.bridge.registerQuestion({
        origin: origin(),
        input: { question: 'q', attachments: [{ local_resource_id: 'x' }] },
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });
    await store.close();
    void MemoryLocalStore;
    void MemorySpool;
  });
  it('queue an attachment offline, restart, and it still publishes', async () => {
    const identity = await makeIdentity();
    const relay = new FakeRelay(identity);
    await relay.initOwner();
    const dbPath = join(tmp, 'restart.db');
    const spoolDir = join(tmp, 'restart-spool');
    const mk = (store: SqliteLocalStore) =>
      new DecisionsBridge({
        identity,
        store,
        sink: new FakeSink(),
        spool: new FileSpool(spoolDir),
        pumpIntervalMs: 0,
        resolver: { resolve: async () => ({ bytes: png }) },
        client: new RelayClient({
          identity,
          fetch: relay.fetch,
          sleep: async () => {},
          maxRetries: 0,
        }),
      });
    const s1 = new SqliteLocalStore(dbPath);
    const b1 = mk(s1);
    relay.down = 1000;
    const r = await b1.registerQuestion({
      origin: origin(),
      input: { question: 'offline with image', attachments: [{ local_resource_id: 'shot' }] },
    });
    await b1.pump();
    expect(relay.questions.size).toBe(0);
    await s1.close(); // process "exits"
    relay.down = 0;
    const s2 = new SqliteLocalStore(dbPath); // new process: fresh memory, same disk
    const b2 = mk(s2);
    for (const o of await s2.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await s2.putOutbox({ ...o, next_attempt_at: 0 });
    await b2.pump();
    expect(relay.questions.has(r.questionId)).toBe(true);
    expect(relay.uploads).toHaveLength(1);
    expect((await s2.getQuestion(r.questionId))!.local_status).toBe('open');
    expect(readdirSync(spoolDir)).toEqual([]); // spool cleaned after publishing
    await s2.close();
  });
});

describe('D: the notice byte budget is enforced per block', () => {
  const cjk = '漢字かな'.repeat(1500); // ~6000 chars = ~18000 UTF-8 bytes
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  it('a huge multi-byte comment still yields a block within budget, properly terminated', () => {
    const t = formatAnswerNotice({
      kind: 'answer',
      questionId: 'q'.repeat(32),
      revision: 1,
      source: 'human',
      choices: [{ id: 'approve', label: 'Approve' }],
      comment: cjk,
      injectionId: 'i'.repeat(32),
    });
    expect(bytes(t)).toBeLessThanOrEqual(MAX_BLOCK_BYTES);
    expect(t.endsWith(BLOCK_END)).toBe(true);
    expect(t).toContain('[truncated]');
    expect(t).toContain('choice: approve'); // metadata is never what gets cut
  });
  it('multi-line CJK comments and a batch of them stay under the chunk cap', () => {
    const block = formatAnswerNotice({
      kind: 'answer',
      questionId: 'q1',
      revision: 1,
      source: 'human',
      comment: (cjk + '\n').repeat(3),
    });
    expect(bytes(block)).toBeLessThanOrEqual(MAX_BLOCK_BYTES);
    for (const chunk of batchNotices([block, block, block]))
      expect(bytes(chunk)).toBeLessThanOrEqual(MAX_NOTICE_BYTES);
  });
  it('short comments are untouched', () => {
    const t = formatAnswerNotice({
      kind: 'answer',
      questionId: 'q1',
      revision: 1,
      source: 'human',
      comment: 'ship it',
    });
    expect(t).toContain('comment: ship it');
    expect(t).not.toContain('truncated');
  });
});
