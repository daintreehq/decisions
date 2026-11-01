import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { utf8ToBytes } from '@daintree/decisions-protocol';
import { sha256Hex } from '@daintree/decisions-crypto';
import {
  IMPORT_LIMITS,
  ImportError,
  MemoryLocalStore,
  exportDecisions,
  importDecisions,
} from '../src/index.js';
import { origin, setupBridge } from './helpers.js';

async function populated() {
  const env = await setupBridge();
  const r = await env.bridge.registerQuestion({
    origin: origin(),
    input: { question: 'Export me? SECRET-TEXT', options: [{ id: 'y', label: 'Yes' }] },
  });
  await env.bridge.pump();
  await env.relay.answerEvent({
    questionId: r.questionId,
    phone: env.phone,
    options: ['y'],
    text: 'because',
  });
  await env.bridge.catchUp();
  return { ...env, qid: r.questionId };
}

describe('export', () => {
  it('requires a passphrase unless plaintext is explicit', async () => {
    const { store, identity } = await populated();
    await expect(exportDecisions({ store, identity })).rejects.toThrow(/passphrase/);
  });
  it('encrypts by default: no plaintext, no key material in the file', async () => {
    const { store, identity } = await populated();
    const out = await exportDecisions({ store, identity, passphrase: 'a long export passphrase' });
    expect(out.encrypted).toBe(true);
    expect(out.fileName).toMatch(/^decisions-export-\d{4}-\d{2}-\d{2}\.dxz\.json$/);
    const text = JSON.stringify(out.data);
    expect(text).not.toContain('SECRET-TEXT');
    expect(text).not.toContain('because');
  });
  it('plaintext export has the documented layout and a verifiable manifest', async () => {
    const { store, identity } = await populated();
    const out = await exportDecisions({ store, identity, plaintext: true });
    if (out.encrypted) throw new Error('expected a zip');
    const files = unzipSync(out.data);
    expect(Object.keys(files).sort()).toEqual([
      'README-restore.md',
      'audit-events.jsonl',
      'decisions.jsonl',
      'device-public-keys.json',
      'manifest.json',
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    for (const f of manifest.files) expect(await sha256Hex(files[f.path]!)).toBe(f.sha256);
    expect(new TextDecoder().decode(files['decisions.jsonl'])).toContain('SECRET-TEXT');
    // private keys must never be exported
    const all = Object.values(files)
      .map((b) => new TextDecoder().decode(b))
      .join('\n');
    expect(all).not.toContain(identity.stored.keys.signing_private_pkcs8);
  });
});

describe('import', () => {
  it('round-trips an encrypted export as history-only that is never delivered', async () => {
    const src = await populated();
    const out = await exportDecisions({
      store: src.store,
      identity: src.identity,
      passphrase: 'a long export passphrase',
    });
    if (!out.encrypted) throw new Error('x');
    const dst = await setupBridge();
    const res = await importDecisions(
      { encrypted: out.data, passphrase: 'a long export passphrase' },
      dst.store,
    );
    expect(res).toMatchObject({ imported: 1, skipped: 0 });
    const row = (await dst.store.getQuestion(src.qid))!;
    expect(row.history_only).toBe(true);
    expect(row.content_json).toContain('SECRET-TEXT');
    expect(await dst.store.dueOutbox(Number.MAX_SAFE_INTEGER, 10)).toHaveLength(0);
    // even a fresh answer-looking event for an imported question is ignored and nothing is typed
    expect((await dst.bridge.delivery.drain()).delivered).toBe(0);
    expect(dst.sink.typed).toHaveLength(0);
    // importing twice skips
    expect(
      (
        await importDecisions(
          { encrypted: out.data, passphrase: 'a long export passphrase' },
          dst.store,
        )
      ).skipped,
    ).toBe(1);
    await expect(
      importDecisions({ encrypted: out.data, passphrase: 'wrong passphrase here' }, dst.store),
    ).rejects.toThrow();
  });

  const manifestFor = async (files: Record<string, Uint8Array>) => ({
    export_version: 1,
    created_at: 'x',
    installation_id: 'i',
    counts: { decisions: 0, audit_events: 0 },
    key_epochs: [1],
    files: await Promise.all(
      Object.entries(files).map(async ([path, b]) => ({
        path,
        sha256: await sha256Hex(b),
        bytes: b.length,
      })),
    ),
  });

  it('rejects a tampered file (checksum mismatch)', async () => {
    const dj = utf8ToBytes('');
    const man = await manifestFor({ 'decisions.jsonl': dj });
    const zip = zipSync({
      'manifest.json': utf8ToBytes(JSON.stringify(man)),
      'decisions.jsonl': utf8ToBytes('{"question_id":"evil"}\n'),
    });
    await expect(importDecisions({ zip }, new MemoryLocalStore())).rejects.toThrow(/checksum/);
  });
  it('rejects path traversal and unexpected files', async () => {
    for (const name of [
      '../escape.txt',
      '/etc/passwd',
      'a\\b.txt',
      'C:evil',
      'attachments/x.png',
    ]) {
      const zip = zipSync({ [name]: utf8ToBytes('x'), 'manifest.json': utf8ToBytes('{}') });
      await expect(importDecisions({ zip }, new MemoryLocalStore())).rejects.toBeInstanceOf(
        ImportError,
      );
    }
  });
  it('rejects zip bombs and oversized entries', async () => {
    const big = new Uint8Array(IMPORT_LIMITS.maxFileBytes + 1);
    const zip = zipSync({ 'decisions.jsonl': big }, { level: 9 });
    expect(zip.length).toBeLessThan(1_000_000); // highly compressible
    await expect(importDecisions({ zip }, new MemoryLocalStore())).rejects.toBeInstanceOf(
      ImportError,
    );
    const ratio = zipSync({ 'decisions.jsonl': new Uint8Array(20 * 1024 * 1024) }, { level: 9 });
    await expect(importDecisions({ zip: ratio }, new MemoryLocalStore())).rejects.toThrow(
      /compression ratio/,
    );
  });
  it('rejects garbage and archives without a manifest', async () => {
    await expect(
      importDecisions({ zip: utf8ToBytes('not a zip') }, new MemoryLocalStore()),
    ).rejects.toBeInstanceOf(ImportError);
    await expect(
      importDecisions(
        { zip: zipSync({ 'decisions.jsonl': utf8ToBytes('') }) },
        new MemoryLocalStore(),
      ),
    ).rejects.toThrow(/manifest/);
  });
});
