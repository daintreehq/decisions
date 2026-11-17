import {
  InvolvementResponse,
  LIMITS,
  effectiveInvolvement,
  type EffectiveInvolvement,
  type InvolvementMode,
  type InvolvementRecord,
  type PreparationReport,
  type Role,
} from '@daintreehq/decisions-protocol';
import { buildSignedInvolvement, verifyObject } from '@daintreehq/decisions-crypto';
import type { TrustStore } from './trust.js';
import type { Verified } from './verify.js';

/*
 * The involvement preference (docs/protocol.md section 20): how involved the person wants agents to make them right
 * now. This phone signs it; the relay keeps only the latest and compare-and-swaps on its revision. It never changes
 * what an agent may do, and nothing here touches a question.
 */

export const INVOLVEMENT_MODES: readonly InvolvementMode[] = ['involve-early', 'recommend'];

export const MODE_LABEL: Record<InvolvementMode, string> = {
  'involve-early': 'Involve me early',
  recommend: 'Bring me a recommendation',
};

export const MODE_DESCRIPTION: Record<InvolvementMode, string> = {
  'involve-early':
    'Agents ask while they explore the options, instead of waiting for a finished answer.',
  recommend:
    'Agents consult each other first and bring you what they recommend and why. If they can’t agree, they bring you the disagreement and the alternatives.',
};

/** The short form the Settings index shows beside the row. */
const MODE_SHORT: Record<InvolvementMode, string> = {
  'involve-early': 'Involve me early',
  recommend: 'Recommendations',
};

export const DEFAULT_CONSULT_COUNT = 3;

/** What the form edits: the record's settable fields, nothing signed. */
export interface InvolvementDraft {
  normalMode: InvolvementMode;
  consultCount: number;
  /** A temporary mode and when it ends (ISO, UTC), or null. */
  override: { mode: InvolvementMode; until: string } | null;
}

/** A verified `GET /involvement`: the record (null when nobody has set one) and when the relay accepted it. */
export interface InvolvementState {
  record: InvolvementRecord | null;
  receivedAt: string | null;
}

const HUMAN: readonly Role[] = ['phone', 'tablet'];

/**
 * Checks a `GET /involvement` response before anything in it is shown: the record is for this installation, its
 * signer is a phone or tablet the pinned owner certified and that is not revoked, and the signature covers every
 * field. The relay is never believed about what the person chose.
 */
export async function verifyInvolvementResponse(
  raw: unknown,
  ctx: { installationId: string; trust: TrustStore },
): Promise<Verified<InvolvementState>> {
  const parsed = InvolvementResponse.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'malformed involvement response' };
  const { preference: record, received_at } = parsed.data;
  if (!record) return { ok: true, value: { record: null, receivedAt: null } };
  if (record.installation_id !== ctx.installationId)
    return { ok: false, reason: 'preference belongs to another installation' };
  const signer = ctx.trust.get(record.signer_device_id);
  if (!signer) return { ok: false, reason: 'unknown signer' };
  if (!HUMAN.includes(signer.role))
    return { ok: false, reason: 'only a phone or tablet sets the involvement preference' };
  if (signer.revokedAt) return { ok: false, reason: 'preference signer was revoked' };
  if (!(await verifyObject(signer.signingKey, record)))
    return { ok: false, reason: 'preference signature does not match' };
  return { ok: true, value: { record, receivedAt: received_at } };
}

/**
 * The revision the relay holds, read without trusting the record: it only sets the compare-and-swap of the next
 * write, which the relay checks itself. Lets the person replace a record this phone could not verify.
 */
export function servedRevision(raw: unknown): number {
  const parsed = InvolvementResponse.safeParse(raw);
  return parsed.success ? (parsed.data.preference?.revision ?? 0) : 0;
}

/** Signs the draft as the record that replaces revision `currentRevision` (0 when there is none). */
export function buildInvolvementRecord(i: {
  installationId: string;
  deviceId: string;
  signingKey: CryptoKey;
  currentRevision: number;
  draft: InvolvementDraft;
  createdAt?: string;
}): Promise<InvolvementRecord> {
  return buildSignedInvolvement({
    installationId: i.installationId,
    signerDeviceId: i.deviceId,
    signingKey: i.signingKey,
    revision: i.currentRevision + 1,
    normalMode: i.draft.normalMode,
    consultCount: i.draft.consultCount,
    override: i.draft.override,
    ...(i.createdAt ? { createdAt: i.createdAt } : {}),
  });
}

/** The preference in force at `now`, or null when nobody has set one. Expiry is worked out here, on every read. */
export function inForce(
  record: InvolvementRecord | null,
  now: number,
): EffectiveInvolvement | null {
  return record ? effectiveInvolvement(record, now) : null;
}

/**
 * The form's starting point for a record at `now`. A temporary mode that has already ended is left out: it no
 * longer applies, and the relay would refuse it if it were saved again.
 */
export function draftOf(record: InvolvementRecord | null, now: number): InvolvementDraft {
  if (!record)
    return { normalMode: 'involve-early', consultCount: DEFAULT_CONSULT_COUNT, override: null };
  const active = record.override && now < Date.parse(record.override.until);
  return {
    normalMode: record.normal_mode,
    consultCount: record.consult_count,
    override: active ? { mode: record.override!.mode, until: record.override!.until } : null,
  };
}

export function draftsEqual(a: InvolvementDraft, b: InvolvementDraft): boolean {
  return (
    a.normalMode === b.normalMode &&
    a.consultCount === b.consultCount &&
    (a.override === null) === (b.override === null) &&
    (a.override === null ||
      (a.override.mode === b.override!.mode &&
        Date.parse(a.override.until) === Date.parse(b.override!.until)))
  );
}

/** Whether `record` says what `draft` says (a save this phone sent, read back). */
export function recordMatches(record: InvolvementRecord | null, draft: InvolvementDraft): boolean {
  if (!record) return false;
  return draftsEqual(
    {
      normalMode: record.normal_mode,
      consultCount: record.consult_count,
      override: record.override
        ? { mode: record.override.mode, until: record.override.until }
        : null,
    },
    draft,
  );
}

/** Why this draft cannot be saved at `now`, or null. Mirrors the relay's own rule. */
export function draftError(d: InvolvementDraft, now: number): string | null {
  if (
    !Number.isInteger(d.consultCount) ||
    d.consultCount < 1 ||
    d.consultCount > LIMITS.involvementConsultMax
  )
    return `Choose between 1 and ${LIMITS.involvementConsultMax} agents`;
  if (!d.override) return null;
  const until = Date.parse(d.override.until);
  if (!Number.isFinite(until)) return 'Choose when the temporary mode ends';
  if (until <= now) return 'Choose an end time in the future';
  if (until > now + LIMITS.involvementOverrideMaxMs)
    return `A temporary mode can last at most ${Math.round(LIMITS.involvementOverrideMaxMs / 86_400_000)} days`;
  return null;
}

/** "3:00 pm" today, "Tue 18 Nov, 3:00 pm" on another day: always an absolute time, never "in 2 hours". */
export function endLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time}`;
}

/** The Settings index row: what is in force now, or "Not set". Empty while unknown. */
export function involvementSummary(
  record: InvolvementRecord | null | undefined,
  now: number,
): string {
  if (record === undefined) return '';
  const e = inForce(record, now);
  if (!e) return 'Not set';
  return e.until ? `${MODE_SHORT[e.mode]} until ${endLabel(e.until, now)}` : MODE_SHORT[e.mode];
}

/** A `datetime-local` value ("2026-11-17T15:00") for an ISO time, in this device's time zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The UTC ISO time (with milliseconds) a `datetime-local` value means here, or null for an empty or bad one. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const ms = new Date(value).getTime(); // a date-time without an offset is local time
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Where a new temporary mode ends by default: two hours from now, on the next quarter hour. */
export function defaultOverrideEnd(now: number): string {
  const quarter = 15 * 60_000;
  return new Date(Math.ceil((now + 2 * 3_600_000) / quarter) * quarter).toISOString();
}

/* ---------------- a question's preparation report ---------------- */

const agents = (n: number) => `${n} other agent${n === 1 ? '' : 's'}`;

/**
 * The asking agent's own account of how it prepared the question, in words. It is what the agent says happened:
 * nothing checked it, so it is never worded as a fact Decisions vouches for.
 */
export function preparationLine(p: PreparationReport): string {
  switch (p.outcome) {
    case 'agreed':
      return p.agents_consulted > 0
        ? `It says it consulted ${agents(p.agents_consulted)} and they agreed.`
        : 'It says it reached a recommendation.';
    case 'split':
      return p.agents_consulted > 0
        ? `It says it consulted ${agents(p.agents_consulted)} and they didn’t agree.`
        : 'It says the consultation didn’t reach an agreement.';
    case 'not-run':
      return 'It says no consultation took place.';
  }
}
