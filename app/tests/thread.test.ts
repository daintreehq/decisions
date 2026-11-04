import { describe, expect, it } from 'vitest';
import { Db } from '../src/data/db.js';
import { Outbox, type Poster } from '../src/data/outbox.js';
import { RelayError } from '../src/data/relay.js';
import { generateCacheKey } from '../src/data/seal.js';
import { QuestionStore } from '../src/domain/model.js';
import {
  awaitingReply,
  canOverrule,
  currentAnswer,
  messageProgress,
  needsYou,
  pendingAsk,
} from '../src/domain/selectors.js';
import { verifyMessageEvent } from '../src/domain/verify.js';
import {
  actionEvent,
  makeWorld,
  messageEvent,
  otherDesktop,
  plainEvent,
  questionEvent,
  type World,
} from './helpers.js';

const ctx = (w: World) => ({
  installationId: w.installationId,
  trust: w.trust,
  epochKeys: w.epochs,
});
const NOW = new Date().toISOString();
const store = (w: World) =>
  new QuestionStore({
    installationId: w.installationId,
    trust: w.trust,
    epochKeys: () => w.epochs,
  });

async function answered(w: World) {
  const s = store(w);
  const q = await questionEvent(w);
  const id = q.question_id!;
  await s.ingest(q);
  await s.ingest(await actionEvent(w, { questionId: id, action: 'answer' }));
  return { s, id };
}

describe('thread message verification', () => {
  it('opens a follow-up the phone signed and a message the publishing desktop signed', async () => {
    const w = await makeWorld();
    const q = await questionEvent(w);
    const id = q.question_id!;
    const human = await messageEvent(w, { questionId: id, side: 'human', text: 'Bump it too.' });
    const agent = await messageEvent(w, { questionId: id, side: 'agent', expectsReply: true });
    const h = await verifyMessageEvent(human.data, NOW, ctx(w), id, w.desktop.id);
    const a = await verifyMessageEvent(agent.data, NOW, ctx(w), id, w.desktop.id);
    expect(h).toMatchObject({
      ok: true,
      value: { content: { side: 'human', text: 'Bump it too.' } },
    });
    expect(a).toMatchObject({ ok: true, value: { record: { expects_reply: true } } });
  });

  it('refuses a human message signed by a desktop, and an agent message signed by a phone', async () => {
    const w = await makeWorld();
    const id = (await questionEvent(w)).question_id!;
    const fromDesktop = await messageEvent(w, { questionId: id, side: 'human', signer: w.desktop });
    const fromPhone = await messageEvent(w, { questionId: id, side: 'agent', signer: w.phone });
    expect(await verifyMessageEvent(fromDesktop.data, NOW, ctx(w), id, w.desktop.id)).toMatchObject(
      {
        ok: false,
      },
    );
    expect(await verifyMessageEvent(fromPhone.data, NOW, ctx(w), id, w.desktop.id)).toMatchObject({
      ok: false,
    });
  });

  it('refuses an agent message from a desktop that did not publish the question', async () => {
    const w = await makeWorld();
    const id = (await questionEvent(w)).question_id!;
    const other = await otherDesktop(w);
    const e = await messageEvent(w, { questionId: id, side: 'agent', signer: other });
    expect(await verifyMessageEvent(e.data, NOW, ctx(w), id, w.desktop.id)).toEqual({
      ok: false,
      reason: 'only the desktop that asked the question speaks for its agent',
    });
  });

  it('refuses content that claims the other side, and a message filed under another question', async () => {
    const w = await makeWorld();
    const id = (await questionEvent(w)).question_id!;
    const lying = await messageEvent(w, {
      questionId: id,
      side: 'human',
      plaintext: { content_version: 1, side: 'agent', text: 'I am the agent' },
    });
    expect(await verifyMessageEvent(lying.data, NOW, ctx(w), id, w.desktop.id)).toMatchObject({
      ok: false,
    });
    const elsewhere = await messageEvent(w, { questionId: id, side: 'human' });
    expect(
      await verifyMessageEvent(elsewhere.data, NOW, ctx(w), 'question_other_1', w.desktop.id),
    ).toEqual({ ok: false, reason: 'question id does not match the signed record' });
  });
});

describe('a thread in the question store', () => {
  it('never moves the answer in force, the revision or the status', async () => {
    const w = await makeWorld();
    const { s, id } = await answered(w);
    const before = { ...s.get(id)! };
    await s.ingest(
      await messageEvent(w, { questionId: id, side: 'human', text: 'Approved, really.' }),
    );
    await s.ingest(await messageEvent(w, { questionId: id, side: 'agent', text: 'Noted.' }));
    const v = s.get(id)!;
    expect(v).toMatchObject({ status: before.status, revision: before.revision });
    expect(currentAnswer(v)?.content).toMatchObject({ text: 'go ahead' });
    expect(v.messages.map((m) => [m.side, m.text, m.verified])).toEqual([
      ['human', 'Approved, really.', true],
      ['agent', 'Noted.', true],
    ]);
    // The person's answer stays final: nothing offers to replace it.
    expect(canOverrule(v)).toBe(false);
  });

  it('keeps an unverifiable message in place, unread, and says so', async () => {
    const w = await makeWorld();
    const { s, id } = await answered(w);
    const other = await otherDesktop(w);
    await s.ingest(await messageEvent(w, { questionId: id, side: 'agent', signer: other }));
    const v = s.get(id)!;
    expect(v.messages).toHaveLength(1);
    expect(v.messages[0]).toMatchObject({ verified: false, text: '' });
    expect(v.integrityIssues.some((i) => i.startsWith('message:'))).toBe(true);
    expect(awaitingReply(v)).toBe(false);
  });

  it('needs the person again while the agent waits on a reply, until something human comes after', async () => {
    const w = await makeWorld();
    const { s, id } = await answered(w);
    expect(needsYou(s.get(id)!)).toBe(false);
    const ask = await messageEvent(w, { questionId: id, side: 'agent', expectsReply: true });
    await s.ingest(ask);
    expect(awaitingReply(s.get(id)!)).toBe(true);
    expect(needsYou(s.get(id)!)).toBe(true);
    expect(pendingAsk(s.get(id)!)?.text).toBe('Which version?');
    await s.ingest(await messageEvent(w, { questionId: id, side: 'human', text: 'v3.' }));
    expect(awaitingReply(s.get(id)!)).toBe(false);
    expect(needsYou(s.get(id)!)).toBe(false);
  });

  it('stops waiting when the agent says something that asks nothing, or the question is withdrawn', async () => {
    const w = await makeWorld();
    const { s, id } = await answered(w);
    await s.ingest(await messageEvent(w, { questionId: id, side: 'agent', expectsReply: true }));
    await s.ingest(await messageEvent(w, { questionId: id, side: 'agent', expectsReply: false }));
    expect(awaitingReply(s.get(id)!)).toBe(false);

    // Withdrawn (only an open or model-answered question can be): a closed thread waits on nobody.
    const w2 = await makeWorld();
    const s2 = store(w2);
    const q2 = await questionEvent(w2);
    const id2 = q2.question_id!;
    await s2.ingest(q2);
    await s2.ingest(await messageEvent(w2, { questionId: id2, side: 'agent', expectsReply: true }));
    expect(awaitingReply(s2.get(id2)!)).toBe(true);
    await s2.ingest(await actionEvent(w2, { questionId: id2, action: 'cancel' }));
    expect(awaitingReply(s2.get(id2)!)).toBe(false);
  });

  it('moves a follow-up through its own receipts, never from a ledger acknowledgement', async () => {
    const w = await makeWorld();
    const { s, id } = await answered(w);
    await s.ingest(await messageEvent(w, { questionId: id, side: 'human' }));
    const m = () => s.get(id)!.messages[0]!;
    await s.ingest(plainEvent('delivery.received', null, { up_to_seq: 10_000 }));
    expect(messageProgress(m()).step).toBe('confirmed');
    const receipt = (status: string, extra: Record<string, unknown> = {}) =>
      plainEvent('delivery.message', id, {
        message_id: m().messageId,
        target_host_id: 'host_aaaaaaaa',
        status,
        received_at: NOW,
        terminal_delivered_at: null,
        injection_id: null,
        error_code: null,
        ...extra,
      });
    await s.ingest(receipt('received'));
    expect(messageProgress(m()).step).toBe('desktop');
    await s.ingest(receipt('needs-attention', { error_code: 'pane_gone' }));
    expect(messageProgress(m())).toMatchObject({ step: 'attention', detail: 'pane_gone' });
    await s.ingest(
      receipt('terminal-delivered', { terminal_delivered_at: NOW, injection_id: 'inj_00000001' }),
    );
    expect(messageProgress(m()).step).toBe('terminal');
    expect(messageProgress(m(), 'queued').step).toBe('queued');
  });

  it('ignores a receipt for another host', async () => {
    const w = await makeWorld();
    const { s, id } = await answered(w);
    await s.ingest(await messageEvent(w, { questionId: id, side: 'human' }));
    await s.ingest(
      plainEvent('delivery.message', id, {
        message_id: s.get(id)!.messages[0]!.messageId,
        target_host_id: 'host_bbbbbbbb',
        status: 'terminal-delivered',
        received_at: NOW,
        terminal_delivered_at: NOW,
        injection_id: 'inj_00000001',
        error_code: null,
      }),
    );
    expect(messageProgress(s.get(id)!.messages[0]!).step).toBe('confirmed');
  });

  it('a model answer awaiting review can still be overruled', async () => {
    const w = await makeWorld();
    const s = store(w);
    const q = await questionEvent(w, { requirement: 'proxy-ok' });
    await s.ingest(q);
    await s.ingest(await actionEvent(w, { questionId: q.question_id!, action: 'proxy-answer' }));
    expect(canOverrule(s.get(q.question_id!)!)).toBe(true);
  });
});

describe('follow-ups in the outbox', () => {
  const poster = (impl: () => Promise<unknown>): Poster => ({
    jsonRaw: (() => impl()) as Poster['jsonRaw'],
  });
  const message = (id: string) => ({
    id,
    questionId: 'question_aaaa',
    kind: 'message' as const,
    messageId: `msg_${id}`,
    path: '/questions/question_aaaa/messages',
    bodyText: JSON.stringify({ body: id }),
    idempotencyKey: `idem_${id}`,
    expectedRevision: 1,
    selected: [],
    text: 'SECRET-FOLLOW-UP',
    reason: '',
  });

  it('is sealed at rest, and a closed thread refuses it without calling it a conflict', async () => {
    const db = await Db.open(`thread-db-${Math.random().toString(36).slice(2)}`);
    const key = await generateCacheKey();
    const ob = new Outbox(db, key, () =>
      poster(async () => {
        throw new RelayError('invalid_state', 409, 'a cancelled question takes no messages');
      }),
    );
    await ob.enqueue(message('closed_1'));
    const row = (await db.outbox())[0]!;
    expect(JSON.stringify(row) + JSON.stringify([...row.sealed.ct])).not.toContain(
      'SECRET-FOLLOW-UP',
    );
    await ob.flush();
    expect(ob.list()[0]).toMatchObject({ state: 'rejected', errorCode: 'invalid_state' });
    db.close();
  });

  it('waits offline, keeps its order, and is sent again with the same request once back', async () => {
    const db = await Db.open(`thread-db-${Math.random().toString(36).slice(2)}`);
    const key = await generateCacheKey();
    let online = false;
    const sent: string[] = [];
    const ob = new Outbox(db, key, () => ({
      jsonRaw: (async (_m: string, _p: string, body: string) => {
        if (!online) throw new RelayError('network', 0, 'offline');
        sent.push(body);
        return {};
      }) as Poster['jsonRaw'],
    }));
    await ob.enqueue(message('first'));
    await ob.enqueue(message('second'));
    await ob.flush();
    expect(ob.list().map((e) => e.state)).toEqual(['queued', 'queued']);
    online = true;
    await ob.flush();
    expect(sent).toEqual([JSON.stringify({ body: 'first' }), JSON.stringify({ body: 'second' })]);
    expect(ob.list()).toEqual([]);
    db.close();
  });
});
