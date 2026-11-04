import { z } from 'zod';

/*
 * A test client shaped like 0.3.0: frozen copies of the wire schemas a client pinned to
 * @daintreehq/decisions-protocol 0.3.0 validates events with, and its two catch-up loops. They prove the relay's
 * feature filtering (docs/protocol.md section 19) keeps such a client working. Never update them to match the
 * current protocol: they stand for software that is already installed.
 */

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const IsoTime = z.iso.datetime({ offset: false, precision: 3 });

const EventType = z.enum([
  'decision.created',
  'decision.answer.committed',
  'decision.answer.overridden',
  'decision.proxy.committed',
  'decision.proxy.abstained',
  'decision.proxy.confirmed',
  'decision.cancelled',
  'decision.expired',
  'decision.reopened',
  'decision.deleted',
  'device.approved',
  'device.revoked',
  'device.key_rotated',
  'attachment.available',
  'delivery.received',
  'delivery.terminal_delivered',
  'delivery.needs_attention',
]);

const LedgerEvent = z.object({
  protocol_version: z.literal(1),
  seq: z.number().int().min(1),
  event_id: Id,
  event_type: EventType,
  occurred_at: IsoTime,
  question_id: Id.nullable(),
  question_revision: z.number().int().min(0).nullable(),
  origin_device_id: Id.nullable(),
  data: z.record(z.string(), z.unknown()),
});
type LedgerEvent030 = z.infer<typeof LedgerEvent>;

const EventsPage = z.object({
  protocol_version: z.literal(1),
  from_exclusive: z.number().int().min(0),
  high_water_seq: z.number().int().min(0),
  events: z.array(LedgerEvent),
  next_after: z.number().int().min(0),
  has_more: z.boolean(),
});

/** The socket frames a 0.3.0 client parses; a frame that fails is dropped and reported as an error. */
const ServerFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    protocol_version: z.literal(1),
    device_id: Id,
    role: z.enum(['owner-desktop', 'desktop-host', 'phone', 'tablet']),
    key_epoch: z.number().int(),
    high_water: z.number().int(),
    server_time: IsoTime,
  }),
  z.object({ t: z.literal('event'), event: LedgerEvent }),
  z.object({
    t: z.literal('caught_up'),
    high_water: z.number().int(),
    has_more: z.boolean().default(false),
  }),
  z.object({ t: z.literal('pairing'), pairing_id: Id }),
  z.object({
    t: z.literal('res'),
    id: z.string().max(64),
    status: z.number().int(),
    body: z.string(),
  }),
  z.object({ t: z.literal('revoked') }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }),
]);

/** 0.3.0 human answer content: a stripping object, so fields it does not know (such as `images`) vanish. */
const HumanAnswerContentV1 = z.object({
  content_version: z.literal(1).default(1),
  selected_option_ids: z.array(z.string().max(64)).max(12).default([]),
  text: z.string().optional(),
  reviewed_attachment_digests: z.array(z.string().regex(/^[0-9a-f]{64}$/)).default([]),
  explicit_approval: z.boolean().optional(),
  reason: z.string().max(2_000).optional(),
});

export const Legacy030 = {
  EventType,
  LedgerEvent,
  EventsPage,
  ServerFrame,
  HumanAnswerContentV1,
} as const;

export interface LegacyCatchUp {
  events: LedgerEvent030[];
  cursor: number;
  pages: number;
}

/**
 * `GET /events` paging as the 0.3.0 desktop does it (`DecisionsBridge.catchUp`): a page that fails the 0.3.0
 * schema throws (the whole catch-up fails), the cursor moves to `next_after`, a page that says `has_more` without
 * advancing throws, and the loop ends on `has_more: false`.
 */
export async function legacyDesktopCatchUp(
  fetchPage: (after: number) => unknown,
  cursor = 0,
  maxPages = 1_000,
): Promise<LegacyCatchUp> {
  const events: LedgerEvent030[] = [];
  let after = cursor;
  for (let pages = 1; pages <= maxPages; pages++) {
    const page = EventsPage.parse(await fetchPage(after));
    events.push(...page.events);
    if (page.next_after > after) after = page.next_after;
    else if (page.has_more)
      throw new Error('relay returned a page that does not advance the cursor');
    if (!page.has_more) return { events, cursor: after, pages };
  }
  throw new Error('catch-up did not finish');
}

/**
 * `GET /events` paging as the 0.3.0 phone app does it (`app/src/data/sync.ts`): a partial page moves the cursor
 * only to its last event, a complete one to `next_after`, and an empty page ends the loop even if it says
 * `has_more`.
 */
export async function legacyPhoneCatchUp(
  fetchPage: (after: number) => unknown,
  cursor = 0,
  maxPages = 1_000,
): Promise<LegacyCatchUp> {
  const events: LedgerEvent030[] = [];
  let at = cursor;
  for (let pages = 1; pages <= maxPages; pages++) {
    const page = EventsPage.parse(await fetchPage(at));
    const fresh = page.events.filter((e) => e.seq > at).sort((a, b) => a.seq - b.seq);
    if (fresh.length || page.next_after > at) {
      events.push(...fresh);
      at = page.has_more
        ? (fresh.at(-1)?.seq ?? at)
        : Math.max(page.next_after, fresh.at(-1)?.seq ?? 0);
    }
    if (!page.has_more || !fresh.length) return { events, cursor: at, pages };
  }
  throw new Error('catch-up did not finish');
}

/** Socket frames as a 0.3.0 client receives them: the ones it can parse, and the ones it would drop. */
export function legacySocketReceive(frames: readonly unknown[]): {
  accepted: z.infer<typeof ServerFrame>[];
  dropped: unknown[];
} {
  const accepted: z.infer<typeof ServerFrame>[] = [];
  const dropped: unknown[] = [];
  for (const f of frames) {
    const parsed = ServerFrame.safeParse(typeof f === 'string' ? JSON.parse(f) : f);
    if (parsed.success) accepted.push(parsed.data);
    else dropped.push(f);
  }
  return { accepted, dropped };
}
