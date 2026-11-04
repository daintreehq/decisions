import {
  LEGACY_EVENT_TYPES,
  ProtocolFeature,
  type EventType,
  type EventsPage,
  type LedgerEvent,
} from './schema.js';
import { PROTOCOL_VERSION } from './version.js';

/*
 * Feature negotiation (docs/protocol.md section 19). A 0.3.0 client validates every event page and socket frame
 * against a closed `EventType` enum and drops what fails, so the relay sends a client only the events its declared
 * features allow. The protocol version stays 1: everything new is opt-in, and a client that declares nothing sees
 * exactly the 0.3.0 protocol.
 */

/** The `features` query parameter of `GET /events`: a comma-separated list, sorted. */
export const FEATURES_QUERY_PARAM = 'features';

/** The known features in a declaration or advertisement. Unknown tokens are ignored, never an error. */
export function knownFeatures(
  list: readonly string[] | string | null | undefined,
): Set<ProtocolFeature> {
  const tokens = typeof list === 'string' ? list.split(',') : (list ?? []);
  const out = new Set<ProtocolFeature>();
  for (const t of tokens) {
    const f = ProtocolFeature.safeParse(t.trim());
    if (f.success) out.add(f.data);
  }
  return out;
}

/** The `features` query value for a declaration: sorted and comma-joined, so the signed query is stable. */
export function formatFeatures(features: Iterable<ProtocolFeature>): string {
  return [...new Set(features)].sort().join(',');
}

/**
 * The features each event type needs. A `Record` over the closed enum, so a new event type cannot compile without
 * a rule; the 0.3.0 types need none.
 */
const EVENT_FEATURES: Record<EventType, readonly ProtocolFeature[]> = {
  ...(Object.fromEntries(LEGACY_EVENT_TYPES.map((t) => [t, []])) as unknown as Record<
    (typeof LEGACY_EVENT_TYPES)[number],
    readonly ProtocolFeature[]
  >),
  'decision.message.posted': ['thread-messages-v1'],
  'delivery.message': ['thread-messages-v1'],
  'decision.snapshot.updated': ['pane-snapshots-v1'],
  'decision.snapshot.refresh_requested': ['pane-snapshots-v1'],
};

const hasImages = (record: unknown): boolean => {
  const ids = (record as { attachment_ids?: unknown } | null | undefined)?.attachment_ids;
  return Array.isArray(ids) && ids.length > 0;
};

/**
 * The features a client must have declared to be sent this event, or `null` for a type this version does not
 * know (never sent). An image-bearing answer or message also needs `phone-images-v1`: a 0.3.0 client parses answer
 * content with a stripping schema, so it would deliver the text and silently drop the images.
 */
export function requiredFeaturesForEvent(
  ev: Pick<LedgerEvent, 'event_type' | 'data'>,
): ProtocolFeature[] | null {
  const base = (EVENT_FEATURES as Record<string, readonly ProtocolFeature[] | undefined>)[
    ev.event_type
  ];
  if (!base) return null;
  const record = (ev.data as { record?: unknown } | null | undefined)?.record;
  const images =
    (ev.event_type === 'decision.message.posted' ||
      ev.event_type === 'decision.answer.committed' ||
      ev.event_type === 'decision.answer.overridden') &&
    hasImages(record);
  return images ? [...base, 'phone-images-v1'] : [...base];
}

export function isEventVisible(
  ev: Pick<LedgerEvent, 'event_type' | 'data'>,
  features: ReadonlySet<ProtocolFeature>,
): boolean {
  const required = requiredFeaturesForEvent(ev);
  return required !== null && required.every((f) => features.has(f));
}

/**
 * Builds one page of the events a client may see, for `GET /events` and for a socket `sync` replay. `events` are
 * the ledger events with `after < seq <= highWater`, in seq order; the relay may produce them lazily, and this
 * reads only as far as it needs.
 *
 * Cursor rules, so a 0.3.0 client never stalls on events it is not sent:
 * - `has_more` is true only when another visible event is left, so a page that says "more" is never empty;
 * - a page that ends the stream advances `next_after` to `highWater`, over any hidden events in between;
 * - a page cut by `limit` or `maxBytes` stops at its last event, and never skips a visible one.
 * The socket's `caught_up` frame carries `next_after` as `high_water` and the same `has_more`.
 */
export function buildEventsPage(i: {
  after: number;
  highWater: number;
  events: Iterable<LedgerEvent>;
  features: ReadonlySet<ProtocolFeature>;
  limit: number;
  maxBytes: number;
}): EventsPage {
  const page: LedgerEvent[] = [];
  let bytes = 0;
  let full = false;
  let hasMore = false;
  for (const ev of i.events) {
    if (ev.seq <= i.after || ev.seq > i.highWater) continue;
    if (!isEventVisible(ev, i.features)) continue;
    if (full) {
      hasMore = true;
      break;
    }
    const size = JSON.stringify(ev).length;
    if (page.length > 0 && bytes + size > i.maxBytes) {
      hasMore = true;
      break;
    }
    page.push(ev);
    bytes += size;
    if (page.length >= i.limit) full = true;
  }
  const last = page.length ? page[page.length - 1]!.seq : i.after;
  return {
    protocol_version: PROTOCOL_VERSION,
    from_exclusive: i.after,
    high_water_seq: i.highWater,
    events: page,
    next_after: hasMore ? last : Math.max(i.after, i.highWater),
    has_more: hasMore,
  };
}
