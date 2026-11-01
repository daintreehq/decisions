import { unzipSync, zipSync } from 'fflate';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  utf8ToBytes,
} from '@daintree/decisions-protocol';
import {
  decryptRecoveryBundle,
  encryptRecoveryBundle,
  sha256Hex,
  type RecoveryBundleFile,
} from '@daintree/decisions-crypto';
import { parseAnswers, serializeAnswers, type AnswerEntry } from './answers.js';
import type { Identity } from './identity.js';
import type { LocalStore } from './store.js';
import type { AuditEntry, QuestionRow } from './types.js';

export const EXPORT_VERSION = 1;
const ALLOWED_PATHS = new Set([
  'manifest.json',
  'decisions.jsonl',
  'device-public-keys.json',
  'audit-events.jsonl',
  'README-restore.md',
]);

/** Limits that stop a hostile archive from exhausting memory (zip bombs, oversized entries). */
export const IMPORT_LIMITS = {
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxEntries: 32,
  maxRatio: 200,
} as const;

export interface ExportManifest {
  export_version: number;
  created_at: string;
  installation_id: string;
  counts: { decisions: number; audit_events: number };
  key_epochs: number[];
  files: { path: string; sha256: string; bytes: number }[];
}

export interface ExportOptions {
  store: LocalStore;
  identity: Identity;
  /** Passphrase for the encrypted archive. Required unless `plaintext` is set. */
  passphrase?: string;
  /** Explicit opt-in to an unencrypted .zip. */
  plaintext?: boolean;
  devices?: {
    device_id: string;
    role: string;
    label: string;
    signing_pub: string;
    exchange_pub: string;
    revoked_at: string | null;
  }[];
  now?: Date;
}

export type ExportResult =
  | { encrypted: true; fileName: string; data: RecoveryBundleFile }
  | { encrypted: false; fileName: string; data: Uint8Array };

const README = `# Decisions export

This archive holds your Daintree Decisions history.

* decisions.jsonl     one JSON object per question: content, requirement, status and every verified answer.
* device-public-keys.json   the public keys of paired devices (no private keys).
* audit-events.jsonl  the local audit log (ids, levels, provenance; never message text unless debug logging was on).
* manifest.json       SHA-256 of every file, verified on import.

Importing restores records as history only. Imported answers are never typed into a terminal.
Encrypted archives need the passphrase you chose at export time; without it they cannot be recovered.
`;

function rowToRecord(q: QuestionRow) {
  return {
    question_id: q.question_id,
    alias: q.alias,
    requirement: q.requirement,
    status: q.local_status,
    created_at: q.origin_created_at,
    expires_at: q.expires_at,
    revision: q.question_revision,
    project_id: q.origin.project_id,
    content: q.content_json ? (JSON.parse(q.content_json) as unknown) : null,
    answers: parseAnswers(q.answers_json),
    attachment_digests: q.attachment_digests,
  };
}

export async function exportDecisions(o: ExportOptions): Promise<ExportResult> {
  if (!o.plaintext && !o.passphrase)
    throw new Error('a passphrase is required (or pass plaintext explicitly)');
  const created = o.now ?? new Date();
  const questions = (await o.store.listQuestions()).filter((q) => !q.history_only || true);
  const audit: AuditEntry[] = await o.store.listAudit(100_000);
  const files: Record<string, Uint8Array> = {
    'decisions.jsonl': utf8ToBytes(
      questions.map((q) => JSON.stringify(rowToRecord(q))).join('\n') + '\n',
    ),
    'device-public-keys.json': utf8ToBytes(JSON.stringify(o.devices ?? [], null, 2)),
    'audit-events.jsonl': utf8ToBytes(
      audit.map((a) => JSON.stringify(a)).join('\n') + (audit.length ? '\n' : ''),
    ),
    'README-restore.md': utf8ToBytes(README),
  };
  const manifest: ExportManifest = {
    export_version: EXPORT_VERSION,
    created_at: created.toISOString(),
    installation_id: o.identity.config.installationId,
    counts: { decisions: questions.length, audit_events: audit.length },
    key_epochs: [...o.identity.epochs.keys()],
    files: await Promise.all(
      Object.entries(files).map(async ([path, bytes]) => ({
        path,
        sha256: await sha256Hex(bytes),
        bytes: bytes.length,
      })),
    ),
  };
  files['manifest.json'] = utf8ToBytes(JSON.stringify(manifest, null, 2));
  const zip = zipSync(files, { level: 6 });
  const day = created.toISOString().slice(0, 10);
  if (o.plaintext) return { encrypted: false, fileName: `decisions-export-${day}.zip`, data: zip };
  const data = await encryptRecoveryBundle(
    { kind: 'decisions-export', zip: bytesToBase64Url(zip) },
    o.passphrase!,
  );
  return { encrypted: true, fileName: `decisions-export-${day}.dxz.json`, data };
}

export class ImportError extends Error {}

function safeName(name: string): boolean {
  return !(
    name.includes('..') ||
    name.startsWith('/') ||
    name.includes('\\') ||
    /^[A-Za-z]:/.test(name) ||
    name.includes('\0')
  );
}

export interface ImportResult {
  imported: number;
  skipped: number;
  manifest: ExportManifest;
}

export async function importDecisions(
  input: { zip: Uint8Array } | { encrypted: RecoveryBundleFile; passphrase: string },
  store: LocalStore,
): Promise<ImportResult> {
  let zip: Uint8Array;
  if ('zip' in input) zip = input.zip;
  else {
    const body = await decryptRecoveryBundle<{ kind: string; zip: string }>(
      input.encrypted,
      input.passphrase,
    );
    if (body.kind !== 'decisions-export') throw new ImportError('not a Decisions export');
    zip = base64UrlToBytes(body.zip);
  }
  let total = 0;
  let entries = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, {
      filter: (f) => {
        if (++entries > IMPORT_LIMITS.maxEntries) throw new ImportError('too many entries');
        if (!safeName(f.name)) throw new ImportError(`unsafe path "${f.name.slice(0, 40)}"`);
        if (f.name.endsWith('/')) return false;
        if (!ALLOWED_PATHS.has(f.name))
          throw new ImportError(`unexpected file "${f.name.slice(0, 40)}"`);
        if (f.originalSize > IMPORT_LIMITS.maxFileBytes) throw new ImportError('entry too large');
        total += f.originalSize;
        if (total > IMPORT_LIMITS.maxTotalBytes) throw new ImportError('archive too large');
        if (f.size > 0 && f.originalSize / f.size > IMPORT_LIMITS.maxRatio)
          throw new ImportError('suspicious compression ratio');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError('not a valid archive');
  }
  const mf = files['manifest.json'];
  if (!mf) throw new ImportError('manifest.json missing');
  const manifest = JSON.parse(bytesToUtf8(mf)) as ExportManifest;
  if (manifest.export_version !== EXPORT_VERSION)
    throw new ImportError('unsupported export version');
  for (const f of manifest.files) {
    const bytes = files[f.path];
    if (!ALLOWED_PATHS.has(f.path) || !bytes) throw new ImportError(`missing file ${f.path}`);
    if ((await sha256Hex(bytes)) !== f.sha256 || bytes.length !== f.bytes)
      throw new ImportError(`checksum mismatch for ${f.path}`);
  }
  const dj = files['decisions.jsonl'];
  if (!dj) throw new ImportError('decisions.jsonl missing');
  let imported = 0;
  let skipped = 0;
  for (const line of bytesToUtf8(dj).split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as ReturnType<typeof rowToRecord>;
    if (typeof r.question_id !== 'string' || (await store.getQuestion(r.question_id))) {
      skipped++;
      continue;
    }
    const answers: AnswerEntry[] = (Array.isArray(r.answers) ? r.answers : []).map((a) => ({
      ...a,
      deliver: false,
      delivered: true,
    }));
    const row: QuestionRow = {
      question_id: r.question_id,
      alias: await store.nextAlias(),
      origin: {
        host_id: 'imported',
        pane_id: 'imported',
        terminal_generation: 0,
        agent_kind: 'imported',
        agent_session_id: null,
        project_id: String(r.project_id ?? 'imported'),
        worktree_id: 'imported',
        worktree_root: '',
        workflow_gate_id: null,
      },
      requirement: r.requirement,
      question_revision: r.revision ?? 0,
      remote_event_seq: null,
      origin_created_at: r.created_at,
      expires_at: r.expires_at ?? null,
      local_status: r.status,
      delivery_status: 'terminal-delivered',
      last_injection_id: null,
      last_attempt_at: null,
      agent_resume_strategy: null,
      error_code: null,
      content_json: r.content ? JSON.stringify(r.content) : null,
      answers_json: serializeAnswers(answers),
      history_only: true,
      delivered_revision: r.revision ?? 0,
      attachment_digests: r.attachment_digests ?? [],
    };
    // History-only rows are inserted without an outbox item: nothing is ever published or delivered.
    await store.commitNewQuestion(row, {
      id: `import-${r.question_id}`.slice(0, 64),
      kind: 'cancel',
      question_id: r.question_id,
      payload: {},
      attempts: 0,
      next_attempt_at: Number.MAX_SAFE_INTEGER,
      created_at: Date.now(),
      last_error: null,
    });
    await store.deleteOutbox(`import-${r.question_id}`.slice(0, 64));
    imported++;
  }
  return { imported, skipped, manifest };
}
