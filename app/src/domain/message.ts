import {
  HumanMessageContentV1,
  MESSAGE_RECORD_TYPE,
  MessageBody,
  PROTOCOL_VERSION,
} from '@daintreehq/decisions-protocol';
import {
  buildSignedMessage,
  encryptEnvelope,
  newId,
  type EpochKey,
} from '@daintreehq/decisions-crypto';
import type { QuestionView } from './model.js';
import { threadOpen } from './selectors.js';

export interface MessageInput {
  installationId: string;
  deviceId: string;
  signingKey: CryptoKey;
  epochKey: EpochKey;
  view: QuestionView;
  text: string;
}

export interface BuiltMessage {
  messageId: string;
  path: string;
  bodyText: string;
  idempotencyKey: string;
}

export class ThreadClosedError extends Error {
  constructor(message = 'This question no longer takes messages.') {
    super(message);
    this.name = 'ThreadClosedError';
  }
}

/**
 * A follow-up from the person (docs/protocol.md section 16): their words, sealed for the question's thread and signed
 * by this device. It is not an action: it carries no revision, no options and no approval, and it never changes the
 * answer in force. The body is serialised once, so every retry (after a restart too) is byte-identical and the relay's
 * idempotency key keeps it exactly-once.
 */
export async function buildMessageRequest(i: MessageInput): Promise<BuiltMessage> {
  if (!threadOpen(i.view)) throw new ThreadClosedError();
  const messageId = newId();
  const idempotencyKey = newId();
  const content = HumanMessageContentV1.parse({
    content_version: 1,
    side: 'human',
    text: i.text,
    images: [],
  });
  const envelope = await encryptEnvelope({
    epochKey: i.epochKey,
    installationId: i.installationId,
    questionId: i.view.id,
    recordId: messageId,
    recordType: MESSAGE_RECORD_TYPE,
    revision: 0,
    senderDeviceId: i.deviceId,
    purpose: 'message-content',
    plaintext: content,
  });
  const message = await buildSignedMessage({
    installationId: i.installationId,
    questionId: i.view.id,
    messageId,
    side: 'human',
    signerDeviceId: i.deviceId,
    signingKey: i.signingKey,
    envelope,
  });
  const body = MessageBody.parse({
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: idempotencyKey,
    message,
  });
  return {
    messageId,
    path: `/questions/${i.view.id}/messages`,
    bodyText: JSON.stringify(body),
    idempotencyKey,
  };
}
