import {
  EventData,
  type ActionKind,
  type DecisionContentV1,
  type LedgerEvent,
  type Provenance,
  type QuestionStatus,
  type Requirement,
  type Role,
} from '@daintree/decisions-protocol';
import type { EpochKey } from '@daintree/decisions-crypto';
import { verifyActionEvent, verifyQuestionEvent, type AnswerContent } from './verify.js';
import type { TrustStore } from './trust.js';

export interface ActionView {
  actionId: string;
  action: ActionKind;
  provenance: Provenance | null;
  /** Question revision after this action. */
  revision: number;
  createdAt: string;
  seq: number;
  signerDeviceId: string;
  signerRole: Role | null;
  content: AnswerContent | null;
  verified: boolean;
  error?: string;
}

export type DeliveryState =
  | 'relay-queued'
  | 'desktop-received'
  | 'terminal-delivered'
  | 'needs-attention'
  | 'delivery-uncertain';

export interface DeliveryView {
  status: DeliveryState;
  errorCode?: string;
}

export interface QuestionView {
  id: string;
  status: QuestionStatus;
  revision: number;
  requirement: Requirement;
  targetHostId: string;
  createdAt: string;
  expiresAt: string | null;
  proxyAbstained: boolean;
  createdSeq: number;
  lastSeq: number;
  lastEventAt: string;
  verification: { ok: true } | { ok: false; reason: string };
  content: DecisionContentV1 | null;
  actions: ActionView[];
  deliveries: Record<number, DeliveryView>;
  attachmentsAvailable: Record<string, true>;
  integrityIssues: string[];
}

export interface StoreCtx {
  installationId: string;
  trust: TrustStore;
  epochKeys: () => ReadonlyMap<number, EpochKey>;
  /** Called once when an event is signed by a device we have no certificate for yet. */
  refreshDevices?: () => Promise<void>;
  /** Called after a key rotation event so the controller can fetch the new grant. */
  onKeyRotated?: (epoch: number) => void;
}

type Listener = () => void;

export class QuestionStore {
  private views = new Map<string, QuestionView>();
  private seen = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private listeners = new Set<Listener>();
  private version = 0;
  desktopAckSeq = 0;
  highestSeq = 0;
  malformedEvents = 0;

  constructor(private readonly ctx: StoreCtx) {}

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = (): number => this.version;

  list(): QuestionView[] {
    return [...this.views.values()];
  }
  get(id: string): QuestionView | undefined {
    return this.views.get(id);
  }

  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** Serialised so verification (async) never reorders the ledger. */
  ingest(ev: LedgerEvent): Promise<void> {
    const run = this.chain.then(() => this.apply(ev));
    this.chain = run.catch(() => undefined);
    return run;
  }

  async ingestAll(events: LedgerEvent[]): Promise<void> {
    for (const e of events) await this.ingest(e);
  }

  /** Re-verify everything from scratch, e.g. after new epoch keys or certificates arrive. */
  async rebuild(events: LedgerEvent[]): Promise<void> {
    await this.chain;
    this.views = new Map();
    this.seen = new Set();
    this.desktopAckSeq = 0;
    this.highestSeq = 0;
    for (const e of [...events].sort((a, b) => a.seq - b.seq)) await this.ingest(e);
    this.bump();
  }

  private async verifyWithRetry<T>(
    run: () => Promise<{ ok: true; value: T } | { ok: false; reason: string }>,
  ) {
    let r = await run();
    if (!r.ok && r.reason === 'unknown signer' && this.ctx.refreshDevices) {
      try {
        await this.ctx.refreshDevices();
      } catch {
        /* offline: stays unverified until the next rebuild */
      }
      r = await run();
    }
    return r;
  }

  private vctx() {
    return {
      installationId: this.ctx.installationId,
      trust: this.ctx.trust,
      epochKeys: this.ctx.epochKeys(),
    };
  }

  private stub(id: string, ev: LedgerEvent, reason: string): QuestionView {
    return {
      id,
      status: 'open',
      revision: 0,
      requirement: 'human-required',
      targetHostId: '',
      createdAt: ev.occurred_at,
      expiresAt: null,
      proxyAbstained: false,
      createdSeq: ev.seq,
      lastSeq: ev.seq,
      lastEventAt: ev.occurred_at,
      verification: { ok: false, reason },
      content: null,
      actions: [],
      deliveries: {},
      attachmentsAvailable: {},
      integrityIssues: [],
    };
  }

  private async apply(ev: LedgerEvent): Promise<void> {
    if (this.seen.has(ev.event_id)) return;
    this.seen.add(ev.event_id);
    this.highestSeq = Math.max(this.highestSeq, ev.seq);
    const qid = ev.question_id;
    const d = ev.data;

    switch (ev.event_type) {
      case 'decision.created': {
        if (!qid) break;
        const parsed = EventData.created.safeParse(d);
        const v = await this.verifyWithRetry(() =>
          verifyQuestionEvent(d, ev.occurred_at, this.vctx()),
        );
        if (!parsed.success) {
          this.malformedEvents++;
          this.views.set(qid, this.stub(qid, ev, 'malformed question event'));
          break;
        }
        const rec = parsed.data.record;
        const issues: string[] = [];
        // The signed record is authoritative for routing metadata; a disagreeing relay is an integrity issue.
        if (parsed.data.requirement !== rec.requirement)
          issues.push('relay requirement differs from the signed record');
        if (parsed.data.expires_at !== rec.expires_at)
          issues.push('relay expiry differs from the signed record');
        this.views.set(qid, {
          id: qid,
          status: 'open',
          revision: 0,
          requirement: rec.requirement,
          targetHostId: rec.target_host_id,
          createdAt: rec.created_at,
          expiresAt: rec.expires_at,
          proxyAbstained: false,
          createdSeq: ev.seq,
          lastSeq: ev.seq,
          lastEventAt: ev.occurred_at,
          verification: v.ok ? { ok: true } : { ok: false, reason: v.reason },
          content: v.ok ? v.value.content : null,
          actions: [],
          deliveries: {},
          attachmentsAvailable: {},
          integrityIssues: issues,
        });
        break;
      }
      case 'decision.answer.committed':
      case 'decision.answer.overridden':
      case 'decision.proxy.committed':
      case 'decision.proxy.abstained':
      case 'decision.proxy.confirmed':
      case 'decision.cancelled':
      case 'decision.reopened': {
        if (!qid) break;
        const parsed = EventData.action.safeParse(d);
        const view = this.views.get(qid) ?? this.stub(qid, ev, 'question not found in ledger');
        this.views.set(qid, view);
        if (!parsed.success) {
          this.malformedEvents++;
          view.integrityIssues.push(`malformed ${ev.event_type} event`);
          break;
        }
        const v = await this.verifyWithRetry(() =>
          verifyActionEvent(d, ev.occurred_at, this.vctx()),
        );
        const rec = parsed.data.record;
        const base = {
          actionId: rec.action_id,
          action: rec.action,
          provenance: parsed.data.provenance,
          revision: parsed.data.revision,
          createdAt: rec.created_at,
          seq: ev.seq,
          signerDeviceId: rec.signer_device_id,
        };
        if (v.ok) {
          view.actions.push({
            ...base,
            provenance: v.value.provenance,
            signerRole: v.value.signerRole,
            content: v.value.content,
            verified: true,
          });
        } else {
          view.actions.push({
            ...base,
            signerRole: null,
            content: null,
            verified: false,
            error: v.reason,
          });
          view.integrityIssues.push(`${rec.action}: ${v.reason}`);
        }
        // Status and revision are routing metadata asserted by the relay; the signed content above is what we trust.
        view.status = parsed.data.status;
        view.revision = parsed.data.revision;
        if (rec.action === 'proxy-abstain') view.proxyAbstained = true;
        if (rec.action === 'reopen') {
          view.expiresAt = rec.expires_at;
          view.proxyAbstained = false;
        }
        view.lastSeq = ev.seq;
        view.lastEventAt = ev.occurred_at;
        break;
      }
      case 'decision.expired': {
        const v = qid ? this.views.get(qid) : undefined;
        if (v && v.status === 'open') v.status = 'expired';
        if (v) {
          v.lastSeq = ev.seq;
          v.lastEventAt = ev.occurred_at;
        }
        break;
      }
      case 'decision.deleted': {
        if (qid) this.views.delete(qid);
        break;
      }
      case 'attachment.available': {
        const p = EventData.attachmentAvailable.safeParse(d);
        const v = qid ? this.views.get(qid) : undefined;
        if (p.success && v) v.attachmentsAvailable[p.data.attachment_id] = true;
        break;
      }
      case 'delivery.received': {
        const p = EventData.deliveryReceived.safeParse(d);
        if (p.success) this.desktopAckSeq = Math.max(this.desktopAckSeq, p.data.up_to_seq);
        break;
      }
      case 'delivery.terminal_delivered': {
        const p = EventData.deliveryTerminal.safeParse(d);
        const v = qid ? this.views.get(qid) : undefined;
        if (p.success && v) v.deliveries[p.data.answer_revision] = { status: 'terminal-delivered' };
        break;
      }
      case 'delivery.needs_attention': {
        const p = EventData.deliveryAttention.safeParse(d);
        const v = qid ? this.views.get(qid) : undefined;
        if (p.success && v) {
          v.deliveries[p.data.answer_revision] = {
            status: p.data.status,
            errorCode: p.data.error_code,
          };
        }
        break;
      }
      case 'device.approved': {
        const p = EventData.deviceApproved.safeParse(d);
        if (p.success) await this.ctx.trust.addCert(p.data.cert, null);
        break;
      }
      case 'device.revoked': {
        const p = EventData.deviceRevoked.safeParse(d);
        if (p.success) this.ctx.trust.markRevoked(p.data.device_id, ev.occurred_at);
        break;
      }
      case 'device.key_rotated': {
        const p = EventData.keyRotated.safeParse(d);
        if (p.success) this.ctx.onKeyRotated?.(p.data.key_epoch);
        break;
      }
      default:
        break;
    }
    this.bump();
  }
}
