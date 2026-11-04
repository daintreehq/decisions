import { z } from 'zod';
import type { Role } from './schema.js';
import {
  ActionBody,
  AttachmentCompleteBody,
  AttachmentReserveBody,
  CorrectionResult,
  CreateQuestionBody,
  DeleteDataBody,
  DeliveryFailedBody,
  DeliveryReceivedBody,
  DeliveryTerminalBody,
  EnrollHostBody,
  EventsPage as EventsPageSchema,
  InfoResponse,
  PairingApproveBody,
  PairingCandidateBody,
  PairingInvitationBody,
  PairingRejectBody,
  PushSubscribeBody,
  RevokeDeviceBody,
  RotateEpochBody,
  SetupClaimBody,
  SettingsBody,
  SocketTicketBody,
  VoiceCorrectBody,
  VoiceSessionBody,
} from './schema.js';
import {
  AttachmentReservation,
  ClaimResponse,
  CommandReceipt,
  Diagnostics,
  DevicesResponse,
  KeyGrantsResponse,
  PairingCandidateResponse,
  PairingStatusResponse,
  PendingPairing,
  PushConfig,
  PushSubscriptionInfo,
  PushTestResponse,
  QuestionDetail,
  QuestionList,
  SettingsResponse,
  SocketTicketResponse,
  VoiceCorrectResponse,
  VoiceSessionResponse,
} from './api.js';
import { MessageBody, MessageReceipt, MessageReceiptBody, MessagesPage } from './thread.js';
import {
  PaneSnapshotBody,
  PaneSnapshotResponse,
  SnapshotRefresh,
  SnapshotRefreshBody,
} from './snapshot.js';
import { API_PREFIX, PROTOCOL_VERSION } from './version.js';

export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path relative to `/api/v1`, with `{id}` style parameters. */
  path: string;
  auth: 'none' | 'signed';
  /** Roles allowed for signed routes. */
  roles?: readonly Role[] | 'any';
  summary: string;
  request?: z.ZodType;
  response?: z.ZodType;
  /** Success status (default 200). */
  status?: number;
  /** Not a JSON route (streaming or WebSocket upgrade). */
  streaming?: 'websocket' | 'binary-upload' | 'binary-download';
}

const DESKTOPS = ['owner-desktop', 'desktop-host'] as const;
const HUMANS = ['phone', 'tablet'] as const;
const OWNER = ['owner-desktop'] as const;
const ok = z.object({ ok: z.literal(true) });

/**
 * The public route inventory. The Worker's route table must match it exactly (`worker/tests/manifest.test.ts`),
 * and `openapi.json` is generated from it, so docs, schemas and implementation cannot drift apart.
 */
export const ROUTE_MANIFEST: readonly RouteSpec[] = [
  {
    method: 'GET',
    path: '/info',
    auth: 'none',
    summary: 'Protocol range, claim state and which dictation providers are configured',
    response: InfoResponse,
  },
  {
    method: 'POST',
    path: '/setup/claim',
    auth: 'none',
    summary: 'One-time claim by the owner desktop (needs the deploy-time CLAIM_SECRET)',
    request: SetupClaimBody,
    response: ClaimResponse,
    status: 201,
  },
  {
    method: 'POST',
    path: '/pairing/invitations',
    auth: 'signed',
    roles: OWNER,
    summary: 'Create a single-use pairing invitation (5 minutes)',
    request: PairingInvitationBody,
    status: 201,
  },
  {
    method: 'POST',
    path: '/pairing/candidates',
    auth: 'none',
    summary: 'A new device submits its keys, proving possession, with the invitation secret',
    request: PairingCandidateBody,
    response: PairingCandidateResponse,
    status: 201,
  },
  {
    method: 'GET',
    path: '/pairing/pending',
    auth: 'signed',
    roles: OWNER,
    summary: 'Candidates waiting for approval',
    response: z.object({ pending: z.array(PendingPairing) }),
  },
  {
    method: 'POST',
    path: '/pairing/{id}/approve',
    auth: 'signed',
    roles: OWNER,
    summary: 'Approve a candidate: owner-signed certificate plus sealed epoch key',
    request: PairingApproveBody,
  },
  {
    method: 'POST',
    path: '/pairing/{id}/reject',
    auth: 'signed',
    roles: OWNER,
    summary: 'Reject a candidate',
    request: PairingRejectBody,
  },
  {
    method: 'GET',
    path: '/pairing/{id}/status',
    auth: 'none',
    summary: 'Candidate polls with X-Pairing-Secret until approved',
    response: PairingStatusResponse,
  },
  {
    method: 'POST',
    path: '/socket-ticket',
    auth: 'signed',
    roles: 'any',
    summary: 'Single-use 30 second ticket for the WebSocket',
    request: SocketTicketBody,
    response: SocketTicketResponse,
  },
  {
    method: 'GET',
    path: '/socket',
    auth: 'none',
    summary: 'Hibernatable WebSocket (ticket in the query string)',
    streaming: 'websocket',
  },
  {
    method: 'GET',
    path: '/events',
    auth: 'signed',
    roles: 'any',
    summary: 'Ordered ledger page after a cursor',
    response: EventsPageSchema,
  },
  {
    method: 'POST',
    path: '/questions',
    auth: 'signed',
    roles: DESKTOPS,
    summary: 'Create a signed, encrypted question',
    request: CreateQuestionBody,
    response: CommandReceipt,
    status: 201,
  },
  {
    method: 'GET',
    path: '/questions',
    auth: 'signed',
    roles: 'any',
    summary: 'List question summaries',
    response: QuestionList,
  },
  {
    method: 'GET',
    path: '/questions/{id}',
    auth: 'signed',
    roles: 'any',
    summary: 'One question with its action log, attachments and deliveries',
    response: QuestionDetail,
  },
  {
    method: 'DELETE',
    path: '/questions/{id}',
    auth: 'signed',
    roles: OWNER,
    summary: 'Delete a question, its events and attachments',
    response: ok,
  },
  {
    method: 'POST',
    path: '/questions/{id}/answer',
    auth: 'signed',
    roles: HUMANS,
    summary: 'First human answer (compare-and-swap on revision)',
    request: ActionBody,
    response: CommandReceipt,
    status: 201,
  },
  {
    method: 'POST',
    path: '/questions/{id}/override',
    auth: 'signed',
    roles: HUMANS,
    summary: 'Deliberately replace an answer',
    request: ActionBody,
    response: CommandReceipt,
    status: 201,
  },
  {
    method: 'POST',
    path: '/questions/{id}/confirm-proxy',
    auth: 'signed',
    roles: HUMANS,
    summary: 'Human confirms a proxy answer (not re-delivered)',
    request: ActionBody,
    response: CommandReceipt,
    status: 201,
  },
  {
    method: 'POST',
    path: '/questions/{id}/proxy-answer',
    auth: 'signed',
    roles: DESKTOPS,
    summary: 'Proxy answer; refused for human-required questions',
    request: ActionBody,
    response: CommandReceipt,
    status: 201,
  },
  {
    method: 'POST',
    path: '/questions/{id}/proxy-abstain',
    auth: 'signed',
    roles: DESKTOPS,
    summary: 'Proxy abstains; escalates to the human',
    request: ActionBody,
    response: CommandReceipt,
    status: 201,
  },
  {
    method: 'POST',
    path: '/questions/{id}/cancel',
    auth: 'signed',
    roles: DESKTOPS,
    summary: 'Cancel an unanswered question (idempotent)',
    request: ActionBody,
    response: CommandReceipt,
    status: 201,
  },
  {
    method: 'POST',
    path: '/questions/{id}/reopen',
    auth: 'signed',
    roles: OWNER,
    summary: 'Reopen a cancelled or expired question',
    request: ActionBody,
    response: CommandReceipt,
    status: 201,
  },
  {
    method: 'PUT',
    path: '/questions/{id}/snapshot',
    auth: 'signed',
    roles: DESKTOPS,
    summary:
      "Replace the question's pane snapshot, or say sharing is off (the publishing desktop only)",
    request: PaneSnapshotBody,
    response: CommandReceipt,
  },
  {
    method: 'GET',
    path: '/questions/{id}/snapshot',
    auth: 'signed',
    roles: 'any',
    summary: 'The latest pane snapshot (ciphertext) and any outstanding refresh request',
    response: PaneSnapshotResponse,
  },
  {
    method: 'POST',
    path: '/questions/{id}/snapshot/refresh',
    auth: 'signed',
    roles: HUMANS,
    summary: 'Ask the publishing desktop for a fresh snapshot (coalesced while one is outstanding)',
    request: SnapshotRefreshBody,
    response: SnapshotRefresh,
  },
  {
    method: 'POST',
    path: '/questions/{id}/messages',
    auth: 'signed',
    roles: 'any',
    summary:
      'Post a thread message: human from a phone or tablet, agent from the publishing desktop (thread-messages-v1)',
    request: MessageBody,
    response: MessageReceipt,
    status: 201,
  },
  {
    method: 'GET',
    path: '/questions/{id}/messages',
    auth: 'signed',
    roles: 'any',
    summary: "A question's thread messages in order, with each human message's delivery",
    response: MessagesPage,
  },
  {
    method: 'POST',
    path: '/attachments/reservations',
    auth: 'signed',
    roles: DESKTOPS,
    summary: 'Reserve an encrypted attachment (client chooses the id)',
    request: AttachmentReserveBody,
    response: AttachmentReservation,
    status: 201,
  },
  {
    method: 'PUT',
    path: '/attachments/{id}/content',
    auth: 'signed',
    roles: DESKTOPS,
    summary: 'Stream ciphertext to private R2 (X-Content-Sha256 header)',
    streaming: 'binary-upload',
  },
  {
    method: 'POST',
    path: '/attachments/{id}/complete',
    auth: 'signed',
    roles: DESKTOPS,
    summary: 'Verify the stored object and publish it',
    request: AttachmentCompleteBody,
  },
  {
    method: 'GET',
    path: '/attachments/{id}/content',
    auth: 'signed',
    roles: 'any',
    summary: 'Download ciphertext',
    streaming: 'binary-download',
  },
  {
    method: 'GET',
    path: '/devices',
    auth: 'signed',
    roles: 'any',
    summary: 'All device certificates, including revoked ones',
    response: DevicesResponse,
  },
  {
    method: 'GET',
    path: '/devices/{id}/key-grants',
    auth: 'signed',
    roles: 'any',
    summary: 'Sealed epoch keys for the calling device',
    response: KeyGrantsResponse,
  },
  {
    method: 'POST',
    path: '/devices/enroll-host',
    auth: 'signed',
    roles: OWNER,
    summary: 'Enroll another desktop (a Daintree Host)',
    request: EnrollHostBody,
    status: 201,
  },
  {
    method: 'POST',
    path: '/devices/{id}/revoke',
    auth: 'signed',
    roles: OWNER,
    summary: 'Revoke a device and rotate the content key',
    request: RevokeDeviceBody,
  },
  {
    method: 'POST',
    path: '/epoch/rotate',
    auth: 'signed',
    roles: OWNER,
    summary: 'Rotate the content key without revoking anyone',
    request: RotateEpochBody,
  },
  {
    method: 'POST',
    path: '/deliveries/received',
    auth: 'signed',
    roles: DESKTOPS,
    summary: 'Desktop durably stored events up to a sequence number',
    request: DeliveryReceivedBody,
  },
  {
    method: 'POST',
    path: '/deliveries/terminal',
    auth: 'signed',
    roles: DESKTOPS,
    summary: 'Answer was really typed into the terminal',
    request: DeliveryTerminalBody,
  },
  {
    method: 'POST',
    path: '/deliveries/failed',
    auth: 'signed',
    roles: DESKTOPS,
    summary: 'Delivery needs attention or is uncertain',
    request: DeliveryFailedBody,
  },
  {
    method: 'POST',
    path: '/deliveries/messages',
    auth: 'signed',
    roles: DESKTOPS,
    summary:
      'The publishing desktop reports one human message received, typed, or needing attention',
    request: MessageReceiptBody,
    response: ok,
  },
  {
    method: 'GET',
    path: '/push/config',
    auth: 'signed',
    roles: 'any',
    summary: 'VAPID application server key',
    response: PushConfig,
  },
  {
    method: 'GET',
    path: '/push/subscriptions',
    auth: 'signed',
    roles: HUMANS,
    summary: "This device's push subscriptions",
    response: z.object({ subscriptions: z.array(PushSubscriptionInfo) }),
  },
  {
    method: 'POST',
    path: '/push/subscriptions',
    auth: 'signed',
    roles: HUMANS,
    summary: 'Register a Web Push subscription',
    request: PushSubscribeBody,
    response: PushSubscriptionInfo,
    status: 201,
  },
  {
    method: 'DELETE',
    path: '/push/subscriptions/{id}',
    auth: 'signed',
    roles: HUMANS,
    summary: 'Remove a subscription',
    response: ok,
  },
  {
    method: 'POST',
    path: '/push/test',
    auth: 'signed',
    roles: HUMANS,
    summary: 'Send a generic test notification to this device',
    response: PushTestResponse,
  },
  {
    method: 'GET',
    path: '/settings',
    auth: 'signed',
    roles: 'any',
    summary: 'Notification preferences',
    response: SettingsResponse,
  },
  {
    method: 'PUT',
    path: '/settings',
    auth: 'signed',
    roles: 'any',
    summary: 'Update notification preferences',
    request: SettingsBody,
    response: SettingsResponse,
  },
  {
    method: 'POST',
    path: '/voice/session',
    auth: 'signed',
    roles: HUMANS,
    summary: 'Mint a one-use dictation ticket (explicit consent required)',
    request: VoiceSessionBody,
    response: VoiceSessionResponse,
  },
  {
    method: 'GET',
    path: '/voice/ws',
    auth: 'none',
    summary: 'Transient dictation proxy WebSocket (ticket in the query string)',
    streaming: 'websocket',
  },
  {
    method: 'POST',
    path: '/voice/correct',
    auth: 'signed',
    roles: HUMANS,
    summary: 'Whole-passage transcript correction (not end-to-end encrypted)',
    request: VoiceCorrectBody,
    response: VoiceCorrectResponse,
  },
  {
    method: 'GET',
    path: '/admin/diagnostics',
    auth: 'signed',
    roles: OWNER,
    summary: 'Counters only, never content',
    response: Diagnostics,
  },
  {
    method: 'POST',
    path: '/admin/delete-data',
    auth: 'signed',
    roles: OWNER,
    summary: 'Delete relay data',
    request: DeleteDataBody,
  },
];

const jsonSchema = (s: z.ZodType) => {
  const j = z.toJSONSchema(s, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete j.$schema;
  return j;
};

/** OpenAPI 3.1 document describing every route; generated, never hand-edited. */
export function buildOpenApi(version = '0.1.0'): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTE_MANIFEST) {
    const key = `${API_PREFIX}${r.path}`;
    const op: Record<string, unknown> = {
      summary: r.summary,
      operationId: `${r.method.toLowerCase()}_${r.path.replace(/[{}]/g, '').replace(/\W+/g, '_').replace(/^_|_$/g, '')}`,
      security: r.auth === 'signed' ? [{ DecisionsSig: [] }] : [],
      'x-roles': r.roles ?? [],
      responses: {
        [String(r.status ?? 200)]: r.response
          ? {
              description: 'Success',
              content: { 'application/json': { schema: jsonSchema(r.response) } },
            }
          : { description: r.streaming ? `Streaming (${r.streaming})` : 'Success' },
        default: {
          description: 'Error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    };
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (params.length) op.parameters = params;
    if (r.request)
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: jsonSchema(r.request) } },
      };
    (paths[key] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Daintree Decisions relay protocol',
      version,
      description: `Normative semantics are in docs/protocol.md. Protocol version ${PROTOCOL_VERSION}. Every authenticated request carries "Authorization: Decisions-Sig v=1,i=<installation>,d=<device>,t=<epoch ms>,n=<nonce>,s=<ECDSA P-256 signature>" over the canonical request (method, path, sorted query, SHA-256 of the body, device, installation, timestamp, nonce).`,
      license: { name: 'Apache-2.0' },
    },
    servers: [
      { url: 'https://{relay}', variables: { relay: { default: 'your-relay.workers.dev' } } },
    ],
    paths,
    components: {
      securitySchemes: {
        DecisionsSig: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description: 'Decisions-Sig request signature (see info.description).',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: {
              type: 'string',
              enum: [
                'validation_error',
                'not_authenticated',
                'forbidden',
                'not_found',
                'revision_conflict',
                'idempotency_collision',
                'already_claimed',
                'invalid_state',
                'expired',
                'payload_too_large',
                'upgrade_required',
                'rate_limited',
                'not_configured',
                'temporarily_unavailable',
                'internal_error',
              ],
            },
            message: { type: 'string' },
            request_id: { type: 'string' },
            retry_after_ms: { type: 'integer' },
            details: { type: 'object' },
          },
        },
        CorrectionResult: jsonSchema(CorrectionResult),
      },
    },
  };
}

/** Plain JSON Schemas for the signed/encrypted structures that are not request or response bodies. */
export async function buildSchemaBundle(): Promise<Record<string, unknown>> {
  const s = await import('./schema.js');
  const api = await import('./api.js');
  const thread = await import('./thread.js');
  const snap = await import('./snapshot.js');
  const pick = {
    DeviceCert: s.DeviceCert,
    EpochGrant: s.EpochGrant,
    CryptoEnvelope: s.CryptoEnvelope,
    QuestionRecord: s.QuestionRecord,
    ActionRecord: s.ActionRecord,
    DecisionContentV1: s.DecisionContentV1,
    HumanAnswerContentV1: s.HumanAnswerContentV1,
    ProxyAnswerContentV1: s.ProxyAnswerContentV1,
    LedgerEvent: s.LedgerEvent,
    ServerFrame: api.ServerFrame,
    ClientFrame: api.ClientFrame,
    /*
     * Extensions (docs/protocol.md sections 16-19). Their routes join the manifest when the relay serves them;
     * the thread-message routes already have.
     */
    ProtocolFeature: s.ProtocolFeature,
    PhoneImageReference: s.PhoneImageReference,
    PhoneImageReserveBody: s.PhoneImageReserveBody,
    MessageRecord: thread.MessageRecord,
    HumanMessageContentV1: thread.HumanMessageContentV1,
    AgentMessageContentV1: thread.AgentMessageContentV1,
    MessageBody: thread.MessageBody,
    MessageReceipt: thread.MessageReceipt,
    MessagesPage: thread.MessagesPage,
    MessageReceiptBody: thread.MessageReceiptBody,
    PushPayload: thread.PushPayload,
    PaneSnapshotRecord: snap.PaneSnapshotRecord,
    PaneSnapshotContentV1: snap.PaneSnapshotContentV1,
    PaneSnapshotBody: snap.PaneSnapshotBody,
    SnapshotRefreshBody: snap.SnapshotRefreshBody,
    PaneSnapshotResponse: snap.PaneSnapshotResponse,
  };
  return Object.fromEntries(Object.entries(pick).map(([k, v]) => [k, jsonSchema(v as z.ZodType)]));
}
