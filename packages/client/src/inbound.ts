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
} from '@daintree/decisions-protocol';
import {
  decryptEnvelope,
  importSigningPublicKey,
  verifyDeviceCert,
  verifyRecordAndEnvelope,
} from '@daintree/decisions-crypto';
import type { BridgeContext } from './context.js';

interface DirEntry {
  cert: DeviceCert;
  pub: CryptoKey;
  revokedAt: number | null;
}

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

/**
 * Device directory pinned to our own owner key: every certificate must be issued by us, so a relay
 * cannot introduce a device. Used to verify record signatures, roles and provenance.
 */
export class EventVerifier {
  private dir = new Map<string, DirEntry>();
  private loadedAt = 0;

  constructor(private readonly ctx: BridgeContext) {}

  invalidate(): void {
    this.loadedAt = 0;
  }

  private async refresh(): Promise<void> {
    const { ctx } = this;
    const list = await ctx.client.devices();
    const owner = ctx.identity.keys.signing.publicKey;
    const next = new Map<string, DirEntry>();
    for (const d of list.devices) {
      const c = d.cert;
      if (c.issuer_device_id !== ctx.identity.config.deviceId) continue;
      if (c.installation_id !== ctx.identity.config.installationId) continue;
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
  }

  private async lookup(deviceId: string): Promise<DirEntry | null> {
    if (this.dir.size === 0 || !this.dir.has(deviceId)) {
      // Refresh at most every 5 s on unknown signers so a hostile relay cannot make us hammer it.
      if (this.ctx.now() - this.loadedAt > 5000 || this.dir.size === 0) await this.refresh();
    }
    return this.dir.get(deviceId) ?? null;
  }

  async verifyAction(ev: LedgerEvent): Promise<VerifiedAnswer | Rejection> {
    const { ctx } = this;
    const parsed = EventData.action.safeParse(ev.data);
    if (!parsed.success) return { ok: false, reason: 'malformed-event' };
    const { record, envelope, action } = parsed.data;
    if (record.action !== action) return { ok: false, reason: 'action-mismatch' };
    if (record.installation_id !== ctx.identity.config.installationId)
      return { ok: false, reason: 'wrong-installation' };
    if (ev.question_id !== record.question_id) return { ok: false, reason: 'question-mismatch' };

    const signer = await this.lookup(record.signer_device_id);
    if (!signer) return { ok: false, reason: 'unknown-signer' };
    if (signer.revokedAt !== null && Date.parse(record.created_at) >= signer.revokedAt) {
      return { ok: false, reason: 'signer-revoked' };
    }
    const role = signer.cert.role;
    const prov = provenanceForAction(action);
    if (prov === 'human' && !HUMAN_ROLES.includes(role))
      return { ok: false, reason: 'human-action-by-non-human-device' };
    if (prov === 'proxy' && !DESKTOP_ROLES.includes(role))
      return { ok: false, reason: 'proxy-action-by-non-desktop-device' };
    if (action === 'reopen' && role !== 'owner-desktop')
      return { ok: false, reason: 'reopen-by-non-owner' };
    if (parsed.data.provenance !== null && prov !== 'none' && parsed.data.provenance !== prov) {
      return { ok: false, reason: 'provenance-mismatch' };
    }
    if (!(await verifyRecordAndEnvelope(record, envelope as CryptoEnvelope | null, signer.pub))) {
      return { ok: false, reason: 'bad-signature-or-digest' };
    }

    let content: VerifiedAnswer['content'] = null;
    if (envelope) {
      try {
        const raw = await decryptEnvelope<unknown>(envelope, ctx.identity.epochs, {
          installationId: ctx.identity.config.installationId,
          questionId: record.question_id,
          recordType: 'answer',
          revision: record.expected_revision + 1,
          senderDeviceId: record.signer_device_id,
          purpose: 'answer-content',
        });
        const p = (prov === 'proxy' ? ProxyAnswerContentV1 : HumanAnswerContentV1).safeParse(raw);
        if (!p.success) return { ok: false, reason: 'malformed-answer-content' };
        content = p.data;
      } catch {
        return { ok: false, reason: 'decryption-failed' };
      }
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
