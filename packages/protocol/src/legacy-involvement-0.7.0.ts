import { z } from 'zod';
import { canonicalize } from './canonical.js';

/*
 * The involvement readers of 0.7.0, frozen: the desktop bridge's verified copy (`InvolvementSync` in
 * @daintreehq/decisions-client 0.7.0) and the phone app's store, which both take a record only from a phone or
 * tablet. They prove that a record set on the owner desktop (docs/protocol.md section 20) never steers such a reader
 * and never stops it taking a later phone-signed one. Never update them to match the current protocol: they stand
 * for software that is already installed.
 */

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const IsoTime = z.iso.datetime({ offset: false, precision: 3 });
const Mode = z.enum(['involve-early', 'recommend']);

const Record070 = z.looseObject({
  v: z.literal(1),
  type: z.literal('involvement.preference'),
  installation_id: Id,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  normal_mode: Mode,
  consult_count: z.number().int().min(1).max(8),
  override: z.looseObject({ mode: Mode, until: IsoTime }).nullable(),
  created_at: IsoTime,
  signer_device_id: Id,
  signature: z
    .string()
    .regex(/^[A-Za-z0-9_-]*$/)
    .length(86),
});
export type LegacyInvolvementRecord = z.infer<typeof Record070>;

const Response070 = z.object({
  preference: Record070.nullable(),
  received_at: IsoTime.nullable(),
});

/** What a 0.7.0 reader knows of a signer whose certificate chains to the pinned owner. */
export interface LegacyInvolvementSigner {
  role: 'owner-desktop' | 'desktop-host' | 'phone' | 'tablet';
  revoked: boolean;
  /** Checks a signature with this device's signing key. */
  verify(record: LegacyInvolvementRecord): Promise<boolean>;
}

export interface LegacyInvolvementContext {
  installationId: string;
  /** The certified signer, or null for a device the reader does not know. */
  signer(deviceId: string): LegacyInvolvementSigner | null;
}

const HUMAN: readonly string[] = ['phone', 'tablet'];

/* ---------------- the desktop ---------------- */

/** The desktop's verified copy, as 0.7.0 keeps it. */
export interface LegacyDesktopInvolvement {
  /** The authentic record at `high_water`, or null when the relay held none. */
  record: LegacyInvolvementRecord | null;
  /** The highest revision ever verified: a record below it is refused. */
  high_water: number;
  /** Authentic, but its signer was removed: kept to bar older records, and steers nothing. */
  status?: 'signer-revoked';
}

export const LEGACY_DESKTOP_INVOLVEMENT_START: LegacyDesktopInvolvement = {
  record: null,
  high_water: 0,
};

/**
 * One 0.7.0 desktop read of a `GET /involvement` body: the copy it keeps afterwards, and why it refused the body,
 * or null when it took it. A refusal leaves the copy exactly as it was. The directory lookup here cannot fail for a
 * while, so 0.7.0's `directory-unavailable` refusal has no counterpart: any throw is `unverifiable`.
 */
export async function legacyDesktopInvolvementRead(
  prev: LegacyDesktopInvolvement,
  raw: unknown,
  ctx: LegacyInvolvementContext,
): Promise<{ copy: LegacyDesktopInvolvement; refused: string | null }> {
  const parsed = Response070.safeParse(raw);
  if (!parsed.success) return { copy: prev, refused: 'malformed' };
  try {
    return await desktopAccept(prev, parsed.data.preference, ctx);
  } catch {
    // A hostile record can make canonicalising or verifying throw: refused like any other bad record.
    return { copy: prev, refused: 'unverifiable' };
  }
}

async function desktopAccept(
  prev: LegacyDesktopInvolvement,
  r: LegacyInvolvementRecord | null,
  ctx: LegacyInvolvementContext,
): Promise<{ copy: LegacyDesktopInvolvement; refused: string | null }> {
  const refuse = (refused: string) => ({ copy: prev, refused });
  if (!r) {
    if (prev.high_water > 0) return refuse('withheld');
    return { copy: { record: null, high_water: 0 }, refused: null };
  }
  if (r.revision < prev.high_water) return refuse('rollback');
  if (
    r.revision === prev.high_water &&
    prev.record &&
    canonicalize(r) !== canonicalize(prev.record)
  )
    return refuse('equivocation');
  const why = await desktopRejection(r, ctx);
  if (why === 'signer-revoked')
    return { copy: { record: r, high_water: r.revision, status: 'signer-revoked' }, refused: why };
  if (why) return refuse(why);
  return { copy: { record: r, high_water: r.revision }, refused: null };
}

async function desktopRejection(
  r: LegacyInvolvementRecord,
  ctx: LegacyInvolvementContext,
): Promise<string | null> {
  if (r.installation_id !== ctx.installationId) return 'wrong-installation';
  const signer = ctx.signer(r.signer_device_id);
  if (!signer) return 'unknown-signer';
  if (!HUMAN.includes(signer.role)) return 'set-by-non-human-device';
  if (!(await signer.verify(r))) return 'bad-signature';
  if (signer.revoked) return 'signer-revoked';
  return null;
}

/**
 * The record a 0.7.0 desktop hands its agents from its copy, or null when none steers them: none was kept, or its
 * signer has been removed (stored with the copy, or seen in the ledger since, which applies before the next read).
 */
export function legacyDesktopInvolvementSteering(
  copy: LegacyDesktopInvolvement,
  ctx: LegacyInvolvementContext,
): LegacyInvolvementRecord | null {
  if (copy.status === 'signer-revoked' || !copy.record) return null;
  return ctx.signer(copy.record.signer_device_id)?.revoked ? null : copy.record;
}

/* ---------------- the phone ---------------- */

/** The phone app's view, as 0.7.0 keeps it. */
export interface LegacyPhoneInvolvement {
  /** `invalid`: the relay holds a record this phone could not verify, so nothing from it is shown. */
  status: 'idle' | 'ready' | 'invalid';
  /** Verified, or null. */
  record: LegacyInvolvementRecord | null;
  /**
   * The revision the relay holds, verified or not. A form opened on it saves one more; a form opened earlier saves
   * its own base, is refused as a conflict, and the person's next save starts from here.
   */
  revision: number;
  problem: string | null;
}

export const LEGACY_PHONE_INVOLVEMENT_START: LegacyPhoneInvolvement = {
  status: 'idle',
  record: null,
  revision: 0,
  problem: null,
};

/** One 0.7.0 phone read of a `GET /involvement` body: what it shows afterwards. */
export async function legacyPhoneInvolvementRead(
  prev: LegacyPhoneInvolvement,
  raw: unknown,
  ctx: LegacyInvolvementContext,
): Promise<LegacyPhoneInvolvement> {
  // Never older than a verified record already shown; an unverified one sets no floor.
  const newer = (revision: number) => prev.status !== 'ready' || revision >= prev.revision;
  const parsed = Response070.safeParse(raw);
  const served = parsed.success ? (parsed.data.preference?.revision ?? 0) : 0;
  const problem = parsed.success
    ? await phoneRejection(parsed.data.preference, ctx)
    : 'malformed involvement response';
  if (problem === null) {
    const record = parsed.success ? parsed.data.preference : null;
    const revision = record?.revision ?? 0;
    if (!newer(revision)) return prev;
    return { status: 'ready', record, revision, problem: null };
  }
  if (!newer(served)) return prev;
  return { status: 'invalid', record: null, revision: served, problem };
}

async function phoneRejection(
  r: LegacyInvolvementRecord | null,
  ctx: LegacyInvolvementContext,
): Promise<string | null> {
  if (!r) return null;
  if (r.installation_id !== ctx.installationId) return 'preference belongs to another installation';
  const signer = ctx.signer(r.signer_device_id);
  if (!signer) return 'unknown signer';
  if (!HUMAN.includes(signer.role)) return 'only a phone or tablet sets the involvement preference';
  if (signer.revoked) return 'preference signer was revoked';
  if (!(await signer.verify(r))) return 'preference signature does not match';
  return null;
}
