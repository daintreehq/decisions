import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADVISORY_ROUND_REVISION,
  ApiError,
  CryptoEnvelope,
  DecisionContentV1,
  EnvelopeAad,
  EnvelopePurpose,
  EventData,
  LIMITS,
  ProtocolFeature,
  QuestionDetail,
  QuestionRecord,
  SignedQuestion,
  advisoryPlanOf,
  advisoryRefusal,
  applyRoundEvent,
  canonicalize,
  isAdvisoryRound,
  replyModeOf,
  signingString,
  advisoryContentIssue,
  knownFeatures,
  type QuestionKind,
  type RoundResult,
  type RoundState,
  type RoundTransition,
} from '../src/index.js';
import {
  ADVISORY_QUESTION_FIXTURE,
  BLOCKING_APPROVAL_FIXTURE,
  FIXTURE_NOW,
  Legacy080Question,
  ROUND_CASES,
} from '../src/fixtures.js';

const SIG = 's'.repeat(86);
const DIGEST = 'a'.repeat(64);
const FROZEN_BLOCKING_RECORD =
  '{"attachment_ids":[],"created_at":"2026-11-01T10:00:00.000Z","envelope_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expires_at":"2026-11-02T10:00:00.000Z","installation_id":"inst_fixture01","key_epoch":1,"origin_ref":"pane_fixture01","originating_device_id":"dev_desktop01","policy_version":1,"question_id":"q_approval001","requirement":"human-required","signer_device_id":"dev_desktop01","target_host_id":"host_fixture01","type":"question","v":1,"workflow_gate_id_hash":"5d1be7e9dda1ee8896be5b7e34a85ee16452a7b4f6fc2b9b4b3b0f6b6a3f1c22"}';

/** A fixture question as it travels once encrypted and signed (placeholder ciphertext, digest and signature). */
const signed = (f: typeof ADVISORY_QUESTION_FIXTURE | typeof BLOCKING_APPROVAL_FIXTURE) => ({
  record: { ...f.record, envelope_digest: DIGEST, signature: SIG },
  envelope: {
    crypto_version: 1,
    suite: 'P256-ECDH-HKDF-SHA256-A256GCM-ECDSA-P256',
    key_epoch: 1,
    nonce: 'AAECAwQFBgcICQoL',
    ciphertext: 'c'.repeat(64),
    ...f.envelope,
  },
});
const created = (q: ReturnType<typeof signed>) => ({
  ...q,
  requirement: q.record.requirement,
  target_host_id: q.record.target_host_id,
  expires_at: q.record.expires_at,
});

const pick = (s: RoundState | null, keys: readonly string[]) =>
  s && Object.fromEntries(keys.map((k) => [k, (s as unknown as Record<string, unknown>)[k]]));

/** Runs every case, and returns each step's result for the cross-case checks. */
function runCases() {
  const results: {
    name: string;
    step: (typeof ROUND_CASES)[number]['steps'][number];
    r: RoundResult;
  }[] = [];
  for (const c of ROUND_CASES) {
    let state: RoundState | null = { ...c.start };
    for (const step of c.steps) {
      const r = applyRoundEvent(state, step.event);
      results.push({ name: c.name, step, r });
      state = r.state;
    }
  }
  return results;
}

describe('the round transition table (section 21)', () => {
  for (const c of ROUND_CASES) {
    it(c.name, () => {
      let state: RoundState | null = { ...c.start };
      for (const [i, step] of c.steps.entries()) {
        const label = `${c.name}: step ${i + 1}`;
        const before = state;
        const r = applyRoundEvent(state, step.event);
        expect(r.expired?.outcome ?? null, label).toBe(step.expired ?? null);
        expect(r.transition?.outcome ?? null, label).toBe(step.outcome);
        expect(r.error?.code ?? null, label).toBe(step.error);
        expect(r.error === null, label).toBe(r.transition !== null);
        const keys = step.after ? Object.keys(step.after) : [];
        expect(pick(r.state, keys), label).toEqual(step.after);
        if (r.error && !r.expired) {
          // A refusal with nothing expired first commits nothing.
          expect(r.state, label).toEqual(before);
        }
        const t = r.transition;
        if (t) expect(t.state, label).toEqual(r.state);
        else if (r.expired) expect(r.expired.state, label).toEqual(r.state);
        if (step.authority !== undefined) expect(t?.authority, label).toBe(step.authority);
        if (step.provenance !== undefined) expect(t?.provenance, label).toBe(step.provenance);
        if (step.deliverable !== undefined) expect(t?.deliverable, label).toBe(step.deliverable);
        if (step.fallbackDue !== undefined) expect(t?.fallbackDue, label).toBe(step.fallbackDue);
        if (step.trainable !== undefined) expect(t?.trainable, label).toBe(step.trainable);
        if (step.eventType !== undefined) expect(t?.eventType, label).toBe(step.eventType);
        state = r.state;
      }
    });
  }

  it('makes the plan due only on the advisory deadline, never with an answer, provenance or training', () => {
    const committed = runCases().flatMap(({ r }) =>
      [r.expired, r.transition].filter((t): t is RoundTransition => t !== null),
    );
    const expiries = committed.filter((t) => t.eventType === 'decision.expired');
    expect(expiries.map((t) => t.outcome)).toEqual(
      expect.arrayContaining(['advisory-unanswered', 'expired-unsatisfied']),
    );
    for (const t of expiries) {
      expect(t).toMatchObject({
        authority: 'relay',
        provenance: null,
        deliverable: false,
        trainable: false,
      });
      expect(t.fallbackDue).toBe(t.outcome === 'advisory-unanswered');
    }
    for (const t of committed.filter((t) => t.fallbackDue)) {
      expect(t.outcome).toBe('advisory-unanswered');
      expect(t.state).toMatchObject({ status: 'expired', revision: ADVISORY_ROUND_REVISION });
    }
    // Only a person's answer or override is ever ground truth, and both appear.
    const trainable = committed.filter((t) => t.trainable);
    expect(new Set(trainable.map((t) => t.outcome))).toEqual(new Set(['answered', 'overridden']));
    for (const t of trainable) expect(['human', 'human-desktop']).toContain(t.provenance);
  });

  it('judges an answer by its commit time, however late a reader replays it', () => {
    const start = ROUND_CASES[0]!.start;
    const D = start.expiresAt!;
    const timely = applyRoundEvent(start, {
      type: 'action',
      action: 'answer',
      role: 'phone',
      expectedRevision: 0,
      at: D - 1,
    });
    const late = applyRoundEvent(start, {
      type: 'action',
      action: 'answer',
      role: 'phone',
      expectedRevision: 0,
      at: D,
    });
    expect(timely.transition?.outcome).toBe('answered');
    expect(late.transition).toBeNull();
    expect(late.error?.code).toBe('expired');
    // Replayed a day later, the deadline check is a no-op on the answered round.
    expect(
      applyRoundEvent(timely.state, { type: 'deadline', at: D + 86_400_000 }).transition?.outcome,
    ).toBe('unchanged');
  });

  it('only the first round of an advisory question is advisory', () => {
    expect(isAdvisoryRound({ advisory: true, revision: 0 })).toBe(true);
    for (const revision of [1, 2, 3])
      expect(isAdvisoryRound({ advisory: true, revision })).toBe(false);
    expect(isAdvisoryRound({ advisory: false, revision: 0 })).toBe(false);
  });

  it('refuses a reopen deadline that is not ahead or too far ahead, like the relay', () => {
    const start: RoundState = { ...ROUND_CASES[0]!.start, status: 'expired' };
    const at = start.expiresAt! + 60_000;
    const reopen = (expiresAt: number) =>
      applyRoundEvent(start, {
        type: 'action',
        action: 'reopen',
        role: 'owner-desktop',
        expectedRevision: 0,
        expiresAt,
        at,
      });
    expect(reopen(at).error?.code).toBe('validation_error');
    expect(reopen(at + LIMITS.maxQuestionExpiryMs + 1).error?.code).toBe('validation_error');
    expect(reopen(at + LIMITS.maxQuestionExpiryMs).transition?.outcome).toBe('reopened');
  });
});

describe('the signed advisory contract', () => {
  it('the fixtures are valid questions, one advisory and one blocking, wherever a question is read', () => {
    for (const f of [ADVISORY_QUESTION_FIXTURE, BLOCKING_APPROVAL_FIXTURE]) {
      const q = signed(f);
      expect(SignedQuestion.safeParse(q).success).toBe(true);
      expect(EventData.created.safeParse(created(q)).success).toBe(true);
      expect(QuestionDetail.shape.question.safeParse(q).success).toBe(true);
      expect(DecisionContentV1.safeParse(f.content).success).toBe(true);
    }
    const adv = SignedQuestion.parse(signed(ADVISORY_QUESTION_FIXTURE));
    expect(replyModeOf(adv.envelope)).toBe('advisory');
    expect(adv.record.workflow_gate_id_hash).toBeNull();
    expect(Date.parse(adv.record.expires_at!)).toBeGreaterThan(Date.parse(FIXTURE_NOW));
    const block = SignedQuestion.parse(signed(BLOCKING_APPROVAL_FIXTURE));
    expect(replyModeOf(block.envelope)).toBe('blocking');
    expect('reply_mode' in block.envelope.aad).toBe(false);
    expect(DecisionContentV1.parse(BLOCKING_APPROVAL_FIXTURE.content).kind).toBe('approval');
  });

  it('keeps the mode out of the signed record: it lives in the AAD, which the digest and AES-GCM cover', () => {
    const q = signed(ADVISORY_QUESTION_FIXTURE);
    expect(q.envelope.aad.reply_mode).toBe('advisory');
    expect(signingString(q.record)).not.toContain('reply_mode');
    expect(canonicalize(q)).not.toContain('planned_fallback');
  });

  it('needs a finite signed deadline and no gate, wherever a question is read', () => {
    const noDeadline = signed(ADVISORY_QUESTION_FIXTURE);
    noDeadline.record = { ...noDeadline.record, expires_at: null };
    const gated = signed(ADVISORY_QUESTION_FIXTURE);
    gated.record = { ...gated.record, workflow_gate_id_hash: DIGEST };
    for (const bad of [noDeadline, gated]) {
      expect(SignedQuestion.safeParse(bad).success).toBe(false);
      // The unsigned deadline beside the record never stands in for the signed one.
      expect(
        EventData.created.safeParse({
          ...created(bad),
          expires_at: ADVISORY_QUESTION_FIXTURE.record.expires_at,
        }).success,
      ).toBe(false);
      expect(QuestionDetail.shape.question.safeParse(bad).success).toBe(false);
    }
    // The same record without the mode is an ordinary blocking question.
    const blocking = signed(BLOCKING_APPROVAL_FIXTURE);
    blocking.record = { ...blocking.record, expires_at: null };
    expect(SignedQuestion.safeParse(blocking).success).toBe(true);
  });

  it('binds the mode to a question create: never another record, round or purpose', () => {
    const aad = ADVISORY_QUESTION_FIXTURE.envelope.aad;
    expect(EnvelopeAad.safeParse(aad).success).toBe(true);
    expect(EnvelopeAad.safeParse({ ...aad, revision: 1 }).success).toBe(false);
    expect(EnvelopeAad.safeParse({ ...aad, record_type: 'answer' }).success).toBe(false);
    expect(EnvelopeAad.safeParse({ ...aad, reply_mode: 'blocking' }).success).toBe(false);
    const env = signed(ADVISORY_QUESTION_FIXTURE).envelope;
    for (const purpose of EnvelopePurpose.options) {
      expect(CryptoEnvelope.safeParse({ ...env, purpose }).success, purpose).toBe(
        purpose === 'question-content',
      );
    }
  });

  it('drops a blank, oversize or non-text plan, so the advisory question is refused and a blocking one still reads', () => {
    const base = ADVISORY_QUESTION_FIXTURE.content;
    const adv = signed(ADVISORY_QUESTION_FIXTURE);
    const block = signed(BLOCKING_APPROVAL_FIXTURE);
    for (const planned_fallback of [
      '',
      '   ',
      'x'.repeat(LIMITS.plannedFallbackChars + 1),
      42,
      null,
    ]) {
      const c = DecisionContentV1.parse({ ...base, planned_fallback });
      expect(c.planned_fallback).toBeUndefined();
      expect(c.question).toBe(base.question);
      expect(advisoryContentIssue(adv, c)).toBe('no-plan');
      expect(advisoryContentIssue(block, c)).toBeNull();
    }
    const { planned_fallback: _omitted, ...withoutPlan } = base;
    expect(DecisionContentV1.parse(withoutPlan).planned_fallback).toBeUndefined();
    const longest = DecisionContentV1.parse({
      ...base,
      planned_fallback: 'x'.repeat(LIMITS.plannedFallbackChars),
    });
    expect(longest.planned_fallback).toHaveLength(LIMITS.plannedFallbackChars);
    expect(advisoryContentIssue(adv, longest)).toBeNull();
  });

  it('refuses advisory content that is an approval or states no plan, whoever signed it', () => {
    const q = signed(ADVISORY_QUESTION_FIXTURE);
    const content = DecisionContentV1.parse(ADVISORY_QUESTION_FIXTURE.content);
    expect(advisoryContentIssue(q, content)).toBeNull();
    expect(advisoryContentIssue(q, { ...content, kind: 'approval' })).toBe('approval');
    expect(advisoryContentIssue(q, { ...content, planned_fallback: undefined })).toBe('no-plan');
    // A blocking question's content means nothing advisory, whatever it carries.
    const block = signed(BLOCKING_APPROVAL_FIXTURE);
    expect(advisoryContentIssue(block, { ...content, kind: 'approval' })).toBeNull();
  });

  it('shows the plan of the advisory round only, the deadline alone when it cannot decrypt, and never a refused one', () => {
    const q = signed(ADVISORY_QUESTION_FIXTURE);
    const content = DecisionContentV1.parse(ADVISORY_QUESTION_FIXTURE.content);
    expect(advisoryPlanOf(q, 0, content)).toEqual({
      deadline: q.record.expires_at,
      fallback: content.planned_fallback,
    });
    expect(advisoryPlanOf(q, 1, content)).toBeNull();
    expect(advisoryPlanOf(q, 0, null)).toEqual({ deadline: q.record.expires_at, fallback: null });
    expect(() => advisoryPlanOf(q, 0, { ...content, kind: 'approval' })).toThrow(
      expect.objectContaining({ code: 'validation_error' }),
    );
    expect(() => advisoryPlanOf(q, 0, { ...content, planned_fallback: undefined })).toThrow(
      ApiError,
    );
    // A later round shows nothing advisory, but refused content stays refused.
    for (const revision of [1, 2])
      expect(() => advisoryPlanOf(q, revision, { ...content, kind: 'approval' })).toThrow(ApiError);
    expect(
      advisoryPlanOf({ ...q, record: { ...q.record, expires_at: null } }, 0, content),
    ).toBeNull();
    expect(advisoryPlanOf(signed(BLOCKING_APPROVAL_FIXTURE), 0, content)).toBeNull();
  });
});

describe('advisory admission (host support and policy)', () => {
  const ok = {
    relaySupport: true,
    hostSupport: true,
    policyAllows: true,
    readerSupport: true,
    originGateId: null,
    namedGateId: null,
    kind: 'choice' as QuestionKind,
    expiresAt: ADVISORY_QUESTION_FIXTURE.record.expires_at,
    plannedFallback: ADVISORY_QUESTION_FIXTURE.content.planned_fallback,
  };
  const NON_APPROVAL: QuestionKind[] = ['choice', 'text', 'mixed'];

  it('admits an ungated, finite, explained question of any kind but an approval', () => {
    for (const kind of NON_APPROVAL) expect(advisoryRefusal({ ...ok, kind }), kind).toBeNull();
  });

  it('needs every permission explicitly; none defaults to allowed', () => {
    const permissions = {
      relaySupport: 'relay-unsupported',
      hostSupport: 'host-unsupported',
      policyAllows: 'policy-disallowed',
      readerSupport: 'no-capable-reader',
    } as const;
    for (const [key, refusal] of Object.entries(permissions)) {
      expect(advisoryRefusal({ ...ok, [key]: false })).toBe(refusal);
      // Left out at runtime (an older caller, a JSON config) is never permission.
      const { [key as keyof typeof permissions]: _omitted, ...without } = ok;
      expect(advisoryRefusal(without as typeof ok)).toBe(refusal);
    }
  });

  it('never weakens a named or an origin-bound gate, registered or not, of any kind', () => {
    for (const kind of NON_APPROVAL) {
      for (const gate of [
        { originGateId: 'design-review/final' },
        { namedGateId: 'design-review/final' },
        { namedGateId: 'no-such-gate' },
        { originGateId: '' },
        { namedGateId: '', originGateId: 'no-such-gate' },
      ]) {
        expect(advisoryRefusal({ ...ok, kind, ...gate }), JSON.stringify({ kind, gate })).toBe(
          'gated',
        );
      }
    }
    expect(advisoryRefusal({ ...ok, kind: 'approval' })).toBe('approval');
  });

  it('needs a well-formed finite deadline and a plan', () => {
    expect(advisoryRefusal({ ...ok, expiresAt: null })).toBe('no-deadline');
    expect(advisoryRefusal({ ...ok, expiresAt: 'not-a-date' })).toBe('no-deadline');
    for (const plannedFallback of [
      undefined,
      null,
      '',
      '  ',
      'x'.repeat(LIMITS.plannedFallbackChars + 1),
    ]) {
      expect(advisoryRefusal({ ...ok, plannedFallback })).toBe('invalid-plan');
    }
  });

  it('declares the extension, and nothing that only looks like it', () => {
    expect([...knownFeatures(['advisory-deadlines-v1', 'advisory-deadline-v1'])]).toEqual([
      'advisory-deadlines-v1',
    ]);
  });
});

describe('older and strict readers', () => {
  it('a 0.8.0 reader refuses an advisory question and still reads the blocking one after it', () => {
    const adv = signed(ADVISORY_QUESTION_FIXTURE);
    expect(Legacy080Question.CreatedEventData.safeParse(created(adv)).success).toBe(false);
    expect(
      Legacy080Question.CreateQuestionBody.safeParse({
        idempotency_key: 'idem_advisory1',
        protocol_version: 1,
        question: adv,
      }).success,
    ).toBe(false);
    // Its loose record would have kept a marker it does not understand: that is why the mode is in the AAD.
    const marked = Legacy080Question.QuestionRecord.parse({
      ...adv.record,
      reply_mode: 'advisory',
    });
    expect(marked).toHaveProperty('reply_mode', 'advisory');
    expect(
      Legacy080Question.CreatedEventData.safeParse(created(signed(BLOCKING_APPROVAL_FIXTURE)))
        .success,
    ).toBe(true);
  });

  it('a blocking question signs exactly the bytes it signed before', () => {
    const block = signed(BLOCKING_APPROVAL_FIXTURE);
    // Frozen JCS of the record, computed outside this package; any change to the signed bytes breaks it.
    expect(signingString(QuestionRecord.parse(block.record))).toBe(FROZEN_BLOCKING_RECORD);
    const legacy = Legacy080Question.CreatedEventData.parse(created(block));
    expect(canonicalize(SignedQuestion.parse(block).envelope)).toBe(canonicalize(legacy.envelope));
  });

  it('the published JSON Schemas are closed where a strict reader would refuse the advisory fields', () => {
    const bundle = JSON.parse(
      readFileSync(fileURLToPath(new URL('../schemas.json', import.meta.url)), 'utf8'),
    ) as Record<string, any>;
    const aad = bundle.CryptoEnvelope.properties.aad;
    expect(aad.additionalProperties).toBe(false);
    expect(aad.properties.reply_mode).toEqual({ type: 'string', const: 'advisory' });
    expect(aad.required).not.toContain('reply_mode');
    expect(bundle.DecisionContentV1.additionalProperties).toBe(false);
    expect(bundle.DecisionContentV1.properties).toHaveProperty('planned_fallback');
    expect(bundle.DecisionContentV1.required ?? []).not.toContain('planned_fallback');
  });
});
