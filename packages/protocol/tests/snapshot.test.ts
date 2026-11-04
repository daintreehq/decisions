import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  PaneSnapshotBody,
  PaneSnapshotContentV1,
  PaneSnapshotRecord,
  PaneSnapshotResponse,
  SignedPaneSnapshot,
  boundTerminalLines,
  snapshotFreshness,
  utf8ByteLength,
  type CryptoEnvelope,
} from '../src/index.js';
import {
  FIXTURE_NOW,
  SHARING_OFF_FIXTURE,
  SNAPSHOT_FIXTURE,
  STALE_SNAPSHOT_FIXTURE,
} from '../src/fixtures.js';

const SIG = 's'.repeat(86);
const DIGEST = 'a'.repeat(64);
const NOW = Date.parse(FIXTURE_NOW);
const content = SNAPSHOT_FIXTURE.content;
const record = { ...SNAPSHOT_FIXTURE.record, envelope_digest: DIGEST, signature: SIG };
const envelope: CryptoEnvelope = {
  crypto_version: 1,
  suite: 'P256-ECDH-HKDF-SHA256-A256GCM-ECDSA-P256',
  key_epoch: 1,
  record_id: record.snapshot_id,
  purpose: 'snapshot-content',
  nonce: 'AAECAwQFBgcICQoL',
  ciphertext: 'c'.repeat(64),
  aad: {
    installation_id: record.installation_id,
    question_id: record.question_id,
    record_type: 'pane.snapshot',
    revision: 0,
    sender_device_id: record.signer_device_id,
  },
};

describe('snapshot content', () => {
  it('parses the fixtures', () => {
    for (const c of [content, STALE_SNAPSHOT_FIXTURE.aged.content]) {
      expect(PaneSnapshotContentV1.safeParse(c).success).toBe(true);
    }
  });
  it('holds plain text only: no escape sequences, control characters or line breaks', () => {
    const lines = (terminal_lines: string[]) =>
      PaneSnapshotContentV1.safeParse({ ...content, terminal_lines }).success;
    expect(lines(['\tindented'])).toBe(true);
    expect(lines(['\u001b[31mred\u001b[0m'])).toBe(false);
    expect(lines(['two\nlines'])).toBe(false);
    expect(lines(['carriage\rreturn'])).toBe(false);
    expect(lines(['c1 \u009b control'])).toBe(false);
    expect(PaneSnapshotContentV1.safeParse({ ...content, pane_title: 'a\u0007b' }).success).toBe(
      false,
    );
  });
  it('caps lines and bytes', () => {
    const lines = (terminal_lines: string[]) =>
      PaneSnapshotContentV1.safeParse({ ...content, terminal_lines }).success;
    expect(lines(Array(LIMITS.snapshotTerminalLines).fill(''))).toBe(true);
    expect(lines(Array(LIMITS.snapshotTerminalLines + 1).fill(''))).toBe(false);
    // two lines joined by one newline: exactly the byte limit, then one over
    const half = (LIMITS.snapshotTerminalBytes - 1) / 2;
    const a = 'x'.repeat(Math.floor(half));
    const b = 'y'.repeat(LIMITS.snapshotTerminalBytes - 1 - a.length);
    expect(lines([a, b])).toBe(true);
    expect(lines([a, b + 'y'])).toBe(false);
    expect(
      PaneSnapshotContentV1.safeParse({
        ...content,
        pane_title: 't'.repeat(LIMITS.snapshotPaneTitleChars + 1),
      }).success,
    ).toBe(false);
  });
  it('reads a newer agent state or waiting reason as unknown rather than failing', () => {
    const c = PaneSnapshotContentV1.parse({
      ...content,
      agent_state: 'meditating',
      waiting_reason: 'coffee',
    });
    expect(c.agent_state).toBe('unknown');
    expect(c.waiting_reason).toBeNull();
    expect(
      PaneSnapshotContentV1.parse({ ...content, waiting_reason: undefined }).waiting_reason,
    ).toBe(null);
  });
});

describe('snapshot records', () => {
  it('a shared snapshot has an envelope bound to its id; sharing off has none', () => {
    expect(SignedPaneSnapshot.safeParse({ record, envelope }).success).toBe(true);
    const off = { ...SHARING_OFF_FIXTURE, envelope_digest: null, signature: SIG };
    expect(PaneSnapshotRecord.safeParse(off).success).toBe(true);
    expect(SignedPaneSnapshot.safeParse({ record: off, envelope: null }).success).toBe(true);
    expect(PaneSnapshotRecord.safeParse({ ...off, envelope_digest: DIGEST }).success).toBe(false);
    expect(PaneSnapshotRecord.safeParse({ ...record, envelope_digest: null }).success).toBe(false);
    expect(SignedPaneSnapshot.safeParse({ record, envelope: null }).success).toBe(false);
    for (const env of [
      { ...envelope, purpose: 'message-content' as const },
      { ...envelope, record_id: 'snap_other001' },
      { ...envelope, aad: { ...envelope.aad, revision: 1 } },
      { ...envelope, aad: { ...envelope.aad, sender_device_id: 'dev_phone0001' } },
    ]) {
      expect(SignedPaneSnapshot.safeParse({ record, envelope: env }).success).toBe(false);
    }
  });
  it('request and response bodies', () => {
    expect(
      PaneSnapshotBody.safeParse({
        protocol_version: 1,
        idempotency_key: 'idem_aaaaaaaa',
        snapshot: { record, envelope },
      }).success,
    ).toBe(true);
    expect(
      PaneSnapshotResponse.safeParse({
        question_id: record.question_id,
        snapshot: { record, envelope },
        refresh: STALE_SNAPSHOT_FIXTURE.refreshTimedOut.refresh,
      }).success,
    ).toBe(true);
  });
});

describe('snapshot freshness', () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const shared = (msAgo: number) => ({ observed_at: at(msAgo), sharing: 'on' as const });
  const f = (
    snapshot: { observed_at: string; sharing: 'on' | 'off' } | null,
    refresh: { deadline_at: string } | null = null,
    status: 'open' | 'human-answered' | 'proxy-answered' | 'expired' | 'cancelled' = 'open',
    now = NOW,
  ) => snapshotFreshness({ now, status, snapshot, refresh });

  it('labels the fixtures', () => {
    expect(f(SNAPSHOT_FIXTURE.record)).toBe('fresh');
    expect(f(STALE_SNAPSHOT_FIXTURE.aged.record)).toBe('stale');
    expect(
      f(
        STALE_SNAPSHOT_FIXTURE.refreshTimedOut.record,
        STALE_SNAPSHOT_FIXTURE.refreshTimedOut.refresh,
      ),
    ).toBe('stale');
    expect(f(SHARING_OFF_FIXTURE)).toBe('off');
  });
  it('is fresh up to the window and stale one millisecond after', () => {
    expect(f(shared(LIMITS.snapshotFreshMs))).toBe('fresh');
    expect(f(shared(LIMITS.snapshotFreshMs + 1))).toBe('stale');
    // a desktop clock slightly ahead is still fresh
    expect(f(shared(-5_000))).toBe('fresh');
  });
  it('is pending until the refresh deadline, then stale whatever the age of the last snapshot', () => {
    const deadline = { deadline_at: at(-1) };
    expect(f(shared(1_000), deadline)).toBe('pending');
    expect(f(null, deadline)).toBe('pending');
    const passed = { deadline_at: at(0) };
    expect(f(shared(1_000), passed)).toBe('stale');
    expect(f(null, passed)).toBe('stale');
  });
  it('is none without a snapshot or once the question closes, and off when sharing is off', () => {
    expect(f(null)).toBe('none');
    expect(f(shared(0), null, 'expired')).toBe('none');
    expect(f(shared(0), null, 'cancelled')).toBe('none');
    expect(f(shared(0), null, 'human-answered')).toBe('fresh');
    expect(f(shared(0), null, 'proxy-answered')).toBe('fresh');
    expect(f({ ...shared(0), sharing: 'off' }, { deadline_at: at(-1) })).toBe('off');
  });
});

describe('boundTerminalLines', () => {
  const valid = (lines: string[]) =>
    PaneSnapshotContentV1.safeParse({ ...content, terminal_lines: lines }).success;

  it('strips escape sequences and control characters and normalises line ends', () => {
    const lines = boundTerminalLines(
      '\u001b[1;32m✓ ok\u001b[0m\r\nnext\u0007\rlast\u001b]0;title\u0007\n\n',
    );
    expect(lines).toEqual(['✓ ok', 'next', 'last']);
    expect(valid(lines)).toBe(true);
  });
  it('keeps the newest lines within the line cap', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const lines = boundTerminalLines(text);
    expect(lines).toHaveLength(LIMITS.snapshotTerminalLines);
    expect(lines.at(-1)).toBe('line 499');
    expect(lines[0]).toBe(`line ${500 - LIMITS.snapshotTerminalLines}`);
  });
  it('drops the oldest lines to fit the byte cap', () => {
    const text = Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(1_000, 'x')).join('\n');
    const lines = boundTerminalLines(text);
    expect(utf8ByteLength(lines.join('\n'))).toBeLessThanOrEqual(LIMITS.snapshotTerminalBytes);
    expect(lines.at(-1)!.startsWith('99')).toBe(true);
    expect(valid(lines)).toBe(true);
  });
  it('keeps the end of a single line that is too long, never splitting a character', () => {
    const text = 'start' + 'é'.repeat(LIMITS.snapshotTerminalBytes) + 'END';
    const [line] = boundTerminalLines(text);
    expect(line!.endsWith('END')).toBe(true);
    expect(utf8ByteLength(line!)).toBeLessThanOrEqual(LIMITS.snapshotTerminalBytes);
    expect(utf8ByteLength(line!)).toBeGreaterThan(LIMITS.snapshotTerminalBytes - 2);
    expect(valid([line!])).toBe(true);
    const emoji = boundTerminalLines('😀'.repeat(LIMITS.snapshotTerminalBytes));
    expect([...emoji[0]!].every((c) => c === '😀')).toBe(true);
  });
  it('returns no lines for an empty pane', () => {
    expect(boundTerminalLines('')).toEqual([]);
    expect(boundTerminalLines('\n\n')).toEqual([]);
  });
});
