import { describe, expect, it } from 'vitest';
import { ActionBody } from '@daintree/decisions-protocol';
import { newId } from '@daintree/decisions-crypto';
import { buildAnswerRequest, highestEpoch } from '../src/domain/answer.js';
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
        selected: [],
        reviewedDigests: [],
      }),
    ).rejects.toThrow(/no verified proxy/);
    expect(() => highestEpoch(new Map())).toThrow(/no content key/);
    expect(newId()).toHaveLength(32);
  });
});
