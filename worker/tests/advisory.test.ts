import { describe, expect, it } from 'vitest';
import {
  EventData,
  PROTOCOL_VERSION,
  QuestionDetail,
  applyRoundEvent,
  replyModeOf,
  type RoundState,
} from '@daintreehq/decisions-protocol';
import {
  ADVISORY_QUESTION_FIXTURE,
  Legacy080Question,
  legacyDesktopCatchUp,
  legacyPhoneCatchUp,
} from '@daintreehq/decisions-protocol/fixtures';
import { buildSignedAction, encryptEnvelope, newId } from '@daintreehq/decisions-crypto';
import { act, ask, claimRelay, events, inRoom, pairDevice, raw, type World } from './helpers.js';

/*
 * Advisory questions at the relay (docs/protocol.md section 21): it admits the signed shape, keeps the plan
 * encrypted, expires the advisory round at revision 0 like any other, and refuses what the round table refuses.
 */

const PLAN = ADVISORY_QUESTION_FIXTURE.content.planned_fallback;
const soon = (ms = 15 * 60_000) => new Date(Date.now() + ms).toISOString();

async function setup() {
  const w = await claimRelay();
  return { w, phone: await pairDevice(w) };
}

const askAdvisory = (w: World, o: Parameters<typeof ask>[1] = {}) =>
  ask(w, {
    replyMode: 'advisory',
    expiresAt: soon(),
    content: { ...ADVISORY_QUESTION_FIXTURE.content },
    ...o,
  });

/** Makes the question's deadline due now, as the existing expiry tests do. */
const makeDue = (questionId: string) =>
  inRoom((room) =>
    room.run(
      `UPDATE questions SET expires_at = ? WHERE question_id = ?`,
      Date.now() - 1,
      questionId,
    ),
  );

describe('advisory questions (section 21)', () => {
  it('admits a signed advisory create and serves it back unchanged, with the plan encrypted', async () => {
    const { w, phone } = await setup();
    const a = await askAdvisory(w);
    expect(a.res.status).toBe(201);
    expect(a.res.json).toMatchObject({ question_id: a.questionId, revision: 0, status: 'open' });

    const d = await phone.call('GET', `/api/v1/questions/${a.questionId}`);
    const detail = QuestionDetail.parse(d.json);
    expect(replyModeOf(detail.question.envelope)).toBe('advisory');
    expect(detail.question.record.expires_at).toBe(a.question.record.expires_at);
    expect(detail.question.envelope).toEqual(a.question.envelope);

    const created = (await events(phone)).find((e) => e.event_type === 'decision.created');
    const data = EventData.created.parse(created.data);
    expect(replyModeOf(data.envelope)).toBe('advisory');

    // Nothing the relay stores or serves holds the plan in the clear.
    const stored = await inRoom((room) =>
      room.q1<{ record_json: string; envelope_json: string }>(
        `SELECT record_json, envelope_json FROM questions WHERE question_id = ?`,
        a.questionId,
      ),
    );
    expect(JSON.stringify(stored)).not.toContain(PLAN);
    expect(d.text).not.toContain(PLAN);
  });

  it('refuses an advisory create without a finite deadline or under a gate', async () => {
    const { w } = await setup();
    const noDeadline = await askAdvisory(w, { expiresAt: null });
    expect(noDeadline.res.status).toBe(400);
    expect(noDeadline.res.json.code).toBe('validation_error');
    const gated = await askAdvisory(w, { workflowGateIdHash: 'b'.repeat(64) });
    expect(gated.res.status).toBe(400);
    expect(gated.res.json.code).toBe('validation_error');
    // The same blocking questions are fine.
    expect((await ask(w, { expiresAt: null })).res.status).toBe(201);
    expect((await ask(w, { workflowGateIdHash: 'b'.repeat(64) })).res.status).toBe(201);
  });

  it('refuses the advisory mode on any envelope but a question create', async () => {
    const { w, phone } = await setup();
    const a = await askAdvisory(w);
    const envelope = await encryptEnvelope({
      epochKey: phone.epoch ?? w.epoch,
      installationId: w.installationId,
      questionId: a.questionId,
      recordId: newId(),
      recordType: 'answer',
      revision: 1,
      senderDeviceId: phone.id,
      purpose: 'answer-content',
      replyMode: 'advisory',
      plaintext: { selected_option_ids: ['memory'] },
    });
    const signed = await buildSignedAction({
      installationId: w.installationId,
      questionId: a.questionId,
      action: 'answer',
      signerDeviceId: phone.id,
      signingKey: phone.keys.signing.privateKey,
      expectedRevision: 0,
      envelope,
    });
    const res = await phone.call('POST', `/api/v1/questions/${a.questionId}/answer`, {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(),
      action: signed,
    });
    expect(res.status).toBe(400);
    expect((await phone.call('GET', `/api/v1/questions/${a.questionId}`)).json.status).toBe('open');
  });

  it('a timely answer wins; the deadline then changes nothing', async () => {
    const { w, phone } = await setup();
    const a = await askAdvisory(w);
    const r = await act(w, phone, 'answer', a.questionId, 0, {
      content: { selected_option_ids: ['sqlite'] },
    });
    expect(r.res.status).toBe(201);
    await makeDue(a.questionId);
    const d = await phone.call('GET', `/api/v1/questions/${a.questionId}`);
    expect(d.json).toMatchObject({ status: 'human-answered', revision: 1 });
    expect((await events(phone)).map((e) => e.event_type)).not.toContain('decision.expired');
  });

  it('expires the unanswered advisory round at revision 0 with no answer, and refuses a late answer', async () => {
    const { w, phone } = await setup();
    const a = await askAdvisory(w);
    await makeDue(a.questionId);
    const late = await act(w, phone, 'answer', a.questionId, 0, {
      content: { selected_option_ids: ['sqlite'] },
    });
    expect(late.res.status).toBe(410);
    expect(late.res.json.code).toBe('expired');

    const d = await phone.call('GET', `/api/v1/questions/${a.questionId}`);
    expect(d.json).toMatchObject({ status: 'expired', revision: 0 });
    expect(d.json.actions).toEqual([]);
    const expired = (await events(phone)).filter((e) => e.event_type === 'decision.expired');
    expect(expired).toHaveLength(1);
    expect(expired[0].question_revision).toBe(0);
    expect(EventData.expired.parse(expired[0].data)).not.toHaveProperty('provenance');

    // The relay agrees with the round table: a late answer meets the deadline and is refused.
    const start: RoundState = {
      status: 'open',
      revision: 0,
      requirement: 'human-required',
      proxyAbstained: false,
      expiresAt: Date.now() - 1,
      advisory: true,
    };
    const tr = applyRoundEvent(start, {
      type: 'action',
      action: 'answer',
      role: 'phone',
      expectedRevision: 0,
      at: Date.now(),
    });
    expect(tr).toMatchObject({ outcome: 'advisory-unanswered', fallbackDue: true });
    expect(tr.refusal?.code).toBe('expired');
    expect(tr.state).toMatchObject({ status: d.json.status, revision: d.json.revision });

    // A late dismissal finds the round closed.
    expect((await act(w, phone, 'cancel', a.questionId, 0, { content: null })).res.status).toBe(
      409,
    );
  });

  it('a reopen opens a blocking round at revision 1', async () => {
    const { w, phone } = await setup();
    const a = await askAdvisory(w);
    await makeDue(a.questionId);
    await phone.call('GET', `/api/v1/questions/${a.questionId}`);
    const re = await act(w, w.owner, 'reopen', a.questionId, 0, {
      content: null,
      expiresAt: soon(60 * 60_000),
    });
    expect(re.res.json).toMatchObject({ revision: 1, status: 'open' });
    // An answer signed for the first round conflicts with the new one.
    const stale = await act(w, phone, 'answer', a.questionId, 0, {
      content: { selected_option_ids: ['sqlite'] },
    });
    expect(stale.res.status).toBe(409);
    expect(stale.res.json.code).toBe('revision_conflict');
    await makeDue(a.questionId);
    await phone.call('GET', `/api/v1/questions/${a.questionId}`);
    const expired = (await events(phone)).filter((e) => e.event_type === 'decision.expired');
    expect(expired.map((e) => e.question_revision)).toEqual([0, 1]);
  });

  it('a 0.3.0 client reads straight past an advisory question; a 0.8.0 reader refuses only that one', async () => {
    const { w, phone } = await setup();
    const a = await askAdvisory(w);
    const b = await ask(w);
    const page = (after: number) =>
      phone
        .call('GET', '/api/v1/events', undefined, `after=${after}&limit=100`)
        .then((r) => r.json);
    const desk = await legacyDesktopCatchUp(page);
    const tel = await legacyPhoneCatchUp(page);
    for (const run of [desk, tel]) {
      expect(run.events.filter((e) => e.event_type === 'decision.created')).toHaveLength(2);
    }
    const byId = new Map(desk.events.map((e) => [e.question_id, e]));
    expect(Legacy080Question.CreatedEventData.safeParse(byId.get(a.questionId)!.data).success).toBe(
      false,
    );
    expect(Legacy080Question.CreatedEventData.safeParse(byId.get(b.questionId)!.data).success).toBe(
      true,
    );
  });

  it('advertises the extension', async () => {
    expect((await raw('GET', '/api/v1/info')).json.features).toContain('advisory-deadlines-v1');
  });
});
