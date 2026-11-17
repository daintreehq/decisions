import { describe, expect, it } from 'vitest';
import {
  CREATOR_MISSING_FEATURE,
  EventData,
  MessageReceipt,
  PROTOCOL_VERSION,
} from '@daintreehq/decisions-protocol';
import { newId } from '@daintreehq/decisions-crypto';
import {
  act,
  ask,
  claimRelay,
  declare,
  enrollHost,
  inRoom,
  pairDevice,
  say,
  thread,
  type Actor,
} from './helpers.js';

/*
 * The owner desktop may sign the person's thread message (docs/protocol.md sections 2 and 16), as a phone does,
 * once the question's publishing desktop declares `owner-desktop-messages-v1`. A Host never may.
 */

const THREADS = 'thread-messages-v1';
const ACCEPTS = 'owner-desktop-messages-v1';

/** The question as stored, and the thread's messages and deliveries: what a refused message must leave alone. */
async function state(questionId: string) {
  return inRoom((room) => ({
    question: room.q1<{ status: string; revision: number }>(
      `SELECT status, revision FROM questions WHERE question_id = ?`,
      questionId,
    ),
    messages: room.q<{ side: string; signer_device_id: string }>(
      `SELECT side, signer_device_id FROM messages WHERE question_id = ? ORDER BY message_seq`,
      questionId,
    ),
    deliveries: room.q<{ status: string; target_host_id: string }>(
      `SELECT status, target_host_id FROM message_deliveries WHERE question_id = ? ORDER BY rowid`,
      questionId,
    ),
    postedEvents: room.q1<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE question_id = ? AND event_type = 'decision.message.posted'`,
      questionId,
    )!.n,
  }));
}

async function expectNoMessages(questionId: string) {
  const s = await state(questionId);
  expect(s.messages).toEqual([]);
  expect(s.deliveries).toEqual([]);
  expect(s.postedEvents).toBe(0);
}

function expectCreatorRefusal(res: { status: number; json: any }) {
  expect(res.status).toBe(409);
  expect(res.json.code).toBe('invalid_state');
  expect(res.json.details).toEqual({
    reason: CREATOR_MISSING_FEATURE,
    required_feature: ACCEPTS,
  });
}

/** Posts an already-signed message body again, as a client's outbox retry does. */
const repost = (actor: Actor, questionId: string, body: unknown) =>
  actor.call('POST', `/api/v1/questions/${questionId}/messages`, body);

const postedEvents = (a: Actor) =>
  a
    .call('GET', '/api/v1/events', undefined, `after=0&features=${THREADS}&limit=100`)
    .then((r) =>
      (r.json.events as any[]).filter((e) => e.event_type === 'decision.message.posted'),
    );

describe("the owner desktop sends the person's messages", () => {
  it('commits one before and after an answer, delivered to the pane like a phone message', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    await declare(w.owner, [THREADS, ACCEPTS, 'owner-desktop-answers-v1']);
    const { questionId } = await ask(w, { requirement: 'human-required' });

    // Before the answer: a clarification. It leaves the question open and needing the person.
    const before = await say(w, w.owner, questionId, { side: 'human', text: 'Which branch?' });
    expect(before.res.status).toBe(201);
    expect(MessageReceipt.parse(before.res.json)).toMatchObject({
      question_id: questionId,
      message_id: before.messageId,
      message_seq: 1,
    });
    expect((await state(questionId)).question).toEqual({ status: 'open', revision: 0 });

    // The person answers on the computer, then adds a note: the answer in force does not move.
    expect((await act(w, w.owner, 'answer', questionId, 0)).res.status).toBe(201);
    const after = await say(w, w.owner, questionId, { side: 'human', text: 'And tag it.' });
    expect(after.res.status).toBe(201);
    expect(after.res.json.message_seq).toBe(2);
    // A phone message after it, in the same order.
    expect((await say(w, phone, questionId)).res.json.message_seq).toBe(3);

    const s = await state(questionId);
    expect(s.question).toEqual({ status: 'human-answered', revision: 1 });
    // Attributed to its signer: the owner desktop, on the human side, apart from the phone's.
    expect(s.messages).toEqual([
      { side: 'human', signer_device_id: w.owner.id },
      { side: 'human', signer_device_id: w.owner.id },
      { side: 'human', signer_device_id: phone.id },
    ]);
    // Each one is typed into the asking pane, as a phone's message is.
    expect(s.deliveries).toEqual([
      { status: 'relay-queued', target_host_id: 'host_aaaaaaaa' },
      { status: 'relay-queued', target_host_id: 'host_aaaaaaaa' },
      { status: 'relay-queued', target_host_id: 'host_aaaaaaaa' },
    ]);

    // Every device that reads threads sees each one with its signed record, untouched.
    const posted = await postedEvents(phone);
    expect(posted.map((e) => e.origin_device_id)).toEqual([w.owner.id, w.owner.id, phone.id]);
    expect(EventData.messagePosted.parse(posted[0].data)).toMatchObject({
      message_seq: 1,
      record: before.record,
      envelope: before.envelope,
    });
    // The sending desktop reads its own messages back like any other, with nothing held back as an echo.
    const ownSeen = await postedEvents(w.owner);
    expect(ownSeen.map((e) => [e.seq, e.data.record.message_id])).toEqual(
      posted.map((e) => [e.seq, e.data.record.message_id]),
    );
    const listed = await thread(phone, questionId);
    expect(listed.map((m) => [m.record.side, m.record.signer_device_id])).toEqual([
      ['human', w.owner.id],
      ['human', w.owner.id],
      ['human', phone.id],
    ]);
    expect(listed.map((m) => m.delivery?.status)).toEqual([
      'relay-queued',
      'relay-queued',
      'relay-queued',
    ]);
  });

  it("replies to the agent's request like a phone, and never expects a reply itself", async () => {
    const w = await claimRelay();
    await pairDevice(w);
    await declare(w.owner, [THREADS, ACCEPTS]);
    const { questionId } = await ask(w);
    expect((await say(w, w.owner, questionId, { expectsReply: true })).res.status).toBe(201);
    // Only an agent message expects a reply: the person's side never does, whoever signs it.
    const asking = await say(w, w.owner, questionId, { side: 'human', expectsReply: true });
    expect(asking.res.status).toBe(400);
    expect(asking.res.json.code).toBe('validation_error');
    const reply = await say(w, w.owner, questionId, { side: 'human' });
    expect(reply.res.status).toBe(201);
    expect(reply.record.expects_reply).toBe(false);
  });

  it('refuses until the asking desktop declares support, with a refusal a client can tell apart', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    const later = await ask(w);

    // No declaration at all, then every other feature but this one.
    const first = await say(w, w.owner, questionId, { side: 'human' });
    expectCreatorRefusal(first.res);
    await declare(w.owner, [THREADS, 'owner-desktop-answers-v1', 'phone-images-v1']);
    expectCreatorRefusal(await repost(w.owner, questionId, first.body));
    // A `GET /events` declaration is per request and never recorded for the device.
    await w.owner.call('GET', '/api/v1/events', undefined, `after=0&limit=1&features=${ACCEPTS}`);
    expectCreatorRefusal(await repost(w.owner, questionId, first.body));
    await expectNoMessages(questionId);
    // A phone needs no such declaration.
    expect((await say(w, phone, later.questionId)).res.status).toBe(201);

    // A refusal stores no receipt, so the very same signed message commits once support is declared.
    await declare(w.owner, [THREADS, ACCEPTS]);
    const ok = await repost(w.owner, questionId, first.body);
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ message_id: first.messageId, message_seq: 1 });

    // Retries stay idempotent after the declaration is withdrawn: the receipt, then the same message id.
    await declare(w.owner, [THREADS]);
    const replay = await repost(w.owner, questionId, first.body);
    expect(replay.status).toBe(201);
    expect(replay.json).toEqual(ok.json);
    const sameMessage = await repost(w.owner, questionId, {
      ...first.body,
      idempotency_key: newId(),
    });
    expect(sameMessage.status).toBe(200);
    expect(sameMessage.json).toEqual(ok.json);
    expect((await state(questionId)).postedEvents).toBe(1);
    // A new message reads the latest declaration, never one the desktop has withdrawn.
    expectCreatorRefusal((await say(w, w.owner, later.questionId, { side: 'human' })).res);
    expect((await state(later.questionId)).messages).toEqual([
      { side: 'human', signer_device_id: phone.id },
    ]);
  });

  it("writes on a Host's question once the Host declares support; the owner's own declaration never counts", async () => {
    const w = await claimRelay();
    await pairDevice(w);
    const { host, world: hostWorld } = await enrollHost(w);
    const { questionId } = await ask(hostWorld, { host: 'host_bbbbbbbb' });
    await declare(w.owner, [THREADS, ACCEPTS]);
    await declare(host, [THREADS]);

    expectCreatorRefusal((await say(w, w.owner, questionId, { side: 'human' })).res);
    await expectNoMessages(questionId);

    // Only the asking desktop's declaration counts: the writing owner needs none.
    await declare(w.owner, []);
    await declare(host, [THREADS, ACCEPTS]);
    const sent = await say(w, w.owner, questionId, { side: 'human' });
    expect(sent.res.status).toBe(201);
    expect(await state(questionId)).toMatchObject({
      messages: [{ side: 'human', signer_device_id: w.owner.id }],
      deliveries: [{ status: 'relay-queued', target_host_id: 'host_bbbbbbbb' }],
    });
    // The Host reads it and reports typing it into its pane, as it does for a phone's message; the owner cannot.
    expect((await postedEvents(host)).map((e) => e.data.record.message_id)).toEqual([
      sent.messageId,
    ]);
    const report = (a: Actor, status: string, extra: Record<string, unknown> = {}) =>
      a.call('POST', '/api/v1/deliveries/messages', {
        protocol_version: PROTOCOL_VERSION,
        idempotency_key: newId(),
        question_id: questionId,
        message_id: sent.messageId,
        host_id: 'host_bbbbbbbb',
        status,
        ...extra,
      });
    expect((await report(w.owner, 'received')).status).toBe(403);
    expect((await report(host, 'received')).status).toBe(200);
    expect((await report(host, 'terminal-delivered', { injection_id: newId() })).status).toBe(200);
    const [listed] = await thread(host, questionId);
    expect(listed.delivery).toMatchObject({ status: 'terminal-delivered' });
    expect(listed.delivery.received_at).not.toBeNull();
    // Still never the agent's side of another desktop's question.
    const agent = await say(w, w.owner, questionId, { side: 'agent' });
    expect(agent.res.status).toBe(403);
  });

  it("writes on a model-answered question without confirming or changing the model's answer", async () => {
    const w = await claimRelay();
    await pairDevice(w);
    await declare(w.owner, [THREADS, ACCEPTS]);
    const { questionId } = await ask(w, { requirement: 'proxy-ok' });
    const proxy = await act(w, w.owner, 'proxy-answer', questionId, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.9,
      },
    });
    expect(proxy.res.status).toBe(201);
    const note = await say(w, w.owner, questionId, { side: 'human', text: 'approved' });
    expect(note.res.status).toBe(201);
    const s = await state(questionId);
    expect(s.question).toEqual({ status: 'proxy-answered', revision: 1 });
    expect(s.deliveries).toEqual([{ status: 'relay-queued', target_host_id: 'host_aaaaaaaa' }]);
    // "approved" in a message is text: the model's answer stays the one in force, and still the model's.
    const actions = await inRoom((room) =>
      room.q<{ action: string; provenance: string | null }>(
        `SELECT action, provenance FROM actions WHERE question_id = ? ORDER BY event_seq`,
        questionId,
      ),
    );
    expect(actions).toEqual([{ action: 'proxy-answer', provenance: 'proxy' }]);
  });

  it('keeps the usual checks ahead of the support check', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    // The asking desktop declares support but not threads: the thread refusal comes first, without the reason.
    await declare(w.owner, [ACCEPTS]);
    const open = await ask(w);
    const noThreads = await say(w, w.owner, open.questionId, { side: 'human' });
    expect(noThreads.res.status).toBe(409);
    expect(noThreads.res.json.code).toBe('invalid_state');
    expect(noThreads.res.json.details).toBeUndefined();

    // Declares threads only from here on, so only an earlier check can produce anything but the refusal.
    await declare(w.owner, [THREADS]);
    const cancelled = await ask(w);
    expect((await act(w, w.owner, 'cancel', cancelled.questionId, 0)).res.status).toBe(201);
    const closed = await say(w, w.owner, cancelled.questionId, { side: 'human' });
    expect(closed.res.status).toBe(409);
    expect(closed.res.json.code).toBe('invalid_state');
    expect(closed.res.json.details).toBeUndefined();

    const due = await ask(w);
    await inRoom((room) =>
      room.run(
        `UPDATE questions SET expires_at = ? WHERE question_id = ?`,
        Date.now() - 1,
        due.questionId,
      ),
    );
    const expired = await say(w, w.owner, due.questionId, { side: 'human' });
    expect(expired.res.status).toBe(410);
    expect(expired.res.json.code).toBe('expired');

    // The record must still be the signer's own and well signed.
    const forged = await say(w, w.owner, open.questionId, {
      side: 'human',
      signingKey: phone.keys.signing.privateKey,
    });
    expect(forged.res.status).toBe(400);
  });

  it('refuses once the asking desktop is revoked, whatever it declared', async () => {
    const w = await claimRelay();
    await pairDevice(w);
    const { host, world: hostWorld } = await enrollHost(w);
    await declare(host, [THREADS, ACCEPTS]);
    const { questionId } = await ask(hostWorld);
    await inRoom((room) =>
      room.run(`UPDATE devices SET revoked_at = ? WHERE device_id = ?`, Date.now(), host.id),
    );
    expectCreatorRefusal((await say(w, w.owner, questionId, { side: 'human' })).res);
    await expectNoMessages(questionId);
  });

  it("never lets a Host write as the person, on its own question or the owner's", async () => {
    const w = await claimRelay();
    await pairDevice(w);
    const { host, world: hostWorld } = await enrollHost(w);
    await declare(w.owner, [THREADS, ACCEPTS]);
    await declare(host, [THREADS, ACCEPTS]);
    const own = await ask(hostWorld, { host: 'host_bbbbbbbb' });
    const owners = await ask(w);
    for (const questionId of [own.questionId, owners.questionId]) {
      const { res } = await say(hostWorld, host, questionId, { side: 'human' });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('forbidden');
      await expectNoMessages(questionId);
    }
  });

  it('refuses phone images on a message the owner desktop signs', async () => {
    const w = await claimRelay();
    await pairDevice(w);
    await declare(w.owner, [THREADS, ACCEPTS, 'phone-images-v1']);
    const { questionId } = await ask(w);
    const withImages = await say(w, w.owner, questionId, {
      side: 'human',
      attachmentIds: [newId()],
    });
    expect(withImages.res.status).toBe(403);
    expect(withImages.res.json.code).toBe('forbidden');
    await expectNoMessages(questionId);
    // An empty list is no image at all.
    expect(
      (await say(w, w.owner, questionId, { side: 'human', attachmentIds: [] })).res.status,
    ).toBe(201);
  });
});
