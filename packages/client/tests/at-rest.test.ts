import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { decryptEnvelope } from '@daintreehq/decisions-crypto';
import type { SignedAction } from '@daintreehq/decisions-protocol';
import {
  DecisionsBridge,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  sealStoredContent,
  type DecisionLearner,
  type Identity,
  type LearnedDecision,
  type LocalStore,
  type ProxyEngine,
} from '../src/index.js';
import { SQLITE_SCHEMA_VERSION, SqliteLocalStore } from '../src/store-sqlite.js';
import { FakeRelay, FakeSink, makeIdentity, makePhone, origin } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'decisions-at-rest-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const dbPath = () => join(dir, `at-rest-${n++}.db`);

// Distinctive plaintext markers: none of them may ever appear in a store row or in the database file.
const QUESTION = 'QPLAIN shall we ship the gizmo';
const CONTEXT = 'CTXPLAIN the staging database is still migrating';
const LABEL = 'LABELPLAIN Approve the release';
const ANSWER = 'ANSPLAIN looks good, ship it';
const MARKERS = ['QPLAIN', 'CTXPLAIN', 'LABELPLAIN', 'ANSPLAIN', 'PROXYPLAIN', 'LEGACYPLAIN'];

/** Everything a LocalStore holds that the bridge wrote, as one string. */
async function dumpStore(store: LocalStore): Promise<string> {
  return JSON.stringify([
    await store.listQuestions(),
    await store.dueOutbox(Number.MAX_SAFE_INTEGER, 10_000),
    await store.listAudit(10_000),
    await store.openIntents(),
  ]);
}

/** The raw bytes of the database and its WAL/SHM side files, searched for each marker. */
function leakedInFile(path: string): string[] {
  const found: string[] = [];
  for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    if (!existsSync(p)) continue;
    const bytes = readFileSync(p);
    for (const m of MARKERS) if (bytes.includes(Buffer.from(m, 'utf8'))) found.push(`${p}:${m}`);
  }
  return found;
}

interface Env {
  identity: Identity;
  relay: FakeRelay;
  phone: Awaited<ReturnType<typeof makePhone>>;
  sink: FakeSink;
}

async function makeEnv(): Promise<Env> {
  const identity = await makeIdentity();
  const relay = new FakeRelay(identity);
  await relay.initOwner();
  const phone = await makePhone(identity);
  relay.devices.push(phone.cert);
  const sink = new FakeSink();
  sink.addPane('pane-1');
  return { identity, relay, phone, sink };
}

function bridgeFor(
  env: Env,
  store: LocalStore,
  over: Partial<ConstructorParameters<typeof DecisionsBridge>[0]> = {},
) {
  const client = new RelayClient({
    identity: env.identity,
    fetch: env.relay.fetch,
    sleep: async () => {},
    maxRetries: 0,
  });
  return new DecisionsBridge({
    identity: env.identity,
    store,
    sink: env.sink,
    client,
    policy: new PolicyRegistry(),
    pumpIntervalMs: 0,
    ...over,
  });
}

async function ask(bridge: DecisionsBridge, extra: Record<string, unknown> = {}) {
  const r = await bridge.registerQuestion({
    origin: origin(),
    input: {
      question: QUESTION,
      context: CONTEXT,
      options: [
        { id: 'approve', label: LABEL },
        { id: 'reject', label: 'Reject' },
      ],
      ...extra,
    },
  });
  await bridge.pump();
  return r.questionId;
}

describe('no question or answer plaintext at rest (learning off)', () => {
  it('a full ask, answer and delivery leaves no plaintext in any store row or in the database file', async () => {
    const env = await makeEnv();
    const path = dbPath();
    const store = new SqliteLocalStore(path);
    const bridge = bridgeFor(env, store);
    const qid = await ask(bridge);
    expect(await dumpStore(store)).not.toMatch(/QPLAIN|CTXPLAIN|LABELPLAIN/);

    await env.relay.answerEvent({
      questionId: qid,
      phone: env.phone,
      options: ['approve'],
      text: ANSWER,
    });
    await bridge.catchUp();
    // Delivery decrypts on demand: the terminal gets the real text.
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain(`comment: ${ANSWER}`);
    expect(env.sink.typed[0]!.text).toContain('choice: approve');
    expect((await store.getQuestion(qid))!.delivery_status).toBe('terminal-delivered');

    // get_decision and the pending view decrypt on demand too.
    const view = await bridge.getDecision(qid);
    expect(view).toMatchObject({ choice: 'approve', text: ANSWER, provenance: 'human' });
    expect(view.answers[0]).toMatchObject({ choices: ['approve'], text: ANSWER });

    const dump = await dumpStore(store);
    for (const m of MARKERS) expect(dump).not.toContain(m);
    const row = (await store.getQuestion(qid))!;
    expect(row.content_sealed).toBeTruthy();
    expect(row.legacy_content_json ?? null).toBeNull();
    await bridge.stop();
    await store.close();
    expect(leakedInFile(path)).toEqual([]);
  });

  it('the in-memory store holds no plaintext either (sealing happens above the store)', async () => {
    const env = await makeEnv();
    const store = new MemoryLocalStore();
    const bridge = bridgeFor(env, store);
    const qid = await ask(bridge);
    env.sink.panes.get('pane-1')!.idle = false;
    await env.relay.answerEvent({
      questionId: qid,
      phone: env.phone,
      options: ['approve'],
      text: ANSWER,
    });
    await bridge.catchUp();
    const dump = await dumpStore(store);
    for (const m of MARKERS) expect(dump).not.toContain(m);
    expect((await bridge.listPending()).length).toBe(0); // human-answered is not pending
    expect((await bridge.getDecision(qid)).text).toBe(ANSWER);
  });

  it('a proxy draft waiting in the outbox is sealed, and still sent with its real content', async () => {
    const env = await makeEnv();
    const store = new MemoryLocalStore();
    const proxy: ProxyEngine = {
      async suggest() {
        return {
          action: 'answer',
          selected_option_ids: ['approve'],
          answer_text: 'PROXYPLAIN the model thinks yes',
          confidence: 0.95,
          model_id: 'dm-1',
          prompt_template_version: 'v1',
          retrieval_reference_ids: [],
          rationale: 'PROXYPLAIN rationale',
          risk_flags: [],
        };
      },
    };
    let clock = Date.now();
    const bridge = bridgeFor(env, store, {
      proxy,
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
      now: () => clock,
    });
    // Straight to the publisher: registerQuestion would also start a background pump that runs the proxy.
    const { questionId: qid } = await bridge.publisher.register(origin(), {
      question: QUESTION,
      options: [{ id: 'approve', label: LABEL }],
      requested_requirement: 'proxy-first',
    });
    // Publish the question, then have the relay drop the proxy-answer so it stays queued.
    await bridge.publisher.flush();
    await bridge.runProxy(qid);
    // The draft as queued, before it was ever prepared for sending.
    expect(await dumpStore(store)).not.toContain('PROXYPLAIN');
    env.relay.down = 1;
    await bridge.publisher.flush();
    const queued = (await store.outboxFor(qid)).filter((o) => o.kind === 'proxy-answer');
    expect(queued).toHaveLength(1);
    expect(await dumpStore(store)).not.toContain('PROXYPLAIN');

    clock += 600_000;
    await bridge.publisher.flush();
    const post = env.relay.calls.find((c) => c.path.endsWith('/proxy-answer'))!;
    const signed = (post.body as { action: SignedAction }).action;
    const sent = await decryptEnvelope<{ text: string }>(signed.envelope!, env.identity.epochs);
    expect(sent.text).toBe('PROXYPLAIN the model thinks yes');
    expect(await dumpStore(store)).not.toContain('PROXYPLAIN');
  });
});

describe('an undelivered answer survives a restart', () => {
  it('is recovered from its sealed copy and delivered after the process restarts', async () => {
    const env = await makeEnv();
    const path = dbPath();
    const store = new SqliteLocalStore(path);
    const bridge = bridgeFor(env, store);
    const qid = await ask(bridge);
    env.sink.panes.get('pane-1')!.idle = false; // the agent is busy: the answer waits
    await env.relay.answerEvent({
      questionId: qid,
      phone: env.phone,
      options: ['approve'],
      text: ANSWER,
    });
    await bridge.catchUp();
    expect(env.sink.typed).toHaveLength(0);
    expect((await store.getQuestion(qid))!.delivery_status).toBe('desktop-received');
    await bridge.stop();
    await store.close();
    // Nothing readable on disk while the answer waits.
    expect(leakedInFile(path)).toEqual([]);

    // "Restart": a fresh store and bridge over the same file and identity, with no help from the relay.
    env.sink.panes.get('pane-1')!.idle = true;
    const store2 = new SqliteLocalStore(path);
    const bridge2 = bridgeFor(env, store2);
    const before = env.relay.calls.length;
    await bridge2.start({ socket: false });
    await bridge2.pump();
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain(`comment: ${ANSWER}`);
    expect(env.sink.typed[0]!.text).toContain('choice: approve');
    expect((await store2.getQuestion(qid))!.delivery_status).toBe('terminal-delivered');
    // The answer came from the local sealed copy: no event was re-fetched to rebuild it.
    expect(env.relay.calls.slice(before).some((c) => c.path === '/api/v1/events')).toBe(false);
    await bridge2.stop();
    await store2.close();
    expect(leakedInFile(path)).toEqual([]);
  });

  it.each([
    [
      'tampered',
      (sealed: string) => {
        const e = JSON.parse(sealed) as { ciphertext: string };
        e.ciphertext = e.ciphertext.slice(0, -4) + 'AAAA';
        return JSON.stringify(e);
      },
    ],
    ['missing', () => null],
  ])(
    'an answer whose sealed copy is %s is never typed blank: it needs attention',
    async (_k, corrupt) => {
      const env = await makeEnv();
      const store = new MemoryLocalStore();
      const bridge = bridgeFor(env, store);
      const qid = await ask(bridge);
      env.sink.panes.get('pane-1')!.idle = false;
      await env.relay.answerEvent({
        questionId: qid,
        phone: env.phone,
        options: ['approve'],
        text: ANSWER,
      });
      await bridge.catchUp();
      const row = (await store.getQuestion(qid))!;
      const entries = JSON.parse(row.answers_json) as { sealed: string | null }[];
      entries[0]!.sealed = corrupt(entries[0]!.sealed!);
      await store.updateQuestion(qid, { answers_json: JSON.stringify(entries) });
      env.sink.panes.get('pane-1')!.idle = true;
      await bridge.notifyPaneIdle();
      expect(env.sink.typed).toHaveLength(0);
      expect((await store.getQuestion(qid))!).toMatchObject({
        delivery_status: 'needs-attention',
        error_code: 'answer_unreadable',
      });
    },
  );
});

describe('learning', () => {
  it('the learner contract accepts a hook that returns a value (the history store returns its record result)', () => {
    const hook: DecisionLearner = { learn: () => ({ recorded: true as const, revision: 1 }) };
    expect(hook.learn).toBeTypeOf('function');
  });

  function learner() {
    const seen: LearnedDecision[] = [];
    const l: DecisionLearner = {
      learn(d) {
        seen.push(d);
      },
    };
    return { l, seen };
  }

  it('with a learner, human answers reach it in full while the store still holds no plaintext', async () => {
    const env = await makeEnv();
    const path = dbPath();
    const store = new SqliteLocalStore(path);
    const { l, seen } = learner();
    const bridge = bridgeFor(env, store, { learner: l });
    const qid = await ask(bridge);
    await env.relay.answerEvent({
      questionId: qid,
      phone: env.phone,
      options: ['approve'],
      text: ANSWER,
    });
    await bridge.catchUp();
    await env.relay.answerEvent({
      questionId: qid,
      phone: env.phone,
      action: 'override',
      expectedRevision: 1,
      options: ['reject'],
      text: 'ANSPLAIN actually no',
    });
    await bridge.catchUp();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      questionId: qid,
      question: QUESTION,
      context: CONTEXT,
      options: [
        { id: 'approve', label: LABEL },
        { id: 'reject', label: 'Reject' },
      ],
      selectedOptionIds: ['approve'],
      text: ANSWER,
      requirement: 'human-required',
      projectId: 'proj-1',
      revision: 1,
      correction: false,
    });
    expect(seen[1]).toMatchObject({ selectedOptionIds: ['reject'], revision: 2, correction: true });
    const dump = await dumpStore(store);
    for (const m of MARKERS) expect(dump).not.toContain(m);
    await bridge.stop();
    await store.close();
    expect(leakedInFile(path)).toEqual([]);
  });

  it("a model's abstention prose never reaches the audit log, only its code", async () => {
    const env = await makeEnv();
    const store = new MemoryLocalStore();
    const bridge = bridgeFor(env, store, {
      proxy: {
        async suggest() {
          return { action: 'abstain', reason: `model-abstained: unsure whether "${QUESTION}"` };
        },
      },
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
    });
    await ask(bridge, { requested_requirement: 'proxy-first' });
    await bridge.pump();
    const audit = await store.listAudit(100);
    expect(audit.find((a) => a.event === 'proxy.abstain')).toMatchObject({
      result: 'model-abstained',
    });
    expect(JSON.stringify(audit)).not.toContain('QPLAIN');
  });

  it('proxy answers are never learned, and a failing learner never blocks delivery', async () => {
    const env = await makeEnv();
    const store = new MemoryLocalStore();
    const seen: LearnedDecision[] = [];
    const bridge = bridgeFor(env, store, {
      learner: {
        learn(d) {
          seen.push(d);
          throw new Error('history store is locked');
        },
      },
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
    });
    const qid = await ask(bridge, { requested_requirement: 'proxy-ok' });
    const proxyDevice = await makePhone(env.identity, 'desktop-host');
    env.relay.devices.push(proxyDevice.cert);
    await env.relay.answerEvent({
      questionId: qid,
      phone: proxyDevice,
      action: 'proxy-answer',
      options: ['approve'],
    });
    await bridge.catchUp();
    expect(seen).toHaveLength(0);
    expect(env.sink.typed).toHaveLength(1);
    await env.relay.answerEvent({
      questionId: qid,
      phone: env.phone,
      action: 'override',
      expectedRevision: 1,
      options: ['reject'],
      text: ANSWER,
    });
    await bridge.catchUp();
    expect(seen).toHaveLength(1);
    expect(env.sink.typed).toHaveLength(2);
    expect((await store.listAudit(100)).some((a) => a.event === 'learning.failed')).toBe(true);
  });
});

/** The schema exactly as version 2 shipped it (before content was sealed). */
function writeVersion2Database(path: string, questionId: string): void {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE questions (
     question_id TEXT PRIMARY KEY, alias INTEGER NOT NULL UNIQUE, origin_host_id TEXT NOT NULL,
     pane_id TEXT NOT NULL, terminal_generation INTEGER NOT NULL, agent_kind TEXT NOT NULL,
     agent_session_id TEXT, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL,
     worktree_root TEXT NOT NULL, workflow_gate_id TEXT, requirement TEXT NOT NULL,
     question_revision INTEGER NOT NULL DEFAULT 0, remote_event_seq INTEGER,
     origin_created_at TEXT NOT NULL, expires_at TEXT, local_status TEXT NOT NULL,
     delivery_status TEXT NOT NULL, last_injection_id TEXT, last_attempt_at TEXT,
     agent_resume_strategy TEXT, error_code TEXT, content_json TEXT,
     answers_json TEXT NOT NULL DEFAULT '[]', history_only INTEGER NOT NULL DEFAULT 0,
     delivered_revision INTEGER NOT NULL DEFAULT 0, attachment_digests TEXT NOT NULL DEFAULT '[]',
     ownership_principal TEXT NOT NULL DEFAULT '', agent_incarnation TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX questions_pane ON questions(origin_host_id, pane_id);
   CREATE TABLE outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, question_id TEXT NOT NULL,
     payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL, last_error TEXT);
   CREATE INDEX outbox_due ON outbox(next_attempt_at);
   CREATE TABLE inbound_events (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
     event_type TEXT NOT NULL, json TEXT NOT NULL, received_at INTEGER NOT NULL, processed_at INTEGER);
   CREATE TABLE injection_intents (injection_id TEXT PRIMARY KEY, question_id TEXT NOT NULL,
     answer_revision INTEGER NOT NULL, host_id TEXT NOT NULL, pane_id TEXT NOT NULL,
     terminal_generation INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL, ownership_principal TEXT NOT NULL DEFAULT '',
     agent_incarnation TEXT NOT NULL DEFAULT '');
   CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, json TEXT NOT NULL);
   PRAGMA user_version = 2;`);
  const bigContext = `LEGACYPLAIN context ${'x'.repeat(20_000)}`; // spills into overflow pages
  const content = (question: string) =>
    JSON.stringify({
      content_version: 1,
      question,
      context: bigContext,
      kind: 'mixed',
      options: [
        { id: 'approve', label: 'LEGACYPLAIN Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      attachments: [],
      allow_text: true,
      project_label: 'proj-1',
      machine_label: 'host-local',
      origin_summary: 'claude · wt-1',
    });
  const answers = JSON.stringify([
    {
      entry_id: 'act-legacy-1',
      kind: 'answer',
      action: 'answer',
      revision: 1,
      source: 'human',
      choices: [{ id: 'approve', label: 'LEGACYPLAIN Approve' }],
      text: 'LEGACYPLAIN answer that was never typed',
      reviewed_attachment_digests: [],
      correction: false,
      created_at: '2026-10-01T00:01:00.000Z',
      deliver: true,
      delivered: false,
    },
  ]);
  db.prepare(
    `INSERT INTO questions(question_id, alias, origin_host_id, pane_id, terminal_generation, agent_kind,
       agent_session_id, project_id, worktree_id, worktree_root, workflow_gate_id, requirement,
       question_revision, origin_created_at, local_status, delivery_status, content_json, answers_json,
       ownership_principal, agent_incarnation)
     VALUES(?, 1, 'host-local', 'pane-1', 1, 'claude', 'sess-1', 'proj-1', 'wt-1', '/work/proj-1',
       NULL, 'proxy-ok', 1, '2026-10-01T00:00:00.000Z', 'human-answered', 'desktop-received', ?, '[]',
       'principal-1', 'inc-1')`,
  ).run(questionId, content('LEGACYPLAIN first draft of the question'));
  // Rewrite the row so earlier copies of the plaintext linger in freed space, as they would in real use.
  db.prepare('UPDATE questions SET content_json = ?, answers_json = ? WHERE question_id = ?').run(
    content('LEGACYPLAIN the question as asked'),
    answers,
    questionId,
  );
  db.prepare(
    `INSERT INTO outbox(id, kind, question_id, payload, attempts, next_attempt_at, created_at)
     VALUES('ob-legacy', 'proxy-answer', ?, ?, 0, 9007199254740991, 1)`,
  ).run(
    questionId,
    JSON.stringify({
      content: {
        content_version: 1,
        selected_option_ids: ['approve'],
        text: 'LEGACYPLAIN queued proxy draft',
        reviewed_attachment_digests: [],
        model_id: 'dm-1',
        prompt_template_version: 'v1',
        confidence: 0.9,
        retrieval_reference_ids: [],
      },
    }),
  );
  db.close();
}

describe('migrating a store written before content was sealed', () => {
  it('seals every plaintext row, erases the old pages, and still delivers the pending answer', async () => {
    const env = await makeEnv();
    const path = dbPath();
    const qid = 'q-legacy-01';
    writeVersion2Database(path, qid);
    expect(leakedInFile(path).length).toBeGreaterThan(0); // the fixture really holds plaintext

    const store = new SqliteLocalStore(path);
    const bridge = bridgeFor(env, store);
    await bridge.start({ socket: false });
    await bridge.pump();
    // The pending answer, recovered from the migrated row, reaches the terminal exactly once.
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain('comment: LEGACYPLAIN answer that was never typed');
    expect(env.sink.typed[0]!.text).toContain('choice: approve');
    const row = (await store.getQuestion(qid))!;
    expect(row.delivery_status).toBe('terminal-delivered');
    expect(row.legacy_content_json ?? null).toBeNull();
    expect(row.content_sealed).toBeTruthy();
    // Viewing still works, decrypting on demand.
    expect(await bridge.getDecision(qid)).toMatchObject({
      choice: 'approve',
      text: 'LEGACYPLAIN answer that was never typed',
    });
    // The queued proxy draft survived, sealed.
    const ob = await store.outboxFor(qid);
    expect(ob).toHaveLength(1);
    expect(JSON.stringify(ob)).not.toContain('LEGACYPLAIN');
    expect(await dumpStore(store)).not.toContain('LEGACYPLAIN');
    expect(leakedInFile(path)).toEqual([]); // while still open, not only after the closing checkpoint
    await bridge.stop();
    await store.close();
    // No plaintext anywhere in the file, including freed pages, overflow pages and the WAL.
    expect(leakedInFile(path)).toEqual([]);
    const raw = new DatabaseSync(path);
    expect(
      (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(SQLITE_SCHEMA_VERSION);
    raw.close();
  });

  it('seals a migrated store even when no bridge ever starts (sealStoredContent)', async () => {
    const env = await makeEnv();
    const path = dbPath();
    writeVersion2Database(path, 'q-legacy-02');
    const store = new SqliteLocalStore(path);
    const r = await sealStoredContent({ store, identity: env.identity });
    expect(r).toEqual({ questions: 1, outbox: 1 });
    // Erased at once, not merely at the next checkpoint: checked while the store is still open.
    expect(leakedInFile(path)).toEqual([]);
    expect(await sealStoredContent({ store, identity: env.identity })).toEqual({
      questions: 0,
      outbox: 0,
    });
    await store.close();
    expect(leakedInFile(path)).toEqual([]);
  });

  it('a crash after sealing but before compacting still compacts on the next open', async () => {
    const env = await makeEnv();
    const path = dbPath();
    writeVersion2Database(path, 'q-legacy-04');
    // The process "dies" straight after the last sealed row (the outbox draft) is written.
    class CrashingStore extends SqliteLocalStore {
      override async putOutbox(item: Parameters<LocalStore['putOutbox']>[0]) {
        await super.putOutbox(item);
        throw new Error('process died');
      }
    }
    const store = new CrashingStore(path);
    await expect(sealStoredContent({ store, identity: env.identity })).rejects.toThrow(/died/);
    await store.close();
    const reopened = new SqliteLocalStore(path);
    // Every row is already sealed, yet the freed pages are still erased.
    expect(await sealStoredContent({ store: reopened, identity: env.identity })).toEqual({
      questions: 0,
      outbox: 0,
    });
    expect(await reopened.getMeta('at-rest:compact-pending')).toBe('');
    expect(leakedInFile(path)).toEqual([]);
    await reopened.close();
  });

  it('sealing keeps bookkeeping another writer changed while it was encrypting', async () => {
    const env = await makeEnv();
    const path = dbPath();
    const qid = 'q-legacy-05';
    writeVersion2Database(path, qid);
    // Between the snapshot and the write, a concurrent delivery marks the legacy answer delivered and a
    // new (already sealed) answer is appended.
    class RacingStore extends SqliteLocalStore {
      armed = true;
      override async getQuestion(id: string) {
        if (this.armed) {
          this.armed = false;
          const cur = (await super.getQuestion(id))!;
          const entries = JSON.parse(cur.answers_json) as Record<string, unknown>[];
          entries[0]!.delivered = true;
          entries.push({
            entry_id: 'act-new-2',
            kind: 'answer',
            action: 'override',
            revision: 2,
            source: 'human',
            correction: true,
            created_at: '2026-10-01T00:02:00.000Z',
            deliver: true,
            delivered: false,
            sealed: 'sealed-by-someone-else',
          });
          await super.updateQuestion(id, { answers_json: JSON.stringify(entries) });
        }
        return super.getQuestion(id);
      }
    }
    const store = new RacingStore(path);
    await sealStoredContent({ store, identity: env.identity });
    const entries = JSON.parse((await store.getQuestion(qid))!.answers_json) as Record<
      string,
      unknown
    >[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ entry_id: 'act-legacy-1', delivered: true });
    expect(entries[0]!.text).toBeUndefined();
    expect(entries[0]!.sealed).toEqual(expect.any(String));
    expect(entries[1]).toMatchObject({ entry_id: 'act-new-2', sealed: 'sealed-by-someone-else' });
    await store.close();
    expect(leakedInFile(path)).toEqual([]);
  });

  it('a compaction that fails (database busy) is retried on the next open', async () => {
    const env = await makeEnv();
    const path = dbPath();
    writeVersion2Database(path, 'q-legacy-03');
    // Another process holds a read transaction open: VACUUM cannot run.
    const other = new DatabaseSync(path);
    other.exec('BEGIN');
    other.prepare('SELECT COUNT(*) FROM questions').get();
    const store = new SqliteLocalStore(path);
    expect(await sealStoredContent({ store, identity: env.identity })).toEqual({
      questions: 1,
      outbox: 1,
    });
    expect(await store.getMeta('at-rest:compact-pending')).toBe('1');
    other.exec('COMMIT');
    other.close();
    // Nothing left to seal, but the pending compaction still runs.
    expect(await sealStoredContent({ store, identity: env.identity })).toEqual({
      questions: 0,
      outbox: 0,
    });
    expect(await store.getMeta('at-rest:compact-pending')).toBe('');
    expect(leakedInFile(path)).toEqual([]);
    await store.close();
  });
});
