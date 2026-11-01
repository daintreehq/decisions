import { describe, expect, it } from 'vitest';
import { ActionBody } from '@daintreehq/decisions-protocol';
import { newId } from '@daintreehq/decisions-crypto';
import {
  assertReviewable,
  buildAnswerRequest,
  highestEpoch,
  StaleQuestionError,
} from '../src/domain/answer.js';
import { QuestionStore } from '../src/domain/model.js';
import { verifyActionEvent } from '../src/domain/verify.js';
import { actionEvent, makeWorld, questionEvent } from './helpers.js';

/** Turns a request body the phone would POST into the ledger event the relay would emit for it. */
function relayEmits(body: string, status: 'human-answered' | 'proxy-answered', revision: number) {
  const parsed = ActionBody.parse(JSON.parse(body));
  return {
    action: parsed.action.record.action,
    record: parsed.action.record,
    envelope: parsed.action.envelope,
    provenance: 'human' as const,
    status,
    revision,
    target_host_id: 'host_aaaaaaaa',
    deliverable: true,
  };
}

describe('building human answers', () => {
  it('produces a request that the verification pipeline accepts end to end', async () => {
    const w = await makeWorld();
    const s = new QuestionStore({
      installationId: w.installationId,
      trust: w.trust,
      epochKeys: () => w.epochs,
    });
    const q = await questionEvent(w);
    await s.ingest(q);
    const view = s.get(q.question_id!)!;
    const req = await buildAnswerRequest({
      installationId: w.installationId,
      deviceId: w.phone.id,
      signingKey: w.phone.keys.signing.privateKey,
      epochKey: highestEpoch(w.epochs),
      view,
      kind: 'answer',
      expectedRevision: 0,
      selected: ['no'],
      text: 'keep the shortcuts',
      reviewedDigests: ['a'.repeat(64)],
    });
    expect(req.path).toBe(`/questions/${q.question_id}/answer`);
    expect(req.expectedRevision).toBe(0);
    const body = ActionBody.parse(JSON.parse(req.bodyText));
    expect(body.idempotency_key).toBe(req.idempotencyKey);
    expect(body.action.record.expected_revision).toBe(0);
    // The relay never sees the answer in the clear.
    expect(req.bodyText).not.toContain('keep the shortcuts');

    const r = await verifyActionEvent(
      relayEmits(req.bodyText, 'human-answered', 1),
      new Date().toISOString(),
      {
        installationId: w.installationId,
        trust: w.trust,
        epochKeys: w.epochs,
      },
      q.question_id!,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.provenance).toBe('human');
      expect(r.value.content).toMatchObject({
        selected_option_ids: ['no'],
        text: 'keep the shortcuts',
        reviewed_attachment_digests: ['a'.repeat(64)],
      });
    }
  });

  it('is deterministic once built: the same body is what every retry sends', async () => {
    const w = await makeWorld();
    const s = new QuestionStore({
      installationId: w.installationId,
      trust: w.trust,
      epochKeys: () => w.epochs,
    });
    const q = await questionEvent(w);
    await s.ingest(q);
    const req = await buildAnswerRequest({
      installationId: w.installationId,
      deviceId: w.phone.id,
      signingKey: w.phone.keys.signing.privateKey,
      epochKey: highestEpoch(w.epochs),
      view: s.get(q.question_id!)!,
      kind: 'answer',
      expectedRevision: 0,
      selected: ['yes'],
      reviewedDigests: [],
      idempotencyKey: 'fixedkey1234',
    });
    expect(req.idempotencyKey).toBe('fixedkey1234');
    expect(typeof req.bodyText).toBe('string');
  });

  it('builds an override at the current revision with a reason, and a confirm that targets the proxy action', async () => {
    const w = await makeWorld();
    const s = new QuestionStore({
      installationId: w.installationId,
      trust: w.trust,
      epochKeys: () => w.epochs,
    });
    const q = await questionEvent(w, { requirement: 'proxy-ok' });
    await s.ingest(q);
    const proxyEv = await actionEvent(w, { questionId: q.question_id!, action: 'proxy-answer' });
    await s.ingest(proxyEv);
    const view = s.get(q.question_id!)!;
    const common = {
      expectedRevision: 1,
      installationId: w.installationId,
      deviceId: w.phone.id,
      signingKey: w.phone.keys.signing.privateKey,
      epochKey: highestEpoch(w.epochs),
      view,
      selected: ['no'],
      reviewedDigests: [] as string[],
    };

    const o = await buildAnswerRequest({
      ...common,
      kind: 'override',
      reason: 'proxy missed the constraint',
    });
    const ob = ActionBody.parse(JSON.parse(o.bodyText));
    expect(ob.action.record).toMatchObject({ action: 'override', expected_revision: 1 });

    const c = await buildAnswerRequest({ ...common, kind: 'confirm-proxy' });
    const cb = ActionBody.parse(JSON.parse(c.bodyText));
    expect(cb.action.record.confirms_action_id).toBe(
      (proxyEv.data as { record: { action_id: string } }).record.action_id,
    );
    expect(cb.action.envelope).toBeNull();
  });

  it('refuses to confirm when there is no verified proxy answer', async () => {
    const w = await makeWorld();
    const s = new QuestionStore({
      installationId: w.installationId,
      trust: w.trust,
      epochKeys: () => w.epochs,
    });
    const q = await questionEvent(w);
    await s.ingest(q);
    await expect(
      buildAnswerRequest({
        installationId: w.installationId,
        deviceId: w.phone.id,
        signingKey: w.phone.keys.signing.privateKey,
        epochKey: highestEpoch(w.epochs),
        view: s.get(q.question_id!)!,
        kind: 'confirm-proxy',
        expectedRevision: 0,
        selected: [],
        reviewedDigests: [],
      }),
    ).rejects.toThrow(/changed/);
    expect(() => highestEpoch(new Map())).toThrow(/no content key/);
    expect(newId()).toHaveLength(32);
  });
});

describe('signing only what the human reviewed', () => {
  it('signs the revision the human saw even though the live view has moved on', async () => {
    const w = await makeWorld();
    const s = new QuestionStore({
      installationId: w.installationId,
      trust: w.trust,
      epochKeys: () => w.epochs,
    });
    const q = await questionEvent(w);
    await s.ingest(q);
    await s.ingest(await actionEvent(w, { questionId: q.question_id!, action: 'answer' }));
    const view = s.get(q.question_id!)!; // the live object: revision 1
    const reviewed = view.revision;
    // The human opens "overrule" at revision 1. Meanwhile another phone's override lands (revision 2) in the same object.
    await s.ingest(
      await actionEvent(w, { questionId: q.question_id!, action: 'override', expectedRevision: 1 }),
    );
    expect(view.revision).toBe(2);
    expect(() => assertReviewable(view, reviewed, 'override')).toThrow(StaleQuestionError);
    await expect(
      buildAnswerRequest({
        installationId: w.installationId,
        deviceId: w.phone.id,
        signingKey: w.phone.keys.signing.privateKey,
        epochKey: highestEpoch(w.epochs),
        view,
        kind: 'override',
        expectedRevision: reviewed,
        selected: ['no'],
        reason: 'stale',
        reviewedDigests: [],
      }),
    ).rejects.toBeInstanceOf(StaleQuestionError);
  });

  it('signs exactly the reviewed revision when it is still current', async () => {
    const w = await makeWorld();
    const s = new QuestionStore({
      installationId: w.installationId,
      trust: w.trust,
      epochKeys: () => w.epochs,
    });
    const q = await questionEvent(w);
    await s.ingest(q);
    await s.ingest(await actionEvent(w, { questionId: q.question_id!, action: 'answer' }));
    const view = s.get(q.question_id!)!;
    const req = await buildAnswerRequest({
      installationId: w.installationId,
      deviceId: w.phone.id,
      signingKey: w.phone.keys.signing.privateKey,
      epochKey: highestEpoch(w.epochs),
      view,
      kind: 'override',
      expectedRevision: 1,
      selected: ['no'],
      reason: 'changed my mind',
      reviewedDigests: [],
    });
    expect(req.expectedRevision).toBe(1);
    expect(ActionBody.parse(JSON.parse(req.bodyText)).action.record.expected_revision).toBe(1);
  });

  it('refuses an answer when the question is no longer open, or an override when it is', async () => {
    const w = await makeWorld();
    const s = new QuestionStore({
      installationId: w.installationId,
      trust: w.trust,
      epochKeys: () => w.epochs,
    });
    const q = await questionEvent(w);
    await s.ingest(q);
    const view = s.get(q.question_id!)!;
    expect(() => assertReviewable(view, 0, 'answer')).not.toThrow();
    expect(() => assertReviewable(view, 0, 'override')).toThrow(StaleQuestionError);
    await s.ingest(await actionEvent(w, { questionId: q.question_id!, action: 'cancel' }));
    expect(() => assertReviewable(view, 0, 'answer')).toThrow(StaleQuestionError);
  });
});
