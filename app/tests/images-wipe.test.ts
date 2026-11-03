import { describe, expect, it, vi } from 'vitest';
import { ImageCache, type ImageResult } from '../src/data/images.js';

function cache() {
  const created: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  const c = new ImageCache({
    createUrl: () => {
      const u = `blob:test/${++n}`;
      created.push(u);
      return u;
    },
    revokeUrl: (u) => void revoked.push(u),
  });
  return { c, created, revoked };
}
const ok = (url: string): ImageResult => ({
  ok: true,
  image: { url, sha256: 'a'.repeat(64), mime: 'image/png' },
});

describe('image cache', () => {
  it('caches successes, retries failures, and tracks the URLs it hands out', async () => {
    const { c, created } = cache();
    const produce = vi.fn(async (ctx: { makeUrl: (b: Blob) => string }) =>
      ok(ctx.makeUrl(new Blob(['x']))),
    );
    const a = await c.load('k', produce);
    const b = await c.load('k', produce);
    expect(a).toBe(b);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(c.liveUrls).toBe(1);

    let fail = true;
    const flaky = vi.fn(async () =>
      fail ? ({ ok: false, reason: 'error', message: 'boom' } as ImageResult) : ok('blob:x'),
    );
    expect((await c.load('f', flaky)).ok).toBe(false);
    fail = false;
    expect((await c.load('f', flaky)).ok).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('dispose() aborts in-flight requests immediately, without waiting for them', async () => {
    const { c } = cache();
    let signal!: AbortSignal;
    const stalled = c.load('stalled', ({ signal: s }) => {
      signal = s;
      return new Promise<ImageResult>(() => undefined); // a response that never arrives
    });
    expect(signal.aborted).toBe(false);
    c.dispose();
    expect(signal.aborted).toBe(true);
    void stalled; // never resolves; dispose must not depend on it
  });

  it('revokes every URL already handed out', async () => {
    const { c, created, revoked } = cache();
    await c.load('a', async (ctx) => ok(ctx.makeUrl(new Blob(['a']))));
    await c.load('b', async (ctx) => ok(ctx.makeUrl(new Blob(['b']))));
    c.dispose();
    expect(revoked.sort()).toEqual(created.sort());
    expect(c.liveUrls).toBe(0);
  });

  it('discards a result that arrives after disposal and revokes its URL', async () => {
    const { c, created } = cache();
    let finish!: () => void;
    const late = c.load(
      'late',
      (ctx) =>
        new Promise<ImageResult>((res, rej) => {
          finish = () => {
            try {
              res(ok(ctx.makeUrl(new Blob(['x']))));
            } catch (e) {
              rej(e); // exactly what an async producer does
            }
          };
        }),
    );
    c.dispose();
    // the transport ignored the abort and the bytes arrive anyway: makeUrl refuses
    finish();
    expect(await late).toEqual({ ok: false, reason: 'error', message: 'Cancelled' });
    expect(created).toHaveLength(0);
    expect(c.liveUrls).toBe(0);
  });

  it('revokes a URL created just before disposal even if the producer only resolves afterwards', async () => {
    const { c, created, revoked } = cache();
    let finish!: () => void;
    const p = c.load('x', (ctx) => {
      const url = ctx.makeUrl(new Blob(['x'])); // created while still valid
      return new Promise<ImageResult>((res) => (finish = () => res(ok(url))));
    });
    expect(created).toHaveLength(1);
    c.dispose();
    expect(revoked).toEqual(created);
    finish();
    expect((await p).ok).toBe(false);
  });

  it('a viewer that lets go and re-acquires in the same update keeps the download running', async () => {
    const { c } = cache();
    let signal!: AbortSignal;
    const release = c.retain('k');
    void c.load('k', ({ signal: s }) => {
      signal = s;
      return new Promise<ImageResult>(() => undefined);
    });
    release();
    const again = c.retain('k');
    await Promise.resolve();
    expect(signal.aborted).toBe(false);
    again();
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
  });

  it('a release from before disposal does not touch the next pairing', async () => {
    const { c } = cache();
    const stale = c.retain('k');
    c.dispose();
    const fresh = c.retain('k');
    let signal!: AbortSignal;
    void c.load('k', ({ signal: s }) => {
      signal = s;
      return new Promise<ImageResult>(() => undefined);
    });
    stale();
    await Promise.resolve();
    expect(signal.aborted).toBe(false);
    fresh();
  });

  it('works again after disposal (a re-paired phone starts clean)', async () => {
    const { c } = cache();
    c.dispose();
    const r = await c.load('k', async (ctx) => ok(ctx.makeUrl(new Blob(['x']))));
    expect(r.ok).toBe(true);
  });
});
