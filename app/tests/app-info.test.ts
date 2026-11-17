// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller.js';

const VOICE = { xai: true, openai: false, anthropic: false };
const answer = () =>
  new Response(JSON.stringify({ voice: VOICE, features: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A relay whose `GET /info` answers only when the test says, and which honours an abort like a real fetch. */
function relay() {
  const asks: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          asks.push({ resolve, reject });
        }),
    ),
  );
  return asks;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("waiting for the relay's /info", () => {
  it('joins the request already on its way instead of asking twice', async () => {
    const asks = relay();
    const ctl = new AppController('https://relay.example');
    const first = ctl.ensureInfo();
    const second = ctl.ensureInfo();
    expect(asks).toHaveLength(1);
    asks[0]!.resolve(answer());
    await Promise.all([first, second]);
    expect(ctl.getSnapshot().info?.voice).toEqual(VOICE);
    // Once the relay has said, nothing is asked again.
    await ctl.ensureInfo();
    expect(asks).toHaveLength(1);
  });

  it('asks again after a failed request, and the answer lands', async () => {
    const asks = relay();
    const ctl = new AppController('https://relay.example');
    const failed = ctl.ensureInfo();
    asks[0]!.reject(new TypeError('Failed to fetch'));
    await failed;
    expect(ctl.getSnapshot().info).toBeNull();
    const retry = ctl.ensureInfo();
    expect(asks).toHaveLength(2);
    asks[1]!.resolve(answer());
    await retry;
    expect(ctl.getSnapshot().info?.voice).toEqual(VOICE);
  });

  it('gives up on a relay that never answers, so a later wait asks again', async () => {
    vi.useFakeTimers();
    const asks = relay();
    const ctl = new AppController('https://relay.example');
    let settled = false;
    void ctl.ensureInfo().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(ctl.getSnapshot().info).toBeNull();
    void ctl.ensureInfo();
    expect(asks).toHaveLength(2);
  });
});
