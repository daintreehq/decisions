import {
  DESKTOP_ROLES,
  EventData,
  HUMAN_ROLES,
  HumanAnswerContentV1,
  ProxyAnswerContentV1,
  provenanceForAction,
  type ActionKind,
  type ActionRecord,
  type CryptoEnvelope,
  type DeviceCert,
  type LedgerEvent,
  type Role,
} from '@daintreehq/decisions-protocol';
import {
  decryptEnvelope,
  importSigningPublicKey,
  verifyDeviceCert,
  verifyRecordAndEnvelope,
} from '@daintreehq/decisions-crypto';
import type { BridgeContext } from './context.js';
import { TransientError } from './mutex.js';

interface DirEntry {
  cert: DeviceCert;
  pub: CryptoKey;
  revokedAt: number | null;
}

/** The only action each action-event type may carry. A cancel record can never arrive as an answer. */
export const EVENT_ACTION: Readonly<Record<string, ActionKind>> = {
  'decision.answer.committed': 'answer',
  'decision.answer.overridden': 'override',
  'decision.proxy.committed': 'proxy-answer',
  'decision.proxy.confirmed': 'confirm-proxy',
  'decision.proxy.abstained': 'proxy-abstain',
  'decision.cancelled': 'cancel',
  'decision.reopened': 'reopen',
};

const ENVELOPE_ACTIONS: readonly ActionKind[] = [
  'answer',
  'override',
  'proxy-answer',
  'confirm-proxy',
];

export type Rejection = { ok: false; reason: string };
export interface VerifiedAnswer {
  ok: true;
  action: ActionKind;
  record: ActionRecord;
  provenance: 'human' | 'proxy' | null;
  signerDeviceId: string;
  signerRole: Role;
  content:
    (HumanAnswerContentV1 & Partial<Pick<ProxyAnswerContentV1, 'model_id' | 'confidence'>>) | null;
}

export const revokedKey = (deviceId: string): string => `revoked:${deviceId}`;

/**
 * Device directory pinned to our own owner key: every certificate must be issued by us, so a relay
 * cannot introduce a device. Used to verify record signatures, roles and provenance.
 */
export class EventVerifier {
  private dir = new Map<string, DirEntry>();
  private loadedAt = 0;
  /** Set by any device/key event: the next lookup MUST re-fetch even for already known signers. */
  private dirty = true;

  constructor(private readonly ctx: BridgeContext) {}

  invalidate(): void {
    this.dirty = true;
  }

  private async refresh(): Promise<void> {
    const { ctx } = this;
    let list;
    try {
      list = await ctx.client.devices();
    } catch (e) {
      throw new TransientError(`device directory unavailable: ${(e as Error).message}`);
    }
    const owner = ctx.identity.keys.signing.publicKey;
    const next = new Map<string, DirEntry>();
    for (const d of list.devices) {
      const c = d.cert;
      if (c.issuer_device_id !== ctx.identity.config.deviceId) continue;
      if (c.installation_id !== ctx.identity.config.installationId) continue;
      if (c.device_id !== d.device_id) continue;
      if (!(await verifyDeviceCert(c, owner))) continue;
      if (c.device_id === ctx.identity.config.deviceId && c.signing_pub !== ctx.identity.signingPub)
        continue;
      next.set(c.device_id, {
        cert: c,
        pub: await importSigningPublicKey(c.signing_pub),
        revokedAt: d.revoked_at ? Date.parse(d.revoked_at) : null,
      });
    }
    this.dir = next;
    this.loadedAt = ctx.now();
    this.dirty = false;
  }

  private async lookup(deviceId: string): Promise<DirEntry | null> {
    if (this.dirty || this.dir.size === 0) await this.refresh();
    else if (!this.dir.has(deviceId) && this.ctx.now() - this.loadedAt > 5000) {
      // Unknown signer: refresh, but at most every 5 s so a hostile relay cannot make us hammer it.
      await this.refresh();
    }
    return this.dir.get(deviceId) ?? null;
  }

  async verifyAction(ev: LedgerEvent): Promise<VerifiedAnswer | Rejection> {
    const { ctx } = this;
    const expected = EVENT_ACTION[ev.event_type];
    if (!expected) return { ok: false, reason: 'not-an-action-event' };
    const parsed = EventData.action.safeParse(ev.data);
    if (!parsed.success) return { ok: false, reason: 'malformed-event' };
    const { record, envelope, action } = parsed.data;
    // The event type, the declared action and the SIGNED action must all agree.
    if (action !== expected || record.action !== expected)
      return { ok: false, reason: 'event-action-mismatch' };
    if (record.installation_id !== ctx.identity.config.installationId)
      return { ok: false, reason: 'wrong-installation' };
    if (ev.question_id !== record.question_id) return { ok: false, reason: 'question-mismatch' };

    const signer = await this.lookup(record.signer_device_id);
    if (!signer) return { ok: false, reason: 'unknown-signer' };
    if (signer.revokedAt !== null && Date.parse(record.created_at) >= signer.revokedAt) {
      return { ok: false, reason: 'signer-revoked' };
    }
    // A revocation we observed in the ledger sticks, even if a stale directory says otherwise.
    const rev = await ctx.store.getMeta(revokedKey(record.signer_device_id));
    if (rev !== null && ev.seq > Number(rev)) return { ok: false, reason: 'signer-revoked' };

    const role = signer.cert.role;
    const prov = provenanceForAction(action);
    if (prov === 'human' && !HUMAN_ROLES.includes(role))
      return { ok: false, reason: 'human-action-by-non-human-device' };
    if (prov === 'proxy' && !DESKTOP_ROLES.includes(role))
      return { ok: false, reason: 'proxy-action-by-non-desktop-device' };
    if (prov === 'none' && !DESKTOP_ROLES.includes(role))
      return { ok: false, reason: 'desktop-action-by-non-desktop-device' };
    if (action === 'reopen' && role !== 'owner-desktop')
      return { ok: false, reason: 'reopen-by-non-owner' };
    // Relay-declared provenance is only a claim; it must match what the signed action implies.
    const declared = parsed.data.provenance;
    if (prov === 'none' ? declared !== null : declared !== prov)
      return { ok: false, reason: 'provenance-mismatch' };
    if (!(await verifyRecordAndEnvelope(record, envelope as CryptoEnvelope | null, signer.pub))) {
      return { ok: false, reason: 'bad-signature-or-digest' };
    }

    let content: VerifiedAnswer['content'] = null;
    if (envelope && ENVELOPE_ACTIONS.includes(action)) {
      const binding = {
        installationId: ctx.identity.config.installationId,
        questionId: record.question_id,
        // The envelope's record type is the action kind: 'answer', 'override', 'proxy-answer', 'confirm-proxy'.
        recordType: action,
        revision: record.expected_revision + 1,
        senderDeviceId: record.signer_device_id,
        purpose: 'answer-content' as const,
      };
      let raw: unknown;
      try {
        raw = await decryptEnvelope<unknown>(envelope, ctx.identity.epochs, binding);
      } catch (e) {
        if (!ctx.identity.epochs.has(envelope.key_epoch)) {
          // Rotated by another process: reload epoch material, then try once more.
          await ctx.refreshIdentity?.();
          if (ctx.identity.epochs.has(envelope.key_epoch)) {
            try {
              raw = await decryptEnvelope<unknown>(envelope, ctx.identity.epochs, binding);
            } catch {
              return { ok: false, reason: 'decryption-failed' };
            }
          } else {
            throw new TransientError(`missing epoch key ${envelope.key_epoch}`);
          }
        } else {
          void e;
          return { ok: false, reason: 'decryption-failed' };
        }
      }
      const p = (prov === 'proxy' ? ProxyAnswerContentV1 : HumanAnswerContentV1).safeParse(raw);
      if (!p.success) return { ok: false, reason: 'malformed-answer-content' };
      content = p.data;
    }
    return {
      ok: true,
      action,
      record,
      provenance: prov === 'none' ? null : prov,
      signerDeviceId: record.signer_device_id,
      signerRole: role,
      content,
    };
  }
}
