import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
 * The dictation mock's own lifecycle. Playwright runs its `/info` route outside every test's promise chain, so a
 * request that outlives its context (a suite's browser closing while the PWA still asks) has to end quietly rather
 * than reject with nowhere to go, which Vitest counts as an error that fails the run. A relay whose `/info` genuinely
 * fails must still fail it. No relay here: a small server stands in for `/info`, so each race can be staged exactly.
 */
const chromiumPath = findChromium();
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the voice mock’s /info route', () => {
  /**
   * The mock's `/info` handler, installed on a stand-in page that stays open, so what it does with a failure can be
   * awaited here instead of escaping as an unhandled rejection.
   */
  const infoRoute = async () => {
    let onInfo: ((route: Route) => Promise<void>) | undefined;
    const page = {
      isClosed: () => false,
      route: async (url: string, handler: (route: Route) => Promise<void>) => {
        if (url === '**/api/v1/info') onInfo = handler;
      },
      routeWebSocket: async () => {},
    };
    const context = { grantPermissions: async () => {} };
    await mockVoice(context as unknown as BrowserContext, page as unknown as Page, () => ({
      words: [],
    }));
    return onInfo!;
  };
  const failing = (fetch: () => Promise<unknown>) =>
    ({ fetch, fulfill: async () => {} }) as unknown as Route;

  it('still fails when the relay’s /info genuinely fails', async () => {
    const onInfo = await infoRoute();
    const unreachable = new Error('route.fetch: connect ECONNREFUSED 127.0.0.1:8845');
    await expect(onInfo(failing(() => Promise.reject(unreachable)))).rejects.toBe(unreachable);
    const notJson = new SyntaxError('Unexpected token \'<\', "<!doctype "... is not valid JSON');
    await expect(
      onInfo(failing(async () => ({ json: () => Promise.reject(notJson) }))),
    ).rejects.toBe(notJson);
  });

  it('stops quietly when Playwright says the request outlived its context', async () => {
    const onInfo = await infoRoute();
    for (const message of [
      'apiResponse.json: Response has been disposed',
      'route.fetch: Request context disposed.',
      'route.fetch: Target page, context or browser has been closed',
      'route.fulfill: Route is already handled!',
    ]) {
      const gone = new Error(message);
      await expect(onInfo(failing(() => Promise.reject(gone)))).resolves.toBeUndefined();
    }
  });
});

describe.skipIf(!chromiumPath)('the voice mock in Chromium', () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  /** How the stand-in relay answers `/info`, set by each test. */
  let info: (res: ServerResponse) => void = (res) => res.end('{}');
  const rejections: unknown[] = [];
  const record = (e: unknown) => rejections.push(e);

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/api/v1/info') return info(res);
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>relay</title>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    process.on('unhandledRejection', record);
  });

  afterEach(() => {
    rejections.length = 0;
  });

  afterAll(async () => {
    process.off('unhandledRejection', record);
    await browser?.close();
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
  });

  /** A page on the stand-in relay with the mock installed, and a way to have the PWA ask for `/info`. */
  const open = async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await mockVoice(context, page, () => ({ words: [] }));
    await page.goto(origin);
    const askInfo = () => page.evaluate(() => void fetch('/api/v1/info').catch(() => {}));
    return { context, page, askInfo };
  };

  it('reports xAI dictation on top of what the relay says', async () => {
    info = (res) =>
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ name: 'relay', voice: { openai: false } }));
    const { context, page } = await open();
    const body = await page.evaluate(() => fetch('/api/v1/info').then((r) => r.json()));
    expect(body).toEqual({ name: 'relay', voice: { openai: false, xai: true } });
    await context.close();
  });

  it('ends quietly when the context closes between fetching /info and reading it', async () => {
    info = (res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ voice: {} }));
    const { context, page, askInfo } = await open();
    let closed: Promise<void> | undefined;
    // Routes added later run first, so this one stages the race for the mock behind it: the context closes the moment
    // the real `/info` has been fetched, before the mock reads it.
    await page.route('**/api/v1/info', async (route) => {
      const fetchReal = route.fetch.bind(route);
      route.fetch = (async (options?: Parameters<Route['fetch']>[0]) => {
        const res = await fetchReal(options);
        closed = context.close();
        await closed;
        return res;
      }) as Route['fetch'];
      await route.fallback();
    });
    await askInfo();
    await until(async () => closed !== undefined, 10_000, 'the context to close');
    await closed;
    await tick(500);
    expect(rejections).toEqual([]);
  });

  it('ends quietly when the context closes while /info is still being fetched', async () => {
    let held: ServerResponse | undefined;
    info = (res) => {
      held = res;
    };
    const { context, askInfo } = await open();
    await askInfo();
    await until(async () => held, 10_000, 'the relay to receive /info');
    await context.close();
    if (!held!.destroyed) held!.writeHead(200).end(JSON.stringify({ voice: {} }));
    await tick(500);
    expect(rejections).toEqual([]);
  });
});
