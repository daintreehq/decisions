import type {
  ApiError,
  EventsPage,
  LedgerEvent,
  ProtocolFeature,
  Role,
  ServerFrame,
  SettingsBody,
} from '@daintreehq/decisions-protocol';
import type { z } from 'zod';
import type { Env } from '../env.js';
import type { ApiRequest, ApiResponse } from '../util.js';

export interface DeviceRow {
  device_id: string;
  role: Role;
  label: string;
  signing_pub: string;
  exchange_pub: string;
  cert_json: string;
  created_at: number;
  revoked_at: number | null;
  last_seen_at: number | null;
  last_ack_seq: number;
  /** JSON array of the feature tokens the device declared on its latest socket ticket (section 19). */
  features: string;
}

export interface Auth {
  deviceId: string;
  role: Role;
  installationId: string;
}

export interface JobInput {
  kind: JobKind;
  runAt: number;
  questionId?: string | null;
  attachmentId?: string | null;
  payload?: Record<string, unknown>;
}

export type JobKind =
  | 'notify_new'
  | 'notify_reply'
  | 'remind'
  | 'proxy_review'
  | 'expire'
  | 'delete_attachments'
  | 'gc_orphan'
  | 'delete_phone_image'
  | 'purge';

export type Settings = Omit<SettingsBody, 'protocol_version'>;

/** What route modules may do. The Durable Object implements it; modules never touch sockets or alarms directly. */
export interface Room {
  env: Env;
  q<T = Record<string, unknown>>(sql: string, ...bindings: SqlStorageValue[]): T[];
  q1<T = Record<string, unknown>>(sql: string, ...bindings: SqlStorageValue[]): T | undefined;
  run(sql: string, ...bindings: SqlStorageValue[]): number;
  /** Runs `fn` atomically; broadcasts events emitted inside it only after commit; refreshes the alarm. */
  tx<T>(fn: () => T): Promise<T>;
  emit(
    type: LedgerEvent['event_type'],
    a: {
      questionId?: string | null;
      revision?: number | null;
      deviceId?: string | null;
      data: Record<string, unknown>;
    },
  ): LedgerEvent;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  installationId(): string | undefined;
  currentEpoch(): number;
  getDevice(id: string): DeviceRow | undefined;
  devicePublicKey(d: Pick<DeviceRow, 'device_id' | 'signing_pub'>): Promise<CryptoKey>;
  forgetDeviceKey(id: string): void;
  schedule(job: JobInput): void;
  /** Recomputes the alarm after the current `tx` commits (for deadlines kept outside `scheduled_jobs`). */
  markAlarmDirty(): void;
  /** One page of the ledger after `after`, holding only events the declared features allow (section 19). */
  eventsPage(
    after: number,
    features: ReadonlySet<ProtocolFeature>,
    limit: number,
    maxBytes: number,
    size?: (ev: LedgerEvent) => number,
  ): EventsPage;
  cancelJobs(where: { questionId: string; kinds?: JobKind[] }): void;
  hit(key: string, limit: number, windowMs: number): void;
  /** Throws rate_limited if `key` already used up its budget, without consuming any. */
  assertBudget(key: string, limit: number, windowMs: number): void;
  /** Throws not_authenticated unless the device is still active. Call inside the final synchronous section. */
  assertActive(deviceId: string): void;
  resetRuntime(): Promise<void>;
  settings(): Settings;
  broadcastToRole(roles: Role[], frame: ServerFrame): void;
  closeDeviceSockets(deviceId: string, frame?: ServerFrame): void;
  socketCount(): number;
  vapid(): { privateJwk: JsonWebKey; publicKey: string } | undefined;
  authenticate(req: ApiRequest, roles?: readonly Role[]): Promise<Auth>;
  mintTicket(
    kind: 'ws' | 'voice',
    deviceId: string,
    payload: Record<string, unknown>,
    ttlMs: number,
  ): Promise<string>;
  alarmAt(): Promise<number | null>;
}

export interface RouteCtx {
  req: ApiRequest;
  auth: Auth | null;
  params: string[];
  body<T extends z.ZodType>(schema: T): z.infer<T>;
  /** SHA-256 hex of the raw body, for idempotency digests. */
  bodyDigest(): Promise<string>;
}

export type Handler = (room: Room, c: RouteCtx) => Promise<ApiResponse>;

export type { ApiError };
