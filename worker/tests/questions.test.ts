import { describe, expect, it, vi } from 'vitest';
import { CREATOR_MISSING_FEATURE, LIMITS, PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import { buildSignedAction, newId } from '@daintreehq/decisions-crypto';
import {
  act,
  ask,
  claimRelay,
  declare,
  enrollHost,
  events,
  inRoom,
  pairDevice,
  PNG,
  settle,
  uploadImage,
  type World,
} from './helpers.js';

const ids = (evs: any[]) => evs.map((e) => e.event_type);

describe('question creation', () => {
  it('creates a question, emits one event, and returns a stable receipt', async () => {
    const w = await claimRelay();
    const { res, questionId } = await ask(w);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ question_id: questionId, revision: 0, status: 'open' });
    const evs = await events(w.owner);
    expect(ids(evs)).toEqual(['decision.created']);
    expect(evs[0].data.requirement).toBe('human-required');
  });

  it('accepts no expiry or one within the protocol limit, and refuses one beyond it', async () => {
    const w = await claimRelay();
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    expect((await ask(w, { expiresAt: null })).res.status).toBe(201);
    expect(
      (await ask(w, { expiresAt: at(LIMITS.maxQuestionExpiryMs - 3_600_000) })).res.status,
    ).toBe(201);
    const beyond = await ask(w, { expiresAt: at(LIMITS.maxQuestionExpiryMs + 3_600_000) });
    expect(beyond.res.status).toBe(400);
    expect(beyond.res.json.message).toMatch(/within a year/);
  });

  it('is idempotent for identical retries and rejects a reused key with a different body', async () => {
    const w = await claimRelay();
    const key = newId();
    const a = await ask(w, { idempotencyKey: key });
    const again = await w.owner.call('POST', '/api/v1/questions', {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: key,
      question: a.question,
    });
    expect(again.status).toBe(201);
    expect(again.json.event_seq).toBe(a.res.json.event_seq);
    expect((await events(w.owner)).length).toBe(1);
    const other = await ask(w, { idempotencyKey: key });
    expect(other.res.status).toBe(409);
    expect(other.res.json.code).toBe('idempotency_collision');
  });

  it('a different idempotency key but the same question id returns the existing question', async () => {
    const w = await claimRelay();
    const a = await ask(w);
    const retry = await w.owner.call('POST', '/api/v1/questions', {
      protocol_version: 1,
      idempotency_key: newId(),
      question: a.question,
    });
    expect(retry.status).toBe(200);
    expect((await events(w.owner)).length).toBe(1);
  });

  it('a retry after the deadline replays the accepted create, answered or not, and changes nothing', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const deadline = Date.now() + 1_500;
    const expiresAt = new Date(deadline).toISOString();
    const post = (question: unknown, idempotencyKey: string) =>
      w.owner.call('POST', '/api/v1/questions', {
        protocol_version: PROTOCOL_VERSION,
        idempotency_key: idempotencyKey,
        question,
      });

    // One question with an image, left open until it expires; another answered in time.
    const openId = newId();
    const up = await uploadImage(w, openId, PNG);
    const openKey = newId();
    const open = await ask(w, {
      questionId: openId,
      idempotencyKey: openKey,
      expiresAt,
      attachmentIds: [up.attachmentId],
    });
    expect(open.res.status).toBe(201);
    const answeredKey = newId();
    const answered = await ask(w, { idempotencyKey: answeredKey, expiresAt });
    expect(answered.res.status).toBe(201);
    expect((await act(w, phone, 'answer', answered.questionId, 0)).res.status).toBe(201);

    while (Date.now() <= deadline) await new Promise((r) => setTimeout(r, 50));
    // A read commits the lazy expiry, so the ledger below holds still for the retries.
    expect((await w.owner.call('GET', `/api/v1/questions/${openId}`)).json.status).toBe('expired');
    await settle();
    const ledger = () =>
      inRoom((room) => ({
        events: room.q(`SELECT seq, event_type, question_id FROM events ORDER BY seq`),
        jobs: room.q(
          `SELECT job_id, kind, question_id, run_at, status FROM scheduled_jobs
           WHERE question_id IN (?, ?) ORDER BY job_id`,
          openId,
          answered.questionId,
        ),
        attachments: room.q(`SELECT attachment_id, question_id, state, bound FROM attachments`),
        questions: room.q(
          `SELECT question_id, status, revision, last_event_seq FROM questions ORDER BY question_id`,
        ),
      }));
    const before = await ledger();

    // The same command (key and body) replays its original receipt.
    const replayOpen = await post(open.question, openKey);
    expect(replayOpen.status).toBe(201);
    expect(replayOpen.json).toEqual(open.res.json);
    const replayAnswered = await post(answered.question, answeredKey);
    expect(replayAnswered.status).toBe(201);
    expect(replayAnswered.json).toEqual(answered.res.json);

    // The same signed question under a fresh key reconciles to the question as it stands now.
    const reconcileOpen = await post(open.question, newId());
    expect(reconcileOpen.status).toBe(200);
    expect(reconcileOpen.json).toMatchObject({ question_id: openId, status: 'expired' });
    const reconcileAnswered = await post(answered.question, newId());
    expect(reconcileAnswered.status).toBe(200);
    expect(reconcileAnswered.json).toMatchObject({
      question_id: answered.questionId,
      status: 'human-answered',
      revision: 1,
    });

    // Collisions stay collisions after the deadline: a reused key, or a reused question id.
    const past = new Date(Date.now() - 1_000).toISOString();
    const reusedKey = await ask(w, { idempotencyKey: openKey, expiresAt: past });
    expect(reusedKey.res.status).toBe(409);
    expect(reusedKey.res.json.code).toBe('idempotency_collision');
    const reusedId = await ask(w, { questionId: openId, expiresAt: past });
    expect(reusedId.res.status).toBe(409);
    expect(reusedId.res.json.code).toBe('idempotency_collision');

    // A new question that is already overdue is still refused.
    const overdue = await ask(w, { expiresAt: past });
    expect(overdue.res.status).toBe(400);
    expect(overdue.res.json.code).toBe('validation_error');

    // No second creation, push, job or attachment binding came of any of it.
    expect(await ledger()).toEqual(before);
  });

  it('checks a new create against its deadline when it commits, not when it arrives', async () => {
    const w = await claimRelay();
    const deadline = Date.now() + 5_000;
    let clock = deadline - 1;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // The deadline arrives as the create's transaction opens, after the signature checks have awaited.
    await inRoom((room) => {
      const tx = room.tx.bind(room);
      room.tx = ((fn) => {
        clock = deadline;
        return tx(fn);
      }) as typeof room.tx;
    });
    try {
      const key = newId();
      const late = await ask(w, { idempotencyKey: key, expiresAt: new Date(deadline).toISOString() });
      expect(late.res.status).toBe(400);
      expect(late.res.json.code).toBe('validation_error');
      const left = await inRoom((room) => ({
        questions: room.q(`SELECT 1 FROM questions WHERE question_id = ?`, late.questionId).length,
        receipts: room.q(`SELECT 1 FROM command_receipts WHERE idempotency_key = ?`, key).length,
        events: room.q(`SELECT 1 FROM events WHERE question_id = ?`, late.questionId).length,
        jobs: room.q(`SELECT 1 FROM scheduled_jobs WHERE question_id = ?`, late.questionId).length,
      }));
      expect(left).toEqual({ questions: 0, receipts: 0, events: 0, jobs: 0 });
    } finally {
      now.mockRestore();
      await inRoom((room) => {
        delete (room as { tx?: unknown }).tx;
      });
    }
  });

  it('rejects tampered records: signature, digest, binding and expiry', async () => {
    const w = await claimRelay();
    const a = await ask(w);
    const post = (q: unknown) =>
      w.owner.call('POST', '/api/v1/questions', {
        protocol_version: 1,
        idempotency_key: newId(),
        question: q,
      });
    const fresh = async () => (await ask(w, { questionId: newId() })).question;
    const q1 = await fresh();
    expect(
      (
        await post({
          ...q1,
          record: { ...q1.record, question_id: newId(), requirement: 'proxy-ok' },
        })
      ).status,
    ).toBe(400);
    const q2 = await fresh();
    expect((await post({ ...q2, record: { ...q2.record, requirement: 'proxy-ok' } })).status).toBe(
      400,
    ); // signature breaks
    const q3 = await fresh();
    expect(
      (
        await post({
          ...q3,
          envelope: { ...q3.envelope, aad: { ...q3.envelope.aad, revision: 3 } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await ask(w, { expiresAt: new Date(Date.now() - 1000).toISOString() })).res.status,
    ).toBe(400);
    void a;
  });

  it('enforces open-question quotas per pane', async () => {
    const w = await claimRelay();
    for (let i = 0; i < 10; i++)
      expect((await ask(w, { originRef: 'pane_quota001' })).res.status).toBe(201);
    const over = await ask(w, { originRef: 'pane_quota001' });
    expect(over.res.status).toBe(429);
    expect((await ask(w, { originRef: 'pane_other001' })).res.status).toBe(201);
  });

  it('phones cannot create questions', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    expect((await phone.call('POST', '/api/v1/questions', {})).status).toBe(403);
  });
});

describe('human answers: first answer wins', () => {
  it('commits the first answer, bumps the revision and queues a delivery', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    const { res } = await act(w, phone, 'answer', questionId, 0);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ revision: 1, status: 'human-answered' });
    const detail = await phone.call('GET', `/api/v1/questions/${questionId}`);
    expect(detail.json.status).toBe('human-answered');
    expect(detail.json.actions).toHaveLength(1);
    expect(detail.json.actions[0]).toMatchObject({
      action: 'answer',
      provenance: 'human',
      revision: 1,
    });
    expect(detail.json.deliveries[0]).toMatchObject({ answer_revision: 1, status: 'relay-queued' });
    const evs = (await events(phone)).filter((e) => e.event_type.startsWith('decision.'));
    expect(ids(evs)).toEqual(['decision.created', 'decision.answer.committed']);
    expect(evs[1].data).toMatchObject({
      deliverable: true,
      provenance: 'human',
      status: 'human-answered',
    });
  });

  it('two phones racing: exactly one commit, the other gets 409 with the latest revision', async () => {
    const w = await claimRelay();
    const a = await pairDevice(w, 'phone', 'Phone A');
    const b = await pairDevice(w, 'tablet', 'Tablet B');
    const { questionId } = await ask(w);
    const [ra, rb] = await Promise.all([
      act(w, a, 'answer', questionId, 0),
      act(w, b, 'answer', questionId, 0),
    ]);
    const statuses = [ra.res.status, rb.res.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = ra.res.status === 409 ? ra.res : rb.res;
    expect(loser.json.code).toBe('revision_conflict');
    expect(loser.json.details.latest_revision).toBe(1);
    const evs = await events(w.owner);
    expect(evs.filter((e) => e.event_type === 'decision.answer.committed')).toHaveLength(1);
  });

  it('a stale answer after the first is a conflict, not an overwrite', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    await act(w, phone, 'answer', questionId, 0);
    const second = await act(w, phone, 'answer', questionId, 0);
    expect(second.res.status).toBe(409);
    const stillOne = await phone.call('GET', `/api/v1/questions/${questionId}`);
    expect(stillOne.json.actions).toHaveLength(1);
  });

  it('replaying the identical signed answer ten times yields one event', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    const key = newId();
    const first = await act(w, phone, 'answer', questionId, 0, { idempotencyKey: key });
    const body = { protocol_version: PROTOCOL_VERSION, idempotency_key: key, action: first.signed };
    for (let i = 0; i < 10; i++) {
      const r = await phone.call('POST', `/api/v1/questions/${questionId}/answer`, body);
      expect([200, 201]).toContain(r.status);
      expect(r.json.revision).toBe(1);
    }
    const evs = await events(w.owner);
    expect(evs.filter((e) => e.event_type === 'decision.answer.committed')).toHaveLength(1);
  });

  it('the same action id with a fresh idempotency key does not create a second event', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    const first = await act(w, phone, 'answer', questionId, 0);
    const again = await phone.call('POST', `/api/v1/questions/${questionId}/answer`, {
      protocol_version: 1,
      idempotency_key: newId(),
      action: first.signed,
    });
    expect(again.status).toBe(200);
    expect(
      (await events(w.owner)).filter((e) => e.event_type === 'decision.answer.committed'),
    ).toHaveLength(1);
  });

  it('rejects forged or mis-bound answers', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const mallory = await pairDevice(w, 'phone', 'Mallory');
    const { questionId } = await ask(w);
    const good = await act(w, phone, 'answer', questionId, 0, { idempotencyKey: newId() });
    void good;
    const fresh = await ask(w);
    // answer signed by phone but submitted by mallory's session
    const signed = (await act(w, phone, 'answer', fresh.questionId, 0)).signed;
    const stolen = await mallory.call('POST', `/api/v1/questions/${fresh.questionId}/answer`, {
      protocol_version: 1,
      idempotency_key: newId(),
      action: signed,
    });
    expect(stolen.status).toBe(400);
    // action kind must match the route
    const wrongRoute = await phone.call('POST', `/api/v1/questions/${fresh.questionId}/override`, {
      protocol_version: 1,
      idempotency_key: newId(),
      action: signed,
    });
    expect(wrongRoute.status).toBe(400);
    // record altered after signing
    const altered = { ...signed, record: { ...signed.record, expected_revision: 7 } };
    expect(
      (
        await phone.call('POST', `/api/v1/questions/${fresh.questionId}/answer`, {
          protocol_version: 1,
          idempotency_key: newId(),
          action: altered,
        })
      ).status,
    ).toBe(400);
    // envelope swapped for another
    const other = (await act(w, phone, 'answer', questionId, 1)).signed;
    const swapped = { ...signed, envelope: other.envelope };
    expect(
      (
        await phone.call('POST', `/api/v1/questions/${fresh.questionId}/answer`, {
          protocol_version: 1,
          idempotency_key: newId(),
          action: swapped,
        })
      ).status,
    ).toBe(400);
  });

  it('answering a missing question is 404; a Host cannot answer as a human', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    expect((await act(w, phone, 'answer', newId(), 0)).res.status).toBe(404);
    const { questionId } = await ask(w);
    const { host } = await enrollHost(w);
    const desktop = await act(w, host, 'answer', questionId, 0);
    expect(desktop.res.status).toBe(403);
    // The owner desktop may answer for the person only where the asking desktop accepts it (owner-answers.test.ts).
    const owner = await act(w, w.owner, 'answer', questionId, 0);
    expect(owner.res.status).toBe(409);
    expect(owner.res.json.details.reason).toBe('creator-missing-feature');
  });

  it('override replaces a human answer with a new revision and a new delivery', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    await act(w, phone, 'answer', questionId, 0);
    const o = await act(w, phone, 'override', questionId, 1, {
      content: { selected_option_ids: ['reject'], reason: 'changed my mind' },
    });
    expect(o.res.json).toMatchObject({ revision: 2, status: 'human-answered' });
    const d = await phone.call('GET', `/api/v1/questions/${questionId}`);
    expect(d.json.deliveries.map((x: any) => x.answer_revision)).toEqual([1, 2]);
  });
});

describe('proxy answers never satisfy human-required', () => {
  it('rejects proxy-answer and proxy-abstain on a human-required question', async () => {
    const w = await claimRelay();
    const { questionId } = await ask(w, { requirement: 'human-required' });
    const p = await act(w, w.owner, 'proxy-answer', questionId, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.99,
      },
    });
    expect(p.res.status).toBe(403);
    expect((await act(w, w.owner, 'proxy-abstain', questionId, 0)).res.status).toBe(403);
    const d = await w.owner.call('GET', `/api/v1/questions/${questionId}`);
    expect(d.json.status).toBe('open');
  });

  it('phones cannot sign proxy answers', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w, { requirement: 'proxy-ok' });
    expect((await act(w, phone, 'proxy-answer', questionId, 0)).res.status).toBe(403);
  });

  it('proxy-ok: proxy answers, the human can confirm (no redelivery) or override (redelivery)', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const a = await ask(w, { requirement: 'proxy-ok' });
    const proxy = await act(w, w.owner, 'proxy-answer', a.questionId, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.9,
      },
    });
    expect(proxy.res.json).toMatchObject({ revision: 1, status: 'proxy-answered' });
    const evs = await events(phone);
    expect(evs.at(-1).data).toMatchObject({ provenance: 'proxy', deliverable: true });
    // a plain "answer" on a proxy-answered question is a conflict: the human must override or confirm deliberately
    expect((await act(w, phone, 'answer', a.questionId, 1)).res.status).toBe(409);
    const confirm = await act(w, phone, 'confirm-proxy', a.questionId, 1, {
      content: null,
      confirmsActionId: proxy.signed.record.action_id,
    });
    expect(confirm.res.json).toMatchObject({ revision: 2, status: 'human-answered' });
    const d = await phone.call('GET', `/api/v1/questions/${a.questionId}`);
    expect(d.json.deliveries).toHaveLength(1); // confirmation is not redelivered
    expect((await events(phone)).at(-1).data.deliverable).toBe(false);

    const b = await ask(w, { requirement: 'proxy-ok' });
    const p2 = await act(w, w.owner, 'proxy-answer', b.questionId, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.8,
      },
    });
    const wrongTarget = await act(w, phone, 'confirm-proxy', b.questionId, 1, {
      content: null,
      confirmsActionId: newId(),
    });
    expect(wrongTarget.res.status).toBe(400);
    const ov = await act(w, phone, 'override', b.questionId, 1, {
      content: { selected_option_ids: ['reject'], reason: 'no' },
    });
    expect(ov.res.json).toMatchObject({ revision: 2, status: 'human-answered' });
    expect(
      (await phone.call('GET', `/api/v1/questions/${b.questionId}`)).json.deliveries,
    ).toHaveLength(2);
    void p2;
  });

  it('proxy-first abstain escalates without changing the revision', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w, { requirement: 'proxy-first' });
    const ab = await act(w, w.owner, 'proxy-abstain', questionId, 0, { content: null });
    expect(ab.res.json).toMatchObject({ revision: 0, status: 'open' });
    const d = await phone.call('GET', `/api/v1/questions/${questionId}`);
    expect(d.json.proxy_abstained).toBe(true);
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(201);
  });

  it('a stale proxy answer after a human answer is refused', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w, { requirement: 'proxy-first' });
    await act(w, phone, 'answer', questionId, 0);
    const late = await act(w, w.owner, 'proxy-answer', questionId, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 1,
      },
    });
    expect(late.res.status).toBe(409);
  });
});

describe('cancel, expiry and reopen', () => {
  async function setup(w?: World) {
    const world = w ?? (await claimRelay());
    return { world, phone: await pairDevice(world) };
  }

  it('cancel is idempotent and cannot remove a human answer', async () => {
    const { world: w, phone } = await setup();
    const a = await ask(w);
    expect((await act(w, w.owner, 'cancel', a.questionId, 0, { content: null })).res.status).toBe(
      201,
    );
    const again = await act(w, w.owner, 'cancel', a.questionId, 0, { content: null });
    expect(again.res.status).toBe(200);
    expect(
      (await events(w.owner)).filter((e) => e.event_type === 'decision.cancelled'),
    ).toHaveLength(1);
    expect((await act(w, phone, 'answer', a.questionId, 0)).res.status).toBe(409);

    const b = await ask(w);
    await act(w, phone, 'answer', b.questionId, 0);
    expect((await act(w, w.owner, 'cancel', b.questionId, 1, { content: null })).res.status).toBe(
      409,
    );
  });

  it('a phone or tablet declines an open question: it closes, stops its jobs and takes no answer', async () => {
    const { world: w, phone } = await setup();
    await declare(w.owner, ['person-declines-v1']);
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    const a = await ask(w);
    const pending = () =>
      inRoom((room) =>
        room.q<{ kind: string }>(
          `SELECT kind FROM scheduled_jobs WHERE question_id = ? AND status = 'pending' AND kind != 'delete_attachments'`,
          a.questionId,
        ),
      );
    expect((await pending()).length).toBeGreaterThan(0);
    const r = await act(w, phone, 'cancel', a.questionId, 0);
    expect(r.res.status).toBe(201);
    expect(r.res.json).toMatchObject({ status: 'cancelled', revision: 0 });
    expect(await pending()).toEqual([]);
    const ev = (await events(w.owner)).filter((e) => e.event_type === 'decision.cancelled');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({
      action: 'cancel',
      provenance: null,
      deliverable: false,
      status: 'cancelled',
      record: { signer_device_id: phone.id, action: 'cancel' },
    });
    // A retry from another device is a no-op: the first cancel keeps its signer.
    expect((await act(w, tablet, 'cancel', a.questionId, 0)).res.status).toBe(200);
    expect((await act(w, w.owner, 'cancel', a.questionId, 0)).res.status).toBe(200);
    expect(
      (await events(w.owner)).filter((e) => e.event_type === 'decision.cancelled'),
    ).toHaveLength(1);
    expect((await act(w, tablet, 'answer', a.questionId, 0)).res.status).toBe(409);
  });

  it('a person cannot decline a proxy answer, an answered question, or reopen one', async () => {
    const { world: w, phone } = await setup();
    await declare(w.owner, ['person-declines-v1']);
    const p = await ask(w, { requirement: 'proxy-ok' });
    expect((await act(w, w.owner, 'proxy-answer', p.questionId, 0)).res.status).toBe(201);
    expect((await act(w, phone, 'cancel', p.questionId, 1)).res.status).toBe(409);
    const h = await ask(w);
    expect((await act(w, phone, 'answer', h.questionId, 0)).res.status).toBe(201);
    expect((await act(w, phone, 'cancel', h.questionId, 1)).res.status).toBe(409);
    const o = await ask(w);
    expect((await act(w, phone, 'cancel', o.questionId, 3)).res.status).toBe(409);
    expect((await act(w, phone, 'cancel', o.questionId, 0)).res.status).toBe(201);
    expect((await act(w, phone, 'reopen', o.questionId, 0)).res.status).toBe(403);
  });

  it('refuses a decline until the asking desktop declares person-declines-v1, and stores nothing', async () => {
    const { world: w, phone } = await setup();
    const a = await ask(w);
    const repost = (action: unknown, idempotencyKey: string) =>
      phone.call('POST', `/api/v1/questions/${a.questionId}/cancel`, {
        protocol_version: PROTOCOL_VERSION,
        idempotency_key: idempotencyKey,
        action,
      });
    const expectRefused = (res: { status: number; json: any }) => {
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({
        code: 'invalid_state',
        details: { reason: CREATOR_MISSING_FEATURE, required_feature: 'person-declines-v1' },
      });
    };
    // A desktop that predates declines (it declares nothing, or only older features) would reject the event.
    const key = newId();
    const first = await act(w, phone, 'cancel', a.questionId, 0, { idempotencyKey: key });
    expectRefused(first.res);
    await declare(w.owner, ['thread-messages-v1', 'owner-desktop-answers-v1']);
    expectRefused(await repost(first.signed, key));
    // Nothing was stored: no status change, no event, no receipt, no action, and its jobs still pending.
    expect((await phone.call('GET', `/api/v1/questions/${a.questionId}`)).json.status).toBe('open');
    expect(
      (await events(w.owner)).filter((e) => e.event_type === 'decision.cancelled'),
    ).toHaveLength(0);
    const stored = await inRoom((room) => ({
      receipts: room.q(`SELECT 1 FROM command_receipts WHERE idempotency_key = ?`, key).length,
      actions: room.q(`SELECT 1 FROM actions WHERE question_id = ?`, a.questionId).length,
      pendingJobs: room.q(
        `SELECT 1 FROM scheduled_jobs WHERE question_id = ? AND status = 'pending' AND kind != 'delete_attachments'`,
        a.questionId,
      ).length,
    }));
    expect(stored).toMatchObject({ receipts: 0, actions: 0 });
    expect(stored.pendingJobs).toBeGreaterThan(0);
    // The desktop withdrawing its own question is not a decline and needs nothing.
    const b = await ask(w);
    expect((await act(w, w.owner, 'cancel', b.questionId, 0, { content: null })).res.status).toBe(
      201,
    );

    // Once declared, the very same signed command commits.
    await declare(w.owner, ['person-declines-v1']);
    const ok = await repost(first.signed, key);
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ status: 'cancelled', revision: 0 });

    // Retries stay idempotent after the declaration is withdrawn: the receipt, the same action id, a fresh no-op.
    await declare(w.owner, []);
    const replay = await repost(first.signed, key);
    expect(replay.status).toBe(201);
    expect(replay.json).toEqual(ok.json);
    expect((await repost(first.signed, newId())).status).toBe(200);
    expect((await act(w, phone, 'cancel', a.questionId, 0)).res.status).toBe(200);
    expect(
      (await events(w.owner)).filter((e) => e.event_type === 'decision.cancelled'),
    ).toHaveLength(2); // a's decline and b's withdrawal, once each
  });

  it("checks the Host that asked, not the owner, and lets a revoked Host's questions be declined", async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { host, world: hostWorld } = await enrollHost(w);
    await declare(w.owner, ['person-declines-v1']);
    await declare(host, ['thread-messages-v1']);
    const a = await ask(hostWorld);
    const refused = await act(w, phone, 'cancel', a.questionId, 0);
    expect(refused.res.status).toBe(409);
    expect(refused.res.json.details).toMatchObject({ required_feature: 'person-declines-v1' });
    await declare(host, ['person-declines-v1']);
    expect((await act(w, phone, 'cancel', a.questionId, 0)).res.status).toBe(201);

    // A revoked desktop is sent nothing, so there is no one to protect: its open question can still be let go.
    const b = await ask(hostWorld);
    await declare(host, []);
    await inRoom((room) =>
      room.run(`UPDATE devices SET revoked_at = ? WHERE device_id = ?`, Date.now(), host.id),
    );
    expect((await act(w, phone, 'cancel', b.questionId, 0)).res.status).toBe(201);
  });

  it('the owner desktop declines an open question for the person: signed, closed, and no answer', async () => {
    const { world: w, phone } = await setup();
    await declare(w.owner, ['owner-desktop-declines-v1']);
    const a = await ask(w);
    const pending = () =>
      inRoom((room) =>
        room.q<{ kind: string }>(
          `SELECT kind FROM scheduled_jobs WHERE question_id = ? AND status = 'pending' AND kind != 'delete_attachments'`,
          a.questionId,
        ),
      );
    expect((await pending()).length).toBeGreaterThan(0);
    const r = await act(w, w.owner, 'cancel', a.questionId, 0, { decline: true });
    expect(r.res.status).toBe(201);
    expect(r.res.json).toMatchObject({ status: 'cancelled', revision: 0 });
    expect(await pending()).toEqual([]);
    const ev = (await events(phone)).filter((e) => e.event_type === 'decision.cancelled');
    expect(ev).toHaveLength(1);
    // What makes it a decline is in the signed record, not in anything the relay adds.
    expect(ev[0]!.data).toMatchObject({
      action: 'cancel',
      provenance: null,
      deliverable: false,
      status: 'cancelled',
      record: { signer_device_id: w.owner.id, action: 'cancel', decline: true },
    });
    expect(ev[0]!.data.record.signature).toBe(r.signed.record.signature);
    const detail = (await phone.call('GET', `/api/v1/questions/${a.questionId}`)).json;
    expect(detail.status).toBe('cancelled');
    expect(detail.actions).toHaveLength(1);
    expect(detail.actions[0]).toMatchObject({ provenance: null, record: { decline: true } });
    expect((await act(w, phone, 'answer', a.questionId, 0)).res.status).toBe(409);

    // The owner desktop's plain cancel is still a withdrawal, and needs no feature.
    await declare(w.owner, []);
    const b = await ask(w);
    const withdrawn = await act(w, w.owner, 'cancel', b.questionId, 0);
    expect(withdrawn.res.status).toBe(201);
    const bEv = (await events(phone)).filter(
      (e) => e.event_type === 'decision.cancelled' && e.question_id === b.questionId,
    );
    expect(bEv).toHaveLength(1);
    expect('decline' in bEv[0]!.data.record).toBe(false);
  });

  it('first close wins: a decline is never relabelled a withdrawal, nor the other way round', async () => {
    const { world: w, phone } = await setup();
    await declare(w.owner, ['owner-desktop-declines-v1', 'person-declines-v1']);
    const stored = (qid: string) =>
      inRoom((room) =>
        room
          .q<{ record_json: string }>(`SELECT record_json FROM actions WHERE question_id = ?`, qid)
          .map((r) => JSON.parse(r.record_json) as { decline?: true; signer_device_id: string }),
      );
    const cancelled = async (qid: string) =>
      (await events(w.owner)).filter(
        (e) => e.event_type === 'decision.cancelled' && e.question_id === qid,
      );

    const declined = await ask(w);
    expect(
      (await act(w, w.owner, 'cancel', declined.questionId, 0, { decline: true })).res.status,
    ).toBe(201);
    // A closed question stays closed whatever is declared now: every retry is a no-op before any feature check.
    await declare(w.owner, []);
    expect((await act(w, w.owner, 'cancel', declined.questionId, 0)).res.status).toBe(200);
    expect((await act(w, phone, 'cancel', declined.questionId, 0)).res.status).toBe(200);
    expect(await stored(declined.questionId)).toEqual([
      expect.objectContaining({ decline: true, signer_device_id: w.owner.id }),
    ]);
    expect(await cancelled(declined.questionId)).toHaveLength(1);

    const withdrawn = await ask(w);
    expect((await act(w, w.owner, 'cancel', withdrawn.questionId, 0)).res.status).toBe(201);
    expect(
      (await act(w, w.owner, 'cancel', withdrawn.questionId, 0, { decline: true })).res.status,
    ).toBe(200);
    const kept = await stored(withdrawn.questionId);
    expect(kept).toHaveLength(1);
    expect('decline' in kept[0]!).toBe(false);
    expect(await cancelled(withdrawn.questionId)).toHaveLength(1);
  });

  it('only the owner desktop signs a decline, and only from open at the revision it saw', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { host, world: hostWorld } = await enrollHost(w);
    await declare(w.owner, ['owner-desktop-declines-v1', 'person-declines-v1']);
    await declare(host, ['owner-desktop-declines-v1', 'person-declines-v1']);
    // A Host never declines for the person: its flagged cancel is refused, and its plain one withdraws.
    const h = await ask(hostWorld);
    const byHost = await act(hostWorld, host, 'cancel', h.questionId, 0, { decline: true });
    expect(byHost.res.status).toBe(403);
    expect(byHost.res.json.code).toBe('forbidden');
    // A phone or tablet declines by its role alone, so the flag is the owner desktop's only.
    const byPhone = await act(w, phone, 'cancel', h.questionId, 0, { decline: true });
    expect(byPhone.res.status).toBe(403);
    expect((await phone.call('GET', `/api/v1/questions/${h.questionId}`)).json.status).toBe('open');
    expect((await act(hostWorld, host, 'cancel', h.questionId, 0)).res.status).toBe(201);
    // The flag means a decline on a cancel and nothing on any other action.
    const reopen = await act(w, w.owner, 'reopen', h.questionId, 0, { decline: true });
    expect(reopen.res.status).toBe(400);
    expect(reopen.res.json.code).toBe('validation_error');

    // The transition and revision checks come before the feature check, so they answer even for a desktop that
    // declares nothing: a proxy answer is withdrawn, never declined.
    const p = await ask(w, { requirement: 'proxy-ok' });
    expect((await act(w, w.owner, 'proxy-answer', p.questionId, 0)).res.status).toBe(201);
    const o = await ask(w);
    const answered = await ask(w);
    expect((await act(w, phone, 'answer', answered.questionId, 0)).res.status).toBe(201);
    await declare(w.owner, []);
    const late = await act(w, w.owner, 'cancel', p.questionId, 1, { decline: true });
    expect(late.res.status).toBe(409);
    expect(late.res.json.code).toBe('invalid_state');
    expect(late.res.json.details?.reason).toBeUndefined();
    const stale = await act(w, w.owner, 'cancel', o.questionId, 3, { decline: true });
    expect(stale.res.status).toBe(409);
    expect(stale.res.json.code).toBe('revision_conflict');
    const closed = await act(w, w.owner, 'cancel', answered.questionId, 1, { decline: true });
    expect(closed.res.status).toBe(409);
    expect(closed.res.json.code).toBe('invalid_state');
    expect(closed.res.json.details?.reason).toBeUndefined();
    // With nothing wrong but the declaration, the feature check is what refuses it.
    const undeclared = await act(w, w.owner, 'cancel', o.questionId, 0, { decline: true });
    expect(undeclared.res.json.details?.reason).toBe(CREATOR_MISSING_FEATURE);
  });

  it('refuses an owner decline until the asking desktop declares owner-desktop-declines-v1, and stores nothing', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { host, world: hostWorld } = await enrollHost(w);
    const expectRefused = (res: { status: number; json: any }) => {
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({
        code: 'invalid_state',
        details: {
          reason: CREATOR_MISSING_FEATURE,
          required_feature: 'owner-desktop-declines-v1',
        },
      });
    };
    // A desktop that only knows the phone's decline would file the owner's as a withdrawal.
    await declare(w.owner, ['owner-desktop-declines-v1']);
    await declare(host, ['person-declines-v1', 'owner-desktop-answers-v1']);
    const a = await ask(hostWorld);
    const key = newId();
    const first = await act(w, w.owner, 'cancel', a.questionId, 0, {
      decline: true,
      idempotencyKey: key,
    });
    expectRefused(first.res);
    // A GET /events declaration is not recorded and does not count.
    const polled = await host.call(
      'GET',
      '/api/v1/events',
      undefined,
      'after=0&features=owner-desktop-declines-v1&limit=100',
    );
    expect(polled.status).toBe(200);
    const repost = (idempotencyKey: string) =>
      w.owner.call('POST', `/api/v1/questions/${a.questionId}/cancel`, {
        protocol_version: PROTOCOL_VERSION,
        idempotency_key: idempotencyKey,
        action: first.signed,
      });
    expectRefused(await repost(key));
    expect((await phone.call('GET', `/api/v1/questions/${a.questionId}`)).json.status).toBe('open');
    const nothing = await inRoom((room) => ({
      receipts: room.q(`SELECT 1 FROM command_receipts WHERE idempotency_key = ?`, key).length,
      actions: room.q(`SELECT 1 FROM actions WHERE question_id = ?`, a.questionId).length,
      pendingJobs: room.q(
        `SELECT 1 FROM scheduled_jobs WHERE question_id = ? AND status = 'pending' AND kind != 'delete_attachments'`,
        a.questionId,
      ).length,
    }));
    expect(nothing).toMatchObject({ receipts: 0, actions: 0 });
    expect(nothing.pendingJobs).toBeGreaterThan(0);
    expect(
      (await events(w.owner)).filter((e) => e.event_type === 'decision.cancelled'),
    ).toHaveLength(0);

    // Once the Host that asked declares it, the very same signed command commits.
    await declare(host, ['owner-desktop-declines-v1']);
    const ok = await repost(key);
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ status: 'cancelled', revision: 0 });

    // A revoked desktop declares nothing: its questions can be withdrawn, not declined.
    const b = await ask(hostWorld);
    await inRoom((room) =>
      room.run(`UPDATE devices SET revoked_at = ? WHERE device_id = ?`, Date.now(), host.id),
    );
    expectRefused((await act(w, w.owner, 'cancel', b.questionId, 0, { decline: true })).res);
    expect((await act(w, w.owner, 'cancel', b.questionId, 0)).res.status).toBe(201);
  });

  it('a due question is expired lazily and an answer after the deadline is refused (410)', async () => {
    const { world: w, phone } = await setup();
    const a = await ask(w, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await inRoom((room) =>
      room.run(
        `UPDATE questions SET expires_at = ? WHERE question_id = ?`,
        Date.now() - 1,
        a.questionId,
      ),
    );
    const r = await act(w, phone, 'answer', a.questionId, 0);
    expect(r.res.status).toBe(410);
    const d = await phone.call('GET', `/api/v1/questions/${a.questionId}`);
    expect(d.json.status).toBe('expired');
    const evs = await events(phone);
    expect(evs.filter((e) => e.event_type === 'decision.expired')).toHaveLength(1);
    expect(evs.at(-1).data).toMatchObject({ target_host_id: 'host_aaaaaaaa' });
  });

  it('expiry never overrides an existing human answer', async () => {
    const { world: w, phone } = await setup();
    const a = await ask(w);
    await act(w, phone, 'answer', a.questionId, 0);
    await inRoom((room) =>
      room.run(
        `UPDATE questions SET expires_at = ? WHERE question_id = ?`,
        Date.now() - 1,
        a.questionId,
      ),
    );
    expect((await phone.call('GET', `/api/v1/questions/${a.questionId}`)).json.status).toBe(
      'human-answered',
    );
  });

  it('only the owner can reopen an expired question, and the new round accepts an answer', async () => {
    const { world: w, phone } = await setup();
    const a = await ask(w);
    await inRoom((room) =>
      room.run(
        `UPDATE questions SET expires_at = ? WHERE question_id = ?`,
        Date.now() - 1,
        a.questionId,
      ),
    );
    await phone.call('GET', `/api/v1/questions/${a.questionId}`);
    expect((await act(w, phone, 'reopen', a.questionId, 0, { content: null })).res.status).toBe(
      403,
    );
    const re = await act(w, w.owner, 'reopen', a.questionId, 0, {
      content: null,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(re.res.json).toMatchObject({ revision: 1, status: 'open' });
    expect((await act(w, phone, 'answer', a.questionId, 1)).res.status).toBe(201);
  });

  it('a stale cancel cannot hit a reopened question', async () => {
    const { world: w } = await setup();
    const a = await ask(w);
    await act(w, w.owner, 'cancel', a.questionId, 0, { content: null });
    await act(w, w.owner, 'reopen', a.questionId, 0, { content: null });
    expect((await act(w, w.owner, 'cancel', a.questionId, 0, { content: null })).res.status).toBe(
      409,
    );
  });
});

describe('listing and deletion', () => {
  it('lists with status filters and pagination, newest first', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const made: string[] = [];
    for (let i = 0; i < 5; i++)
      made.push((await ask(w, { originRef: `pane_list00${i}` })).questionId);
    await act(w, phone, 'answer', made[0]!, 0);
    const open = await phone.call('GET', '/api/v1/questions', undefined, 'status=open');
    expect(open.json.questions).toHaveLength(4);
    const p1 = await phone.call('GET', '/api/v1/questions', undefined, 'limit=2');
    expect(p1.json.questions).toHaveLength(2);
    expect(p1.json.next_cursor).toBeTruthy();
    const p2 = await phone.call(
      'GET',
      '/api/v1/questions',
      undefined,
      `limit=10&cursor=${p1.json.next_cursor}`,
    );
    expect(p2.json.questions).toHaveLength(3);
    const all = [...p1.json.questions, ...p2.json.questions].map((q: any) => q.question_id);
    expect(new Set(all).size).toBe(5);
  });

  it('owner deletes a question, emitting a tombstone and removing its events', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const a = await ask(w);
    await act(w, phone, 'answer', a.questionId, 0);
    expect((await phone.call('DELETE', `/api/v1/questions/${a.questionId}`)).status).toBe(403);
    expect((await w.owner.call('DELETE', `/api/v1/questions/${a.questionId}`)).status).toBe(200);
    expect((await phone.call('GET', `/api/v1/questions/${a.questionId}`)).status).toBe(404);
    const evs = await events(phone);
    expect(evs.map((e) => e.event_type)).toContain('decision.deleted');
    expect(
      evs.filter((e) => e.question_id === a.questionId && e.event_type !== 'decision.deleted'),
    ).toHaveLength(0);
  });
});

describe('event ledger', () => {
  it('pages in order with a monotonically increasing seq and a correct cursor', async () => {
    const w = await claimRelay();
    for (let i = 0; i < 7; i++) await ask(w, { originRef: `pane_ledger0${i}` });
    const p1 = await w.owner.call('GET', '/api/v1/events', undefined, 'after=0&limit=3');
    expect(p1.json.events.map((e: any) => e.seq)).toEqual([1, 2, 3]);
    expect(p1.json).toMatchObject({ has_more: true, next_after: 3, high_water_seq: 7 });
    const p2 = await w.owner.call(
      'GET',
      '/api/v1/events',
      undefined,
      `after=${p1.json.next_after}&limit=100`,
    );
    expect(p2.json.events.map((e: any) => e.seq)).toEqual([4, 5, 6, 7]);
    expect(p2.json.has_more).toBe(false);
    expect((await w.owner.call('GET', '/api/v1/events', undefined, 'after=-1')).status).toBe(400);
  });

  it('stores no plaintext anywhere in the database', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const secretMarker = 'PLAINTEXT-MARKER-7f3a';
    const a = await ask(w, {
      content: {
        content_version: 1,
        question: secretMarker,
        kind: 'text',
        options: [],
        attachments: [],
        allow_text: true,
      },
    });
    await act(w, phone, 'answer', a.questionId, 0, { content: { text: secretMarker } });
    const dump = await inRoom((room) => {
      const out: string[] = [];
      for (const t of [
        'questions',
        'actions',
        'events',
        'command_receipts',
        'deliveries',
        'meta',
        'devices',
      ]) {
        out.push(JSON.stringify(room.q(`SELECT * FROM ${t}`)));
      }
      return out.join('\n');
    });
    expect(dump).not.toContain(secretMarker);
  });
});

void buildSignedAction;
