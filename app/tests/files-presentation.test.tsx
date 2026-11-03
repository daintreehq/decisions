// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDescriptor } from '@daintreehq/decisions-protocol';
import type { QuestionView } from '../src/domain/model.js';
import type { ImageResult } from '../src/data/images.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The inline stage is always fully on screen: only what covers it can stop it counting as seen. */
class VisibleObserver {
  constructor(private cb: (e: Partial<IntersectionObserverEntry>[]) => void) {}
  observe() {
    this.cb([{ isIntersecting: true, intersectionRatio: 1 }]);
  }
  disconnect() {}
  unobserve() {}
}

const sha = 'a'.repeat(64);
const desc: AttachmentDescriptor = {
  attachment_id: 'att1',
  role: 'other',
  mime: 'image/png',
  size: 10,
  sha256: sha,
  nonce: 'n'.repeat(16),
  key_epoch: 1,
};
let qn = 0;
const view = (): QuestionView =>
  ({
    id: `q${++qn}`,
    revision: 1,
    content: { question: 'Ship it?', attachments: [desc] },
  }) as unknown as QuestionView;

type Gallery = typeof import('../src/components/AttachmentGallery.js');
type Evidence = typeof import('../src/components/files/evidence.js');

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(): Promise<{ v: QuestionView; ev: Evidence; img: () => HTMLImageElement }> {
  vi.resetModules();
  const { app } = await import('../src/app/controller.js');
  const ok: ImageResult = {
    ok: true,
    image: { url: 'blob:test/1', sha256: sha, mime: 'image/png' },
  };
  vi.spyOn(app, 'loadImage').mockResolvedValue(ok);
  const g: Gallery = await import('../src/components/AttachmentGallery.js');
  const ev: Evidence = await import('../src/components/files/evidence.js');
  const v = view();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(createElement(g.AttachmentGallery, { view: v, onReview: () => undefined })),
  );
  const img = () => host!.querySelector<HTMLImageElement>('.fx-inline-stage img')!;
  return { v, ev, img };
}

/** The image finishes decoding: the browser fires load with its natural size. */
async function decode(img: HTMLImageElement) {
  Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
  await act(async () => void img.dispatchEvent(new Event('load')));
}

const flush = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', VisibleObserver);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = host = null;
  document.querySelectorAll('dialog, .ws').forEach((d) => d.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('inline presentation (finding 7)', () => {
  it('a file that loads behind the open navigator sheet is not presented until the sheet closes', async () => {
    const { v, ev, img } = await render();
    // The phone navigator: a modal dialog over the workspace.
    const sheet = document.createElement('dialog');
    sheet.className = 'nav-sheet';
    sheet.setAttribute('open', '');
    document.body.append(sheet);
    await flush();

    await decode(img());
    await flush();
    expect(ev.presentationLog.get(ev.scopeKey(v)).size).toBe(0);

    // Closing it uncovers the stage: now the file is seen.
    sheet.removeAttribute('open');
    await flush();
    expect(ev.presentationLog.get(ev.scopeKey(v)).size).toBe(1);
  });

  it('the full-height editor covers the stage too', async () => {
    const { v, ev, img } = await render();
    const ws = document.createElement('div');
    ws.className = 'ws editor-full';
    document.body.append(ws);
    await flush();
    await decode(img());
    await flush();
    expect(ev.presentationLog.get(ev.scopeKey(v)).size).toBe(0);
    ws.className = 'ws';
    await flush();
    expect(ev.presentationLog.get(ev.scopeKey(v)).size).toBe(1);
  });

  it('a hidden page presents nothing, and presents once it is visible again', async () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { v, ev, img } = await render();
    await decode(img());
    await flush();
    expect(ev.presentationLog.get(ev.scopeKey(v)).size).toBe(0);
    vis.mockReturnValue('visible');
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(ev.presentationLog.get(ev.scopeKey(v)).size).toBe(1);
  });

  it('with nothing over it, the decoded inline file is presented', async () => {
    const { v, ev, img } = await render();
    await decode(img());
    await flush();
    expect(ev.presentationLog.get(ev.scopeKey(v)).size).toBe(1);
  });
});
