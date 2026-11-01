import { describe, expect, it, vi } from 'vitest';
import { QuestionStore } from '../src/domain/model.js';
import { TrustStore } from '../src/domain/trust.js';
import {
  currentAnswer,
  deliveryProgress,
  effectiveStatus,
  needsYou,
  proxyNeedsReview,
  sortNeedsYou,
  submitKind,
} from '../src/domain/selectors.js';
import { actionEvent, makeWorld, plainEvent, questionEvent, type World } from './helpers.js';

const store = (w: World, extra: Partial<ConstructorParameters<typeof QuestionStore>[0]> = {}) =>
  new QuestionStore({
    installationId: w.installationId,
    trust: w.trust,
    epochKeys: () => w.epochs,
    ...extra,
  });

describe('question store', () => {
  it('builds a verified view and moves through answered', async () => {
    const w = await makeWorld();
    const s = store(w);
    const q = await questionEvent(w);
    await s.ingest(q);
    const id = q.question_id!;
    expect(s.get(id)).toMatchObject({ status: 'open', revision: 0, requirement: 'human-required' });
    expect(needsYou(s.get(id)!)).toBe(true);
    expect(submitKind(s.get(id)!)).toBe('answer');

    await s.ingest(await actionEvent(w, { questionId: id, action: 'answer' }));
    const v = s.get(id)!;
    expect(v).toMatchObject({ status: 'human-answered', revision: 1 });
    expect(currentAnswer(v)?.content).toMatchObject({ text: 'go ahead' });
    expect(needsYou(v)).toBe(false);
    expect(submitKind(v)).toBe('override');
  });

  it('is idempotent for duplicate events', async () => {
    const w = await makeWorld();
    const s = store(w);
    const q = await questionEvent(w);
    await s.ingest(q);
    await s.ingest(q);
    const a = await actionEvent(w, { questionId: q.question_id!, action: 'answer' });
    await s.ingest(a);
    await s.ingest(a);
    expect(s.list()).toHaveLength(1);
    expect(s.get(q.question_id!)!.actions).toHaveLength(1);
  });

  it('never presents a forged answer as a decision', async () => {
    const w = await makeWorld();
    const s = store(w);
    const q = await questionEvent(w);
    await s.ingest(q);
    // The relay claims a human answered, but the desktop signed it.
    await s.ingest(
      await actionEvent(w, { questionId: q.question_id!, action: 'answer', signer: w.desktop }),
    );
    const v = s.get(q.question_id!)!;
    expect(effectiveStatus(v)).toBe('unverified');
    expect(currentAnswer(v)).toBeNull();
    expect(needsYou(v)).toBe(false);
    expect(v.integrityIssues[0]).toMatch(/cannot sign answer/);
  });

  it('shows an unverifiable question as unverified with no content', async () => {
    const w = await makeWorld();
    const s = store(w);
    const q = await questionEvent(w, { signer: w.phone });
    await s.ingest(q);
    const v = s.get(q.question_id!)!;
    expect(v.content).toBeNull();
    expect(effectiveStatus(v)).toBe('unverified');
  });

  it('handles proxy answer, confirm and human override', async () => {
    const w = await makeWorld();
    const s = store(w);
    const q = await questionEvent(w, { requirement: 'proxy-ok' });
    await s.ingest(q);
    const id = q.question_id!;
    await s.ingest(await actionEvent(w, { questionId: id, action: 'proxy-answer' }));
    let v = s.get(id)!;
    expect(effectiveStatus(v)).toBe('proxy-answered');
    expect(currentAnswer(v)?.provenance).toBe('proxy');
    expect(proxyNeedsReview(v)).toBe(true);

    await s.ingest(
      await actionEvent(w, {
        questionId: id,
        action: 'override',
        expectedRevision: 1,
        plaintext: {
          content_version: 1,
          selected_option_ids: ['no'],
          reason: 'wrong call',
          reviewed_attachment_digests: [],
        },
      }),
    );
    v = s.get(id)!;
    expect(v.revision).toBe(2);
    expect(currentAnswer(v)).toMatchObject({ provenance: 'human', action: 'override' });
    expect(proxyNeedsReview(v)).toBe(false);
  });

  it('believes the relay’s expiry event only after the signed deadline has passed', async () => {
    const w = await makeWorld();
    const s = store(w);
    const past = new Date(Date.now() - 1000).toISOString();
    const q = await questionEvent(w, { expiresAt: past });
    await s.ingest(q);
    expect(effectiveStatus(s.get(q.question_id!)!)).toBe('expired'); // from the signed deadline alone
    expect(submitKind(s.get(q.question_id!)!)).toBeNull();
    await s.ingest(
      plainEvent('decision.expired', q.question_id, {
        expired_at: new Date().toISOString(),
        target_host_id: 'host_aaaaaaaa',
      }),
    );
    expect(s.get(q.question_id!)!.status).toBe('expired');

    // No signed deadline, or one still in the future: a relay "expired" claim changes nothing.
    const never = await questionEvent(w);
    const future = await questionEvent(w, {
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await s.ingestAll([never, future]);
    for (const e of [never, future]) {
      await s.ingest(
        plainEvent('decision.expired', e.question_id, {
          expired_at: new Date().toISOString(),
          target_host_id: 'host_aaaaaaaa',
        }),
      );
      expect(s.get(e.question_id!)!.status).toBe('open');
      expect(s.get(e.question_id!)!.integrityIssues.join()).toMatch(/before the signed deadline/);
    }
  });

  it('removes deleted questions and tracks cancellation', async () => {
    const w = await makeWorld();
    const s = store(w);
    const a = await questionEvent(w);
    const b = await questionEvent(w);
    await s.ingestAll([a, b]);
    await s.ingest(await actionEvent(w, { questionId: a.question_id!, action: 'cancel' }));
    expect(s.get(a.question_id!)!.status).toBe('cancelled');
    await s.ingest(plainEvent('decision.deleted', b.question_id, { question_id: b.question_id }));
    expect(s.get(b.question_id!)).toBeUndefined();
  });

  it('refreshes devices once when it meets an unknown signer', async () => {
    const w = await makeWorld();
    // This viewer only knows the owner; the refresh callback teaches it about the phone.
    const trust = await TrustStore.create(w.installationId, w.owner.cert);
    const refresh = vi.fn(async () => {
      await trust.addCert(w.phone.cert, null);
    });
    const s = new QuestionStore({
      installationId: w.installationId,
      trust,
      epochKeys: () => w.epochs,
      refreshDevices: refresh,
    });
    const q = await questionEvent(w);
    await s.ingest(q);
    expect(refresh).not.toHaveBeenCalled(); // the owner desktop was already trusted
    await s.ingest(await actionEvent(w, { questionId: q.question_id!, action: 'answer' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(effectiveStatus(s.get(q.question_id!)!)).toBe('human-answered');
  });

  it('applies device events: approval adds a cert, revocation closes the door', async () => {
    const w = await makeWorld();
    const trust = await TrustStore.create(w.installationId, w.owner.cert);
    const s = new QuestionStore({
      installationId: w.installationId,
      trust,
      epochKeys: () => w.epochs,
    });
    await s.ingest(plainEvent('device.approved', null, { cert: w.phone.cert }));
    expect(trust.get(w.phone.id)?.role).toBe('phone');
    await s.ingest(
      plainEvent(
        'device.revoked',
        null,
        { device_id: w.phone.id, key_epoch: 2 },
        { occurred_at: '2026-11-01T10:00:00.000Z' },
      ),
    );
    expect(trust.get(w.phone.id)?.revokedAt).toBe('2026-11-01T10:00:00.000Z');
  });

  it('reports delivery progress from receipts, terminal delivery and attention events', async () => {
    const w = await makeWorld();
    const s = store(w);
    const q = await questionEvent(w);
    const id = q.question_id!;
    await s.ingest(q);
    const ans = await actionEvent(w, { questionId: id, action: 'answer' });
    await s.ingest(ans);
    const v = () => s.get(id)!;
    expect(deliveryProgress(v(), s, 'queued')?.step).toBe('queued');
    expect(deliveryProgress(v(), s)?.step).toBe('confirmed');
    await s.ingest(
      plainEvent('delivery.received', null, { up_to_seq: ans.seq, device_id: w.owner.id }),
    );
    expect(deliveryProgress(v(), s)?.step).toBe('desktop');
    await s.ingest(
      plainEvent('delivery.terminal_delivered', id, {
        answer_revision: 1,
        target_host_id: 'host_aaaaaaaa',
        injection_id: 'inj_aaaaaaaa',
      }),
    );
    expect(deliveryProgress(v(), s)?.step).toBe('terminal');
    await s.ingest(
      plainEvent('delivery.needs_attention', id, {
        answer_revision: 1,
        target_host_id: 'host_aaaaaaaa',
        status: 'needs-attention',
        error_code: 'pane_gone',
      }),
    );
    expect(deliveryProgress(v(), s)).toMatchObject({ step: 'attention', detail: 'pane_gone' });
  });

  it('rebuild re-verifies from scratch with new keys', async () => {
    const w = await makeWorld();
    let keys = new Map<number, typeof w.epochs extends Map<number, infer V> ? V : never>();
    const s = new QuestionStore({
      installationId: w.installationId,
      trust: w.trust,
      epochKeys: () => keys,
    });
    const q = await questionEvent(w);
    await s.ingest(q);
    expect(s.get(q.question_id!)!.verification.ok).toBe(false); // no key for this epoch yet
    keys = w.epochs;
    await s.rebuild([q]);
    expect(s.get(q.question_id!)!.verification.ok).toBe(true);
  });
});

describe('needs-you ordering', () => {
  it('puts soon-expiring questions first, then oldest first; newest on request', async () => {
    const w = await makeWorld();
    const s = store(w);
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const a = await questionEvent(w, { content: { question: 'old' } });
    await new Promise((r) => setTimeout(r, 5));
    const b = await questionEvent(w, { content: { question: 'urgent' }, expiresAt: soon });
    await new Promise((r) => setTimeout(r, 5));
    const c = await questionEvent(w, { content: { question: 'new' } });
    await s.ingestAll([a, b, c]);
    const list = s.list();
    const names = (l: typeof list) => l.map((v) => v.content?.question);
    expect(names(sortNeedsYou(list, false, Date.now()))).toEqual(['urgent', 'old', 'new']);
    expect(names(sortNeedsYou(list, true, Date.now()))).toEqual(['new', 'urgent', 'old']);
  });
});

describe('the store never lets the relay re-home signed content', () => {
  it('ignores question A’s signed content filed under question B’s id', async () => {
    const w = await makeWorld();
    const s = store(w);
    const a = await questionEvent(w, { content: { question: 'Deploy to production?' } });
    const b = await questionEvent(w, { content: { question: 'Rename the tab?' } });
    await s.ingest(b);
    // Malicious relay: A's valid record + envelope, labelled as B.
    await s.ingest({
      ...a,
      seq: a.seq + 1000,
      event_id: 'evil_event_aaaaaaaa',
      question_id: b.question_id,
    });
    const v = s.get(b.question_id!)!;
    expect(v.content?.question).toBe('Rename the tab?');
    expect(v.integrityIssues.join()).toMatch(/duplicate question event ignored/);
    expect(s.list()).toHaveLength(1);
  });

  it('shows an unknown id as unverified with none of A’s content', async () => {
    const w = await makeWorld();
    const s = store(w);
    const a = await questionEvent(w, { content: { question: 'Deploy to production?' } });
    await s.ingest({ ...a, question_id: 'victim_question_01' });
    const v = s.get('victim_question_01')!;
    expect(v.content).toBeNull();
    expect(v.verification).toEqual({
      ok: false,
      reason: 'question id does not match the signed record',
    });
    expect(effectiveStatus(v)).toBe('unverified');
    expect(submitKind(v)).toBeNull();
  });

  it('does not let an answer for A mark B answered', async () => {
    const w = await makeWorld();
    const s = store(w);
    const a = await questionEvent(w);
    const b = await questionEvent(w);
    await s.ingestAll([a, b]);
    const forA = await actionEvent(w, { questionId: a.question_id!, action: 'answer' });
    await s.ingest({ ...forA, question_id: b.question_id });
    const vb = s.get(b.question_id!)!;
    expect(vb.status).toBe('open');
    expect(vb.revision).toBe(0);
    expect(currentAnswer(vb)).toBeNull();
    expect(vb.actions[0]).toMatchObject({ verified: false });
    expect(effectiveStatus(vb)).toBe('unverified');
  });
});

describe('trusted state comes only from verified, legal transitions', () => {
  const setup = async (requirement: 'human-required' | 'proxy-ok' = 'proxy-ok') => {
    const w = await makeWorld();
    const s = store(w);
    const q = await questionEvent(w, { requirement });
    await s.ingest(q);
    return { w, s, id: q.question_id! };
  };

  it('ignores the relay’s unsigned status on a genuine proxy answer', async () => {
    const { w, s, id } = await setup();
    await s.ingest(
      await actionEvent(w, { questionId: id, action: 'proxy-answer', status: 'human-answered' }),
    );
    const v = s.get(id)!;
    expect(v.status).toBe('proxy-answered');
    expect(effectiveStatus(v)).toBe('proxy-answered');
    expect(proxyNeedsReview(v)).toBe(true);
    expect(v.integrityIssues.join()).toMatch(/differ from the verified transition/);
  });

  it('a confirm-proxy with a bad signature changes nothing, whatever status the relay claims', async () => {
    const { w, s, id } = await setup();
    const proxy = await actionEvent(w, { questionId: id, action: 'proxy-answer' });
    await s.ingest(proxy);
    const proxyId = (proxy.data as { record: { action_id: string } }).record.action_id;
    const forged = await actionEvent(w, {
      questionId: id,
      action: 'confirm-proxy',
      expectedRevision: 1,
      confirms: proxyId,
      status: 'human-answered',
    });
    (forged.data as { record: { signature: string } }).record.signature = 'A'.repeat(86);
    await s.ingest(forged);
    const v = s.get(id)!;
    expect(v.status).toBe('proxy-answered');
    expect(v.revision).toBe(1);
    expect(proxyNeedsReview(v)).toBe(true);
    expect(v.actions.at(-1)).toMatchObject({ action: 'confirm-proxy', verified: false });
  });

  it('confirm-proxy must reference the latest proxy action', async () => {
    const { w, s, id } = await setup();
    const proxy = await actionEvent(w, { questionId: id, action: 'proxy-answer' });
    await s.ingest(proxy);
    await s.ingest(
      await actionEvent(w, {
        questionId: id,
        action: 'confirm-proxy',
        expectedRevision: 1,
        confirms: 'someother_action_id',
      }),
    );
    expect(s.get(id)!.status).toBe('proxy-answered');
    expect(s.get(id)!.actions.at(-1)).toMatchObject({
      verified: false,
      error: expect.stringMatching(/latest/),
    });

    const latest = (proxy.data as { record: { action_id: string } }).record.action_id;
    await s.ingest(
      await actionEvent(w, {
        questionId: id,
        action: 'confirm-proxy',
        expectedRevision: 1,
        confirms: latest,
      }),
    );
    expect(s.get(id)).toMatchObject({ status: 'human-answered', revision: 2 });
  });

  it('a proxy can never answer a human-required question, even with a valid desktop signature', async () => {
    const { w, s, id } = await setup('human-required');
    await s.ingest(
      await actionEvent(w, { questionId: id, action: 'proxy-answer', status: 'proxy-answered' }),
    );
    const v = s.get(id)!;
    expect(v).toMatchObject({ status: 'open', revision: 0 });
    expect(currentAnswer(v)).toBeNull();
    expect(effectiveStatus(v)).toBe('unverified');
    expect(needsYou(v)).toBe(false);
  });

  it('rejects stale and illegal transitions and leaves state untouched', async () => {
    const { w, s, id } = await setup('human-required');
    await s.ingest(await actionEvent(w, { questionId: id, action: 'answer', expectedRevision: 5 })); // stale revision
    expect(s.get(id)).toMatchObject({ status: 'open', revision: 0 });
    await s.ingest(
      await actionEvent(w, { questionId: id, action: 'override', expectedRevision: 0 }),
    ); // nothing to override
    expect(s.get(id)).toMatchObject({ status: 'open', revision: 0 });
    await s.ingest(await actionEvent(w, { questionId: id, action: 'reopen', expectedRevision: 0 })); // not cancelled
    expect(s.get(id)).toMatchObject({ status: 'open', revision: 0 });
    expect(s.get(id)!.actions.every((a) => !a.verified)).toBe(true);
  });

  it('does not apply any action to a question that failed verification', async () => {
    const w = await makeWorld();
    const s = store(w);
    const bad = await questionEvent(w, { signer: w.phone });
    await s.ingest(bad);
    await s.ingest(await actionEvent(w, { questionId: bad.question_id!, action: 'answer' }));
    const v = s.get(bad.question_id!)!;
    expect(v.status).toBe('open');
    expect(v.actions[0]).toMatchObject({
      verified: false,
      error: expect.stringMatching(/question itself/),
    });
  });
});
