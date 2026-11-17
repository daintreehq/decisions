import { z } from 'zod';
import { LIMITS } from './limits.js';
import { Id, IsoTime, SigB64 } from './schema.js';
import { PROTOCOL_VERSION } from './version.js';

/*
 * The involvement preference (docs/protocol.md section 20): how involved the person wants to be right now, set on
 * a phone or tablet and read by agents through their desktop. One per installation. The relay keeps only the
 * latest signed record and compare-and-swaps on its revision; the record is signed, not encrypted, so the relay
 * sees the modes, the consult count and when a temporary mode ends. It describes how the person wants to take
 * part, never what an agent may do: no requirement, gate or approval reads it.
 */

/** The signed record's `type`. */
export const INVOLVEMENT_RECORD_TYPE = 'involvement.preference' as const;

/**
 * - `involve-early`: ask while exploring the options, rather than waiting for a finished recommendation;
 * - `recommend`: consult other agents first, try to agree, then bring the recommendation and its reasoning, or
 *   the disagreement and the alternatives.
 */
export const InvolvementMode = z.enum(['involve-early', 'recommend']);
export type InvolvementMode = z.infer<typeof InvolvementMode>;

/** A temporary mode, in force until `until` (exclusive), after which the normal mode applies again. */
export const InvolvementOverride = z.looseObject({
  mode: InvolvementMode,
  until: IsoTime,
});
export type InvolvementOverride = z.infer<typeof InvolvementOverride>;

export const InvolvementRecord = z.looseObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal(INVOLVEMENT_RECORD_TYPE),
  installation_id: Id,
  /** One more than the revision the signer replaced (0 when there was none). The relay compare-and-swaps on it. */
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  normal_mode: InvolvementMode,
  /** Other agents to consult before a recommendation (the asking agent excluded). */
  consult_count: z.number().int().min(1).max(LIMITS.involvementConsultMax),
  override: InvolvementOverride.nullable(),
  /** The signer's clock; shown, never used to order records. */
  created_at: IsoTime,
  /** A phone or tablet: only the person sets their involvement. */
  signer_device_id: Id,
  signature: SigB64,
});
export type InvolvementRecord = z.infer<typeof InvolvementRecord>;

/** `PUT /involvement` (phone, tablet). */
export const InvolvementBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  idempotency_key: Id,
  preference: InvolvementRecord,
});
export type InvolvementBody = z.infer<typeof InvolvementBody>;

/** `PUT /involvement` result: metadata only, so a stored receipt keeps no copy of an older preference. */
export const InvolvementReceipt = z.object({
  revision: z.number().int().min(1),
  event_seq: z.number().int().min(1),
});
export type InvolvementReceipt = z.infer<typeof InvolvementReceipt>;

/** `GET /involvement`. Reading it creates nothing: no question, event or notification. */
export const InvolvementResponse = z.object({
  /** The latest signed record, or null when nobody has set one. */
  preference: InvolvementRecord.nullable(),
  /** Relay time when the relay accepted `preference`; null with no preference. */
  received_at: IsoTime.nullable(),
});
export type InvolvementResponse = z.infer<typeof InvolvementResponse>;

/* ---------- rules ---------- */

export interface EffectiveInvolvement {
  /** The mode in force at `now`: the temporary one until it ends, then the normal one. */
  mode: InvolvementMode;
  normal_mode: InvolvementMode;
  consult_count: number;
  revision: number;
  /** True while a temporary mode is in force. */
  override_active: boolean;
  /** When the temporary mode in force ends; null when none is. */
  until: string | null;
}

/**
 * The preference in force at `now` (epoch ms), worked out on every read: a temporary mode applies while
 * `now < until` and the normal mode from `until` on. Nothing is written when it ends, so the revision does not
 * change: a reader that only compares revisions misses the end of a temporary mode.
 */
export function effectiveInvolvement(
  r: Pick<InvolvementRecord, 'normal_mode' | 'consult_count' | 'revision' | 'override'>,
  now: number,
): EffectiveInvolvement {
  const active = r.override !== null && now < Date.parse(r.override.until);
  return {
    mode: active ? r.override!.mode : r.normal_mode,
    normal_mode: r.normal_mode,
    consult_count: r.consult_count,
    revision: r.revision,
    override_active: active,
    until: active ? r.override!.until : null,
  };
}

/**
 * Why the relay refuses a new record at relay time `now`, or null. A temporary mode must end in the future and
 * no more than `LIMITS.involvementOverrideMaxMs` away (plus the request skew the relay allows).
 */
export function involvementWriteIssue(r: InvolvementRecord, now: number): string | null {
  if (!r.override) return null;
  const until = Date.parse(r.override.until);
  if (until <= now) return 'the temporary mode has already ended';
  if (until > now + LIMITS.involvementOverrideMaxMs + LIMITS.requestSkewMs)
    return 'the temporary mode ends too far ahead';
  return null;
}
