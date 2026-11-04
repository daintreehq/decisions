import { describe, expect, it } from 'vitest';
import {
  HumanMessageContentV1,
  MESSAGE_RECORD_TYPE,
  MessageContentV1,
  MessagesPage,
  PROTOCOL_VERSION,
  imagesMatchRecord,
} from '@daintreehq/decisions-protocol';
import {
  decryptEnvelope,
  envelopeDigest,
  importSigningPublicKey,
  newId,
  signObject,
  verifyObject,
} from '@daintreehq/decisions-crypto';
import { buildRotation } from './devices.helpers.js';
import {
  act,
  ask,
  claimRelay,
  declare,
  enrollHost,
  inRoom,
  pairDevice,
  raw,
  say,
  thread,
  type Actor,
  type World,
} from './helpers.js';

const THREADS = 'thread-messages-v1';

/** A relay whose owner desktop understands messages, with a paired phone and an open question. */
async function setup() {
  const w = await claimRelay();
  await declare(w.owner);
  const phone = await pairDevice(w);
  const { questionId } = await ask(w);
  return { w, phone, questionId };
}

const question = async (a: Actor, id: string) =>
  (await a.call('GET', `/api/v1/questions/${id}`)).json;

const modernEvents = (a: Actor, after = 0) =>
  a
    .call('GET', '/api/v1/events', undefined, `after=${after}&features=${THREADS}&limit=100`)
    .then((r) => r.json.events as any[]);

describe('posting thread messages (docs/protocol.md section 16)', () => {
  it('takes human messages from phones and tablets and agent messages from the publishing desktop', async () => {
    const { w, phone, questionId } = await setup();
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    const human = await say(w, phone, questionId);
    expect(human.res.status).toBe(201);
    expect(human.res.json).toMatchObject({
      question_id: questionId,
      message_id: human.messageId,
      message_seq: 1,
    });
    expect((await say(w, tablet, questionId)).res.json.message_seq).toBe(2);
    const agent = await say(w, w.owner, questionId, { expectsReply: true });
    expect(agent.res.status).toBe(201);
    expect(agent.res.json.message_seq).toBe(3);

    // A desktop host speaks for the agents of the questions it published.
    const { host, world } = await enrollHost(w);
    await declare(host);
    const hosted = (await ask(world, { host: 'host_remote001' })).questionId;
    expect((await say(world, host, hosted)).res.status).toBe(201);
    expect((await say(w, phone, hosted)).res.status).toBe(201);
  });

  it('refuses every other sender', async () => {
    const { w, phone, questionId } = await setup();
    const { host, world } = await enrollHost(w);
    const hosted = (await ask(world, { host: 'host_remote001' })).questionId;
    const refused = async (r: Promise<{ res: { status: number; json: any } }>, status = 403) => {
      const { res } = await r;
      expect(res.status).toBe(status);
      if (status === 403) expect(res.json.code).toBe('forbidden');
    };
    // No desktop speaks for another desktop's agent, not even the owner.
    await refused(say(w, host, questionId));
    await refused(say(world, w.owner, hosted));
    // Sides follow roles: a phone never speaks for the agent, a desktop never for the person.
    await refused(say(w, phone, questionId, { side: 'agent' }));
    await refused(say(w, w.owner, questionId, { side: 'human' }));
    await refused(say(world, host, hosted, { side: 'human' }));

    // Unsigned, and revoked.
    const unsigned = await raw('POST', `/api/v1/questions/${questionId}/messages`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.status).toBe(401);
    const lost = await pairDevice(w, 'phone', 'Lost phone');
    const rotation = await buildRotation(w, [phone, host]);
    expect((await w.owner.call('POST', `/api/v1/devices/${lost.id}/revoke`, rotation.body)).status).toBe(
      200,
    );
    await refused(say(w, lost, questionId), 401);

    expect(await thread(phone, questionId)).toEqual([]);
    expect(await thread(phone, hosted)).toEqual([]);
  });

  it('checks the signature, the envelope binding and the record before anything is stored', async () => {
    const { w, phone, questionId } = await setup();
    const other = await pairDevice(w, 'phone', 'Other phone');
    const status = async (p: Promise<{ res: { status: number } }>) => (await p).res.status;

    const base = await say(w, phone, questionId);
    expect(base.res.status).toBe(201);
    // A record signed by another device's key, claiming to be this phone's.
    const forged = await say(w, phone, questionId, { signingKey: other.keys.signing.privateKey });
    expect(forged.res.status).toBe(400);
    expect(forged.res.json.message).toMatch(/signature/);
    // Ciphertext swapped after signing: the record commits to the envelope's digest.
    const swapped = await say(w, phone, questionId, { post: false });
    const tampered = await phone.call('POST', `/api/v1/questions/${questionId}/messages`, {
      ...swapped.body,
      message: {
        record: swapped.record,
        envelope: { ...swapped.envelope, ciphertext: base.envelope.ciphertext },
      },
    });
    expect(tampered.status).toBe(400);
    expect(tampered.json.message).toMatch(/digest/);

    // The envelope must say it is this message's content, from this signer, for this question.
    expect(
      await status(
        say(w, phone, questionId, { edit: (r) => void (r.signer_device_id = other.id) }),
      ),
    ).toBe(400);
    expect(
      await status(say(w, phone, questionId, { edit: (r) => void (r.installation_id = newId()) })),
    ).toBe(400);
    // The path names the question.
    const elsewhere = await say(w, phone, questionId);
    const moved = await phone.call(
      'POST',
      `/api/v1/questions/${(await ask(w)).questionId}/messages`,
      { ...elsewhere.body, idempotency_key: newId() },
    );
    expect(moved.status).toBe(400);
    // A key epoch the relay has never had.
    const future = { ...w.epoch, epoch: 9 };
    expect(await status(say(w, phone, questionId, { epoch: future }))).toBe(400);
    // Phone images need the image extension, which this relay does not implement yet.
    expect(await status(say(w, phone, questionId, { attachmentIds: [newId()] }))).toBe(400);
    // A human message never expects a reply; an envelope over the limit never parses.
    expect(await status(say(w, phone, questionId, { expectsReply: true }))).toBe(400);
    const big = await say(w, phone, questionId);
    const oversize = await phone.call('POST', `/api/v1/questions/${questionId}/messages`, {
      ...big.body,
      idempotency_key: newId(),
      message: { ...big.body.message, envelope: { ...big.envelope, ciphertext: 'A'.repeat(184_321) } },
    });
    expect(oversize.status).toBe(400);
    // Unknown questions.
    const ghost = newId();
    expect((await say(w, phone, ghost)).res.status).toBe(404);

    const stored = await thread(phone, questionId);
    expect(stored.map((m) => m.record.message_id)).toEqual([
      base.messageId,
      elsewhere.messageId,
      big.messageId,
    ]);
  });

  it("refuses a human message while the question's desktop does not declare threads", async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    const before = await say(w, phone, questionId);
    expect(before.res.status).toBe(409);
    expect(before.res.json.code).toBe('invalid_state');
    // The agent side is the desktop itself, so it needs no declaration to speak.
    expect((await say(w, w.owner, questionId)).res.status).toBe(201);
    await declare(w.owner);
    expect((await say(w, phone, questionId)).res.status).toBe(201);
    // A later ticket without features (an older client) is the 0.3.0 baseline again.
    await declare(w.owner, []);
    expect((await say(w, phone, questionId)).res.json.code).toBe('invalid_state');
  });
});

describe('idempotency', () => {
  it('returns the original receipt for a retried key or message, and refuses a changed one', async () => {
    const { w, phone, questionId } = await setup();
    const first = await say(w, phone, questionId);
    expect(first.res.status).toBe(201);

    // Same key, same body.
    const again = await phone.call(
      'POST',
      `/api/v1/questions/${questionId}/messages`,
      first.body,
    );
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.res.json);
    // Same record under a fresh key.
    const sameRecord = await phone.call('POST', `/api/v1/questions/${questionId}/messages`, {
      ...first.body,
      idempotency_key: newId(),
    });
    expect(sameRecord.status).toBe(200);
    expect(sameRecord.json).toEqual(first.res.json);
    // The same record signed again (ECDSA signatures differ every time) is still the same message.
    const { signature: _s, ...unsignedFirst } = first.record as Record<string, unknown>;
    const resigned = await signObject(phone.keys.signing.privateKey, unsignedFirst);
    const resent = await phone.call('POST', `/api/v1/questions/${questionId}/messages`, {
      ...first.body,
      idempotency_key: newId(),
      message: { record: resigned, envelope: first.envelope },
    });
    expect(resent.status).toBe(200);
    expect(resent.json).toEqual(first.res.json);

    // Same key, different body.
    const other = await say(w, phone, questionId, { idempotencyKey: first.body.idempotency_key });
    expect(other.res.status).toBe(409);
    expect(other.res.json.code).toBe('idempotency_collision');
    // Same message id, different record; and the same id on another question.
    const changed = await say(w, phone, questionId, {
      messageId: first.messageId,
      text: 'something else',
    });
    expect(changed.res.json.code).toBe('idempotency_collision');
    const second = (await ask(w)).questionId;
    expect((await say(w, phone, second, { messageId: first.messageId })).res.json.code).toBe(
      'idempotency_collision',
    );

    expect((await thread(phone, questionId)).map((m) => m.record.message_id)).toEqual([
      first.messageId,
    ]);
    expect(
      (await modernEvents(phone)).filter((e) => e.event_type === 'decision.message.posted'),
    ).toHaveLength(1);
  });

  it('recognises a retry before the state and quota checks', async () => {
    const { w, phone, questionId } = await setup();
    const first = await say(w, phone, questionId);
    expect((await act(w, w.owner, 'cancel', questionId, 0)).res.status).toBe(201);
    const retry = await phone.call('POST', `/api/v1/questions/${questionId}/messages`, {
      ...first.body,
      idempotency_key: newId(),
    });
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual(first.res.json);
    expect((await say(w, phone, questionId)).res.json.code).toBe('invalid_state');
  });
});

describe('ordering', () => {
  it('assigns one per-question order to concurrent senders, independent of the revision', async () => {
    const { w, phone, questionId } = await setup();
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    const posts = await Promise.all([
      say(w, phone, questionId, { text: 'one' }),
      say(w, w.owner, questionId, { text: 'two' }),
      say(w, tablet, questionId, { text: 'three' }),
      say(w, phone, questionId, { text: 'four' }),
      say(w, w.owner, questionId, { text: 'five', expectsReply: true }),
      say(w, tablet, questionId, { text: 'six' }),
    ]);
    for (const p of posts) expect(p.res.status).toBe(201);
    const seqs = posts.map((p) => p.res.json.message_seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);

    const listed = await thread(phone, questionId);
    expect(listed.map((m) => m.message_seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const eventSeqs = listed.map((m) => m.event_seq);
    expect([...eventSeqs].sort((a, b) => a - b)).toEqual(eventSeqs);
    // The event feed carries the same thread in the same order, and no message has a revision.
    const posted = (await modernEvents(phone)).filter(
      (e) => e.event_type === 'decision.message.posted',
    );
    expect(posted.map((e) => e.data.message_seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(posted.map((e) => e.seq)).toEqual(eventSeqs);
    for (const e of posted) {
      expect(e.question_revision).toBeNull();
      expect(e.data.target_host_id).toBe('host_aaaaaaaa');
    }

    // An answer moves the revision; the thread order carries on from where it was.
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(201);
    const after = await say(w, phone, questionId);
    expect(after.res.json.message_seq).toBe(7);
    expect((await question(phone, questionId)).revision).toBe(1);
  });

  it('pages a thread in order with a cursor', async () => {
    const { w, phone, questionId } = await setup();
    for (let i = 0; i < 7; i++) await say(w, i % 2 ? w.owner : phone, questionId);
    const first = await phone.call(
      'GET',
      `/api/v1/questions/${questionId}/messages`,
      undefined,
      'after=0&limit=3',
    );
    expect(MessagesPage.parse(first.json)).toMatchObject({ next_after: 3, has_more: true });
    expect((await thread(phone, questionId, 3)).map((m) => m.message_seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    const tail = await phone.call(
      'GET',
      `/api/v1/questions/${questionId}/messages`,
      undefined,
      'after=7',
    );
    expect(tail.json).toEqual({ question_id: questionId, messages: [], next_after: 7, has_more: false });
    const bad = await phone.call(
      'GET',
      `/api/v1/questions/${questionId}/messages`,
      undefined,
      'after=-1',
    );
    expect(bad.status).toBe(400);
    expect((await phone.call('GET', `/api/v1/questions/${newId()}/messages`)).status).toBe(404);
  });
});

describe('question states', () => {
  async function snapshot(a: Actor, id: string) {
    const q = await question(a, id);
    return {
      status: q.status,
      revision: q.revision,
      proxy_abstained: q.proxy_abstained,
      actions: q.actions.length,
      deliveries: q.deliveries,
    };
  }
  async function bothSides(w: World, phone: Actor, id: string) {
    return [(await say(w, phone, id)).res, (await say(w, w.owner, id)).res];
  }

  it('takes messages on open, human-answered and proxy-answered questions without touching the decision', async () => {
    const { w, phone, questionId: open } = await setup();
    const before = await snapshot(phone, open);
    for (const r of await bothSides(w, phone, open)) expect(r.status).toBe(201);
    expect(await snapshot(phone, open)).toEqual(before);

    const answered = (await ask(w)).questionId;
    expect((await act(w, phone, 'answer', answered, 0)).res.status).toBe(201);
    const afterAnswer = await snapshot(phone, answered);
    expect(afterAnswer.status).toBe('human-answered');
    for (const r of await bothSides(w, phone, answered)) expect(r.status).toBe(201);
    expect(await snapshot(phone, answered)).toEqual(afterAnswer);

    const proxied = (await ask(w, { requirement: 'proxy-ok' })).questionId;
    const proxy = await act(w, w.owner, 'proxy-answer', proxied, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.9,
      },
    });
    expect(proxy.res.status).toBe(201);
    const afterProxy = await snapshot(phone, proxied);
    expect(afterProxy.status).toBe('proxy-answered');
    // "Approved" in a message is text: it never confirms the model's answer.
    const approving = await say(w, phone, proxied, { text: 'approved' });
    expect(approving.res.status).toBe(201);
    expect((await say(w, w.owner, proxied)).res.status).toBe(201);
    expect(await snapshot(phone, proxied)).toEqual(afterProxy);

    // No message event is deliverable, and none carries a revision.
    for (const e of (await modernEvents(phone)).filter(
      (e) => e.event_type === 'decision.message.posted',
    )) {
      expect(e.data.deliverable).toBeUndefined();
      expect(e.question_revision).toBeNull();
    }
  });

  it('refuses expired questions with 410 and cancelled ones with 409, and a reopen opens the thread again', async () => {
    const { w, phone, questionId } = await setup();
    expect((await say(w, phone, questionId)).res.status).toBe(201);

    expect((await act(w, w.owner, 'cancel', questionId, 0)).res.status).toBe(201);
    for (const r of await bothSides(w, phone, questionId)) {
      expect(r.status).toBe(409);
      expect(r.json.code).toBe('invalid_state');
    }
    expect((await act(w, w.owner, 'reopen', questionId, 0, { content: null })).res.status).toBe(
      201,
    );
    const reopened = await say(w, phone, questionId);
    expect(reopened.res.json.message_seq).toBe(2);

    const expiring = (await ask(w)).questionId;
    await inRoom((room) =>
      room.run(`UPDATE questions SET expires_at = ? WHERE question_id = ?`, Date.now() - 1, expiring),
    );
    for (const r of await bothSides(w, phone, expiring)) {
      expect(r.status).toBe(410);
      expect(r.json.code).toBe('expired');
    }
    expect((await question(phone, expiring)).status).toBe('expired');
    expect(await thread(phone, expiring)).toEqual([]);
    // Closed threads stay readable.
    expect((await thread(phone, questionId)).map((m) => m.message_seq)).toEqual([1, 2]);
  });

  it('enforces the lifetime limit per question, across both sides and reopens', async () => {
    const { w, phone, questionId } = await setup();
    const seed = await say(w, phone, questionId);
    // Fill the thread to one under the limit directly; each message is a signed record the relay never reads.
    await inRoom((room) => {
      const row = room.q1<Record<string, unknown>>(
        `SELECT * FROM messages WHERE message_id = ?`,
        seed.messageId,
      )!;
      for (let seq = 2; seq <= 199; seq++) {
        room.run(
          `INSERT INTO messages (message_id, question_id, message_seq, side, expects_reply, signer_device_id,
             record_json, envelope_json, committed_at, event_seq) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
          newId(),
          questionId,
          seq,
          'human',
          phone.id,
          row.record_json as string,
          row.envelope_json as string,
          Date.now(),
          row.event_seq as number,
        );
      }
    });
    const last = await say(w, w.owner, questionId);
    expect(last.res.status).toBe(201);
    expect(last.res.json.message_seq).toBe(200);
    for (const r of await bothSides(w, phone, questionId)) {
      expect(r.status).toBe(409);
      expect(r.json.code).toBe('invalid_state');
    }
    expect((await act(w, w.owner, 'cancel', questionId, 0)).res.status).toBe(201);
    expect((await act(w, w.owner, 'reopen', questionId, 0, { content: null })).res.status).toBe(
      201,
    );
    expect((await say(w, phone, questionId)).res.json.code).toBe('invalid_state');
  });
});

describe('message receipts (section 16.4)', () => {
  const receipt = (a: Actor, body: Record<string, unknown>) =>
    a.call('POST', '/api/v1/deliveries/messages', {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(),
      host_id: 'host_aaaaaaaa',
      ...body,
    });
  const deliveryOf = async (a: Actor, questionId: string, messageId: string) =>
    (await thread(a, questionId)).find((m) => m.record.message_id === messageId)!.delivery;

  it('lets the publishing desktop report each human message, and the phone read it', async () => {
    const { w, phone, questionId } = await setup();
    const one = await say(w, phone, questionId);
    const two = await say(w, phone, questionId);
    const agent = await say(w, w.owner, questionId);
    expect(await deliveryOf(phone, questionId, one.messageId)).toEqual({
      status: 'relay-queued',
      received_at: null,
      terminal_delivered_at: null,
      injection_id: null,
      error_code: null,
    });
    expect(await deliveryOf(phone, questionId, agent.messageId)).toBeNull();

    // A ledger acknowledgement never stands in for an explicit receipt.
    const high = (await modernEvents(w.owner)).at(-1)!.seq;
    expect(
      (await w.owner.call('POST', '/api/v1/deliveries/received', { protocol_version: 1, seq: high }))
        .status,
    ).toBe(200);
    expect((await deliveryOf(phone, questionId, one.messageId)).status).toBe('relay-queued');

    const ids = { question_id: questionId, message_id: one.messageId };
    expect((await receipt(w.owner, { ...ids, status: 'received' })).status).toBe(200);
    const received = await deliveryOf(phone, questionId, one.messageId);
    expect(received.status).toBe('received');
    expect(received.received_at).not.toBeNull();
    const injection = newId();
    expect(
      (await receipt(w.owner, { ...ids, status: 'terminal-delivered', injection_id: injection }))
        .status,
    ).toBe(200);
    expect(await deliveryOf(phone, questionId, one.messageId)).toMatchObject({
      status: 'terminal-delivered',
      injection_id: injection,
      received_at: received.received_at,
    });
    // Repeating the same delivery is harmless; a different injection or a later failure is refused.
    expect(
      (await receipt(w.owner, { ...ids, status: 'terminal-delivered', injection_id: injection }))
        .status,
    ).toBe(200);
    expect(
      (await receipt(w.owner, { ...ids, status: 'terminal-delivered', injection_id: newId() })).json
        .code,
    ).toBe('invalid_state');
    expect(
      (await receipt(w.owner, { ...ids, status: 'needs-attention', error_code: 'pane_gone' })).json
        .code,
    ).toBe('invalid_state');
    expect((await receipt(w.owner, { ...ids, status: 'received' })).status).toBe(200);
    expect((await deliveryOf(phone, questionId, one.messageId)).status).toBe('terminal-delivered');

    // Each message has its own delivery: attention first, recovery later.
    const two_ = { question_id: questionId, message_id: two.messageId };
    expect(
      (await receipt(w.owner, { ...two_, status: 'needs-attention', error_code: 'pane_busy' }))
        .status,
    ).toBe(200);
    expect(await deliveryOf(phone, questionId, two.messageId)).toMatchObject({
      status: 'needs-attention',
      error_code: 'pane_busy',
      received_at: null,
    });
    expect((await receipt(w.owner, { ...two_, status: 'received' })).status).toBe(200);
    expect(await deliveryOf(phone, questionId, two.messageId)).toMatchObject({
      status: 'needs-attention',
    });
    expect(
      (await receipt(w.owner, { ...two_, status: 'terminal-delivered', injection_id: newId() }))
        .status,
    ).toBe(200);
    expect(await deliveryOf(phone, questionId, two.messageId)).toMatchObject({
      status: 'terminal-delivered',
      error_code: null,
    });

    // The phone sees the same changes as `delivery.message` events, in order.
    const deliveries = (await modernEvents(phone)).filter((e) => e.event_type === 'delivery.message');
    expect(deliveries.map((e) => [e.data.message_id, e.data.status])).toEqual([
      [one.messageId, 'received'],
      [one.messageId, 'terminal-delivered'],
      [two.messageId, 'needs-attention'],
      [two.messageId, 'needs-attention'],
      [two.messageId, 'terminal-delivered'],
    ]);
    for (const e of deliveries) {
      expect(e.question_revision).toBeNull();
      expect(e.data.target_host_id).toBe('host_aaaaaaaa');
    }
  });

  it('accepts receipts only from the publishing desktop, for its own human messages', async () => {
    const { w, phone, questionId } = await setup();
    const { host } = await enrollHost(w);
    const human = await say(w, phone, questionId);
    const agent = await say(w, w.owner, questionId);
    const ids = { question_id: questionId, message_id: human.messageId, status: 'received' };
    expect((await receipt(host, ids)).json.code).toBe('forbidden');
    expect((await receipt(phone, ids)).status).toBe(403);
    expect((await receipt(w.owner, { ...ids, host_id: 'host_bbbbbbbb' })).status).toBe(404);
    expect((await receipt(w.owner, { ...ids, message_id: agent.messageId })).status).toBe(404);
    expect((await receipt(w.owner, { ...ids, question_id: newId() })).status).toBe(404);
    expect((await deliveryOf(phone, questionId, human.messageId)).status).toBe('relay-queued');

    // Receipts are idempotent on their key.
    const body = {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(),
      host_id: 'host_aaaaaaaa',
      ...ids,
    };
    expect((await w.owner.call('POST', '/api/v1/deliveries/messages', body)).status).toBe(200);
    expect((await w.owner.call('POST', '/api/v1/deliveries/messages', body)).status).toBe(200);
    expect(
      (
        await w.owner.call('POST', '/api/v1/deliveries/messages', {
          ...body,
          status: 'needs-attention',
          error_code: 'x',
        })
      ).json.code,
    ).toBe('idempotency_collision');
  });
});

describe('export and delete', () => {
  it('serves every message of a thread back complete: verifiable records and decryptable content', async () => {
    const { w, phone, questionId } = await setup();
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    const sent: { id: string; text: string; side: string; signer: Actor }[] = [];
    for (let i = 0; i < 12; i++) {
      const signer = [phone, w.owner, tablet][i % 3]!;
      const text = `message ${i} ${'·'.repeat(i)}`;
      const r = await say(w, signer, questionId, { text, expectsReply: signer === w.owner });
      expect(r.res.status).toBe(201);
      sent.push({ id: r.messageId, text, side: r.record.side as string, signer });
    }
    const got = await thread(w.owner, questionId, 5);
    expect(got.map((m) => m.record.message_id)).toEqual(sent.map((s) => s.id));
    const keys = new Map([[w.epoch.epoch, w.epoch]]);
    for (const [i, m] of got.entries()) {
      const s = sent[i]!;
      expect(m.record.signer_device_id).toBe(s.signer.id);
      expect(await verifyObject(await importSigningPublicKey(s.signer.signingPub), m.record)).toBe(
        true,
      );
      expect(await envelopeDigest(m.envelope)).toBe(m.record.envelope_digest);
      const content = MessageContentV1.parse(
        await decryptEnvelope(m.envelope, keys, {
          installationId: w.installationId,
          questionId,
          recordType: MESSAGE_RECORD_TYPE,
          revision: 0,
          senderDeviceId: s.signer.id,
          purpose: 'message-content',
        }),
      );
      expect(content).toMatchObject({ side: s.side, text: s.text });
      if (content.side === 'human') {
        expect(HumanMessageContentV1.safeParse(content).success).toBe(true);
        expect(imagesMatchRecord(m.record.attachment_ids, content.images)).toBe(true);
      }
    }
    // The relay stores ciphertext only: no message text anywhere in its tables.
    const dump = await inRoom((room) =>
      JSON.stringify([
        room.q(`SELECT * FROM messages`),
        room.q(`SELECT * FROM events`),
        room.q(`SELECT * FROM command_receipts`),
      ]),
    );
    for (const s of sent) expect(dump).not.toContain(s.text);
  });

  it('deletes a question with its messages, receipts and events, leaving other threads alone', async () => {
    const { w, phone, questionId } = await setup();
    const keep = (await ask(w)).questionId;
    const gone = await say(w, phone, questionId);
    await say(w, w.owner, questionId);
    await w.owner.call('POST', '/api/v1/deliveries/messages', {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(),
      question_id: questionId,
      message_id: gone.messageId,
      host_id: 'host_aaaaaaaa',
      status: 'received',
    });
    const kept = await say(w, phone, keep);

    expect((await w.owner.call('DELETE', `/api/v1/questions/${questionId}`)).status).toBe(200);
    expect((await phone.call('GET', `/api/v1/questions/${questionId}/messages`)).status).toBe(404);
    const left = await inRoom((room) => ({
      messages: room.q<{ question_id: string }>(`SELECT question_id FROM messages`),
      deliveries: room.q<{ question_id: string }>(`SELECT question_id FROM message_deliveries`),
      events: room.q<{ event_type: string }>(
        `SELECT event_type FROM events WHERE question_id = ?`,
        questionId,
      ),
    }));
    expect(left.messages).toEqual([{ question_id: keep }]);
    expect(left.deliveries).toEqual([{ question_id: keep }]);
    expect(left.events.map((e) => e.event_type)).toEqual(['decision.deleted']);
    expect((await thread(phone, keep)).map((m) => m.record.message_id)).toEqual([kept.messageId]);
    expect((await say(w, phone, keep)).res.json.message_seq).toBe(2);
  });

  it.each(['questions', 'everything'] as const)(
    'removes every message and receipt when relay data is deleted (%s)',
    async (scope) => {
      const { w, phone, questionId } = await setup();
      await say(w, phone, questionId);
      await say(w, w.owner, questionId, { expectsReply: true });
      const res = await w.owner.call('POST', '/api/v1/admin/delete-data', {
        protocol_version: PROTOCOL_VERSION,
        confirm: 'DELETE',
        scope,
      });
      expect(res.status).toBe(200);
      const counts = await inRoom((room) => ({
        messages: room.q1<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`)!.n,
        deliveries: room.q1<{ n: number }>(`SELECT COUNT(*) AS n FROM message_deliveries`)!.n,
        replies: room.q1<{ n: number }>(
          `SELECT COUNT(*) AS n FROM scheduled_jobs WHERE kind = 'notify_reply'`,
        )!.n,
      }));
      expect(counts).toEqual({ messages: 0, deliveries: 0, replies: 0 });
    },
  );

  it('counts messages in diagnostics, without content', async () => {
    const { w, phone, questionId } = await setup();
    await say(w, phone, questionId);
    const d = await w.owner.call('GET', '/api/v1/admin/diagnostics');
    expect(d.json.counts.messages).toBe(1);
  });
});
