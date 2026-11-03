// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDescriptor } from '@daintreehq/decisions-protocol';
import type { QuestionView } from '../src/domain/model.js';
import type { ImageContext, ImageResult } from '../src/data/images.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Controller = typeof import('../src/app/controller.js');
type Loader = typeof import('../src/components/files/useFileLoader.js');
type Sequence = typeof import('../src/components/files/sequence.js');

const sha = 'a'.repeat(64);
const desc = (id: string): AttachmentDescriptor => ({
  attachment_id: id,
  role: 'other',
  mime: 'image/png',
  size: 10,
  sha256: sha,
  nonce: 'n'.repeat(16),
  key_epoch: 1,
});
const view = (id: string, attachments: AttachmentDescriptor[]): QuestionView =>
  ({ id, revision: 1, content: { question: '?', attachments } }) as unknown as QuestionView;

let m: { c: Controller; l: Loader; s: Sequence };
let fetches: Array<{ id: string; ctx: ImageContext; finish: () => void }>;
let created: string[];
let revoked: string[];

beforeEach(async () => {
  vi.resetModules();
  m = {
    c: await import('../src/app/controller.js'),
    l: await import('../src/components/files/useFileLoader.js'),
    s: await import('../src/components/files/sequence.js'),
  };
  fetches = [];
  created = [];
  revoked = [];
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const u = `blob:test/${++n}`;
    created.push(u);
    return u;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
  // The network and decryption: each fetch waits until the test finishes it, then makes its object URL.
  const fetchImage = (_v: QuestionView, d: AttachmentDescriptor, ctx: ImageContext) =>
    new Promise<ImageResult>((resolve, reject) => {
      fetches.push({
        id: d.attachment_id,
        ctx,
        finish: () => {
          try {
            resolve({
              ok: true,
              image: { url: ctx.makeUrl(new Blob(['x'])), sha256: d.sha256, mime: d.mime },
            });
          } catch (e) {
            reject(e);
          }
        },
      });
    });
  vi.spyOn(
    m.c.app as unknown as { fetchImage: typeof fetchImage },
    'fetchImage',
  ).mockImplementation(fetchImage);
});
afterEach(() => {
  m.c.app.images.dispose();
  vi.restoreAllMocks();
});

/** A gallery's loading, mounted for one question. */
async function mount(v: QuestionView): Promise<() => Promise<void>> {
  const items = m.s.buildSequence(v.content!.attachments ?? []);
  function Files() {
    m.l.useFileLoader(v, items, 0);
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(Files)));
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}

const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));

describe('decrypted image lifetime (finding 14)', () => {
  it('unmounting the gallery aborts its outstanding downloads, and they create no URL', async () => {
    const unmount = await mount(view('q1', [desc('a1'), desc('a2')]));
    expect(fetches.map((f) => f.id)).toEqual(['a1', 'a2']);
    await unmount();
    await settle();
    expect(fetches.every((f) => f.ctx.signal.aborted)).toBe(true);
    // The bytes arrive anyway: no object URL is made for them.
    fetches.forEach((f) => f.finish());
    await settle();
    expect(created).toHaveLength(0);
    expect(m.c.app.images.liveUrls).toBe(0);
  });

  it('keeps only a bounded number of decrypted images once their galleries are gone', async () => {
    for (let i = 0; i < 30; i++) {
      const unmount = await mount(view(`q${i}`, [desc(`a${i}`)]));
      fetches.at(-1)!.finish();
      await settle();
      await unmount();
      await settle();
    }
    expect(created).toHaveLength(30);
    expect(m.c.app.images.liveUrls).toBeLessThanOrEqual(16);
    expect(revoked.length).toBe(30 - m.c.app.images.liveUrls);
  });

  it('a recently viewed question comes back without downloading again', async () => {
    let unmount = await mount(view('q1', [desc('a1')]));
    fetches[0]!.finish();
    await settle();
    await unmount();
    await settle();
    unmount = await mount(view('q1', [desc('a1')]));
    await settle();
    expect(fetches).toHaveLength(1);
    expect(revoked).toHaveLength(0);
    await unmount();
  });

  it('revocation disposes every decrypted image and ignores late results', async () => {
    const unmount = await mount(view('q1', [desc('a1'), desc('a2')]));
    fetches[0]!.finish();
    await settle();
    expect(m.c.app.images.liveUrls).toBe(1);

    act(() => m.c.app.lockRevoked());
    expect(m.c.app.getSnapshot().phase).toBe('revoked');
    expect(m.c.app.images.liveUrls).toBe(0);
    expect(revoked).toEqual(created);
    expect(fetches[1]!.ctx.signal.aborted).toBe(true);
    fetches[1]!.finish();
    await settle();
    expect(created).toHaveLength(1);
    await unmount();
  });
});
