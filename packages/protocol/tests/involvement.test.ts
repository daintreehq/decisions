import { describe, expect, it } from 'vitest';
import {
  DecisionContentV1,
  EventData,
  INVOLVEMENT_SETTER_ROLES,
  InvolvementBody,
  InvolvementRecord,
  InvolvementResponse,
  LIMITS,
  PreparationReport,
  ROUTE_MANIFEST,
  effectiveInvolvement,
  involvementSetOn,
  involvementWriteIssue,
  isEventVisible,
  requiredFeaturesForEvent,
  type InvolvementRecord as Rec,
  type LedgerEvent,
  type Role,
} from '../src/index.js';
import {
  LEGACY_DESKTOP_INVOLVEMENT_START,
  LEGACY_PHONE_INVOLVEMENT_START,
  legacyDesktopInvolvementRead,
  legacyDesktopInvolvementSteering,
  legacyPhoneInvolvementRead,
  type LegacyInvolvementContext,
} from '../src/fixtures.js';

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

  it('is served at /involvement: read by any device, written by the owner desktop, phones and tablets', () => {
    const get = ROUTE_MANIFEST.find((r) => r.method === 'GET' && r.path === '/involvement');
    const put = ROUTE_MANIFEST.find((r) => r.method === 'PUT' && r.path === '/involvement');
    expect(get?.roles).toBe('any');
    expect([...(put?.roles as Role[])].sort()).toEqual(['owner-desktop', 'phone', 'tablet']);
    expect(put?.roles).not.toContain('desktop-host');
  });
});

describe('where the preference was set', () => {
  it('is the computer for the owner desktop and the phone for a phone or tablet', () => {
    expect(involvementSetOn('owner-desktop')).toBe('computer');
    expect(involvementSetOn('phone')).toBe('phone');
    expect(involvementSetOn('tablet')).toBe('phone');
  });

  it('is nothing for a Daintree Host, which never sets it', () => {
    expect(involvementSetOn('desktop-host')).toBeNull();
    expect(INVOLVEMENT_SETTER_ROLES).not.toContain('desktop-host');
  });

  it('changes nothing about the preference in force', () => {
    const fromPhone = record({ signer_device_id: 'dev_phone0001' });
    const fromComputer = record({ signer_device_id: 'dev_desktop01' });
    expect(effectiveInvolvement(fromComputer, T0)).toEqual(effectiveInvolvement(fromPhone, T0));
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

describe('the frozen 0.7.0 readers', () => {
  const PHONE = 'phone_000001';
  const OWNER = 'desk_0000001';
  const context = (revoked = false): LegacyInvolvementContext => ({
    installationId: 'inst_00000001',
    signer: (id) =>
      id === PHONE
        ? { role: 'phone', revoked, verify: async () => true }
        : id === OWNER
          ? { role: 'owner-desktop', revoked: false, verify: async () => true }
          : null,
  });
  const served = (r: Rec | null) => ({ preference: r, received_at: r ? iso(T0) : null });

  it('a refused owner record sets no revision floor: a lower phone record after it is still taken', async () => {
    const ctx = context();
    const r1 = record({ revision: 1 });
    const desktop = await legacyDesktopInvolvementRead(
      LEGACY_DESKTOP_INVOLVEMENT_START,
      served(r1),
      ctx,
    );
    const owner = await legacyDesktopInvolvementRead(
      desktop.copy,
      served(record({ revision: 5, signer_device_id: OWNER })),
      ctx,
    );
    expect(owner).toEqual({ copy: desktop.copy, refused: 'set-by-non-human-device' });
    const r3 = record({ revision: 3 });
    expect(await legacyDesktopInvolvementRead(owner.copy, served(r3), ctx)).toEqual({
      copy: { record: r3, high_water: 3 },
      refused: null,
    });

    const handset = await legacyPhoneInvolvementRead(
      await legacyPhoneInvolvementRead(LEGACY_PHONE_INVOLVEMENT_START, served(r1), ctx),
      served(record({ revision: 5, signer_device_id: OWNER })),
      ctx,
    );
    expect(handset).toMatchObject({ status: 'invalid', record: null, revision: 5 });
    expect(await legacyPhoneInvolvementRead(handset, served(r3), ctx)).toMatchObject({
      status: 'ready',
      record: r3,
      revision: 3,
    });
  });

  it('the desktop refuses a record it cannot canonicalise and keeps its copy', async () => {
    const ctx = context();
    const { copy } = await legacyDesktopInvolvementRead(
      LEGACY_DESKTOP_INVOLVEMENT_START,
      served(record({ revision: 1 })),
      ctx,
    );
    const hostile = { ...record({ revision: 1 }), note: '\ud800' };
    expect(await legacyDesktopInvolvementRead(copy, served(hostile), ctx)).toEqual({
      copy,
      refused: 'unverifiable',
    });
  });

  it('the desktop stops steering by a record whose signer was removed since, before reading again', async () => {
    const { copy } = await legacyDesktopInvolvementRead(
      LEGACY_DESKTOP_INVOLVEMENT_START,
      served(record({ revision: 1 })),
      context(),
    );
    expect(legacyDesktopInvolvementSteering(copy, context())).toEqual(record({ revision: 1 }));
    expect(legacyDesktopInvolvementSteering(copy, context(true))).toBeNull();
  });
});
