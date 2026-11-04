import {
  EventData,
  applyAction,
  type ActionKind,
  type DecisionContentV1,
  type LedgerEvent,
  type MessageDeliveryInfo,
  type MessageSide,
  type MessageView as RelayMessageView,
  type PhoneImageReference,
  type Provenance,
  type QuestionStatus,
  type Requirement,
  type Role,
} from '@daintreehq/decisions-protocol';
import type { EpochKey } from '@daintreehq/decisions-crypto';
import {
  verifyActionEvent,
  verifyMessageEvent,
  verifyQuestionEvent,
  type AnswerContent,
} from './verify.js';
import { lastProxyAction } from './selectors.js';
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
  /** A human answer's photos match its signed record; false shows them as unavailable. */
  imagesOk?: boolean;
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

/**
 * One message in a question's thread (docs/protocol.md section 16): a follow-up from the person or a message from the
 * asking agent. It never changes the answer in force. `seq` is the ledger seq of its `decision.message.posted` event,
 * which places it among the question's answers.
 */
export interface ThreadMessage {
  messageId: string;
  messageSeq: number;
  seq: number;
  side: MessageSide;
  /** Agent only: the agent is waiting on the person. */
  expectsReply: boolean;
  createdAt: string;
  committedAt: string;
  signerDeviceId: string;
  /** Verified, decrypted text; empty when it could not be verified. */
  text: string;
  /** Human only: the photos it carries, verified against its signed record (their bytes are checked when shown). */
  images: PhoneImageReference[];
  verified: boolean;
  error?: string;
  /** Human only: where it has reached on its way into the pane, as the publishing desktop reported it. */
  delivery: MessageDeliveryInfo | null;
}

export interface QuestionView {
  id: string;
  status: QuestionStatus;
  revision: number;
  requirement: Requirement;
  targetHostId: string;
  /** The desktop that signed the question; only it may publish the question's pane snapshots. */
  originatingDeviceId: string;
  createdAt: string;
  expiresAt: string | null;
  proxyAbstained: boolean;
  createdSeq: number;
  lastSeq: number;
  lastEventAt: string;
  verification: { ok: true } | { ok: false; reason: string };
  content: DecisionContentV1 | null;
  actions: ActionView[];
  /** The thread's messages in ledger order. */
  messages: ThreadMessage[];
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

  /**
   * Messages read from `GET /questions/{id}/messages` rather than the ledger (a device that turned the feature on
   * after they were posted), as the ledger events they were: each is verified exactly as its event would be. Their
   * current delivery comes with them. Returns the events so the caller can cache them like any other.
   */
  async adoptMessages(
    questionId: string,
    views: readonly RelayMessageView[],
  ): Promise<LedgerEvent[]> {
    const events = messageEvents(questionId, this.views.get(questionId)?.targetHostId ?? '', views);
    for (const e of events) await this.ingest(e);
    const view = this.views.get(questionId);
    for (const m of views) {
      const msg = view?.messages.find((x) => x.messageId === m.record.message_id);
      if (msg && msg.side === 'human' && m.delivery) msg.delivery = m.delivery;
    }
    this.bump();
    return events;
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
      originatingDeviceId: '',
      createdAt: ev.occurred_at,
      expiresAt: null,
      proxyAbstained: false,
      createdSeq: ev.seq,
      lastSeq: ev.seq,
      lastEventAt: ev.occurred_at,
      verification: { ok: false, reason },
      content: null,
      actions: [],
      messages: [],
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
        if (!parsed.success) {
          this.malformedEvents++;
          if (!this.views.has(qid))
            this.views.set(qid, this.stub(qid, ev, 'malformed question event'));
          break;
        }
        const rec = parsed.data.record;
        const existing = this.views.get(qid);
        // A question is created exactly once. A second "created" for a known id can never replace what we hold.
        if (existing && existing.verification.ok) {
          existing.integrityIssues.push('duplicate question event ignored');
          break;
        }
        const v = await this.verifyWithRetry(() =>
          verifyQuestionEvent(d, ev.occurred_at, this.vctx(), qid),
        );
        if (!v.ok) {
          // Never adopt fields from a record that did not verify for THIS id (it may belong to another question).
          if (!existing) this.views.set(qid, this.stub(qid, ev, v.reason));
          else existing.verification = { ok: false, reason: v.reason };
          break;
        }
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
          originatingDeviceId: rec.originating_device_id,
          createdAt: rec.created_at,
          expiresAt: rec.expires_at,
          proxyAbstained: false,
          createdSeq: ev.seq,
          lastSeq: ev.seq,
          lastEventAt: ev.occurred_at,
          verification: { ok: true },
          content: v.value.content,
          actions: [],
          messages: [],
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
        const rec = parsed.data.record;
        const base = {
          actionId: rec.action_id,
          action: rec.action,
          provenance: parsed.data.provenance,
          revision: view.revision,
          createdAt: rec.created_at,
          seq: ev.seq,
          signerDeviceId: rec.signer_device_id,
        };
        const reject = (reason: string) => {
          view.actions.push({
            ...base,
            signerRole: null,
            content: null,
            verified: false,
            error: reason,
          });
          view.integrityIssues.push(`${rec.action}: ${reason}`);
        };

        const v = await this.verifyWithRetry(() =>
          verifyActionEvent(d, ev.occurred_at, this.vctx(), qid),
        );
        if (!v.ok) {
          reject(v.reason);
          break;
        }
        if (!view.verification.ok) {
          reject('the question itself could not be verified');
          break;
        }
        if (rec.action === 'confirm-proxy') {
          const latest = lastProxyAction(view);
          if (!latest || rec.confirms_action_id !== latest.actionId) {
            reject('confirms a proxy answer that is not the latest one');
            break;
          }
        }
        // Trusted state moves only through the shared transition table, using the CERTIFIED signer role,
        // the SIGNED expected revision and the question's SIGNED requirement. Relay metadata plays no part.
        let tr;
        try {
          tr = applyAction(
            {
              status: view.status,
              revision: view.revision,
              requirement: view.requirement,
              proxyAbstained: view.proxyAbstained,
            },
            rec.action,
            v.value.signerRole,
            rec.expected_revision,
          );
        } catch (e) {
          reject(e instanceof Error ? e.message : 'illegal transition');
          break;
        }
        if (parsed.data.status !== tr.status || parsed.data.revision !== tr.revision) {
          view.integrityIssues.push(
            `${rec.action}: relay status/revision differ from the verified transition (ignored)`,
          );
        }
        view.actions.push({
          ...base,
          revision: tr.revision,
          provenance: v.value.provenance,
          signerRole: v.value.signerRole,
          content: v.value.content,
          verified: true,
          imagesOk: v.value.imagesOk,
        });
        view.status = tr.status;
        view.revision = tr.revision;
        view.proxyAbstained = tr.proxyAbstained;
        if (rec.action === 'reopen') view.expiresAt = rec.expires_at;
        view.lastSeq = ev.seq;
        view.lastEventAt = ev.occurred_at;
        break;
      }
      case 'decision.message.posted': {
        if (!qid) break;
        const parsed = EventData.messagePosted.safeParse(d);
        const view = this.views.get(qid) ?? this.stub(qid, ev, 'question not found in ledger');
        this.views.set(qid, view);
        if (!parsed.success) {
          this.malformedEvents++;
          view.integrityIssues.push('malformed message event');
          break;
        }
        const entry = parsed.data;
        // Seen already (a backfilled copy, or the same message replayed): the first verified copy stands.
        if (view.messages.some((m) => m.messageId === entry.record.message_id)) break;
        const base = {
          messageId: entry.record.message_id,
          messageSeq: entry.message_seq,
          seq: ev.seq,
          side: entry.record.side,
          expectsReply: entry.record.expects_reply,
          createdAt: entry.record.created_at,
          committedAt: entry.committed_at,
          signerDeviceId: entry.record.signer_device_id,
          delivery: null,
        };
        const v = view.verification.ok
          ? await this.verifyWithRetry(() =>
              verifyMessageEvent(d, ev.occurred_at, this.vctx(), qid, view.originatingDeviceId),
            )
          : ({ ok: false, reason: 'the question itself could not be verified' } as const);
        if (!v.ok) {
          // Kept in place (so the order stays honest) but never shown as anything anyone said.
          view.messages.push({ ...base, text: '', images: [], verified: false, error: v.reason });
          view.integrityIssues.push(`message: ${v.reason}`);
        } else {
          const c = v.value.content;
          view.messages.push({
            ...base,
            text: c.text,
            images: c.side === 'human' ? c.images : [],
            verified: true,
          });
        }
        view.messages.sort((a, b) => a.seq - b.seq);
        view.lastSeq = Math.max(view.lastSeq, ev.seq);
        view.lastEventAt = ev.occurred_at;
        break;
      }
      case 'delivery.message': {
        const p = EventData.messageDelivery.safeParse(d);
        const v = qid ? this.views.get(qid) : undefined;
        if (!p.success || !v) break;
        const m = v.messages.find((x) => x.messageId === p.data.message_id);
        // Receipts describe human messages only, and only for the host the question was published to.
        if (m && m.side === 'human' && p.data.target_host_id === v.targetHostId) {
          const { message_id: _id, target_host_id: _host, ...info } = p.data;
          m.delivery = info;
        }
        break;
      }
      case 'decision.expired': {
        // Unsigned and relay-asserted: only believed once the SIGNED deadline has really passed by the relay's own clock.
        const v = qid ? this.views.get(qid) : undefined;
        if (!v) break;
        if (
          v.status === 'open' &&
          v.expiresAt &&
          Date.parse(ev.occurred_at) >= Date.parse(v.expiresAt)
        ) {
          v.status = 'expired';
          v.lastSeq = ev.seq;
          v.lastEventAt = ev.occurred_at;
        } else if (v.status === 'open') {
          v.integrityIssues.push('expiry reported before the signed deadline (ignored)');
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

/**
 * The `decision.message.posted` events a page of `GET /questions/{id}/messages` stands for: same seq, same payload.
 * Only the event id is local, since the relay never sent the event itself to this device.
 */
export function messageEvents(
  questionId: string,
  targetHostId: string,
  views: readonly RelayMessageView[],
): LedgerEvent[] {
  return views.map((m) => ({
    protocol_version: 1,
    seq: m.event_seq,
    event_id: `bf-${m.record.message_id}`.slice(0, 64),
    event_type: 'decision.message.posted',
    occurred_at: m.committed_at,
    question_id: questionId,
    question_revision: null,
    origin_device_id: m.record.signer_device_id,
    data: {
      message_seq: m.message_seq,
      committed_at: m.committed_at,
      record: m.record,
      envelope: m.envelope,
      target_host_id: targetHostId,
    },
  }));
}
