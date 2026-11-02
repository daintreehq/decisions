import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '@daintreehq/decisions-crypto';
import type { AuditLog } from './audit.js';
import type { Identity } from './identity.js';
import type { PolicyRegistry } from './policy.js';
import type { DecisionLearner } from './proxy.js';
import type { RelayClient } from './relay.js';
import type { Mutex } from './mutex.js';
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

/** Everything that identifies WHERE a question came from. Used to scope ownership and correlation ids. */
export async function originScope(o: QuestionOrigin): Promise<string> {
  return (
    await sha256Hex(
      JSON.stringify([
        'decisions/scope',
        o.host_id,
        o.pane_id,
        o.terminal_generation,
        o.ownership_principal,
        o.agent_incarnation,
        o.agent_session_id,
        o.worktree_id,
      ]),
    )
  ).slice(0, 32);
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

/**
 * Durable spool for encrypted attachment ciphertext awaiting upload: files (0600) in a private directory (0700),
 * written atomically and fsynced. Required whenever the local store survives restarts.
 */
export class FileSpool implements AttachmentSpool {
  constructor(private readonly dir: string) {}
  private path(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('invalid spool id');
    return join(this.dir, id);
  }
  async put(id: string, bytes: Uint8Array): Promise<void> {
    const target = this.path(id);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const tmp = `${target}.tmp`;
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
  }
  async get(id: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(id)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async delete(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
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
  /** Serialises read-modify-write sections that touch a question's answer history. */
  lock: Mutex;
  /**
   * Pick up epoch keys rotated since the identity was loaded: from the key store on the owner desktop (another
   * process may have rotated), from this device's sealed grants on the relay on a `desktop-host`.
   * `announcedEpoch` is the epoch a rotation event says the relay committed, when one triggered the refresh.
   */
  refreshIdentity?: (announcedEpoch?: number) => Promise<void>;
  /** The decision model's history, when the host wired one: receives human decisions (see `DecisionLearner`). */
  learner?: DecisionLearner;
}
