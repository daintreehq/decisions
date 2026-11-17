import { describe, expect, it } from 'vitest';
import {
  DecisionContentV1,
  EventData,
  InvolvementBody,
  InvolvementRecord,
  InvolvementResponse,
  LIMITS,
  PreparationReport,
  ROUTE_MANIFEST,
  effectiveInvolvement,
  involvementWriteIssue,
  isEventVisible,
  requiredFeaturesForEvent,
  type InvolvementRecord as Rec,
  type LedgerEvent,
} from '../src/index.js';

const SIG = 's'.repeat(86);
const T0 = Date.parse('2026-11-17T09:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const record = (o: Partial<Rec> = {}): Rec => ({
  v: 1,
  type: 'involvement.preference',
  installation_id: 'inst_00000001',
  revision: 3,
  normal_mode: 'recommend',
  consult_count: 3,
  override: null,
  created_at: iso(T0),
  signer_device_id: 'phone_000001',
  signature: SIG,
  ...o,
});

describe('the involvement record', () => {
  it('parses a normal preference and one with a temporary mode', () => {
    expect(InvolvementRecord.safeParse(record()).success).toBe(true);
    expect(
      InvolvementRecord.safeParse(
        record({ override: { mode: 'involve-early', until: iso(T0 + 3_600_000) } }),
      ).success,
    ).toBe(true);
  });

  it('refuses unknown modes, a zero or oversized consult count and revision 0', () => {
    const bad = [
      record({ normal_mode: 'whenever' as never }),
      record({ override: { mode: 'later' as never, until: iso(T0) } }),
      record({ consult_count: 0 }),
      record({ consult_count: LIMITS.involvementConsultMax + 1 }),
      record({ consult_count: 1.5 }),
      record({ revision: 0 }),
      record({ type: 'pane.snapshot' as never }),
      record({ override: { mode: 'recommend', until: 'tomorrow' } }),
    ];
    for (const r of bad)
      expect(InvolvementRecord.safeParse(r).success, JSON.stringify(r)).toBe(false);
  });

  it('keeps fields a newer signer added, so its signature still verifies', () => {
    const r = InvolvementRecord.parse({
      ...record({ override: { mode: 'recommend', until: iso(T0 + 1000), note: 'x' } as never }),
      later: true,
    });
    expect((r as Record<string, unknown>).later).toBe(true);
    expect((r.override as Record<string, unknown>).note).toBe('x');
  });

  it('a PUT body carries one record and an idempotency key; a GET may hold none', () => {
    expect(
      InvolvementBody.safeParse({
        protocol_version: 1,
        idempotency_key: 'idem_0000001',
        preference: record(),
      }).success,
    ).toBe(true);
    expect(InvolvementResponse.parse({ preference: null, received_at: null }).preference).toBe(
      null,
    );
  });

  it('is served at /involvement: read by any device, written only by phones and tablets', () => {
    const get = ROUTE_MANIFEST.find((r) => r.method === 'GET' && r.path === '/involvement');
    const put = ROUTE_MANIFEST.find((r) => r.method === 'PUT' && r.path === '/involvement');
    expect(get?.roles).toBe('any');
    expect(put?.roles).toEqual(['phone', 'tablet']);
  });
});

describe('the preference in force', () => {
  const until = T0 + 60 * 60_000;
  const r = record({
    normal_mode: 'recommend',
    override: { mode: 'involve-early', until: iso(until) },
  });

  it('is the temporary mode until it ends, then the normal one, with the same revision', () => {
    const during = effectiveInvolvement(r, until - 1);
    expect(during).toEqual({
      mode: 'involve-early',
      normal_mode: 'recommend',
      consult_count: 3,
      revision: 3,
      override_active: true,
      until: iso(until),
    });
    const at = effectiveInvolvement(r, until);
    expect(at.mode).toBe('recommend');
    expect(at.override_active).toBe(false);
    expect(at.until).toBeNull();
    expect(at.revision).toBe(during.revision);
  });

  it('is the normal mode with no temporary one', () => {
    expect(effectiveInvolvement(record({ normal_mode: 'involve-early' }), T0)).toMatchObject({
      mode: 'involve-early',
      override_active: false,
      until: null,
    });
  });
});

describe('what the relay accepts as a new record', () => {
  it('a temporary mode must end in the future and within the limit', () => {
    expect(involvementWriteIssue(record(), T0)).toBeNull();
    const at = (ms: number) => record({ override: { mode: 'recommend', until: iso(ms) } });
    expect(involvementWriteIssue(at(T0 + 1), T0)).toBeNull();
    expect(involvementWriteIssue(at(T0), T0)).toMatch(/already ended/);
    expect(involvementWriteIssue(at(T0 - 1), T0)).toMatch(/already ended/);
    const max = T0 + LIMITS.involvementOverrideMaxMs + LIMITS.requestSkewMs;
    expect(involvementWriteIssue(at(max), T0)).toBeNull();
    expect(involvementWriteIssue(at(max + 1), T0)).toMatch(/too far ahead/);
  });
});

describe('the involvement hint', () => {
  const hint = (): LedgerEvent => ({
    protocol_version: 1,
    seq: 9,
    event_id: 'evt_00000009',
    event_type: 'involvement.updated',
    occurred_at: iso(T0),
    question_id: null,
    question_revision: null,
    origin_device_id: 'phone_000001',
    data: { revision: 4 },
  });

  it('needs involvement-v1 and nothing else', () => {
    expect(requiredFeaturesForEvent(hint())).toEqual(['involvement-v1']);
    expect(isEventVisible(hint(), new Set())).toBe(false);
    expect(isEventVisible(hint(), new Set(['pane-snapshots-v1'] as const))).toBe(false);
    expect(isEventVisible(hint(), new Set(['involvement-v1'] as const))).toBe(true);
  });

  it('carries only the revision', () => {
    expect(EventData.involvementUpdated.parse(hint().data)).toEqual({ revision: 4 });
  });
});

describe('the preparation report', () => {
  const base = {
    question: 'Ship the new onboarding?',
    kind: 'choice' as const,
    options: [{ id: 'a', label: 'Ship' }],
  };

  it('travels in the question content and defaults its revision to null', () => {
    const c = DecisionContentV1.parse({
      ...base,
      preparation: { agents_consulted: 3, outcome: 'split', summary: 'Two for A, one for B.' },
    });
    expect(c.preparation).toEqual({
      preference_revision: null,
      agents_consulted: 3,
      outcome: 'split',
      summary: 'Two for A, one for B.',
    });
  });

  it('a question without one, from an older desktop, parses as before', () => {
    expect(DecisionContentV1.parse(base).preparation).toBeUndefined();
  });

  it('a malformed report is dropped and never makes the question unreadable', () => {
    for (const preparation of [
      { agents_consulted: -1, outcome: 'agreed' },
      { agents_consulted: 2, outcome: 'unanimous' },
      {
        agents_consulted: 2,
        outcome: 'agreed',
        summary: 'x'.repeat(LIMITS.preparationSummaryChars + 1),
      },
      'agreed',
    ]) {
      const c = DecisionContentV1.safeParse({ ...base, preparation });
      expect(c.success, JSON.stringify(preparation)).toBe(true);
      expect(c.data!.preparation).toBeUndefined();
    }
  });

  it('is strict on its own, so an agent hears what is wrong', () => {
    expect(PreparationReport.safeParse({ agents_consulted: 2, outcome: 'agreed' }).success).toBe(
      true,
    );
    expect(
      PreparationReport.safeParse({
        agents_consulted: LIMITS.preparationAgentsMax + 1,
        outcome: 'agreed',
      }).success,
    ).toBe(false);
    expect(
      PreparationReport.safeParse({
        preference_revision: 0,
        agents_consulted: 0,
        outcome: 'not-run',
      }).success,
    ).toBe(false);
  });
});
