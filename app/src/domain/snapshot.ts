import {
  PaneSnapshotContentV1,
  PaneSnapshotResponse,
  SNAPSHOT_RECORD_TYPE,
  snapshotAgentState,
  snapshotWaitingReason,
  type SnapshotAgentState,
  type SnapshotWaitingReason,
} from '@daintreehq/decisions-protocol';
import { decryptEnvelope, verifyRecordAndEnvelope } from '@daintreehq/decisions-crypto';
import type { QuestionView } from './model.js';
import type { Verified, VerifyCtx } from './verify.js';

/**
 * What the asking pane looked like, as the question's own desktop last published it (docs/protocol.md section 18).
 * An observation, never a claim about what the agent is doing now: `observedAt` is when Daintree read the pane
 * (desktop time, shown to the person) and `receivedAt` is when the relay accepted it (relay time, which is what
 * freshness is measured from).
 */
export interface PaneObservation {
  snapshotId: string;
  /** `off`: the desktop does not share its panes. Nothing else is set. */
  sharing: 'on' | 'off';
  agentState: SnapshotAgentState;
  waitingReason: SnapshotWaitingReason | null;
  paneTitle: string;
  terminalLines: string[];
  observedAt: string;
  receivedAt: string;
}

/** A question's snapshot state as the relay reports it: the observation (if any) and an outstanding refresh. */
export interface SnapshotState {
  observation: PaneObservation | null;
  /** Relay time; past it with no newer snapshot, the observation is stale however recent it was. */
  refreshDeadline: string | null;
  /**
   * This observation has already outlived a refresh nobody answered (the computer asleep or offline). Asking again
   * is not newer evidence, so it stays stale, whatever the next request's deadline, until a newer snapshot arrives.
   */
  missedRefresh?: boolean;
}

const DESKTOP = new Set(['owner-desktop', 'desktop-host']);

/**
 * Checks a `GET /questions/{id}/snapshot` response before anything in it is shown: the record is for this
 * installation and question, it is signed by the desktop that published the question (no other device, not even
 * the owner, speaks for another desktop's pane), the envelope is the one the signer committed to, and the content
 * decrypts under this installation's key and parses within the protocol's limits.
 */
export async function verifySnapshotResponse(
  raw: unknown,
  view: Pick<QuestionView, 'id' | 'originatingDeviceId'>,
  ctx: VerifyCtx,
): Promise<Verified<SnapshotState>> {
  const parsed = PaneSnapshotResponse.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'malformed snapshot response' };
  const { snapshot, received_at, refresh, question_id } = parsed.data;
  if (question_id !== view.id) return { ok: false, reason: 'snapshot is for another question' };
  const refreshDeadline = refresh?.deadline_at ?? null;
  if (!snapshot || !received_at) return { ok: true, value: { observation: null, refreshDeadline } };
  const { record, envelope } = snapshot;
  if (record.installation_id !== ctx.installationId)
    return { ok: false, reason: 'snapshot belongs to another installation' };
  if (record.question_id !== view.id)
    return { ok: false, reason: 'snapshot id does not match the question' };
  if (!view.originatingDeviceId || record.signer_device_id !== view.originatingDeviceId)
    return { ok: false, reason: 'snapshot is not signed by the asking desktop' };
  const signer = ctx.trust.get(record.signer_device_id);
  if (!signer) return { ok: false, reason: 'unknown signer' };
  if (!DESKTOP.has(signer.role)) return { ok: false, reason: 'snapshots come only from a desktop' };
  if (signer.revokedAt) return { ok: false, reason: 'snapshot signer was revoked' };
  if (!(await verifyRecordAndEnvelope(record, envelope, signer.signingKey)))
    return { ok: false, reason: 'snapshot signature does not match' };
  const base = { snapshotId: record.snapshot_id, observedAt: record.observed_at };
  if (record.sharing === 'off' || !envelope) {
    return {
      ok: true,
      value: {
        observation: {
          ...base,
          sharing: 'off',
          agentState: 'unknown',
          waitingReason: null,
          paneTitle: '',
          terminalLines: [],
          receivedAt: received_at,
        },
        refreshDeadline,
      },
    };
  }
  let plain: unknown;
  try {
    plain = await decryptEnvelope(envelope, ctx.epochKeys, {
      installationId: ctx.installationId,
      questionId: view.id,
      senderDeviceId: record.signer_device_id,
      recordType: SNAPSHOT_RECORD_TYPE,
      revision: 0,
      purpose: 'snapshot-content',
    });
  } catch {
    return { ok: false, reason: 'could not decrypt the snapshot' };
  }
  const content = PaneSnapshotContentV1.safeParse(plain);
  if (!content.success) return { ok: false, reason: 'snapshot content is malformed' };
  if (content.data.observed_at !== record.observed_at)
    return { ok: false, reason: 'snapshot times disagree' };
  return {
    ok: true,
    value: {
      observation: {
        ...base,
        sharing: 'on',
        agentState: snapshotAgentState(content.data.agent_state),
        waitingReason: snapshotWaitingReason(content.data.waiting_reason),
        paneTitle: content.data.pane_title,
        terminalLines: content.data.terminal_lines,
        receivedAt: received_at,
      },
      refreshDeadline,
    },
  };
}
