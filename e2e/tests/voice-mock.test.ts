import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from 'playwright-core';
import { findChromium, until } from './harness.js';
import { mockVoice } from './voice-mock.js';

/**
 * The dictation mock's own lifecycle. Playwright runs its routes outside every test's promise chain, so a request that
 * outlives its context (a suite closing its browser while the PWA still asks for `/info`) has to end quietly rather
 * than reject with nowhere to go, which Vitest counts as an error that fails the run. A relay whose `/info` genuinely
 * fails must still make the mock reject. No relay here: a small server stands in for `/info`, so each race can be
 * staged exactly.
 */
const chromiumPath = findChromium();
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!chromiumPath)('the voice mock', () => {
  let server: Server;
  let origin: string;
  /** How the stand-in relay answers `/info`, set by each test. */
  let info: (res: ServerResponse) => void;
  const browsers: Browser[] = [];
  /**
   * Every unhandled rejection while these tests run. With a listener of its own installed, Vitest leaves them to it,
   * so each test takes the rejections it expects and anything left over fails it.
   */
  const rejections: unknown[] = [];
  const collect = (e: unknown) => rejections.push(e);

  beforeAll(async () => {
    process.on('unhandledRejection', collect);
    server = createServer((req, res) => {
      if (req.url === '/api/v1/info') return info(res);
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><title>relay</title>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((b) => b.close()));
    await tick(50);
    expect(rejections.splice(0)).toEqual([]);
  });

  afterAll(async () => {
    process.off('unhandledRejection', collect);
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
  });

  const answer =
    (body: unknown, status = 200) =>
    (res: ServerResponse) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  /** A fresh browser on the stand-in relay with the mock installed, and a way to have the PWA ask for `/info`. */
  const open = async () => {
    const browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    browsers.push(browser);
    const context = await browser.newContext();
    const page = await context.newPage();
    await mockVoice(context, page, () => ({ words: [] }));
    await page.goto(origin);
    const askInfo = () => page.evaluate(() => void fetch('/api/v1/info').catch(() => {}));
    const readInfo = () => page.evaluate(() => fetch('/api/v1/info').then((r) => r.json()));
    return { browser, context, page, askInfo, readInfo };
  };

  /**
   * Steps into the mock's next `/info` from a route added after it, which Playwright runs first: `between` runs once
   * the real `/info` has been fetched and before the mock reads it. The returned check says when the mock's fetch and
   * read are over, however they ended.
   */
  const stage = async (page: Page, between?: () => Promise<unknown>) => {
    let over = false;
    await page.route(
      '**/api/v1/info',
      async (route) => {
        const fetchReal = route.fetch.bind(route);
        route.fetch = (async (options?: Parameters<Route['fetch']>[0]) => {
          try {
            const res = await fetchReal(options);
            const read = res.json.bind(res);
            res.json = () => read().finally(() => (over = true));
            await between?.();
            return res;
          } catch (e) {
            over = true;
            throw e;
          }
        }) as Route['fetch'];
        await route.fallback();
      },
      { times: 1 },
    );
    return () => over;
  };

  it('reports xAI dictation on top of what the relay says', async () => {
    info = answer({ name: 'relay', voice: { openai: false } });
    const { readInfo } = await open();
    await expect(readInfo()).resolves.toEqual({
      name: 'relay',
      voice: { openai: false, xai: true },
    });
  });

  describe.each(['context', 'browser'] as const)('when the %s closes', (closing) => {
    const close = (o: { browser: Browser; context: BrowserContext }) =>
      closing === 'browser' ? o.browser.close() : o.context.close();

    it('between fetching /info and reading it, the route ends quietly', async () => {
      info = answer({ voice: {} });
      const opened = await open();
      const over = await stage(opened.page, () => close(opened));
      await opened.askInfo();
      await until(async () => over(), 10_000, 'the mock to read /info');
      await tick(50);
      expect(rejections).toEqual([]);
    });

    it('while /info is still being fetched, the route ends quietly', async () => {
      let held: ServerResponse | undefined;
      info = (res) => {
        held = res;
      };
      const opened = await open();
      const over = await stage(opened.page);
      await opened.askInfo();
      await until(async () => held !== undefined, 10_000, 'the relay to receive /info');
      await close(opened);
      if (!held!.destroyed) answer({ voice: {} })(held!);
      await until(async () => over(), 10_000, 'the mock’s fetch to end');
      await tick(50);
      expect(rejections).toEqual([]);
    });
  });

  it('lets the page navigate away from an /info it is still answering', async () => {
    info = answer({ voice: {} });
    const { page, askInfo, readInfo } = await open();
    const over = await stage(page, () => page.goto(`${origin}/elsewhere`));
    await askInfo();
    await until(async () => over(), 10_000, 'the mock to read /info');
    await tick(50);
    expect(rejections).toEqual([]);
    await expect(readInfo()).resolves.toEqual({ voice: { xai: true } });
  });

  it('still fails when the relay’s /info is not JSON', async () => {
    info = (res) =>
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><title>Bad gateway</title>');
    const { askInfo } = await open();
    await askInfo();
    await until(async () => rejections.length > 0, 10_000, 'the mock to fail');
    expect(rejections.splice(0)).toEqual([expect.any(SyntaxError)]);
  });

  it('still fails when the relay’s /info answers with an error', async () => {
    info = answer({ error: 'internal' }, 500);
    const { askInfo } = await open();
    await askInfo();
    await until(async () => rejections.length > 0, 10_000, 'the mock to fail');
    expect(rejections.splice(0)).toEqual([new Error("the relay's /info answered 500")]);
  });
});
