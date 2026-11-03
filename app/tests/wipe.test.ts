// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/app/controller.js';
import type { ImageResult } from '../src/data/images.js';

describe('wiping an unpaired controller never waits on downloads', () => {
  it('completes while a download is still stalled, aborting it', async () => {
    const ctl = new AppController('https://relay.example');
    await ctl.init();
    let aborted = false;
    void ctl.images.load('stuck', ({ signal }) => {
      signal.addEventListener('abort', () => (aborted = true));
      return new Promise<ImageResult>(() => undefined);
    });
    const outcome = await Promise.race([
      ctl.wipe().then(() => 'wiped'),
      new Promise((r) => setTimeout(() => r('hung'), 1500)),
    ]);
    expect(outcome).toBe('wiped');
    expect(aborted).toBe(true);
    expect(ctl.getSnapshot().phase).toBe('unpaired');
  });

  it('tears down registered in-memory owners synchronously, before the erase is awaited', async () => {
    const ctl = new AppController('https://relay.example');
    let ran = 0;
    ctl.registerTeardown(() => void ran++);
    const wiping = ctl.wipe();
    expect(ran).toBe(1);
    await wiping;
    expect(ran).toBe(1);
  });
});
