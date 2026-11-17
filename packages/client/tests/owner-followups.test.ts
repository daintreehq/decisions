import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from '@daintreehq/decisions-protocol';
import {
  BRIDGE_FEATURES,
  DecisionsBridge,
  EventVerifier,
  FOLLOWUP_BLOCK_END,
  FOLLOWUP_BLOCK_START,
  FOLLOWUP_NOTE_UNANSWERED,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  THREAD_PREFACE,
  bridgeFeatures,
  parseMessages,
  serializeMessages,
  type Identity,
} from '../src/index.js';
import {
  FakeRelay,
  FakeSink,
  makeHost,
  makeIdentity,
  makePhone,
  origin,
  setupBridge,
} from './helpers.js';

/*
 * Issue #119: desktops that declare `owner-desktop-messages-v1` take the person's follow-up signed by the owner
 * desktop and deliver it like a phone's, attributed as sent from the computer.
 */

const asOwner = (identity: Identity) => ({
  deviceId: identity.config.deviceId,
  keys: identity.keys,
});

const idOf = (ev: { data: unknown }) =>
  (ev.data as { record: { message_id: string } }).record.message_id;

async function asked(extra: Parameters<typeof setupBridge>[0] = {}) {
  const env = await setupBridge({ followUps: true, ...extra });
  const r = await env.bridge.registerQuestion({
    origin: origin(),
    input: { question: 'Keep the old column?' },
  });
  await env.bridge.pump();
  return { ...env, qid: r.questionId, alias: r.alias };
}

const rejections = async (store: MemoryLocalStore) =>
  (await store.listAudit(50)).filter((a) => a.event === 'event.rejected').map((a) => a.result);

describe('a desktop with follow-ups on takes the person’s follow-up sent from the computer', () => {
  it('declares owner-desktop-messages-v1 only with follow-ups', () => {
    expect(BRIDGE_FEATURES).not.toContain('owner-desktop-messages-v1');
    expect(bridgeFeatures()).not.toContain('owner-desktop-messages-v1');
    expect(bridgeFeatures({ followUps: true })).toEqual([
      ...BRIDGE_FEATURES,
      'thread-messages-v1',
      'owner-desktop-messages-v1',
    ]);
  });

  it('types it with sent_from: computer and reports it as the person’s, sent from the computer', async () => {
    const env = await asked();
    const ev = await env.relay.messageEvent({
      questionId: env.qid,
      signer: asOwner(env.identity),
      text: 'Wait, check the migration first.',
    });
    await env.bridge.catchUp();

    expect(env.sink.typed).toHaveLength(1);
    const typed = env.sink.typed[0]!;
    expect(typed.text.split('\n')).toEqual([
      THREAD_PREFACE,
      FOLLOWUP_BLOCK_START,
      `question_id: ${env.qid} (q-${env.alias})`,
      `message_id: ${idOf(ev)}`,
      `injection_id: ${typed.id}`,
      'question: Keep the old column?',
      'source: human',
      'sent_from: computer',
      FOLLOWUP_NOTE_UNANSWERED,
      'text: Wait, check the migration first.',
      FOLLOWUP_BLOCK_END,
    ]);

    const [stored] = parseMessages((await env.store.getQuestion(env.qid))!.messages_json);
    expect(stored).toMatchObject({ side: 'human', signer_role: 'owner-desktop' });
    const view = await env.bridge.getDecision(env.qid);
    expect(view.thread).toEqual([
      expect.objectContaining({
        kind: 'message',
        side: 'human',
        sentFrom: 'computer',
        expectsReply: false,
        text: 'Wait, check the migration first.',
        delivery: expect.objectContaining({ status: 'terminal-delivered' }),
      }),
    ]);
    // A message never answers.
    expect(view).toMatchObject({ status: 'open', provenance: null, answeredOn: null });
  });

  it('keeps a phone’s follow-up as it was, sent from the phone', async () => {
    const env = await asked();
    await env.relay.messageEvent({
      questionId: env.qid,
      signer: env.phone,
      text: 'From the phone',
    });
    await env.bridge.catchUp();
    expect(env.sink.typed[0]!.text).not.toContain('sent_from');
    const view = await env.bridge.getDecision(env.qid);
    expect(view.thread[0]).toMatchObject({ side: 'human', sentFrom: 'phone' });
  });

  it('reads a follow-up stored before signer roles were kept as a phone’s, and the agent’s own as neither', async () => {
    const env = await asked();
    await env.relay.messageEvent({ questionId: env.qid, signer: env.phone, text: 'Older' });
    await env.bridge.catchUp();
    const row = (await env.store.getQuestion(env.qid))!;
    const legacy = parseMessages(row.messages_json).map(({ signer_role: _drop, ...m }) => m);
    await env.store.updateQuestion(env.qid, { messages_json: serializeMessages(legacy) });
    await env.bridge.postMessage(
      { question_id: env.qid, text: 'Noted.', expects_reply: false },
      {
        host_id: 'host-local',
        pane_id: 'pane-1',
        terminal_generation: 1,
        ownership_principal: 'principal-1',
        agent_incarnation: 'inc-1',
        agent_session_id: 'sess-1',
        worktree_id: 'wt-1',
      },
    );
    env.relay.postMessageEvents = true;
    await env.bridge.pump();
    await env.bridge.catchUp();
    const thread = (await env.bridge.getDecision(env.qid)).thread;
    expect(thread.map((t) => (t.kind === 'message' ? [t.side, t.sentFrom] : null))).toEqual([
      ['human', 'phone'],
      ['agent', null],
    ]);
  });

  it('refuses one that lists phone images, and a Host still never speaks for the person', async () => {
    const env = await asked();
    await env.relay.messageEvent({
      questionId: env.qid,
      signer: asOwner(env.identity),
      text: 'with a picture',
      images: [{ attachment_id: 'img_00000001', sha256: 'a'.repeat(64), mime: 'image/png' }],
    });
    const host = await makeHost(env.identity, env.relay);
    await env.relay.messageEvent({
      questionId: env.qid,
      signer: { deviceId: host.identity.config.deviceId, keys: host.identity.keys },
      text: 'I am the person',
    });
    await env.bridge.catchUp();
    expect(await rejections(env.store)).toEqual([
      'images-on-desktop-message',
      'human-message-by-non-human-device',
    ]);
    expect(parseMessages((await env.store.getQuestion(env.qid))!.messages_json)).toEqual([]);
    expect(env.sink.typed).toHaveLength(0);
  });

  it('a verifier that has not been told to take them refuses the owner desktop’s message', async () => {
    const env = await asked();
    const ev = (await env.relay.messageEvent({
      questionId: env.qid,
      signer: asOwner(env.identity),
      text: 'From the computer',
    })) as LedgerEvent;
    expect(await new EventVerifier(env.bridge.ctx).verifyMessage(ev)).toEqual({
      ok: false,
      reason: 'human-message-by-non-human-device',
    });
    expect(
      await new EventVerifier(env.bridge.ctx, { ownerMessages: true }).verifyMessage(ev),
    ).toMatchObject({ ok: true, signerRole: 'owner-desktop' });
  });

  it('a Remote Host types the owner’s follow-up on its own question as sent from the computer', async () => {
    const owner = await makeIdentity();
    const relay = new FakeRelay(owner);
    await relay.initOwner();
    const phone = await makePhone(owner);
    relay.devices.push(phone.cert);
    const host = await makeHost(owner, relay);
    const sink = new FakeSink();
    sink.addPane('pane-1');
    const bridge = new DecisionsBridge({
      identity: host.identity,
      keyStore: host.keyStore,
      store: new MemoryLocalStore(),
      sink,
      client: new RelayClient({
        identity: host.identity,
        fetch: relay.fetch,
        sleep: async () => {},
        maxRetries: 0,
      }),
      policy: new PolicyRegistry(),
      pumpIntervalMs: 0,
      followUps: true,
    });
    expect(bridge.features).toContain('owner-desktop-messages-v1');
    const r = await bridge.registerQuestion({
      origin: origin({ host_id: 'host-remote' }),
      input: { question: 'Rebuild the cache?' },
    });
    await bridge.pump();
    await relay.messageEvent({
      questionId: r.questionId,
      signer: asOwner(owner),
      text: 'Only the dev cache.',
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.text).toContain('source: human\nsent_from: computer\n');
    expect((await bridge.getDecision(r.questionId)).thread[0]).toMatchObject({
      side: 'human',
      sentFrom: 'computer',
      text: 'Only the dev cache.',
    });
  });
});
