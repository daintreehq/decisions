import { describe, expect, it, vi } from 'vitest';
import {
  MemoryLocalStore,
  STORE_FORMAT,
  STORE_FORMAT_KEY,
  StoreFormatError,
  formatAnswerNotice,
  parseAnswers,
  sealAnswerContent,
  sealStoredContent,
  serializeAnswers,
  parseMessages,
  unsupportedEntry,
  type AnswerEntry,
  type AnswerNoticeInput,
} from '../src/index.js';
import { origin, setupBridge, tick } from './helpers.js';

/** A question published and open, with nothing delivered yet. */
async function openQuestion(over: Parameters<typeof setupBridge>[0] = {}) {
  const env = await setupBridge(over);
  const { questionId } = await env.bridge.registerQuestion({
    origin: origin(),
    input: { question: 'Ship it?', options: [{ id: 'yes', label: 'Yes' }] },
  });
  await env.bridge.pump();
  return { ...env, questionId };
}

/** An entry as a newer client might store it: a kind (and source) this client has never heard of. */
const futureEntry = (over: Record<string, unknown> = {}): AnswerEntry =>
  ({
    entry_id: 'act-future-1',
    kind: 'superseded',
    action: 'expire',
    revision: 1,
    source: 'system',
    correction: false,
    created_at: '2026-11-19T00:00:00.000Z',
    event_seq: 1,
    deliver: true,
    delivered: false,
    sealed: null,
    ...over,
  }) as unknown as AnswerEntry;

async function setEntries(
  env: Awaited<ReturnType<typeof openQuestion>>,
  entries: AnswerEntry[],
  questionId = env.questionId,
) {
  await env.store.updateQuestion(questionId, { answers_json: serializeAnswers(entries) });
}

const attentionAudits = async (env: Awaited<ReturnType<typeof openQuestion>>) =>
  (await env.store.listAudit(1000)).filter((a) => a.event === 'delivery.attention');

describe('an answer entry this client does not understand', () => {
  it('is never typed as an answer: the question is held and reported', async () => {
    const env = await openQuestion();
    await setEntries(env, [futureEntry()]);
    const r = await env.bridge.delivery.drain();
    expect(r.needsAttention).toBe(1);
    expect(env.sink.typed).toHaveLength(0);
    const row = (await env.store.getQuestion(env.questionId))!;
    expect(row.delivery_status).toBe('needs-attention');
    expect(row.error_code).toBe('answer_unknown_kind');
    // The entry is kept as the newer client wrote it, for a client that understands it.
    expect(parseAnswers(row.answers_json)).toEqual([futureEntry()]);
    expect(await env.store.openIntents()).toEqual([]);
    expect((await attentionAudits(env)).map((a) => a.result)).toEqual(['answer_unknown_kind']);
  });

  it('is reported once, and again after a retry, which still types nothing', async () => {
    const env = await openQuestion();
    await setEntries(env, [futureEntry()]);
    await env.bridge.delivery.drain();
    expect((await env.bridge.delivery.drain()).needsAttention).toBe(0);
    expect(await attentionAudits(env)).toHaveLength(1);
    const r = await env.bridge.retryDelivery(env.questionId);
    expect(r.needsAttention).toBe(1);
    expect(env.sink.typed).toHaveLength(0);
    expect((await env.store.getQuestion(env.questionId))!.error_code).toBe('answer_unknown_kind');
    expect(await attentionAudits(env)).toHaveLength(2);
  });

  it('a question whose earlier write may have reached the terminal keeps saying so', async () => {
    const env = await openQuestion();
    await env.relay.answerEvent({ questionId: env.questionId, phone: env.phone, options: ['yes'] });
    await env.bridge.catchUp();
    const typed = (await env.store.getQuestion(env.questionId))!;
    await env.store.updateIntent(typed.last_injection_id!, { state: 'uncertain' });
    // A retry clears the flag, never the intent; the newer client's entry arrives meanwhile.
    await env.store.updateQuestion(env.questionId, {
      delivery_status: 'desktop-received',
      answers_json: serializeAnswers([
        ...parseAnswers(typed.answers_json),
        futureEntry({ revision: 2, event_seq: 99 }),
      ]),
    });
    env.sink.typed.length = 0;
    expect((await env.bridge.delivery.drain()).needsAttention).toBe(0);
    expect(env.sink.typed).toHaveLength(0);
    expect(await attentionAudits(env)).toHaveLength(0);
    expect(await env.store.hasUncertainIntent(env.questionId)).toBe(true);
  });

  it('holds an answer, or a decline, from a source this client does not expect', async () => {
    for (const [kind, source] of [
      ['answer', 'system'],
      ['answer', 'gate'],
      ['declined', 'proxy'],
      ['declined', 'system'],
    ] as const) {
      const env = await openQuestion();
      const row = (await env.store.getQuestion(env.questionId))!;
      if (kind === 'declined')
        await env.store.updateQuestion(env.questionId, { local_status: 'cancelled' });
      // A well-formed entry in every other way: an answer that opens, a decline as the inbox writes one.
      const entry_id = `act-${kind}-${source}`;
      const revision = row.question_revision;
      const sealed =
        kind === 'answer'
          ? await sealAnswerContent(env, env.questionId, entry_id, revision, {
              choices: [{ id: 'yes', label: 'Yes' }],
              text: '',
              reviewed_attachment_digests: [],
            })
          : null;
      const action = kind === 'answer' ? 'answer' : 'cancel';
      await setEntries(env, [futureEntry({ entry_id, kind, source, action, revision, sealed })]);
      await env.bridge.delivery.drain();
      expect(env.sink.typed).toHaveLength(0);
      const after = (await env.store.getQuestion(env.questionId))!;
      expect([kind, source, after.delivery_status, after.error_code]).toEqual([
        kind,
        source,
        'needs-attention',
        'answer_unknown_source',
      ]);
    }
  });

  it("holds the question's later answers and follow-ups with it, never another question's", async () => {
    const env = await openQuestion({ followUps: true });
    const other = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Other?', options: [{ id: 'yes', label: 'Yes' }] },
    });
    await env.bridge.pump();
    await setEntries(env, [futureEntry()]);
    await env.relay.answerEvent({ questionId: env.questionId, phone: env.phone, options: ['yes'] });
    await env.relay.messageEvent({ questionId: env.questionId, signer: env.phone, text: 'and?' });
    await env.relay.answerEvent({
      questionId: other.questionId,
      phone: env.phone,
      options: ['yes'],
    });
    await env.bridge.catchUp();
    const typed = env.sink.typed.map((t) => t.text).join('\n');
    expect(typed).toContain(`question_id: ${other.questionId}`);
    expect(typed).not.toContain(`question_id: ${env.questionId}`);
    const row = (await env.store.getQuestion(env.questionId))!;
    expect(row.error_code).toBe('answer_unknown_kind');
    expect(parseAnswers(row.answers_json).filter((e) => !e.delivered)).toHaveLength(2);
    const messages = parseMessages(row.messages_json);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.delivery).toMatchObject({ deliver: true, status: 'received' });
  });

  it('is left as it is by the pass that seals legacy content, which still seals the rest', async () => {
    const env = await openQuestion();
    const entry = futureEntry({ text: 'kept for a newer client', choices: [] });
    const legacy = futureEntry({
      entry_id: 'act-legacy',
      kind: 'answer',
      action: 'answer',
      source: 'human',
      text: 'an answer stored in clear',
      choices: [{ id: 'yes' }],
      reviewed_attachment_digests: [],
    });
    await setEntries(env, [legacy, entry]);
    await sealStoredContent({ store: env.store, identity: env.identity });
    const [sealed, kept] = parseAnswers(
      (await env.store.getQuestion(env.questionId))!.answers_json,
    );
    expect(sealed).not.toHaveProperty('text');
    expect(sealed!.sealed).toEqual(expect.any(String));
    expect(kept).toEqual(entry);
  });

  it("is never reported as the person's answer by get_decision", async () => {
    const env = await openQuestion();
    await env.relay.answerEvent({ questionId: env.questionId, phone: env.phone, options: ['yes'] });
    await env.bridge.catchUp();
    expect((await env.bridge.getDecision(env.questionId)).provenance).toBe('human');
    const row = (await env.store.getQuestion(env.questionId))!;
    await setEntries(
      env,
      parseAnswers(row.answers_json).map(
        (e) => ({ ...e, source: 'gate' }) as unknown as AnswerEntry,
      ),
    );
    expect((await env.bridge.getDecision(env.questionId)).provenance).toBeNull();
  });

  it("never reads a confirmation or a decline from anyone but the person as the person's", async () => {
    const env = await openQuestion();
    const content = { choices: [{ id: 'yes' }], text: '', reviewed_attachment_digests: [] };
    const entry = async (entry_id: string, revision: number, over: Record<string, unknown>) =>
      futureEntry({
        entry_id,
        revision,
        sealed: await sealAnswerContent(env, env.questionId, entry_id, revision, content),
        delivered: true,
        ...over,
      });
    const proxy = await entry('act-proxy', 1, {
      kind: 'answer',
      action: 'proxy-answer',
      source: 'proxy',
    });
    for (const [source, provenance] of [
      ['human', 'human'],
      ['proxy', 'proxy'],
      ['gate', 'proxy'],
    ] as const) {
      const confirm = await entry('act-confirm', 2, {
        kind: 'answer',
        action: 'confirm-proxy',
        source,
      });
      await setEntries(env, [proxy, confirm]);
      await env.store.updateQuestion(env.questionId, {
        local_status: 'human-answered',
        question_revision: 2,
      });
      expect([source, (await env.bridge.getDecision(env.questionId)).provenance]).toEqual([
        source,
        provenance,
      ]);
    }
    for (const [source, closedReason] of [
      ['human', 'declined'],
      ['proxy', 'withdrawn'],
    ] as const) {
      await setEntries(env, [
        futureEntry({ kind: 'declined', action: 'cancel', source, revision: 3, delivered: true }),
      ]);
      await env.store.updateQuestion(env.questionId, {
        local_status: 'cancelled',
        question_revision: 3,
      });
      expect([source, (await env.bridge.getDecision(env.questionId)).closedReason]).toEqual([
        source,
        closedReason,
      ]);
    }
  });

  it('is refused by the formatter rather than typed as an answer', () => {
    const base: AnswerNoticeInput = {
      kind: 'answer',
      questionId: 'q1',
      revision: 1,
      source: 'human',
    };
    expect(formatAnswerNotice(base)).toContain('source: human');
    expect(formatAnswerNotice({ ...base, source: 'proxy' })).toContain('source: proxy');
    expect(() =>
      formatAnswerNotice({ ...base, kind: 'superseded' as unknown as AnswerNoticeInput['kind'] }),
    ).toThrow(/answer_unknown_kind/);
    const system = 'system' as unknown as AnswerNoticeInput['source'];
    expect(() => formatAnswerNotice({ ...base, source: system })).toThrow(/answer_unknown_source/);
    expect(() => formatAnswerNotice({ ...base, kind: 'declined', source: 'proxy' })).toThrow(
      /answer_unknown_source/,
    );
    // An expiry prints its own source, whatever it is given.
    expect(formatAnswerNotice({ ...base, kind: 'expired', source: system })).toContain(
      'status: expired',
    );
  });

  it('every kind and source this client writes is one it types', () => {
    for (const [kind, source] of [
      ['answer', 'human'],
      ['answer', 'proxy'],
      ['expired', 'system'],
      ['declined', 'human'],
      ['unpublished', 'system'],
    ] as const)
      expect(unsupportedEntry({ kind, source })).toBeNull();
  });
});

describe('a store a newer client wrote', () => {
  it('is refused by start, which starts nothing', async () => {
    const store = new MemoryLocalStore();
    await store.setMeta(STORE_FORMAT_KEY, String(STORE_FORMAT + 1));
    const env = await setupBridge({ store });
    // Sealing and recovery list the store's rows and intents first: neither may run.
    const listQuestions = vi.spyOn(store, 'listQuestions');
    const openIntents = vi.spyOn(store, 'openIntents');
    const states: string[] = [];
    env.bridge.on('state', (s) => void states.push(s));
    const calls = env.relay.calls.length;
    const err = await env.bridge.start({ socket: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreFormatError);
    expect(err).toMatchObject({
      marker: 'format',
      found: String(STORE_FORMAT + 1),
      supported: STORE_FORMAT,
    });
    expect((err as Error).message).toMatch(/newer Decisions client.*Upgrade this client/);
    expect(env.bridge.state).toBe('created');
    expect(states).toEqual([]);
    expect(env.relay.calls.length).toBe(calls);
    expect(listQuestions).not.toHaveBeenCalled();
    expect(openIntents).not.toHaveBeenCalled();
    expect(await store.getMeta(STORE_FORMAT_KEY)).toBe(String(STORE_FORMAT + 1));
  });

  it('refuses a marker that is not a format', async () => {
    for (const raw of ['', 'two', '1.5', '-1', '01']) {
      const store = new MemoryLocalStore();
      await store.setMeta(STORE_FORMAT_KEY, raw);
      const { bridge } = await setupBridge({ store });
      await expect(bridge.start({ socket: false })).rejects.toBeInstanceOf(StoreFormatError);
    }
  });

  it("an older or unmarked store is stamped with this client's format when the bridge starts", async () => {
    for (const before of [null, '0', String(STORE_FORMAT)]) {
      const store = new MemoryLocalStore();
      if (before !== null) await store.setMeta(STORE_FORMAT_KEY, before);
      const { bridge } = await setupBridge({ store });
      const setMeta = vi.spyOn(store, 'setMeta');
      await bridge.start({ socket: false });
      expect(bridge.state).toBe('running');
      expect(await store.getMeta(STORE_FORMAT_KEY)).toBe(String(STORE_FORMAT));
      // A store already at this format is only read.
      expect(setMeta.mock.calls.some(([k]) => k === STORE_FORMAT_KEY)).toBe(
        before !== String(STORE_FORMAT),
      );
      await bridge.stop();
    }
  });

  /** A store whose format read waits until released, and says when it was reached. */
  function slowStore() {
    const store = new MemoryLocalStore();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = new Promise<void>((r) => (reached = r));
    const getMeta = store.getMeta.bind(store);
    store.getMeta = async (key) => {
      if (key === STORE_FORMAT_KEY) {
        reached();
        await gate;
      }
      return getMeta(key);
    };
    return { store, release, read };
  }

  it('a stop while the store is being admitted keeps the bridge from starting', async () => {
    const { store, release, read } = slowStore();
    const { bridge } = await setupBridge({ store });
    const states: string[] = [];
    bridge.on('state', (s) => void states.push(s));
    const started = bridge.start({ socket: false });
    await read;
    expect(bridge.state).toBe('created');
    await bridge.stop();
    release();
    await started;
    expect(bridge.state).toBe('stopped');
    expect(states).toEqual(['stopped']);
  });

  it('idle waits for the admission still reading the store', async () => {
    const { store, release, read } = slowStore();
    const { bridge } = await setupBridge({ store });
    const started = bridge.start({ socket: false }).catch(() => undefined);
    await read;
    await bridge.stop();
    let idle = false;
    const settled = bridge.idle().then(() => void (idle = true));
    await tick(5);
    expect(idle).toBe(false);
    release();
    await settled;
    await started;
    expect(idle).toBe(true);
  });

  it('idle waits for every start still admitting the store', async () => {
    const store = new MemoryLocalStore();
    const releases: (() => void)[] = [];
    const getMeta = store.getMeta.bind(store);
    store.getMeta = async (key) => {
      if (key === STORE_FORMAT_KEY) await new Promise<void>((r) => releases.push(r));
      return getMeta(key);
    };
    const { bridge } = await setupBridge({ store });
    const a = bridge.start({ socket: false });
    const b = bridge.start({ socket: false });
    await tick(5);
    expect(releases).toHaveLength(2);
    await bridge.stop();
    let idle = false;
    const settled = bridge.idle().then(() => void (idle = true));
    releases[1]!();
    await b;
    await tick(5);
    expect(idle).toBe(false);
    releases[0]!();
    await Promise.all([a, settled]);
    expect([idle, bridge.state]).toEqual([true, 'stopped']);
  });
});
