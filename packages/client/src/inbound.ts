import {
  DESKTOP_ROLES,
  EventData,
  HUMAN_ROLES,
  HumanAnswerContentV1,
  MESSAGE_RECORD_TYPE,
  MessageContentV1,
  ProxyAnswerContentV1,
  imagesMatchRecord,
  messageEnvelopeIssues,
  provenanceForAction,
  type ActionKind,
  type ActionRecord,
  type CryptoEnvelope,
  type DeviceCert,
  type EnvelopePurpose,
  type LedgerEvent,
  type MessageEntry,
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

/** A thread message whose signer, signature, envelope binding and content all checked out. */
export interface VerifiedMessage {
  ok: true;
  /** The message as the relay committed it: `message_seq`, `committed_at`, the signed record and envelope. */
  entry: MessageEntry;
  content: MessageContentV1;
  signerRole: Role;
  /** The host reference the relay keyed the message's delivery by: what its receipts name. Never used to route. */
  targetHostId: string;
}

export const revokedKey = (deviceId: string): string => `revoked:${deviceId}`;

/**
 * Device directory pinned to the owner identity: this device itself on the owner desktop, the owner pinned at
 * enrollment on a `desktop-host`. Every certificate must be issued by that owner and verify against its key, so
 * a relay cannot introduce a device (and neither can a Host). Exactly one `owner-desktop` is accepted: the
 * pinned one. Used to verify record signatures, roles and provenance.
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
    const { identity } = ctx;
    const pin = identity.owner;
    const next = new Map<string, DirEntry>();
    for (const d of list.devices) {
      const c = d.cert;
      if (c.issuer_device_id !== pin.deviceId) continue;
      if (c.installation_id !== identity.config.installationId) continue;
      if (c.device_id !== d.device_id) continue;
      if (!(await verifyDeviceCert(c, pin.signingKey))) continue;
      // The owner entry must be the pinned owner key, and no other device may claim to be an owner.
      const isOwner = c.device_id === pin.deviceId;
      if (isOwner !== (c.role === 'owner-desktop')) continue;
      if (isOwner && c.signing_pub !== pin.signingPub) continue;
      // Our own entry must carry our own key and role.
      if (
        c.device_id === identity.config.deviceId &&
        (c.signing_pub !== identity.signingPub || c.role !== identity.role)
      )
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

  /**
   * The signer's directory entry, if it may sign a record created at `createdAt` and carried by the event at
   * ledger `seq`: known to the pinned directory, not revoked by then, and not revoked by any event we observed.
   */
  private async signer(
    deviceId: string,
    createdAt: string,
    seq: number,
  ): Promise<DirEntry | Rejection> {
    const signer = await this.lookup(deviceId);
    if (!signer) return { ok: false, reason: 'unknown-signer' };
    if (signer.revokedAt !== null && Date.parse(createdAt) >= signer.revokedAt) {
      return { ok: false, reason: 'signer-revoked' };
    }
    // A revocation we observed in the ledger sticks, even if a stale directory says otherwise.
    const rev = await this.ctx.store.getMeta(revokedKey(deviceId));
    if (rev !== null && seq > Number(rev)) return { ok: false, reason: 'signer-revoked' };
    return signer;
  }

  /**
   * Decrypt an inbound envelope under its exact binding. A key epoch this identity does not hold yet is reloaded
   * once (rotated by another process) and otherwise throws `TransientError`, so the event is retried in order.
   */
  private async decrypt(
    envelope: CryptoEnvelope,
    binding: {
      installationId: string;
      questionId: string;
      recordType: string;
      revision: number;
      senderDeviceId: string;
      purpose: EnvelopePurpose;
    },
  ): Promise<{ raw: unknown } | Rejection> {
    const { ctx } = this;
    try {
      return { raw: await decryptEnvelope<unknown>(envelope, ctx.identity.epochs, binding) };
    } catch {
      if (ctx.identity.epochs.has(envelope.key_epoch))
        return { ok: false, reason: 'decryption-failed' };
    }
    // Rotated by another process: reload epoch material, then try once more.
    await ctx.refreshIdentity?.();
    if (!ctx.identity.epochs.has(envelope.key_epoch))
      throw new TransientError(`missing epoch key ${envelope.key_epoch}`);
    try {
      return { raw: await decryptEnvelope<unknown>(envelope, ctx.identity.epochs, binding) };
    } catch {
      return { ok: false, reason: 'decryption-failed' };
    }
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

    const signer = await this.signer(record.signer_device_id, record.created_at, ev.seq);
    if ('reason' in signer) return signer;

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
      const opened = await this.decrypt(envelope, binding);
      if ('reason' in opened) return opened;
      const p = (prov === 'proxy' ? ProxyAnswerContentV1 : HumanAnswerContentV1).safeParse(
        opened.raw,
      );
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
  /**
   * Verify a `decision.message.posted` event (protocol section 16): the signed record and its envelope, bound to
   * each other and to this installation and question; a signer the pinned directory knows and has not revoked;
   * a human message signed by a phone or tablet, and an agent message only by this desktop, which published every
   * question it holds live; and decrypted content of the same side referencing exactly the signed images.
   * The relay's `target_host_id` is never trusted for routing: the question's own origin is.
   */
  async verifyMessage(ev: LedgerEvent): Promise<VerifiedMessage | Rejection> {
    const { ctx } = this;
    if (ev.event_type !== 'decision.message.posted')
      return { ok: false, reason: 'not-a-message-event' };
    const parsed = EventData.messagePosted.safeParse(ev.data);
    if (!parsed.success) return { ok: false, reason: 'malformed-event' };
    const { record, envelope, message_seq, committed_at, target_host_id } = parsed.data;
    if (messageEnvelopeIssues(record, envelope).length > 0)
      return { ok: false, reason: 'envelope-binding-mismatch' };
    if (record.installation_id !== ctx.identity.config.installationId)
      return { ok: false, reason: 'wrong-installation' };
    if (ev.question_id !== record.question_id) return { ok: false, reason: 'question-mismatch' };

    const signer = await this.signer(record.signer_device_id, record.created_at, ev.seq);
    if ('reason' in signer) return signer;
    const role = signer.cert.role;
    if (record.side === 'human' && !HUMAN_ROLES.includes(role))
      return { ok: false, reason: 'human-message-by-non-human-device' };
    if (record.side === 'agent' && record.signer_device_id !== ctx.identity.config.deviceId)
      return { ok: false, reason: 'agent-message-by-another-device' };
    if (!(await verifyRecordAndEnvelope(record, envelope, signer.pub)))
      return { ok: false, reason: 'bad-signature-or-digest' };

    const opened = await this.decrypt(envelope, {
      installationId: ctx.identity.config.installationId,
      questionId: record.question_id,
      recordType: MESSAGE_RECORD_TYPE,
      revision: 0,
      senderDeviceId: record.signer_device_id,
      purpose: 'message-content',
    });
    if ('reason' in opened) return opened;
    const p = MessageContentV1.safeParse(opened.raw);
    if (!p.success) return { ok: false, reason: 'malformed-message-content' };
    if (p.data.side !== record.side) return { ok: false, reason: 'message-side-mismatch' };
    if (!imagesMatchRecord(record.attachment_ids, p.data.side === 'human' ? p.data.images : []))
      return { ok: false, reason: 'message-images-mismatch' };
    return {
      ok: true,
      entry: { message_seq, committed_at, record, envelope },
      content: p.data,
      signerRole: role,
      targetHostId: target_host_id,
    };
  }
}
