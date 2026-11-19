import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADVISORY_ROUND_REVISION,
  ApiError,
  CryptoEnvelope,
  DecisionContentV1,
  EnvelopeAad,
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

describe('the round transition table (section 21)', () => {
  for (const c of ROUND_CASES) {
    it(c.name, () => {
      let state: RoundState | null = { ...c.start };
      for (const [i, step] of c.steps.entries()) {
        const label = `${c.name}: step ${i + 1}`;
        let tr: RoundTransition | null = null;
        let thrown: unknown = null;
        try {
          tr = applyRoundEvent(state, step.event);
        } catch (e) {
          thrown = e;
        }
        if (step.outcome === null) {
          expect(thrown, label).toBeInstanceOf(ApiError);
          expect((thrown as ApiError).code, label).toBe(step.error);
          // A refusal commits nothing.
          expect(state && { status: state.status, revision: state.revision }, label).toEqual(
            step.after,
          );
          continue;
        }
        expect(thrown, label).toBeNull();
        expect(tr!.outcome, label).toBe(step.outcome);
        expect(tr!.refusal?.code ?? null, label).toBe(step.error);
        state = tr!.state;
        expect(state && { status: state.status, revision: state.revision }, label).toEqual(
          step.after,
        );
        if (step.authority !== undefined) expect(tr!.authority, label).toBe(step.authority);
        if (step.provenance !== undefined) expect(tr!.provenance, label).toBe(step.provenance);
        if (step.fallbackDue !== undefined) expect(tr!.fallbackDue, label).toBe(step.fallbackDue);
        if (step.trainable !== undefined) expect(tr!.trainable, label).toBe(step.trainable);
      }
    });
  }

  it('makes the plan due only on the advisory deadline, never with an answer, provenance or training', () => {
    const all = ROUND_CASES.flatMap((c) => {
      let state: RoundState | null = { ...c.start };
      return c.steps.flatMap((s) => {
        try {
          const tr = applyRoundEvent(state, s.event);
          state = tr.state;
          return [tr];
        } catch {
          return [];
        }
      });
    });
    const due = all.filter((t) => t.fallbackDue);
    expect(due.length).toBeGreaterThan(0);
    for (const t of due) {
      expect(t).toMatchObject({
        outcome: 'advisory-unanswered',
        authority: 'relay',
        provenance: null,
        deliverable: false,
        trainable: false,
        eventType: 'decision.expired',
      });
      expect(t.state).toMatchObject({ status: 'expired', revision: ADVISORY_ROUND_REVISION });
    }
    // Only a person's answer or override is ever ground truth.
    for (const t of all.filter((t) => t.trainable)) {
      expect(['answered', 'overridden']).toContain(t.outcome);
      expect(['human', 'human-desktop']).toContain(t.provenance);
    }
  });

  it('judges a committed answer by its commit time, not when a reader replays it', () => {
    const c = ROUND_CASES[0]!;
    const tr = applyRoundEvent(c.start, c.steps[0]!.event);
    expect(tr.outcome).toBe('answered');
    // Replayed long after the deadline, the deadline check is a no-op on the answered round.
    expect(
      applyRoundEvent(tr.state, { type: 'deadline', at: c.start.expiresAt! + 86_400_000 }).outcome,
    ).toBe('unchanged');
  });

  it('only the first round of an advisory question is advisory', () => {
    expect(isAdvisoryRound({ advisory: true, revision: 0 })).toBe(true);
    expect(isAdvisoryRound({ advisory: true, revision: 1 })).toBe(false);
    expect(isAdvisoryRound({ advisory: false, revision: 0 })).toBe(false);
  });

  it('refuses a reopen deadline that is not ahead, like the relay', () => {
    const start: RoundState = { ...ROUND_CASES[0]!.start, status: 'expired' };
    const at = start.expiresAt! + 60_000;
    expect(() =>
      applyRoundEvent(start, {
        type: 'action',
        action: 'reopen',
        role: 'owner-desktop',
        expectedRevision: 0,
        expiresAt: at,
        at,
      }),
    ).toThrow(expect.objectContaining({ code: 'validation_error' }));
  });
});

describe('the signed advisory contract', () => {
  it('the fixtures are valid questions, one advisory and one blocking', () => {
    const adv = SignedQuestion.parse(signed(ADVISORY_QUESTION_FIXTURE));
    expect(replyModeOf(adv.envelope)).toBe('advisory');
    expect(adv.record.workflow_gate_id_hash).toBeNull();
    expect(Date.parse(adv.record.expires_at!)).toBeGreaterThan(Date.parse(FIXTURE_NOW));
    const block = SignedQuestion.parse(signed(BLOCKING_APPROVAL_FIXTURE));
    expect(replyModeOf(block.envelope)).toBe('blocking');
    expect('reply_mode' in block.envelope.aad).toBe(false);
    expect(DecisionContentV1.parse(ADVISORY_QUESTION_FIXTURE.content).planned_fallback).toBe(
      ADVISORY_QUESTION_FIXTURE.content.planned_fallback,
    );
    expect(DecisionContentV1.parse(BLOCKING_APPROVAL_FIXTURE.content).kind).toBe('approval');
    expect(EventData.created.safeParse(created(signed(ADVISORY_QUESTION_FIXTURE))).success).toBe(
      true,
    );
  });

  it('keeps the plan out of every cleartext field', () => {
    const q = signed(ADVISORY_QUESTION_FIXTURE);
    const visible = canonicalize(q);
    expect(visible).not.toContain(ADVISORY_QUESTION_FIXTURE.content.planned_fallback);
    expect(visible).not.toContain('planned_fallback');
    // The mode is in the AAD, which the envelope digest (signed into the record) and AES-GCM both cover.
    expect(q.envelope.aad.reply_mode).toBe('advisory');
    expect(signingString(q.record)).not.toContain('reply_mode');
  });

  it('needs a finite signed deadline and no gate, wherever a question is read', () => {
    const noDeadline = signed(ADVISORY_QUESTION_FIXTURE);
    noDeadline.record = { ...noDeadline.record, expires_at: null as unknown as string };
    const gated = signed(ADVISORY_QUESTION_FIXTURE);
    gated.record = { ...gated.record, workflow_gate_id_hash: DIGEST as unknown as null };
    for (const bad of [noDeadline, gated]) {
      expect(SignedQuestion.safeParse(bad).success).toBe(false);
      expect(EventData.created.safeParse(created(bad)).success).toBe(false);
      expect(
        QuestionDetail.shape.question.safeParse(bad).success,
        'QuestionDetail reads the same rule',
      ).toBe(false);
    }
    // The same record without the mode is an ordinary blocking question.
    const blocking = signed(BLOCKING_APPROVAL_FIXTURE);
    blocking.record = { ...blocking.record, expires_at: null as unknown as string };
    expect(SignedQuestion.safeParse(blocking).success).toBe(true);
  });

  it('binds the mode to a question create: never another record, round or purpose', () => {
    const aad = ADVISORY_QUESTION_FIXTURE.envelope.aad;
    expect(EnvelopeAad.safeParse(aad).success).toBe(true);
    expect(EnvelopeAad.safeParse({ ...aad, revision: 1 }).success).toBe(false);
    expect(EnvelopeAad.safeParse({ ...aad, record_type: 'answer' }).success).toBe(false);
    expect(EnvelopeAad.safeParse({ ...aad, reply_mode: 'blocking' }).success).toBe(false);
    const env = signed(ADVISORY_QUESTION_FIXTURE).envelope;
    expect(CryptoEnvelope.safeParse(env).success).toBe(true);
    expect(CryptoEnvelope.safeParse({ ...env, purpose: 'answer-content' }).success).toBe(false);
    expect(CryptoEnvelope.safeParse({ ...env, purpose: 'message-content' }).success).toBe(false);
  });

  it('drops a missing, blank or oversize plan rather than failing the question', () => {
    const base = ADVISORY_QUESTION_FIXTURE.content;
    for (const planned_fallback of ['', '   ', 'x'.repeat(LIMITS.plannedFallbackChars + 1), 42]) {
      const c = DecisionContentV1.parse({ ...base, planned_fallback });
      expect(c.planned_fallback).toBeUndefined();
      expect(c.question).toBe(base.question);
    }
    expect(
      DecisionContentV1.parse({
        ...base,
        planned_fallback: 'x'.repeat(LIMITS.plannedFallbackChars),
      }).planned_fallback,
    ).toHaveLength(LIMITS.plannedFallbackChars);
  });

  it('shows the plan of the advisory round only, and the deadline alone when the plan is unreadable', () => {
    const q = signed(ADVISORY_QUESTION_FIXTURE);
    const content = DecisionContentV1.parse(ADVISORY_QUESTION_FIXTURE.content);
    expect(advisoryPlanOf(q, 0, content)).toEqual({
      deadline: q.record.expires_at,
      fallback: content.planned_fallback,
    });
    expect(advisoryPlanOf(q, 1, content)).toBeNull();
    expect(
      advisoryPlanOf(q, 0, DecisionContentV1.parse({ ...content, planned_fallback: ' ' })),
    ).toEqual({
      deadline: q.record.expires_at,
      fallback: null,
    });
    expect(advisoryPlanOf(q, 0, null)).toEqual({ deadline: q.record.expires_at, fallback: null });
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
    kind: 'choice' as const,
    expiresAt: ADVISORY_QUESTION_FIXTURE.record.expires_at,
    plannedFallback: ADVISORY_QUESTION_FIXTURE.content.planned_fallback,
  };

  it('admits an ungated, finite, explained question that every party supports', () => {
    expect(advisoryRefusal(ok)).toBeNull();
  });

  it('needs every permission explicitly; none defaults to allowed', () => {
    expect(advisoryRefusal({ ...ok, relaySupport: false })).toBe('relay-unsupported');
    expect(advisoryRefusal({ ...ok, hostSupport: false })).toBe('host-unsupported');
    expect(advisoryRefusal({ ...ok, policyAllows: false })).toBe('policy-disallowed');
    expect(advisoryRefusal({ ...ok, readerSupport: false })).toBe('no-capable-reader');
    // Host support alone, or policy alone, is never enough.
    expect(advisoryRefusal({ ...ok, policyAllows: false, hostSupport: true })).not.toBeNull();
    expect(advisoryRefusal({ ...ok, hostSupport: false, policyAllows: true })).not.toBeNull();
  });

  it('never weakens a named or an origin-bound gate, registered or not', () => {
    expect(advisoryRefusal({ ...ok, originGateId: 'design-review/final' })).toBe('gated');
    expect(advisoryRefusal({ ...ok, namedGateId: 'design-review/final' })).toBe('gated');
    expect(advisoryRefusal({ ...ok, originGateId: 'a', namedGateId: 'b' })).toBe('gated');
    expect(advisoryRefusal({ ...ok, namedGateId: 'no-such-gate' })).toBe('gated');
    expect(advisoryRefusal({ ...ok, kind: 'approval' })).toBe('approval');
  });

  it('needs a finite deadline and a plan', () => {
    expect(advisoryRefusal({ ...ok, expiresAt: null })).toBe('no-deadline');
    expect(advisoryRefusal({ ...ok, plannedFallback: undefined })).toBe('invalid-plan');
    expect(advisoryRefusal({ ...ok, plannedFallback: '  ' })).toBe('invalid-plan');
    expect(
      advisoryRefusal({ ...ok, plannedFallback: 'x'.repeat(LIMITS.plannedFallbackChars + 1) }),
    ).toBe('invalid-plan');
  });

  it('declares the extension', () => {
    expect(ProtocolFeature.safeParse('advisory-deadlines-v1').success).toBe(true);
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
    // Its loose record alone would have kept a marker it does not understand: that is why the mode is in the AAD.
    expect(Legacy080Question.QuestionRecord.safeParse(adv.record).success).toBe(true);
    expect(
      Legacy080Question.CreatedEventData.safeParse(created(signed(BLOCKING_APPROVAL_FIXTURE)))
        .success,
    ).toBe(true);
  });

  it('a blocking question reads and signs exactly as before', () => {
    const block = signed(BLOCKING_APPROVAL_FIXTURE);
    const current = SignedQuestion.parse(block);
    const legacy = Legacy080Question.CreatedEventData.parse(created(block));
    expect(canonicalize(current.envelope)).toBe(canonicalize(legacy.envelope));
    expect(signingString(QuestionRecord.parse(block.record))).toBe(signingString(legacy.record));
  });

  it('the published JSON Schemas are closed where a strict reader would refuse the advisory fields', () => {
    const bundle = JSON.parse(
      readFileSync(fileURLToPath(new URL('../schemas.json', import.meta.url)), 'utf8'),
    ) as Record<string, any>;
    const aad = bundle.CryptoEnvelope.properties.aad;
    expect(aad.additionalProperties).toBe(false);
    expect(aad.properties.reply_mode).toEqual({ type: 'string', const: 'advisory' });
    expect(bundle.DecisionContentV1.additionalProperties).toBe(false);
    expect(bundle.DecisionContentV1.properties).toHaveProperty('planned_fallback');
  });
});
