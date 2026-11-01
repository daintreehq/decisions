import { z } from 'zod';
import {
  ActionKind,
  B64Url,
  CryptoEnvelope,
  DeliveryStatus,
  DeviceCert,
  EpochGrant,
  Id,
  IsoTime,
  LedgerEvent,
  Provenance,
  QuestionRecord,
  QuestionStatus,
  Requirement,
  Role,
  Sha256Hex,
  SettingsBody,
  ActionRecord,
} from './schema.js';
import { PROTOCOL_VERSION } from './version.js';

/* ---------- REST responses ---------- */

export const ClaimResponse = z.object({
  installation_id: Id,
  /** VAPID application server key (raw P-256 point, base64url) for PushManager.subscribe. */
  vapid_public_key: B64Url,
  server_time: IsoTime,
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export const QuestionSummary = z.object({
  question_id: Id,
  status: QuestionStatus,
  revision: z.number().int().min(0),
  requirement: Requirement,
  target_host_id: Id,
  created_at: IsoTime,
  expires_at: IsoTime.nullable(),
  resolved_at: IsoTime.nullable(),
  last_event_seq: z.number().int(),
  proxy_abstained: z.boolean(),
});
export type QuestionSummary = z.infer<typeof QuestionSummary>;

export const ActionLogEntry = z.object({
  action_id: Id,
  action: ActionKind,
  /** Revision of the question after this action. */
  revision: z.number().int().min(0),
  provenance: Provenance.nullable(),
  actor_device_id: Id,
  created_at: IsoTime,
  event_seq: z.number().int(),
  record: ActionRecord,
  envelope: CryptoEnvelope.nullable(),
});
export type ActionLogEntry = z.infer<typeof ActionLogEntry>;

export const DeliveryInfo = z.object({
  answer_revision: z.number().int(),
  target_host_id: Id,
  status: DeliveryStatus,
  received_at: IsoTime.nullable(),
  terminal_delivered_at: IsoTime.nullable(),
  injection_id: Id.nullable(),
  error_code: z.string().nullable(),
});
export type DeliveryInfo = z.infer<typeof DeliveryInfo>;

export const AttachmentInfo = z.object({
  attachment_id: Id,
  state: z.enum(['reserved', 'uploaded', 'available', 'deleted']),
  ciphertext_bytes: z.number().int(),
});
export type AttachmentInfo = z.infer<typeof AttachmentInfo>;

export const QuestionDetail = QuestionSummary.extend({
  question: z.object({ record: QuestionRecord, envelope: CryptoEnvelope }),
  actions: z.array(ActionLogEntry),
  attachments: z.array(AttachmentInfo),
  deliveries: z.array(DeliveryInfo),
});
export type QuestionDetail = z.infer<typeof QuestionDetail>;

export const QuestionList = z.object({
  questions: z.array(QuestionSummary),
  next_cursor: z.string().nullable(),
});

export const CommandReceipt = z.object({
  question_id: Id,
  revision: z.number().int().min(0),
  status: QuestionStatus,
  event_seq: z.number().int().nullable(),
  created_at: IsoTime.optional(),
});
export type CommandReceipt = z.infer<typeof CommandReceipt>;

export const DeviceInfo = z.object({
  device_id: Id,
  role: Role,
  label: z.string(),
  created_at: IsoTime,
  revoked_at: IsoTime.nullable(),
  last_seen_at: IsoTime.nullable(),
  last_ack_seq: z.number().int(),
  /** Owner-signed certificate: clients verify historical signatures against it, even for revoked devices. */
  cert: DeviceCert,
  push_enabled: z.boolean(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const DevicesResponse = z.object({
  key_epoch: z.number().int().min(1),
  owner_device_id: Id,
  devices: z.array(DeviceInfo),
});
export type DevicesResponse = z.infer<typeof DevicesResponse>;

export const KeyGrantsResponse = z.object({
  current_epoch: z.number().int().min(1),
  grants: z.array(EpochGrant),
});

export const PairingState = z.enum([
  'waiting-for-candidate',
  'pending-approval',
  'approved',
  'rejected',
  'expired',
]);

export const PairingCandidateResponse = z.object({
  pairing_id: Id,
  short_code: z.string().regex(/^\d{3} \d{3}$/),
  expires_at: IsoTime,
  owner_cert: DeviceCert,
  installation_id: Id,
});

export const PairingStatusResponse = z.object({
  state: PairingState,
  short_code: z.string().nullable(),
  expires_at: IsoTime,
  owner_cert: DeviceCert.nullable(),
  /** Present once approved. */
  cert: DeviceCert.nullable(),
  grant: EpochGrant.nullable(),
});
export type PairingStatusResponse = z.infer<typeof PairingStatusResponse>;

export const PendingPairing = z.object({
  pairing_id: Id,
  device_id: Id,
  label: z.string(),
  role: z.enum(['phone', 'tablet']),
  signing_pub: B64Url,
  exchange_pub: B64Url,
  short_code: z.string(),
  expires_at: IsoTime,
});
export type PendingPairing = z.infer<typeof PendingPairing>;

export const SocketTicketResponse = z.object({
  ticket: B64Url,
  expires_at: IsoTime,
  /** Path (relative to the relay origin) to open as wss. */
  ws_path: z.string(),
});

export const AttachmentReservation = z.object({
  attachment_id: Id,
  upload_path: z.string(),
  expires_at: IsoTime,
});

export const PushConfig = z.object({ vapid_public_key: B64Url });
export const PushSubscriptionInfo = z.object({
  subscription_id: Id,
  device_id: Id,
  created_at: IsoTime,
  last_success_at: IsoTime.nullable(),
  last_error_code: z.string().nullable(),
  enabled: z.boolean(),
});
export const PushTestResponse = z.object({
  attempted: z.number().int(),
  delivered: z.number().int(),
  results: z.array(
    z.object({ subscription_id: Id, status: z.number().int().nullable(), ok: z.boolean() }),
  ),
});

export const SettingsResponse = z.object({
  settings: SettingsBody.omit({ protocol_version: true }),
});

export const VoiceSessionResponse = z.object({
  ticket: B64Url,
  ws_path: z.string(),
  provider: z.enum(['xai', 'openai']),
  /** The Worker always accepts mono PCM16 little-endian at this rate as binary frames. */
  sample_rate: z.literal(16000),
  max_session_ms: z.number().int(),
  expires_at: IsoTime,
});
export const VoiceCorrectResponse = z.object({
  result: z.unknown(),
  model: z.string(),
});

export const Diagnostics = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  worker_version: z.string(),
  key_epoch: z.number().int(),
  counts: z.record(z.string(), z.number()),
  jobs: z.object({
    pending: z.number().int(),
    failed: z.number().int(),
    next_run_at: IsoTime.nullable(),
    alarm_at: IsoTime.nullable(),
  }),
  attachments: z.object({
    reserved: z.number().int(),
    available: z.number().int(),
    bytes: z.number().int(),
  }),
  sockets: z.number().int(),
  event_high_water: z.number().int(),
  push: z.object({ subscriptions: z.number().int(), failing: z.number().int() }),
});
export type Diagnostics = z.infer<typeof Diagnostics>;

/* ---------- WebSocket frames (hibernatable Durable Object socket) ---------- */

/**
 * One socket per device at `GET /api/v1/socket?ticket=...`. Plain-text `ping` is answered with `pong`
 * by the runtime without waking the Durable Object (setWebSocketAutoResponse), so keep-alives are free.
 */
export const ServerFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    protocol_version: z.literal(PROTOCOL_VERSION),
    device_id: Id,
    role: Role,
    key_epoch: z.number().int(),
    high_water: z.number().int(),
    server_time: IsoTime,
  }),
  /** Ledger event, pushed in seq order as they commit (and during `sync`). */
  z.object({ t: z.literal('event'), event: LedgerEvent }),
  /**
   * Reply to `sync`. `high_water` is the last seq sent. When `has_more` is true the replay was cut short by the
   * per-request budget: send `sync` again with `after = high_water`. Only `has_more: false` means "fully caught up".
   */
  z.object({
    t: z.literal('caught_up'),
    high_water: z.number().int(),
    has_more: z.boolean().default(false),
  }),
  /** Hint to owner desktops that a pairing candidate is waiting for approval. */
  z.object({ t: z.literal('pairing'), pairing_id: Id }),
  /** Response to a tunnelled `req` frame. `body` is the JSON string a plain HTTP call would return. */
  z.object({
    t: z.literal('res'),
    id: z.string().max(64),
    status: z.number().int(),
    body: z.string(),
  }),
  /** Sent just before the server closes with code 4401 because this device was revoked. */
  z.object({ t: z.literal('revoked') }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

export const ClientFrame = z.discriminatedUnion('t', [
  /** Replay every ledger event with seq > after (paged server-side), then `caught_up`. */
  z.object({ t: z.literal('sync'), after: z.number().int().min(0) }),
  /** Desktop durable-receipt of events up to and including `seq` (not terminal delivery). */
  z.object({ t: z.literal('ack'), seq: z.number().int().min(0) }),
  /**
   * Tunnel a signed REST request over the socket. Identical semantics to HTTP: the Authorization
   * header is the same Decisions-Sig value and signs method/path/query/sha256(body).
   * Not available for attachment content or WebSocket-upgrade routes.
   */
  z.object({
    t: z.literal('req'),
    id: z.string().min(1).max(64),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    path: z.string().max(512),
    query: z.string().max(1024).default(''),
    body: z
      .string()
      .max(1024 * 1024)
      .optional(),
    authorization: z.string().max(1024),
  }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const WS_CLOSE = {
  revoked: 4401,
  replaced: 4409,
  badFrame: 4400,
} as const;

/** Shapes of `LedgerEvent.data` per event type, for typed consumers. */
export const EventData = {
  created: z.object({
    record: QuestionRecord,
    envelope: CryptoEnvelope,
    requirement: Requirement,
    target_host_id: Id,
    expires_at: IsoTime.nullable(),
  }),
  action: z.object({
    action: ActionKind,
    record: ActionRecord,
    envelope: CryptoEnvelope.nullable(),
    provenance: Provenance.nullable(),
    status: QuestionStatus,
    revision: z.number().int(),
    target_host_id: Id,
    /** True when this event carries an answer the desktop must deliver into the originating terminal. */
    deliverable: z.boolean(),
  }),
  expired: z.object({ expired_at: IsoTime, target_host_id: Id }),
  deleted: z.object({ question_id: Id }),
  deviceApproved: z.object({ cert: DeviceCert }),
  deviceRevoked: z.object({ device_id: Id, key_epoch: z.number().int() }),
  keyRotated: z.object({ key_epoch: z.number().int() }),
  attachmentAvailable: z.object({ attachment_id: Id }),
  deliveryReceived: z.object({ up_to_seq: z.number().int(), device_id: Id }),
  deliveryTerminal: z.object({
    answer_revision: z.number().int(),
    target_host_id: Id,
    injection_id: Id,
  }),
  deliveryAttention: z.object({
    answer_revision: z.number().int(),
    target_host_id: Id,
    status: z.enum(['needs-attention', 'delivery-uncertain']),
    error_code: z.string(),
  }),
} as const;

export { Sha256Hex };
