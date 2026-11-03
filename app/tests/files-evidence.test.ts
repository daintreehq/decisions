import { describe, expect, it } from 'vitest';
import type { AttachmentDescriptor } from '@daintreehq/decisions-protocol';
import type { ImageResult } from '../src/data/images.js';
import {
  PresentationLog,
  computeReview,
  firstUnreviewed,
  scopeKey,
} from '../src/components/files/evidence.js';
import {
  announceFor,
  autoPair,
  buildSequence,
  downloadName,
  loadOrder,
} from '../src/components/files/sequence.js';

const sha = (c: string) => c.repeat(64);
const desc = (
  id: string,
  digest: string,
  extra: Partial<AttachmentDescriptor> = {},
): AttachmentDescriptor => ({
  attachment_id: id,
  role: 'other',
  mime: 'image/png',
  size: 10,
  sha256: digest,
  nonce: 'n'.repeat(16),
  key_epoch: 1,
  ...extra,
});
const ok = (digest: string): ImageResult => ({
  ok: true,
  image: { url: `blob:${digest.slice(0, 4)}`, sha256: digest, mime: 'image/png' },
});

describe('evidence: presented versus loaded', () => {
  const items = buildSequence([
    desc('a', sha('a'), { role: 'before' }),
    desc('b', sha('b'), { role: 'after' }),
    desc('c', sha('c')),
  ]);

  it('loading (a prefetch) is not presenting', () => {
    const results = { a: ok(sha('a')), b: ok(sha('b')), c: ok(sha('c')) };
    const r = computeReview(items, results, new Set());
    expect(r).toMatchObject({ total: 3, loaded: 3, presented: 0, digests: [] });
  });

  it('acknowledges only files that are both verified and presented', () => {
    const results = { a: ok(sha('a')), b: ok(sha('b')) };
    const log = new PresentationLog();
    const scope = scopeKey({ id: 'q1', revision: 1 });
    log.mark(scope, items[0]!.key);
    log.mark(scope, items[2]!.key); // c was "shown" but never verified: it cannot count
    const r = computeReview(items, results, log.get(scope));
    expect(r).toMatchObject({ loaded: 2, presented: 1, digests: [sha('a')] });
    expect(firstUnreviewed(items, results, log.get(scope))).toBe(1);
    log.mark(scope, items[1]!.key);
    // c is marked, but it never verified, so it is still the one to review.
    expect(firstUnreviewed(items, results, log.get(scope))).toBe(2);
    expect(firstUnreviewed(items, { ...results, c: ok(sha('c')) }, log.get(scope))).toBe(-1);
  });

  it('a changed digest or a new revision resets presentation', () => {
    const log = new PresentationLog();
    const s1 = scopeKey({ id: 'q1', revision: 1 });
    for (const it of items) log.mark(s1, it.key);
    // Revision 2: same question, nothing presented yet.
    expect(log.get(scopeKey({ id: 'q1', revision: 2 })).size).toBe(0);
    // Same revision, but file b now has other bytes: its old presentation does not cover them.
    const changed = buildSequence([
      desc('a', sha('a'), { role: 'before' }),
      desc('b', sha('d'), { role: 'after' }),
      desc('c', sha('c')),
    ]);
    const results = { a: ok(sha('a')), b: ok(sha('d')), c: ok(sha('c')) };
    expect(computeReview(changed, results, log.get(s1))).toMatchObject({
      loaded: 3,
      presented: 2,
      digests: [sha('a'), sha('c')],
    });
  });

  it('counts expired and failed files separately and never as presented', () => {
    const results: Record<string, ImageResult> = {
      a: { ok: false, reason: 'expired', message: 'gone' },
      b: { ok: false, reason: 'unverified', message: 'bad' },
      c: { ok: false, reason: 'error', message: 'net' },
    };
    const all = new Set(items.map((i) => i.key));
    expect(computeReview(items, results, all)).toEqual({
      digests: [],
      total: 3,
      loaded: 0,
      presented: 0,
      expired: 1,
      failed: 2,
    });
  });
});

describe('the file sequence', () => {
  it('keeps signed order and labels honestly', () => {
    const s = buildSequence([
      desc('x', sha('x')),
      desc('b', sha('b'), { role: 'after' }),
      desc('c', sha('c'), { alt: 'Settings panel, collapsed' }),
      desc('a', sha('a'), { role: 'before' }),
    ]);
    expect(s.map((i) => i.label)).toEqual([
      'Image 1',
      'After',
      'Settings panel, collapsed',
      'Before',
    ]);
    expect(announceFor(s[1]!, 4)).toBe('After screenshot, file 2 of 4');
    expect(autoPair(s)).toEqual({ before: 3, after: 1 });
    expect(downloadName(2, 'image/png')).toBe('decision-image-3.png');
    expect(downloadName(0, 'image/jpeg')).toBe('decision-image-1.jpg');
  });

  it('auto-pairs only exactly one Before and one After', () => {
    const two = buildSequence([
      desc('a', sha('a'), { role: 'before' }),
      desc('b', sha('b'), { role: 'before' }),
      desc('c', sha('c'), { role: 'after' }),
    ]);
    expect(autoPair(two)).toBeNull();
  });

  it('loads the active file first, then its neighbours outwards', () => {
    expect(loadOrder(5, 2)).toEqual([2, 3, 1, 4, 0]);
    expect(loadOrder(4, 0)).toEqual([0, 1, 2, 3]);
    expect(loadOrder(3, 2)).toEqual([2, 1, 0]);
  });
});
