import { describe, expect, it } from 'vitest';
import {
  CREATOR_MISSING_FEATURE,
  EventData,
  PROTOCOL_VERSION,
} from '@daintreehq/decisions-protocol';
import { newId } from '@daintreehq/decisions-crypto';
import {
  act,
  ask,
  claimRelay,
  declare,
  enrollHost,
  events,
  inRoom,
  pairDevice,
  say,
  uploadPhoneImage,
  type Actor,
  type World,
} from './helpers.js';
import { refresh } from './snapshots.helpers.js';

/*
 * The owner desktop may sign the person's `answer` (docs/protocol.md section 2), recorded as `human-desktop`, once
 * the question's publishing desktop declares `owner-desktop-answers-v1`. A Host never may, and the owner desktop
 * gains no other human action.
 */

const ACCEPTS = 'owner-desktop-answers-v1';

async function state(questionId: string) {
  return inRoom((room) => ({
    question: room.q1<{ status: string; revision: number }>(
      `SELECT status, revision FROM questions WHERE question_id = ?`,
      questionId,
    ),
    actions: room.q<{ action: string; provenance: string | null; actor_device_id: string }>(
      `SELECT action, provenance, actor_device_id FROM actions WHERE question_id = ? ORDER BY event_seq`,
      questionId,
    ),
    deliveries: room.q1<{ n: number }>(
      `SELECT COUNT(*) AS n FROM deliveries WHERE question_id = ?`,
      questionId,
    )!.n,
    answerEvents: room.q1<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE question_id = ? AND event_type = 'decision.answer.committed'`,
      questionId,
    )!.n,
  }));
}

/** Nothing about the question changed: still open at revision 0, no action, delivery or answer event. */
async function expectUntouched(questionId: string) {
  expect(await state(questionId)).toEqual({
    question: { status: 'open', revision: 0 },
    actions: [],
    deliveries: 0,
    answerEvents: 0,
  });
}

function expectCreatorRefusal(res: { status: number; json: any }) {
  expect(res.status).toBe(409);
  expect(res.json.code).toBe('invalid_state');
  expect(res.json.details).toEqual({
    reason: CREATOR_MISSING_FEATURE,
    required_feature: ACCEPTS,
  });
}

/** Posts an already-signed action again, as a client's outbox retry does. */
const repost = (actor: Actor, questionId: string, action: unknown, idempotencyKey: string) =>
  actor.call('POST', `/api/v1/questions/${questionId}/answer`, {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: idempotencyKey,
    action,
  });

describe('the owner desktop answers for the person', () => {
  it('commits a human-required answer recorded as human-desktop, delivered like a phone answer', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    await declare(w.owner, [ACCEPTS]);
    const { questionId } = await ask(w, { requirement: 'human-required' });

    const { res } = await act(w, w.owner, 'answer', questionId, 0);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ revision: 1, status: 'human-answered' });

    const detail = await phone.call('GET', `/api/v1/questions/${questionId}`);
    expect(detail.json.status).toBe('human-answered');
    expect(detail.json.actions).toHaveLength(1);
    expect(detail.json.actions[0]).toMatchObject({
      action: 'answer',
      provenance: 'human-desktop',
      actor_device_id: w.owner.id,
      revision: 1,
    });
    expect(detail.json.deliveries).toEqual([
      expect.objectContaining({ answer_revision: 1, status: 'relay-queued' }),
    ]);

    // Every device sees the commit, with its distinct provenance, and no declaration is needed to see it.
    const ev = (await events(phone)).find((e) => e.event_type === 'decision.answer.committed');
    expect(ev.data).toMatchObject({
      provenance: 'human-desktop',
      deliverable: true,
      status: 'human-answered',
    });
    expect(EventData.action.safeParse(ev.data).success).toBe(true);
    expect(ev.origin_device_id).toBe(w.owner.id);

    // First answer wins, whoever gave it.
    const late = await act(w, phone, 'answer', questionId, 0);
    expect(late.res.status).toBe(409);
    expect(late.res.json.code).toBe('revision_conflict');
  });

  it('answers at every requirement level, and a phone answer stays human', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    await declare(w.owner, [ACCEPTS]);
    for (const requirement of ['human-required', 'proxy-ok', 'proxy-first'] as const) {
      const { questionId } = await ask(w, { requirement });
      expect((await act(w, w.owner, 'answer', questionId, 0)).res.status, requirement).toBe(201);
      expect((await state(questionId)).actions).toEqual([
        { action: 'answer', provenance: 'human-desktop', actor_device_id: w.owner.id },
      ]);
    }
    const { questionId } = await ask(w);
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(201);
    expect((await state(questionId)).actions[0]!.provenance).toBe('human');
  });

  it('refuses until the asking desktop declares support, with a refusal a client can tell apart', async () => {
    const w = await claimRelay();
    await pairDevice(w);
    const { questionId } = await ask(w);

    // No declaration, then every other feature but this one.
    const key = newId();
    const first = await act(w, w.owner, 'answer', questionId, 0, { idempotencyKey: key });
    expectCreatorRefusal(first.res);
    await declare(w.owner, ['pane-snapshots-v1', 'phone-images-v1', 'thread-messages-v1']);
    expectCreatorRefusal(await repost(w.owner, questionId, first.signed, key));
    // A `GET /events` declaration is per request and never recorded for the device.
    await w.owner.call('GET', '/api/v1/events', undefined, `after=0&limit=1&features=${ACCEPTS}`);
    expectCreatorRefusal(await repost(w.owner, questionId, first.signed, key));
    await expectUntouched(questionId);

    // A refusal stores no receipt, so the very same signed command commits once support is declared.
    await declare(w.owner, [ACCEPTS]);
    const ok = await repost(w.owner, questionId, first.signed, key);
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ revision: 1, status: 'human-answered' });

    // Retries stay idempotent after the declaration is withdrawn: the receipt, then the same action id.
    await declare(w.owner, []);
    const replay = await repost(w.owner, questionId, first.signed, key);
    expect(replay.status).toBe(201);
    expect(replay.json).toEqual(ok.json);
    const sameAction = await repost(w.owner, questionId, first.signed, newId());
    expect(sameAction.status).toBe(200);
    expect(sameAction.json).toMatchObject({ revision: 1, status: 'human-answered' });
    expect((await state(questionId)).answerEvents).toBe(1);
  });

  it("answers a Host's question once the Host declares support; the owner's own declaration never counts", async () => {
    const w = await claimRelay();
    await pairDevice(w);
    const { host, world: hostWorld } = await enrollHost(w);
    const { questionId } = await ask(hostWorld, { host: 'host_bbbbbbbb' });
    await declare(w.owner, [ACCEPTS]);
    await declare(host, ['thread-messages-v1']);

    expectCreatorRefusal((await act(w, w.owner, 'answer', questionId, 0)).res);
    await expectUntouched(questionId);

    await declare(host, ['thread-messages-v1', ACCEPTS]);
    const { res } = await act(w, w.owner, 'answer', questionId, 0);
    expect(res.status).toBe(201);
    const detail = await host.call('GET', `/api/v1/questions/${questionId}`);
    expect(detail.json.actions[0]).toMatchObject({
      provenance: 'human-desktop',
      actor_device_id: w.owner.id,
    });
    expect(detail.json.deliveries).toEqual([
      expect.objectContaining({ target_host_id: 'host_bbbbbbbb', status: 'relay-queued' }),
    ]);
  });

  it('never lets a Host answer as the person, on its own question or the owner’s', async () => {
    const w = await claimRelay();
    await pairDevice(w);
    const { host, world: hostWorld } = await enrollHost(w);
    await declare(w.owner, [ACCEPTS]);
    await declare(host, [ACCEPTS]);
    const own = await ask(hostWorld, { requirement: 'proxy-ok' });
    const owners = await ask(w);
    for (const questionId of [own.questionId, owners.questionId]) {
      const { res } = await act(hostWorld, host, 'answer', questionId, 0);
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('forbidden');
      await expectUntouched(questionId);
    }
  });

  it('refuses phone images on an answer the owner desktop signs', async () => {
    const w = await claimRelay();
    await pairDevice(w);
    await declare(w.owner, [ACCEPTS, 'phone-images-v1']);
    const { questionId } = await ask(w);
    const withImages = await act(w, w.owner, 'answer', questionId, 0, {
      attachmentIds: [newId()],
    });
    expect(withImages.res.status).toBe(403);
    expect(withImages.res.json.code).toBe('forbidden');
    await expectUntouched(questionId);
    // An empty list is no image at all.
    expect((await act(w, w.owner, 'answer', questionId, 0, { attachmentIds: [] })).res.status).toBe(
      201,
    );
  });
});

describe('the owner desktop gains no other human action', () => {
  async function world(): Promise<{ w: World; phone: Actor }> {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    await declare(w.owner, [
      ACCEPTS,
      'pane-snapshots-v1',
      'phone-images-v1',
      'thread-messages-v1',
    ]);
    return { w, phone };
  }

  it('cannot override an answer or confirm a proxy answer', async () => {
    const { w, phone } = await world();
    const answered = await ask(w);
    expect((await act(w, phone, 'answer', answered.questionId, 0)).res.status).toBe(201);
    expect((await act(w, w.owner, 'override', answered.questionId, 1)).res.status).toBe(403);

    const proxied = await ask(w, { requirement: 'proxy-ok' });
    const proxy = await act(w, w.owner, 'proxy-answer', proxied.questionId, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.9,
      },
    });
    expect(proxy.res.status).toBe(201);
    expect((await act(w, w.owner, 'override', proxied.questionId, 1)).res.status).toBe(403);
    const confirm = await act(w, w.owner, 'confirm-proxy', proxied.questionId, 1, {
      content: null,
      confirmsActionId: proxy.signed.record.action_id,
    });
    expect(confirm.res.status).toBe(403);
    // The proxy answer is still the one in force, and still the model's.
    expect((await state(proxied.questionId)).actions.map((a) => a.provenance)).toEqual(['proxy']);
  });

  it('cannot send a human message, attach a phone image or ask for a fresh snapshot', async () => {
    const { w } = await world();
    const { questionId } = await ask(w);
    const message = await say(w, w.owner, questionId, { side: 'human' });
    expect(message.res.status).toBe(403);
    expect(message.res.json.code).toBe('forbidden');
    const image = await uploadPhoneImage(
      w,
      w.owner,
      questionId,
      { kind: 'answer', record_id: newId() },
      { until: 'reserve' },
    );
    expect(image.reserve.status).toBe(403);
    expect((await refresh(w.owner, questionId)).status).toBe(403);
    await expectUntouched(questionId);
  });

  it('cannot use push or voice', async () => {
    const { w } = await world();
    const sub = {
      protocol_version: 1,
      endpoint: `https://fcm.googleapis.com/fcm/send/${newId()}`,
      p256dh: 'B'.repeat(87),
      auth: 'A'.repeat(22),
    };
    expect((await w.owner.call('GET', '/api/v1/push/subscriptions')).status).toBe(403);
    expect((await w.owner.call('POST', '/api/v1/push/subscriptions', sub)).status).toBe(403);
    expect((await w.owner.call('DELETE', `/api/v1/push/subscriptions/${newId()}`)).status).toBe(
      403,
    );
    expect((await w.owner.call('POST', '/api/v1/push/test', {})).status).toBe(403);
    expect(
      (
        await w.owner.call('POST', '/api/v1/voice/session', {
          protocol_version: 1,
          provider: 'xai',
          consent: true,
          keyterms: [],
        })
      ).status,
    ).toBe(403);
  });
});
