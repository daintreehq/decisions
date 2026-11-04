import { describe, expect, it } from 'vitest';
import {
  DeviceInfo,
  EventType,
  EventsPage,
  InfoResponse,
  LEGACY_EVENT_TYPES,
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolFeature,
  ServerFrame,
  SocketTicketBody,
  buildEventsPage,
  formatFeatures,
  isEventVisible,
  knownFeatures,
  requiredFeaturesForEvent,
  type LedgerEvent,
} from '../src/index.js';
import {
  Legacy030,
  legacyDesktopCatchUp,
  legacyPhoneCatchUp,
  legacySocketReceive,
} from '../src/fixtures.js';

const ALL = new Set(ProtocolFeature.options);
const NONE = new Set<ProtocolFeature>();

const event = (
  seq: number,
  event_type: EventType,
  data: Record<string, unknown> = {},
): LedgerEvent => ({
  protocol_version: 1,
  seq,
  event_id: `evt_${String(seq).padStart(8, '0')}`,
  event_type,
  occurred_at: '2026-11-01T09:00:00.000Z',
  question_id: 'q_aaaaaaaa',
  question_revision: null,
  origin_device_id: null,
  data,
});
const withImages = { record: { attachment_ids: ['att_aaaaaaaa'] } };

/** A ledger mixing every kind of event, with stretches of hidden events in the middle and at the end. */
function mixedLedger(): LedgerEvent[] {
  const types: [EventType, Record<string, unknown>?][] = [
    ['decision.created'],
    ['decision.answer.committed', { record: {} }],
    ['decision.message.posted', { record: { attachment_ids: [] } }],
    ['delivery.message'],
    ['decision.snapshot.refresh_requested'],
    ['decision.snapshot.updated'],
    ['delivery.terminal_delivered'],
    ['decision.message.posted', withImages],
    ['decision.answer.overridden', withImages],
    ['decision.created'],
    ['decision.answer.committed', withImages],
    ['delivery.received'],
    ['decision.snapshot.updated'],
    ['decision.message.posted', { record: { attachment_ids: [] } }],
  ];
  return types.map(([t, d], i) => event(i + 1, t, d));
}

/** A relay that holds `ledger` and pages it with `buildEventsPage` for a client with `features`. */
const relay =
  (ledger: LedgerEvent[], features: ReadonlySet<ProtocolFeature>, limit: number, maxBytes = 1e9) =>
  (after: number) =>
    buildEventsPage({
      after,
      highWater: ledger.at(-1)?.seq ?? 0,
      events: ledger.filter((e) => e.seq > after),
      features,
      limit,
      maxBytes,
    });

describe('feature declarations', () => {
  it('reads known features and ignores the rest', () => {
    expect(
      [...knownFeatures(['thread-messages-v1', 'teleport-v9', 'pane-snapshots-v1'])].sort(),
    ).toEqual(['pane-snapshots-v1', 'thread-messages-v1']);
    expect([...knownFeatures('phone-images-v1, nonsense')]).toEqual(['phone-images-v1']);
    expect(knownFeatures(undefined).size).toBe(0);
    expect(knownFeatures('').size).toBe(0);
  });
  it('formats a declaration stably for a signed query', () => {
    expect(formatFeatures(['thread-messages-v1', 'pane-snapshots-v1', 'thread-messages-v1'])).toBe(
      'pane-snapshots-v1,thread-messages-v1',
    );
  });
  it('accepts a 0.3.0 ticket body and a declaring one', () => {
    expect(SocketTicketBody.safeParse({ protocol_version: 1 }).success).toBe(true);
    expect(
      SocketTicketBody.safeParse({ protocol_version: 1, features: ['thread-messages-v1'] }).success,
    ).toBe(true);
    expect(
      SocketTicketBody.safeParse({
        protocol_version: 1,
        features: Array(LIMITS.featuresPerDeclaration + 1).fill('x'),
      }).success,
    ).toBe(false);
    expect(
      SocketTicketBody.safeParse({ protocol_version: 1, features: ['Bad Token'] }).success,
    ).toBe(false);
  });
  it('a newer peer advertising features this version does not know still parses', () => {
    const info = {
      name: 'daintree-decisions',
      protocol_min: 1,
      protocol_max: 1,
      worker_version: 'x',
      claimed: true,
      claim_configured: true,
      voice: { xai: false, anthropic: false, openai: false },
      features: ['thread-messages-v1', 'holograms-v3'],
    };
    expect(InfoResponse.safeParse(info).success).toBe(true);
    const { features: _f, ...without } = info;
    expect(InfoResponse.safeParse(without).success).toBe(true);
    expect(DeviceInfo.shape.features.safeParse(['holograms-v3']).success).toBe(true);
  });
  it('keeps protocol version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('which events need which features', () => {
  it('0.3.0 events need nothing, and every newer type needs a feature', () => {
    const legacy = new Set<string>(LEGACY_EVENT_TYPES);
    expect([...legacy].sort()).toEqual([...Legacy030.EventType.options].sort());
    for (const t of EventType.options) {
      const required = requiredFeaturesForEvent(event(1, t, { record: {} }));
      if (legacy.has(t)) expect(required, t).toEqual([]);
      else expect(required!.length, t).toBeGreaterThan(0);
    }
  });
  it('messages need threads, snapshots need snapshots, and images need images on top', () => {
    expect(
      requiredFeaturesForEvent(
        event(1, 'decision.message.posted', { record: { attachment_ids: [] } }),
      ),
    ).toEqual(['thread-messages-v1']);
    expect(requiredFeaturesForEvent(event(1, 'decision.message.posted', withImages))).toEqual([
      'thread-messages-v1',
      'phone-images-v1',
    ]);
    expect(requiredFeaturesForEvent(event(1, 'delivery.message'))).toEqual(['thread-messages-v1']);
    expect(requiredFeaturesForEvent(event(1, 'decision.snapshot.updated'))).toEqual([
      'pane-snapshots-v1',
    ]);
    expect(requiredFeaturesForEvent(event(1, 'decision.answer.committed', withImages))).toEqual([
      'phone-images-v1',
    ]);
    expect(requiredFeaturesForEvent(event(1, 'decision.answer.overridden', withImages))).toEqual([
      'phone-images-v1',
    ]);
    // a proxy answer can never name images, so its data is not inspected
    expect(requiredFeaturesForEvent(event(1, 'decision.proxy.committed', withImages))).toEqual([]);
  });
  it('an event type this version does not know is never sent', () => {
    const odd = { event_type: 'decision.teleported', data: {} } as unknown as LedgerEvent;
    expect(requiredFeaturesForEvent(odd)).toBeNull();
    expect(isEventVisible(odd, ALL)).toBe(false);
  });
});

describe('a client pinned to 0.3.0', () => {
  it('would reject a page or frame holding a new event, which is the problem', () => {
    const ledger = mixedLedger();
    const unfiltered = relay(ledger, ALL, 100)(0);
    expect(Legacy030.EventsPage.safeParse(unfiltered).success).toBe(false);
    const frame = { t: 'event', event: ledger.find((e) => e.event_type === 'delivery.message') };
    expect(legacySocketReceive([frame]).dropped).toHaveLength(1);
  });

  it('pages through a filtered ledger to the end, at any page size, as the desktop and as the phone', async () => {
    const ledger = mixedLedger();
    const want = ledger.filter((e) => isEventVisible(e, NONE)).map((e) => e.seq);
    for (const limit of [1, 2, 3, 5, 100]) {
      const desktop = await legacyDesktopCatchUp(relay(ledger, NONE, limit));
      expect(
        desktop.events.map((e) => e.seq),
        `desktop limit ${limit}`,
      ).toEqual(want);
      expect(desktop.cursor, `desktop limit ${limit}`).toBe(ledger.length);
      const phone = await legacyPhoneCatchUp(relay(ledger, NONE, limit));
      expect(
        phone.events.map((e) => e.seq),
        `phone limit ${limit}`,
      ).toEqual(want);
      expect(phone.cursor, `phone limit ${limit}`).toBe(ledger.length);
    }
  });

  it('does not stall on a ledger that is all hidden past its cursor', async () => {
    const ledger = [
      event(1, 'decision.created'),
      ...Array.from({ length: 10 }, (_, i) => event(i + 2, 'decision.snapshot.updated')),
    ];
    const page = relay(ledger, NONE, 2)(1);
    expect(page).toMatchObject({ events: [], has_more: false, next_after: 11 });
    expect(Legacy030.EventsPage.safeParse(page).success).toBe(true);
    expect((await legacyDesktopCatchUp(relay(ledger, NONE, 2), 1)).cursor).toBe(11);
    expect((await legacyPhoneCatchUp(relay(ledger, NONE, 2), 1)).cursor).toBe(11);
  });

  it('a byte cut stops at the last event sent and never skips a visible one', async () => {
    const ledger = mixedLedger();
    const size = JSON.stringify(ledger[0]).length;
    const desktop = await legacyDesktopCatchUp(relay(ledger, NONE, 100, size * 1.5));
    expect(desktop.events.map((e) => e.seq)).toEqual(
      ledger.filter((e) => isEventVisible(e, NONE)).map((e) => e.seq),
    );
    expect(desktop.pages).toBeGreaterThan(2);
  });

  it('receives a socket replay it can parse in full', () => {
    const ledger = mixedLedger();
    const frames: unknown[] = [];
    let after = 0;
    for (let i = 0; i < 20; i++) {
      const page = relay(ledger, NONE, 2)(after);
      frames.push(...page.events.map((e) => ({ t: 'event', event: e })));
      frames.push({ t: 'caught_up', high_water: page.next_after, has_more: page.has_more });
      after = page.next_after;
      if (!page.has_more) break;
    }
    const { accepted, dropped } = legacySocketReceive(frames.map((f) => JSON.stringify(f)));
    expect(dropped).toEqual([]);
    expect(accepted.at(-1)).toEqual({ t: 'caught_up', high_water: ledger.length, has_more: false });
  });

  it('never sees an answer that carries images, so it cannot deliver it without them', async () => {
    const { events } = await legacyDesktopCatchUp(relay(mixedLedger(), NONE, 100));
    expect(events.some((e) => (e.data as typeof withImages).record?.attachment_ids?.length)).toBe(
      false,
    );
  });
});

describe('events pages for any client', () => {
  /** Deterministic pseudo-random ledgers, so the cursor rules are checked beyond hand-written cases. */
  function* ledgers(): Generator<LedgerEvent[]> {
    let x = 7;
    const rand = () => (x = (x * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const types = EventType.options;
    for (let n = 0; n < 60; n++) {
      const len = Math.floor(rand() * 25);
      const out: LedgerEvent[] = [];
      let seq = 0;
      for (let i = 0; i < len; i++) {
        seq += 1 + Math.floor(rand() * 2); // holes, as deletion leaves them
        const t = types[Math.floor(rand() * types.length)]!;
        out.push(event(seq, t, rand() < 0.3 ? withImages : { record: { attachment_ids: [] } }));
      }
      yield out;
    }
  }
  const featureSets = [NONE, ALL, new Set<ProtocolFeature>(['thread-messages-v1'])];

  it('delivers every visible event exactly once, in order, never says more on an empty page, and ends at high water', () => {
    for (const ledger of ledgers()) {
      const highWater = ledger.at(-1)?.seq ?? 0;
      for (const features of featureSets) {
        for (const limit of [1, 3, 100]) {
          const seen: number[] = [];
          let after = 0;
          for (let guard = 0; ; guard++) {
            expect(guard).toBeLessThan(200);
            const page = relay(ledger, features, limit)(after);
            expect(EventsPage.safeParse(page).success).toBe(true);
            if (page.has_more) expect(page.events.length).toBeGreaterThan(0);
            expect(page.next_after).toBeGreaterThanOrEqual(after);
            for (const e of page.events) expect(isEventVisible(e, features)).toBe(true);
            seen.push(...page.events.map((e) => e.seq));
            after = page.next_after;
            if (!page.has_more) break;
          }
          expect(seen).toEqual(ledger.filter((e) => isEventVisible(e, features)).map((e) => e.seq));
          expect(after).toBe(highWater);
        }
      }
    }
  });

  it('never moves a cursor backwards or past what the relay holds', () => {
    const ledger = mixedLedger();
    const page = buildEventsPage({
      after: 50,
      highWater: 14,
      events: ledger,
      features: ALL,
      limit: 10,
      maxBytes: 1e9,
    });
    expect(page).toMatchObject({ events: [], next_after: 50, has_more: false });
    const capped = buildEventsPage({
      after: 0,
      highWater: 5,
      events: ledger,
      features: ALL,
      limit: 100,
      maxBytes: 1e9,
    });
    expect(capped.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(capped.next_after).toBe(5);
  });

  it('a client declaring every feature sees the whole ledger, and its frames parse', () => {
    const ledger = mixedLedger();
    const page = relay(ledger, ALL, 100)(0);
    expect(page.events).toHaveLength(ledger.length);
    for (const e of page.events) {
      expect(ServerFrame.safeParse({ t: 'event', event: e }).success).toBe(true);
    }
  });
});

describe('each feature set sees exactly its events', () => {
  // Seqs of mixedLedger(), worked out by hand from the contract, not from isEventVisible.
  const cases: [string, ProtocolFeature[], number[]][] = [
    ['nothing (0.3.0)', [], [1, 2, 7, 10, 12]],
    ['threads', ['thread-messages-v1'], [1, 2, 3, 4, 7, 10, 12, 14]],
    ['snapshots', ['pane-snapshots-v1'], [1, 2, 5, 6, 7, 10, 12, 13]],
    // an image-bearing message also needs threads, so images alone show only image-bearing answers
    ['images', ['phone-images-v1'], [1, 2, 7, 9, 10, 11, 12]],
    [
      'threads and images',
      ['thread-messages-v1', 'phone-images-v1'],
      [1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 14],
    ],
    ['everything', [...ProtocolFeature.options], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]],
  ];
  it.each(cases)('%s', (_name, declared, want) => {
    const ledger = mixedLedger();
    const features = new Set(declared);
    expect(relay(ledger, features, 100)(0).events.map((e) => e.seq)).toEqual(want);
    // paged two at a time, the same events arrive and the cursor ends at high water
    const seen: number[] = [];
    let after = 0;
    for (;;) {
      const page = relay(ledger, features, 2)(after);
      seen.push(...page.events.map((e) => e.seq));
      after = page.next_after;
      if (!page.has_more) break;
    }
    expect(seen).toEqual(want);
    expect(after).toBe(14);
  });
  it('a refresh request needs snapshots and nothing else', () => {
    expect(requiredFeaturesForEvent(event(1, 'decision.snapshot.refresh_requested'))).toEqual([
      'pane-snapshots-v1',
    ]);
  });
});

describe('the frozen 0.3.0 loops are as strict as the real ones', () => {
  const page = (o: Partial<{ events: LedgerEvent[]; next_after: number; has_more: boolean }>) => ({
    protocol_version: 1,
    from_exclusive: 0,
    high_water_seq: 10,
    events: [],
    next_after: 0,
    has_more: false,
    ...o,
  });
  const script = (pages: object[]) => {
    let i = 0;
    return () => pages[Math.min(i++, pages.length - 1)];
  };

  it('both fail on a page holding an event type 0.3.0 does not know', async () => {
    const bad = page({ events: [event(1, 'delivery.message')], next_after: 1 });
    await expect(legacyDesktopCatchUp(script([bad]))).rejects.toThrow();
    await expect(legacyPhoneCatchUp(script([bad]))).rejects.toThrow();
  });

  it('the desktop fails on a page that says more but does not advance', async () => {
    const stuck = page({ events: [], next_after: 0, has_more: true });
    await expect(legacyDesktopCatchUp(script([stuck]))).rejects.toThrow(/does not advance/);
  });

  it('the desktop moves to next_after; the phone moves only to its last event on a partial page', async () => {
    const partial = page({ events: [event(2, 'decision.created')], next_after: 5, has_more: true });
    const end = page({ events: [], next_after: 5, has_more: false });
    expect((await legacyDesktopCatchUp(script([partial, end]))).cursor).toBe(5);
    const phone = await legacyPhoneCatchUp((after) => (after === 0 ? partial : end));
    expect(phone.cursor).toBe(5);
    // the phone asked again from 2, its last event, not from next_after
    const asked: number[] = [];
    await legacyPhoneCatchUp((after) => {
      asked.push(after);
      return after === 0 ? partial : end;
    });
    expect(asked).toEqual([0, 2]);
  });

  it('the phone stops on an empty page even when it says more, and never moves its cursor', async () => {
    const empty = page({ events: [], next_after: 0, has_more: true });
    const r = await legacyPhoneCatchUp(script([empty]), 0);
    expect(r).toMatchObject({ cursor: 0, pages: 1, events: [] });
  });
});
