import { sha256Hex } from '@daintree/decisions-crypto';
import type { AuditLog } from './audit.js';
import type { Identity } from './identity.js';
import type { PolicyRegistry } from './policy.js';
import type { RelayClient } from './relay.js';
import type { LocalStore } from './store.js';
import type { QuestionOrigin } from './types.js';

/** Opaque, relay-safe identifiers derived from local names. Real host/pane ids never leave the machine. */
export async function hostRef(hostId: string): Promise<string> {
  return (await sha256Hex(`decisions/host/${hostId}`)).slice(0, 32);
}
export async function paneRef(hostId: string, paneId: string): Promise<string> {
  return (await sha256Hex(`decisions/pane/${hostId}/${paneId}`)).slice(0, 32);
}
export async function gateHash(gateId: string): Promise<string> {
  return sha256Hex(`decisions/gate/${gateId}`);
}

export interface AttachmentSpool {
  put(id: string, bytes: Uint8Array): Promise<void>;
  get(id: string): Promise<Uint8Array | null>;
  delete(id: string): Promise<void>;
}

export class MemorySpool implements AttachmentSpool {
  private m = new Map<string, Uint8Array>();
  async put(id: string, b: Uint8Array) {
    this.m.set(id, b);
  }
  async get(id: string) {
    return this.m.get(id) ?? null;
  }
  async delete(id: string) {
    this.m.delete(id);
  }
}

/** Scope-checked attachment source supplied by the host; the agent only ever names an id, never a path. */
export interface AttachmentResolver {
  resolve(origin: QuestionOrigin, localResourceId: string): Promise<{ bytes: Uint8Array } | null>;
}

export interface BridgeContext {
  identity: Identity;
  client: RelayClient;
  store: LocalStore;
  audit: AuditLog;
  policy: PolicyRegistry;
  spool: AttachmentSpool;
  resolver: AttachmentResolver | undefined;
  now: () => number;
}
