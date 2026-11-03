import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const CLAIM_SECRET = 'e2e-claim-secret-0123456789abcdef';

export interface RunningRelay {
  origin: string;
  stop(): Promise<void>;
}

/** Starts the real Worker (workerd via `wrangler dev`) with a fresh, empty storage directory. */
export async function startRelay(port: number): Promise<RunningRelay> {
  if (!existsSync(join(ROOT, 'app/dist/index.html'))) {
    throw new Error('app/dist is missing: run `pnpm build` before the end-to-end tests');
  }
  const persist = mkdtempSync(join(tmpdir(), 'decisions-e2e-'));
  const child: ChildProcess = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      // Each relay gets its own inspector port so several suites can run side by side.
      '--inspector-port',
      String(port + 1000),
      '--var',
      `CLAIM_SECRET:${CLAIM_SECRET}`,
      '--persist-to',
      persist,
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
    },
  );
  let log = '';
  child.stdout?.on('data', (d) => (log += String(d)));
  child.stderr?.on('data', (d) => (log += String(d)));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`);
    try {
      const r = await fetch(`${origin}/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`wrangler dev did not start:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return {
    origin,
    stop: () =>
      new Promise((done) => {
        if (child.exitCode !== null) return done();
        child.once('exit', () => done());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }),
  };
}

/** Finds a Chromium that Playwright's cache already holds (override with E2E_CHROMIUM). */
export function findChromium(): string | null {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
  const base =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library/Caches/ms-playwright');
  const linux = join(homedir(), '.cache/ms-playwright');
  for (const dir of [base, linux]) {
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir)
      .filter((n) => /^chromium-\d+$/.test(n))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const n of names) {
      const candidates = [
        join(
          dir,
          n,
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ),
        join(
          dir,
          n,
          'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ),
        join(dir, n, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        join(dir, n, 'chrome-linux64/chrome'),
        join(dir, n, 'chrome-linux/chrome'),
      ];
      const hit = candidates.find((c) => existsSync(c));
      if (hit) return hit;
    }
  }
  return null;
}

export const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 30_000,
  what = 'condition',
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(150);
  }
}
