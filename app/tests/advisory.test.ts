// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InfoResponse } from '@daintreehq/decisions-protocol';
import { ADVISORY_QUESTION_FIXTURE } from '@daintreehq/decisions-protocol/fixtures';
import { AppController } from '../src/app/controller.js';
import { closedLine, historyEntries, principalStatus } from '../src/domain/lists.js';
import { QuestionStore } from '../src/domain/model.js';
import {
  advisoryRound,
  currentAnswer,
  deadlinePhase,
  deadlineWords,
  declinedLabel,
  effectiveStatus,
  unreadableHere,
} from '../src/domain/selectors.js';
import {
  actionEvent,
  deadlineScenario,
  expiredEvent,
  makeWorld,
  MINUTE,
  questionEvent,
  type World,
} from './helpers.js';

const PLAN = ADVISORY_QUESTION_FIXTURE.content.planned_fallback;

const store = (w: World, keys = true) =>
  new QuestionStore({
    installationId: w.installationId,
    trust: w.trust,
    epochKeys: () => (keys ? w.epochs : new Map()),
  });

describe('the deadline fixtures as this phone reads them', () => {
  it('shows each one with the deadline, plan and outcome it signed', async () => {
    const w = await makeWorld();
    const s = store(w);
    const old = await deadlineScenario(w, 'old-content');
    const none = await deadlineScenario(w, 'no-expiry');
    const adv = await deadlineScenario(w, 'advisory');
    const dismissed = await deadlineScenario(w, 'dismissed');
    const required = await deadlineScenario(w, 'required-expiry');
    for (const sc of [old, none, adv, dismissed, required]) await s.ingestAll(sc.events);
    const now = adv.asked + MINUTE;

    // Signed as 0.8.0 did: blocking, with a deadline that authorises nothing.
    const o = s.get(old.questionId)!;
    expect(o).toMatchObject({ replyMode: 'blocking', verification: { ok: true } });
    expect(advisoryRound(o)).toBe(false);
    expect(deadlinePhase(o, now)).toBe('before');

    const n = s.get(none.questionId)!;
    expect(deadlinePhase(n, now)).toBe('none');
    expect(deadlineWords(n, Number.MAX_SAFE_INTEGER)).toBeNull();

    const a = s.get(adv.questionId)!;
    expect(a).toMatchObject({ replyMode: 'advisory', status: 'open', revision: 0 });
    expect(a.content?.planned_fallback).toBe(PLAN);
    expect(advisoryRound(a)).toBe(true);
    expect(deadlinePhase(a, now)).toBe('before');
    expect(deadlineWords(a, now)).toBeNull();

    // Declined: the plan never becomes due, and the deadline no longer applies.
    const d = s.get(dismissed.questionId)!;
    expect(d.status).toBe('cancelled');
    expect(declinedLabel(d)).toBe('Declined by you');
    expect(deadlinePhase(d, dismissed.deadline! + MINUTE)).toBe('none');
    expect(deadlineWords(d, dismissed.deadline! + MINUTE)).toBeNull();

    // A gated approval the relay expired: nothing approved, the step stays blocked.
    const r = s.get(required.questionId)!;
    expect(r).toMatchObject({ status: 'expired', replyMode: 'blocking' });
    expect(r.expiries).toEqual([
      {
        seq: required.events[1]!.seq,
        at: new Date(required.deadline!).toISOString(),
        advisory: false,
      },
    ]);
    expect(deadlineWords(r, now)).toEqual({
      title: 'Expired without an answer',
      detail:
        'Nothing was approved, and the step stays blocked. To decide now, ask your agent again from your computer.',
      row: 'Expired without an answer',
    });
    expect(closedLine(principalStatus(r, now), r)).toBe('Expired without an answer');
  });

  it('tells the deadline passing on this phone apart from the relay expiring the advisory round', async () => {
    const w = await makeWorld();
    const s = store(w);
    const adv = await deadlineScenario(w, 'advisory');
    await s.ingestAll(adv.events);
    const D = adv.deadline!;
    const v = s.get(adv.questionId)!;

    // This phone's clock passed it: closed to new answers here, but no outcome yet.
    expect(effectiveStatus(v, D)).toBe('expired');
    expect(deadlinePhase(v, D)).toBe('passed-here');
    expect(deadlineWords(v, D)).toEqual({
      title: 'The deadline passed on this phone',
      detail:
        'Waiting for your relay to confirm. If no answer reached it in time, your agent may go ahead with its plan.',
      row: 'Deadline passed on this phone',
    });
    expect(deadlineWords(v, D, true)?.detail).toBe(
      'Your relay will say whether your answer reached it in time.',
    );
    expect(closedLine(principalStatus(v, D), v)).toBe('Deadline passed on this phone');

    // The relay expired it: the plan is due, and nothing says the agent was told or acted.
    await s.ingest(expiredEvent(adv.questionId, D));
    const e = s.get(adv.questionId)!;
    expect(e.status).toBe('expired');
    expect(e.expiries).toMatchObject([{ advisory: true }]);
    expect(deadlinePhase(e, D)).toBe('passed');
    const words = deadlineWords(e, D)!;
    expect(words.title).toBe('No answer by the deadline');
    expect(words.detail).toMatch(/may now go ahead with its plan/);
    expect(words.detail).toMatch(/can’t see whether your agent has been told yet, or what it did/);
    expect(closedLine(principalStatus(e, D), e)).toBe('No answer · your agent may go ahead');
    expect(historyEntries([e], 'decisions', '', D).map((h) => h.status)).toEqual(['expired']);
  });

  it('lets an answer the relay committed in time win, however late this phone reads it', async () => {
    const w = await makeWorld();
    const s = store(w);
    const adv = await deadlineScenario(w, 'advisory');
    await s.ingestAll(adv.events);
    const D = adv.deadline!;
    const later = D + 60 * MINUTE;
    expect(deadlinePhase(s.get(adv.questionId)!, later)).toBe('passed-here');
    // Committed a millisecond before the deadline, read an hour after it.
    await s.ingest(
      await actionEvent(w, {
        questionId: adv.questionId,
        action: 'answer',
        occurredAt: new Date(D - 1).toISOString(),
      }),
    );
    // The relay can't expire an answered round; an expiry that claims to is not believed.
    await s.ingest(expiredEvent(adv.questionId, D + 1, 1));
    const v = s.get(adv.questionId)!;
    expect(effectiveStatus(v, later)).toBe('human-answered');
    expect(currentAnswer(v)?.content).toMatchObject({ text: 'go ahead' });
    expect(deadlinePhase(v, later)).toBe('none');
    expect(deadlineWords(v, later)).toBeNull();
    expect(v.expiries).toEqual([]);
    expect(advisoryRound(v)).toBe(false);
  });

  it('believes an expiry only for the open round it names, at or after its signed deadline', async () => {
    const w = await makeWorld();
    const s = store(w);
    const adv = await deadlineScenario(w, 'advisory');
    await s.ingestAll(adv.events);
    const D = adv.deadline!;
    await s.ingest(expiredEvent(adv.questionId, D - 1));
    await s.ingest(expiredEvent(adv.questionId, D, 3));
    const v = s.get(adv.questionId)!;
    expect(v.status).toBe('open');
    expect(v.expiries).toEqual([]);
    expect(v.integrityIssues).toEqual([
      'expiry reported before the signed deadline (ignored)',
      'expiry reported for another round (ignored)',
    ]);
  });

  it('keeps the advisory round’s expiry after a reopen, and the reopened round waits', async () => {
    const w = await makeWorld();
    const s = store(w);
    const adv = await deadlineScenario(w, 'advisory');
    await s.ingestAll(adv.events);
    const D = adv.deadline!;
    const D2 = D + 30 * MINUTE;
    await s.ingest(expiredEvent(adv.questionId, D));
    await s.ingest(
      await actionEvent(w, {
        questionId: adv.questionId,
        action: 'reopen',
        signer: w.owner,
        expectedRevision: 0,
        status: 'open',
        expiresAt: new Date(D2).toISOString(),
      }),
    );
    const v = s.get(adv.questionId)!;
    expect(v).toMatchObject({ status: 'open', revision: 1, replyMode: 'advisory' });
    expect(advisoryRound(v)).toBe(false);
    expect(deadlinePhase(v, D + MINUTE)).toBe('before');
    expect(v.expiries).toMatchObject([{ advisory: true }]);
    // The earlier round's expiry, replayed at the new deadline, never closes the reopened round.
    await s.ingest(expiredEvent(adv.questionId, D2, 0));
    expect(s.get(adv.questionId)).toMatchObject({ status: 'open', revision: 1 });
    expect(s.get(adv.questionId)!.expiries).toHaveLength(1);
    await s.ingest(expiredEvent(adv.questionId, D2, 1));
    const e = s.get(adv.questionId)!;
    expect(e.expiries).toMatchObject([{ advisory: true }, { advisory: false }]);
    expect(deadlineWords(e, D2)?.title).toBe('Expired without an answer');
  });

  it('keeps the signed deadline of an advisory question it holds no key for, until the key arrives', async () => {
    const w = await makeWorld();
    let keys = false;
    const s = new QuestionStore({
      installationId: w.installationId,
      trust: w.trust,
      epochKeys: () => (keys ? w.epochs : new Map()),
    });
    const adv = await deadlineScenario(w, 'advisory');
    const events = [
      ...adv.events,
      await actionEvent(w, { questionId: adv.questionId, action: 'proxy-abstain' }),
    ];
    await s.ingestAll(events);
    const v = s.get(adv.questionId)!;
    expect(unreadableHere(v)).toBe(true);
    expect(v).toMatchObject({
      replyMode: 'advisory',
      expiresAt: new Date(adv.deadline!).toISOString(),
      content: null,
    });
    expect(effectiveStatus(v, adv.asked)).toBe('unverified');
    expect(deadlinePhase(v, adv.asked)).toBe('before');
    // An answer it can't apply may have ended the round: a later expiry is no outcome here.
    const other = await deadlineScenario(w, 'advisory');
    await s.ingestAll([
      ...other.events,
      await actionEvent(w, { questionId: other.questionId, action: 'answer' }),
      expiredEvent(other.questionId, other.deadline!),
    ]);
    expect(s.get(other.questionId)).toMatchObject({ status: 'open', expiries: [] });
    expect(s.get(other.questionId)!.integrityIssues.at(-1)).toBe(
      'expiry reported for a round this device cannot follow (ignored)',
    );
    // With only an abstention recorded, the relay's expiry of the advisory round stands.
    await s.ingest(expiredEvent(adv.questionId, adv.deadline!));
    expect(s.get(adv.questionId)!.expiries).toMatchObject([{ advisory: true }]);
    keys = true;
    await s.rebuild(events);
    const r = s.get(adv.questionId)!;
    expect(r).toMatchObject({ verification: { ok: true }, replyMode: 'advisory' });
    expect(r.content?.planned_fallback).toBe(PLAN);
  });
});

describe('rounds that end some other way', () => {
  it('waits without a deadline once reopened with none', async () => {
    const w = await makeWorld();
    const s = store(w);
    const adv = await deadlineScenario(w, 'advisory');
    const D = adv.deadline!;
    await s.ingestAll([
      ...adv.events,
      expiredEvent(adv.questionId, D),
      await actionEvent(w, {
        questionId: adv.questionId,
        action: 'reopen',
        signer: w.owner,
        expectedRevision: 0,
        status: 'open',
        expiresAt: null,
      }),
    ]);
    const v = s.get(adv.questionId)!;
    expect(v.expiresAt).toBeNull();
    expect(deadlinePhase(v, D + 60 * MINUTE)).toBe('none');
    expect(effectiveStatus(v, D + 60 * MINUTE)).toBe('open');
  });

  it('says only that a blocking question’s deadline passed here, with no plan to go ahead with', async () => {
    const w = await makeWorld();
    const s = store(w);
    const old = await deadlineScenario(w, 'old-content');
    await s.ingestAll(old.events);
    expect(deadlineWords(s.get(old.questionId)!, old.deadline!)).toEqual({
      title: 'The deadline passed on this phone',
      detail: 'Waiting for your relay to confirm.',
      row: 'Deadline passed on this phone',
    });
    await s.ingest(expiredEvent(old.questionId, old.deadline!));
    expect(deadlineWords(s.get(old.questionId)!, old.deadline!)?.detail).toBe(
      'No answer reached your relay in time. To decide now, ask your agent again from your computer.',
    );
  });

  it('keeps no model answer in force once the desktop withdrew the question', async () => {
    const w = await makeWorld();
    const s = store(w);
    const q = await questionEvent(w, {
      requirement: 'proxy-ok',
      replyMode: 'advisory',
      expiresAt: new Date(Date.now() + 15 * MINUTE).toISOString(),
      content: { ...ADVISORY_QUESTION_FIXTURE.content },
    });
    const id = q.question_id!;
    await s.ingestAll([
      q,
      await actionEvent(w, { questionId: id, action: 'proxy-answer' }),
      await actionEvent(w, { questionId: id, action: 'cancel', expectedRevision: 1 }),
    ]);
    const v = s.get(id)!;
    expect(v.status).toBe('cancelled');
    expect(currentAnswer(v)).toBeNull();
    expect(closedLine(principalStatus(v, Date.now()), v)).toMatch(/^Withdrawn/);
  });
});

describe('declaring advisory-deadlines-v1', () => {
  type Inside = { patch(p: { info: InfoResponse | null }): void; declaredFeatures(): string[] };
  const info = (features: string[]): InfoResponse => ({
    name: 'daintree-decisions',
    protocol_min: 1,
    protocol_max: 1,
    worker_version: 'test',
    claimed: true,
    claim_configured: true,
    voice: { xai: false, anthropic: false, openai: false },
    features,
  });
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    ),
  );
  afterEach(() => vi.unstubAllGlobals());

  it('reads the relay at once when the deadline passes here, or an answer reaches it too late', async () => {
    const c = new AppController('https://relay.example');
    const catchUp = vi.fn(async () => undefined);
    (c as unknown as { sync: { catchUp: typeof catchUp } }).sync = { catchUp };
    c.checkDeadline();
    expect(catchUp).toHaveBeenCalledTimes(1);
    const hooks = (
      c as unknown as { outboxHooks(id: string): { onRefused(e: object): void } }
    ).outboxHooks('phone_000001');
    hooks.onRefused({ kind: 'answer', state: 'expired' });
    expect(catchUp).toHaveBeenCalledTimes(2);
    // Any refusal means the relay knows more: an answer that won, a withdrawal, a follow-up after the deadline.
    hooks.onRefused({ kind: 'answer', state: 'conflicted' });
    hooks.onRefused({ kind: 'answer', state: 'rejected' });
    hooks.onRefused({ kind: 'message', state: 'expired' });
    expect(catchUp).toHaveBeenCalledTimes(5);
  });

  it('says this phone shows advisory questions only once the relay validates them', () => {
    const c = new AppController('https://relay.example');
    const inside = c as unknown as Inside;
    expect(inside.declaredFeatures()).not.toContain('advisory-deadlines-v1');
    inside.patch({ info: info(['thread-messages-v1']) });
    expect(inside.declaredFeatures()).not.toContain('advisory-deadlines-v1');
    inside.patch({ info: info(['thread-messages-v1', 'advisory-deadlines-v1']) });
    expect(inside.declaredFeatures()).toContain('advisory-deadlines-v1');
  });
});
