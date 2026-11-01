import {
  ActionBody,
  HumanAnswerContentV1,
  PROTOCOL_VERSION,
  type ActionKind,
} from '@daintree/decisions-protocol';
import {
  buildSignedAction,
  encryptEnvelope,
  newId,
  type EpochKey,
} from '@daintree/decisions-crypto';
import type { QuestionView } from './model.js';
import { lastProxyAction } from './selectors.js';

export type HumanActionKind = Extract<ActionKind, 'answer' | 'override' | 'confirm-proxy'>;

export interface AnswerInput {
  installationId: string;
  deviceId: string;
  signingKey: CryptoKey;
  epochKey: EpochKey;
  view: QuestionView;
  kind: HumanActionKind;
  selected: string[];
  text?: string;
  reason?: string;
  /** sha256 of each plaintext image the human actually saw (approvals bind to these). */
  reviewedDigests: string[];
  explicitApproval?: boolean;
  idempotencyKey?: string;
}

export interface BuiltRequest {
  kind: HumanActionKind;
  path: string;
  bodyText: string;
  idempotencyKey: string;
  expectedRevision: number;
}

/**
 * Builds the signed, encrypted request for a human action. The body is serialised once so that every retry
 * (including after an app restart) is byte-identical and the relay's idempotency key keeps it exactly-once.
 */
export async function buildAnswerRequest(i: AnswerInput): Promise<BuiltRequest> {
  const expectedRevision = i.view.revision;
  const actionId = newId();
  const idempotencyKey = i.idempotencyKey ?? newId();
  let envelope = null;
  let confirmsActionId: string | null = null;

  if (i.kind === 'confirm-proxy') {
    const proxy = lastProxyAction(i.view);
    if (!proxy) throw new Error('there is no verified proxy answer to confirm');
    confirmsActionId = proxy.actionId;
  } else {
    const content = HumanAnswerContentV1.parse({
      content_version: 1,
      selected_option_ids: i.selected,
      text: i.text?.trim() ? i.text : undefined,
      reviewed_attachment_digests: i.reviewedDigests,
      explicit_approval: i.explicitApproval,
      reason: i.reason?.trim() ? i.reason : undefined,
    });
    envelope = await encryptEnvelope({
      epochKey: i.epochKey,
      installationId: i.installationId,
      questionId: i.view.id,
      recordId: actionId,
      recordType: i.kind,
      revision: expectedRevision + 1,
      senderDeviceId: i.deviceId,
      purpose: 'answer-content',
      plaintext: content,
    });
  }

  const action = await buildSignedAction({
    installationId: i.installationId,
    questionId: i.view.id,
    action: i.kind,
    signerDeviceId: i.deviceId,
    signingKey: i.signingKey,
    expectedRevision,
    envelope,
    confirmsActionId,
    actionId,
  });
  const body = ActionBody.parse({
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: idempotencyKey,
    action,
  });
  return {
    kind: i.kind,
    path: `/questions/${i.view.id}/${i.kind}`,
    bodyText: JSON.stringify(body),
    idempotencyKey,
    expectedRevision,
  };
}

export function highestEpoch(keys: ReadonlyMap<number, EpochKey>): EpochKey {
  let best: EpochKey | undefined;
  for (const k of keys.values()) if (!best || k.epoch > best.epoch) best = k;
  if (!best) throw new Error('no content key available on this device');
  return best;
}
