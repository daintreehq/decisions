import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LocalStore } from './store.js';
import type { AuditEntry } from './types.js';

/**
 * Local audit log: question ids, levels, provenance and delivery results. Question and answer TEXT is never
 * recorded unless `debugContent` is explicitly enabled by the user.
 */
export class AuditLog {
  constructor(
    private readonly store: LocalStore,
    private readonly opts: { jsonlPath?: string; debugContent?: boolean; now?: () => Date } = {},
  ) {}

  get debugContent(): boolean {
    return this.opts.debugContent === true;
  }

  async log(entry: Omit<AuditEntry, 'at'> & { content?: string }): Promise<void> {
    const { content, ...rest } = entry;
    const e: AuditEntry = { at: (this.opts.now?.() ?? new Date()).toISOString(), ...rest };
    if (this.opts.debugContent && content !== undefined) {
      e.detail = { ...(e.detail ?? {}), content };
    }
    await this.store.appendAudit(e);
    if (this.opts.jsonlPath) {
      try {
        await mkdir(dirname(this.opts.jsonlPath), { recursive: true, mode: 0o700 });
        await appendFile(this.opts.jsonlPath, JSON.stringify(e) + '\n', { mode: 0o600 });
      } catch {
        /* the table copy is authoritative; never fail a delivery over a log file */
      }
    }
  }
}
