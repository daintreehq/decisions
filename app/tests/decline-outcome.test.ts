import { describe, expect, it } from 'vitest';
import { CREATOR_MISSING_FEATURE, type LedgerEvent } from '@daintreehq/decisions-protocol';
import { buildSignedAction, newId } from '@daintreehq/decisions-crypto';
import type { OutboxEntry } from '../src/data/outbox.js';
import { declineSettlement, declineStanding } from '../src/domain/decline.js';
import { QuestionStore } from '../src/domain/model.js';
import {
  actionEvent,
  makeWorld,
  otherHuman,
  plainEvent,
  questionEvent,
  type Actor,
  type World,
} from './helpers.js';

/** A decline from the phone at revision 0 as the outbox keeps it. */
function entry(questionId: string, o: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: newId(),
    createdAt: Date.now(),
    questionId,
    kind: 'decline',
    recordId: newId(),
    path: `/questions/${questionId}/cancel`,
    bodyText: '{}',
    idempotencyKey: newId(),
    expectedRevision: 0,
    selected: [],
    text: '',
    reason: '',
    state: 'queued',
    attempts: 0,
    ...o,
  };
}

/** A `decision.cancelled` carrying a cancel signed by `signer` with the action id given. */
async function cancelWithId(
  w: World,
  questionId: string,
  actionId: string,
  signer: Actor,
  revision = 0,
  tamper = false,
): Promise<LedgerEvent> {
  const a = await buildSignedAction({
    installationId: w.installationId,
    questionId,
    action: 'cancel',
    signerDeviceId: signer.id,
    signingKey: signer.keys.signing.privateKey,
    expectedRevision: revision,
    envelope: null,
    actionId,
  });
  const record = tamper
    ? { ...a.record, signature: a.record.signature.slice(0, -4) + 'AAAA' }
    : a.record;
  return plainEvent(
    'decision.cancelled',
    questionId,
    {
      action: 'cancel',
      record,
      envelope: null,
      provenance: null,
      status: 'cancelled',
      revision,
      target_host_id: 'host_aaaaaaaa',
      deliverable: false,
    },
    { question_revision: revision, origin_device_id: signer.id },
  );
}

async function setup() {
  const w = await makeWorld({ ownerLabel: 'Studio Mac' });
  const s = new QuestionStore({
    installationId: w.installationId,
    trust: w.trust,
    epochKeys: () => w.epochs,
  });
  const q = await questionEvent(w);
  await s.ingest(q);
  const id = q.question_id!;
  return { w, s, id, view: () => s.get(id)! };
}

describe('how a dismissal from this device settled (docs/protocol.md section 6.1)', () => {
  it('is on its way, and only on this device, until the relay has answered', async () => {
    const { w, id, view } = await setup();
    const e = entry(id);
    expect(declineStanding(e, view(), w.phone.id)).toEqual({ kind: 'queued' });
    // Sent before, its answer lost: the relay may have it, so it is never shown as unsent.
    expect(declineStanding({ ...e, attempts: 1 }, view(), w.phone.id)).toEqual({
      kind: 'unconfirmed',
    });
    expect(declineStanding({ ...e, state: 'sending', attempts: 1 }, view(), w.phone.id)).toEqual({
      kind: 'sending',
    });
    // The relay answered, but the thread hasn't shown how: a 2xx alone never says it was taken.
    expect(declineSettlement({ ...e, state: 'committed' }, view(), w.phone.id)).toBeNull();
    expect(declineStanding({ ...e, state: 'committed' }, view(), w.phone.id)).toEqual({
      kind: 'confirming',
    });
  });

  it('is declined once the thread holds the very cancel this device signed, verified', async () => {
    const { w, s, id, view } = await setup();
    const e = entry(id, { state: 'committed' });
    // Its id, but a signature that fails: never taken for the person's decline.
    await s.ingest(await cancelWithId(w, id, e.recordId!, w.phone, 0, true));
    expect(view().actions.find((a) => a.actionId === e.recordId)?.verified).toBe(false);
    expect(declineSettlement(e, view(), w.phone.id)).toBeNull();

    const { w: w2, s: s2, id: id2, view: view2 } = await setup();
    const e2 = entry(id2, { state: 'committed' });
    await s2.ingest(await cancelWithId(w2, id2, e2.recordId!, w2.phone));
    expect(declineSettlement(e2, view2(), w2.phone.id)).toBe('accepted');
    // Its answer lost while still queued here: the thread already settles it.
    expect(declineSettlement({ ...e2, state: 'queued', attempts: 1 }, view2(), w2.phone.id)).toBe(
      'accepted',
    );
    // Another device's id for the same record is not this device's decline.
    expect(declineSettlement(e2, view2(), 'dev_someoneelse')).not.toBe('accepted');
  });

  it('keeps who closed the round when another cancel beat it and the relay answered 200', async () => {
    const { w, s, id, view } = await setup();
    const e = entry(id, { state: 'committed' });
    await s.ingest(await actionEvent(w, { questionId: id, action: 'cancel' }));
    expect(declineSettlement(e, view(), w.phone.id)).toEqual({
      status: 'withdrawn',
      label: 'Withdrawn on studio-mac',
    });
    // Reopened since: the round it was signed for still says what closed it.
    await s.ingest(await actionEvent(w, { questionId: id, action: 'reopen', expectedRevision: 0 }));
    expect(view().status).toBe('open');
    expect(declineSettlement(e, view(), w.phone.id)).toMatchObject({ status: 'withdrawn' });

    // Declined first on another of the person's devices, or on the computer.
    const t = await setup();
    const tablet = await otherHuman(t.w);
    await t.s.ingest(
      await actionEvent(t.w, { questionId: t.id, action: 'cancel', signer: tablet }),
    );
    expect(declineSettlement(entry(t.id, { state: 'committed' }), t.view(), t.w.phone.id)).toEqual({
      status: 'declined-elsewhere',
      computer: null,
    });
    const d = await setup();
    await d.s.ingest(await actionEvent(d.w, { questionId: d.id, action: 'cancel', decline: true }));
    expect(declineSettlement(entry(d.id, { state: 'committed' }), d.view(), d.w.phone.id)).toEqual({
      status: 'declined-elsewhere',
      computer: 'Studio Mac',
    });
  });

  it('reads a refusal from its code and details, never its message', async () => {
    const { w, s, id, view } = await setup();
    const refused = (o: Partial<OutboxEntry>) =>
      declineSettlement(entry(id, { state: 'conflicted', attempts: 1, ...o }), view(), w.phone.id);
    expect(refused({ errorCode: 'invalid_state', refusalReason: CREATOR_MISSING_FEATURE })).toEqual(
      { status: 'unsupported' },
    );
    expect(refused({ state: 'expired', errorCode: 'expired' })).toEqual({ status: 'expired' });
    // A desktop (or model) answer won the race: the revision moved, and the relay says to what.
    expect(
      refused({
        errorCode: 'revision_conflict',
        latestRevision: 1,
        latestStatus: 'human-answered',
      }),
    ).toEqual({ status: 'answered' });
    expect(
      refused({
        errorCode: 'revision_conflict',
        latestRevision: 1,
        latestStatus: 'proxy-answered',
      }),
    ).toEqual({ status: 'answered' });
    // Reopened: the old round's decline is never moved onto the new one.
    expect(
      refused({ errorCode: 'revision_conflict', latestRevision: 1, latestStatus: 'open' }),
    ).toEqual({ status: 'changed' });
    // Refused at the same revision without a reason: the relay's sweep expired it first.
    expect(refused({ errorCode: 'invalid_state' })).toEqual({ status: 'expired' });
    expect(refused({ state: 'rejected', errorCode: 'not_found' })).toEqual({ status: 'gone' });
    expect(refused({ state: 'rejected', errorCode: 'forbidden' })).toEqual({
      status: 'rejected',
      code: 'forbidden',
    });
    // Once kept, an outcome is never worked out again from a thread that moved on.
    await s.ingest(await actionEvent(w, { questionId: id, action: 'answer', expectedRevision: 0 }));
    expect(refused({ errorCode: 'expired', outcome: { status: 'changed' } })).toEqual({
      status: 'changed',
    });
  });

  it('waits rather than guess while the thread is being rebuilt or the closer is unverified', async () => {
    const { w, s, id, view } = await setup();
    // A refusal is read from the relay's answer, a 2xx only from the thread: no question, nothing to wait for.
    expect(declineSettlement(entry(id, { state: 'committed' }), undefined, w.phone.id)).toBe(
      'accepted',
    );
    expect(declineSettlement(entry(id, { state: 'queued' }), undefined, w.phone.id)).toBeNull();
    // A cancel nobody here can verify: never attributed to anyone, and it closes nothing here.
    await s.ingest(await cancelWithId(w, id, newId(), w.phone, 0, true));
    expect(view().status).toBe('open');
    expect(declineSettlement(entry(id, { state: 'committed' }), view(), w.phone.id)).toBeNull();
  });
});
