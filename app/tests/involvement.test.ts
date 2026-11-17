import { describe, expect, it, vi } from 'vitest';
import {
  EventsPage,
  LIMITS,
  type InvolvementRecord,
  type LedgerEvent,
} from '@daintreehq/decisions-protocol';
import { newId } from '@daintreehq/decisions-crypto';
import { InvolvementStore, type InvolvementDeps } from '../src/data/involvement.js';
import { RelayError } from '../src/data/relay.js';
import { QuestionStore } from '../src/domain/model.js';
import {
  buildInvolvementRecord,
  defaultOverrideEnd,
  draftError,
  draftOf,
  draftsEqual,
  fromLocalInput,
  inForce,
  involvementSummary,
  preparationLine,
  recordMatches,
  servedRevision,
  toLocalInput,
  verifyInvolvementResponse,
  type InvolvementDraft,
} from '../src/domain/involvement.js';
import { makeWorld, otherDesktop, plainEvent, type Actor, type World } from './helpers.js';

const T0 = Date.parse('2026-11-17T09:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

const draft = (o: Partial<InvolvementDraft> = {}): InvolvementDraft => ({
  normalMode: 'recommend',
  consultCount: 3,
  override: null,
  ...o,
});

function sign(w: World, d: InvolvementDraft, currentRevision = 0, signer: Actor = w.phone) {
  return buildInvolvementRecord({
    installationId: w.installationId,
    deviceId: signer.id,
    signingKey: signer.keys.signing.privateKey,
    currentRevision,
    draft: d,
  });
}

const served = (r: InvolvementRecord | null) => ({
  preference: r,
  received_at: r ? iso(T0) : null,
});

const ctx = (w: World) => ({ installationId: w.installationId, trust: w.trust });

describe('verifying the preference the relay serves', () => {
  it('shows a record this installation’s phone signed', async () => {
    const w = await makeWorld();
    const r = await sign(
      w,
      draft({ override: { mode: 'involve-early', until: iso(T0 + HOUR) } }),
      2,
    );
    expect(r.revision).toBe(3);
    const v = await verifyInvolvementResponse(served(r), ctx(w));
    expect(v).toEqual({ ok: true, value: { record: r, receivedAt: iso(T0) } });
  });

  it('reads "nobody has set one" as an empty preference', async () => {
    const w = await makeWorld();
    expect(await verifyInvolvementResponse(served(null), ctx(w))).toEqual({
      ok: true,
      value: { record: null, receivedAt: null },
    });
  });

  it('refuses a record the relay changed, whatever field it touched', async () => {
    const w = await makeWorld();
    const r = await sign(w, draft({ override: { mode: 'involve-early', until: iso(T0 + HOUR) } }));
    for (const tampered of [
      { ...r, normal_mode: 'involve-early' },
      { ...r, consult_count: 5 },
      { ...r, revision: 9 },
      { ...r, override: null },
      { ...r, override: { mode: 'involve-early', until: iso(T0 + 2 * HOUR) } },
    ]) {
      const v = await verifyInvolvementResponse(served(tampered as InvolvementRecord), ctx(w));
      expect(v, JSON.stringify(tampered)).toEqual({
        ok: false,
        reason: 'preference signature does not match',
      });
    }
  });

  it('only a phone or tablet speaks for the person: a desktop’s record is refused', async () => {
    const w = await makeWorld();
    const desktop = await otherDesktop(w);
    for (const signer of [w.owner, desktop]) {
      const r = await sign(w, draft(), 0, signer);
      expect(await verifyInvolvementResponse(served(r), ctx(w))).toEqual({
        ok: false,
        reason: 'only a phone or tablet sets the involvement preference',
      });
    }
  });

  it('refuses a revoked phone’s record, another installation’s and an unknown signer’s', async () => {
    const w = await makeWorld();
    const r = await sign(w, draft());
    w.trust.markRevoked(w.phone.id, iso(T0));
    expect(await verifyInvolvementResponse(served(r), ctx(w))).toMatchObject({
      ok: false,
      reason: 'preference signer was revoked',
    });

    const w2 = await makeWorld();
    const foreign = await sign(w2, draft());
    expect(
      await verifyInvolvementResponse(served(foreign), { ...ctx(w2), installationId: newId() }),
    ).toMatchObject({ ok: false, reason: 'preference belongs to another installation' });
    expect(
      await verifyInvolvementResponse(
        served({ ...foreign, installation_id: w.installationId }),
        ctx(w),
      ),
    ).toMatchObject({ ok: false, reason: 'unknown signer' });
  });

  it('refuses a malformed response, but still reads the revision a new save must replace', async () => {
    const w = await makeWorld();
    const r = await sign(w, draft(), 6);
    expect(await verifyInvolvementResponse({ preference: 'x' }, ctx(w))).toMatchObject({
      ok: false,
    });
    expect(servedRevision(served(r))).toBe(7);
    expect(servedRevision(served(null))).toBe(0);
    expect(servedRevision({ nope: true })).toBe(0);
  });
});

describe('the preference in force', () => {
  it('is the temporary mode until it ends and the normal one after, at the same revision', async () => {
    const w = await makeWorld();
    const until = T0 + HOUR;
    const r = await sign(w, draft({ override: { mode: 'involve-early', until: iso(until) } }), 4);
    const during = inForce(r, until - 1)!;
    const after = inForce(r, until)!;
    expect(during).toMatchObject({
      mode: 'involve-early',
      override_active: true,
      until: iso(until),
    });
    expect(after).toMatchObject({ mode: 'recommend', override_active: false, until: null });
    expect(after.revision).toBe(during.revision);
    expect(inForce(null, T0)).toBeNull();
  });

  it('the form leaves out a temporary mode that has ended, so it is never saved again', async () => {
    const w = await makeWorld();
    const r = await sign(w, draft({ override: { mode: 'involve-early', until: iso(T0 + HOUR) } }));
    expect(draftOf(r, T0).override).toEqual({ mode: 'involve-early', until: iso(T0 + HOUR) });
    expect(draftOf(r, T0 + HOUR).override).toBeNull();
    expect(draftOf(null, T0)).toEqual({
      normalMode: 'involve-early',
      consultCount: 3,
      override: null,
    });
    expect(recordMatches(r, draftOf(r, T0))).toBe(true);
    expect(recordMatches(r, draft())).toBe(false);
  });

  it('summarises what is in force for the Settings index', async () => {
    const w = await makeWorld();
    expect(involvementSummary(undefined, T0)).toBe('');
    expect(involvementSummary(null, T0)).toBe('Not set');
    const r = await sign(w, draft({ override: { mode: 'involve-early', until: iso(T0 + HOUR) } }));
    expect(involvementSummary(r, T0)).toMatch(/^Involve me early until /);
    expect(involvementSummary(r, T0 + HOUR)).toBe('Recommendations');
  });
});

describe('editing', () => {
  it('a temporary mode must end in the future and within the limit', () => {
    const at = (ms: number) => draft({ override: { mode: 'involve-early', until: iso(ms) } });
    expect(draftError(draft(), T0)).toBeNull();
    expect(draftError(at(T0 + 60_000), T0)).toBeNull();
    expect(draftError(at(T0), T0)).toMatch(/future/);
    expect(draftError(at(T0 + LIMITS.involvementOverrideMaxMs + 1), T0)).toMatch(/at most 30 days/);
    expect(draftError(draft({ override: { mode: 'recommend', until: '' } }), T0)).toMatch(/ends/);
    expect(draftError(draft({ consultCount: 0 }), T0)).toMatch(/between 1 and/);
    expect(draftError(draft({ consultCount: LIMITS.involvementConsultMax + 1 }), T0)).toMatch(
      /between 1 and/,
    );
  });

  it('reads and writes the date-time field in this device’s time zone', () => {
    const local = '2026-11-17T15:30';
    const utc = fromLocalInput(local)!;
    expect(utc).toBe(new Date(2026, 10, 17, 15, 30).toISOString());
    expect(utc).toMatch(/\.000Z$/);
    expect(toLocalInput(utc)).toBe(local);
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('tomorrow')).toBeNull();
    expect(toLocalInput('')).toBe('');
  });

  it('offers a temporary mode ending a couple of hours from now, on a quarter hour', () => {
    const end = Date.parse(defaultOverrideEnd(T0 + 7 * 60_000));
    expect(end).toBeGreaterThanOrEqual(T0 + 2 * HOUR);
    expect(end % (15 * 60_000)).toBe(0);
  });

  it('compares drafts by meaning, not by the spelling of the time', () => {
    const a = draft({ override: { mode: 'recommend', until: '2026-11-17T15:00:00.000Z' } });
    expect(
      draftsEqual(a, { ...a, override: { mode: 'recommend', until: '2026-11-17T15:00:00Z' } }),
    ).toBe(true);
    expect(draftsEqual(a, draft())).toBe(false);
  });
});

describe('the preparation report, in words', () => {
  it('says what the agent says happened, attributed to it', () => {
    expect(
      preparationLine({ preference_revision: 2, agents_consulted: 3, outcome: 'agreed' }),
    ).toBe('It says it consulted 3 other agents and they agreed.');
    expect(preparationLine({ preference_revision: 2, agents_consulted: 1, outcome: 'split' })).toBe(
      'It says it consulted 1 other agent and they didn’t agree.',
    );
    expect(
      preparationLine({ preference_revision: null, agents_consulted: 0, outcome: 'not-run' }),
    ).toBe('It says no consultation took place.');
  });
});

/** A relay holding one preference, compare-and-swapping like the real one. */
function fakeRelay(w: World) {
  let current: InvolvementRecord | null = null;
  const puts: InvolvementRecord[] = [];
  let failNext: Error | null = null;
  const deps: InvolvementDeps = {
    fetch: vi.fn(async () => served(current)),
    put: vi.fn(async (r: InvolvementRecord) => {
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      const have = current?.revision ?? 0;
      if (r.revision !== have + 1)
        throw new RelayError('revision_conflict', 409, 'stale', { latest_revision: have });
      puts.push(r);
      current = r;
      return { revision: r.revision, event_seq: 1 };
    }),
    verify: (raw) => verifyInvolvementResponse(raw, ctx(w)),
    sign: (d, rev) => sign(w, d, rev),
  };
  return {
    deps,
    puts,
    /** Another device saves its own preference. */
    setCurrent: (r: InvolvementRecord | null) => (current = r),
    get current() {
      return current;
    },
    failWith: (e: Error) => (failNext = e),
  };
}

const hint = (): LedgerEvent => plainEvent('involvement.updated', null, { revision: 1 });

describe('the involvement store', () => {
  it('reads on demand and saves over the revision it read', async () => {
    const w = await makeWorld();
    const relay = fakeRelay(w);
    const s = new InvolvementStore(relay.deps);
    expect(s.get().status).toBe('idle');
    await s.load();
    expect(s.get()).toMatchObject({ status: 'ready', record: null, revision: 0 });
    expect(await s.save(draft())).toEqual({ kind: 'saved' });
    expect(relay.puts[0]!.revision).toBe(1);
    expect(s.get()).toMatchObject({ status: 'ready', revision: 1, record: relay.puts[0] });
    expect(await s.save(draft({ normalMode: 'involve-early' }))).toEqual({ kind: 'saved' });
    expect(relay.puts[1]!.revision).toBe(2);
  });

  it('a save on top of another device’s change is refused and reported, never re-signed over it', async () => {
    const w = await makeWorld();
    const relay = fakeRelay(w);
    const s = new InvolvementStore(relay.deps);
    await s.load();
    const tablet = await sign(w, draft({ normalMode: 'involve-early', consultCount: 5 }), 0);
    relay.setCurrent(tablet);
    expect(await s.save(draft())).toEqual({ kind: 'conflict' });
    expect(relay.puts).toHaveLength(0);
    expect(relay.current).toBe(tablet);
    // What is set now has been read, so a deliberate save goes over it.
    expect(s.get()).toMatchObject({ status: 'ready', record: tablet, revision: 1 });
    expect(await s.save(draft())).toEqual({ kind: 'saved' });
    expect(relay.puts[0]!.revision).toBe(2);
  });

  it('a retried save whose first attempt landed is not a conflict', async () => {
    const w = await makeWorld();
    const relay = fakeRelay(w);
    const s = new InvolvementStore(relay.deps);
    await s.load();
    const mine = await sign(w, draft(), 0);
    relay.setCurrent(mine); // the first attempt landed; its answer never came back
    expect(await s.save(draft())).toEqual({ kind: 'saved' });
  });

  it('any other failure throws and leaves what was read in place', async () => {
    const w = await makeWorld();
    const relay = fakeRelay(w);
    const s = new InvolvementStore(relay.deps);
    await s.load();
    relay.failWith(new RelayError('network', 0, 'Could not reach the relay'));
    await expect(s.save(draft())).rejects.toThrow(/reach the relay/);
    expect(s.get()).toMatchObject({ status: 'ready', revision: 0 });
  });

  it('shows nothing from a record it cannot verify, but can replace it', async () => {
    const w = await makeWorld();
    const relay = fakeRelay(w);
    const forged = { ...(await sign(w, draft(), 3)), consult_count: 8 };
    relay.setCurrent(forged);
    const s = new InvolvementStore(relay.deps);
    await s.load();
    expect(s.get()).toMatchObject({ status: 'invalid', record: null, revision: 4 });
    expect(await s.save(draft())).toEqual({ kind: 'saved' });
    expect(relay.puts[0]!.revision).toBe(5);
  });

  it('a hint reads again only once something has read it here', async () => {
    const w = await makeWorld();
    const relay = fakeRelay(w);
    const s = new InvolvementStore(relay.deps);
    s.noteEvents([hint()]);
    expect(relay.deps.fetch).not.toHaveBeenCalled();
    await s.load();
    relay.setCurrent(await sign(w, draft({ normalMode: 'involve-early' }), 0));
    s.noteEvents([plainEvent('decision.snapshot.updated', newId(), {})]);
    expect(relay.deps.fetch).toHaveBeenCalledTimes(1);
    s.noteEvents([hint()]);
    await vi.waitFor(() => expect(s.get().record?.normal_mode).toBe('involve-early'));
  });

  it('a hint during a read is followed by one more read', async () => {
    const w = await makeWorld();
    const relay = fakeRelay(w);
    const s = new InvolvementStore(relay.deps);
    const next = await sign(w, draft({ consultCount: 7 }), 0);
    const first = s.load(); // reads nothing yet
    relay.setCurrent(next);
    s.noteEvents([hint()]);
    await first;
    expect(relay.deps.fetch).toHaveBeenCalledTimes(2);
    expect(s.get().record?.consult_count).toBe(7);
  });

  it('a first read that fails is an error; a later one keeps what was read', async () => {
    const w = await makeWorld();
    const relay = fakeRelay(w);
    const s = new InvolvementStore(relay.deps);
    (relay.deps.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    await expect(s.load()).rejects.toThrow('offline');
    expect(s.get()).toMatchObject({ status: 'error', problem: 'offline' });
    await s.load();
    expect(s.get().status).toBe('ready');
    (relay.deps.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    await expect(s.load()).rejects.toThrow('offline');
    expect(s.get().status).toBe('ready');
  });

  it('clear forgets the preference and drops a read still on its way', async () => {
    const w = await makeWorld();
    const relay = fakeRelay(w);
    relay.setCurrent(await sign(w, draft(), 0));
    let release!: () => void;
    (relay.deps.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((r) => (release = () => r(served(relay.current)))),
    );
    const s = new InvolvementStore(relay.deps);
    const heard = vi.fn();
    s.subscribe(heard);
    const late = s.load();
    s.clear();
    expect(s.get()).toMatchObject({ status: 'idle', record: null, revision: 0 });
    release();
    await late;
    expect(s.get()).toMatchObject({ status: 'idle', record: null });
    expect(heard).toHaveBeenCalled();
  });

  it('a save still on its way when the device is unpaired never lands in what comes after', async () => {
    const w = await makeWorld();
    const relay = fakeRelay(w);
    const s = new InvolvementStore(relay.deps);
    await s.load();
    let release!: () => void;
    (relay.deps.put as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ revision: 1, event_seq: 1 }))),
    );
    const saving = s.save(draft());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    s.clear();
    release();
    await expect(saving).rejects.toThrow(/unpaired/);
    expect(s.get().status).toBe('idle');
  });
});

describe('the hint on its way through sync', () => {
  it('parses in a page and leaves the questions alone', async () => {
    const w = await makeWorld();
    const h = hint();
    expect(
      EventsPage.safeParse({
        protocol_version: 1,
        from_exclusive: 0,
        high_water_seq: h.seq,
        events: [h],
        next_after: h.seq,
        has_more: false,
      }).success,
    ).toBe(true);
    const questions = new QuestionStore({
      installationId: w.installationId,
      trust: w.trust,
      epochKeys: () => w.epochs,
    });
    await questions.ingestAll([h]);
    expect(questions.list()).toEqual([]);
    expect(questions.malformedEvents).toBe(0);
    expect(questions.highestSeq).toBe(h.seq);
  });
});
