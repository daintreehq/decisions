import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@daintreehq/decisions-protocol';
import {
  PaneDirectoryResolver,
  humanFileResolver,
  noAttachmentsResolver,
  readBounded,
} from '../src/resolvers.js';
import { cliOrigin, daemon } from '../src/commands/daemon.js';
import { setup } from '../src/commands/setup.js';
import type { Ctx } from '../src/runtime.js';

const root = mkdtempSync(join(tmpdir(), 'decisions-res-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const origin = cliOrigin('mcp');

describe('readBounded', () => {
  it('reads regular files, refuses oversize, empty, directories and FIFOs without blocking', async () => {
    const f = join(root, 'ok.png');
    writeFileSync(f, png);
    expect(Buffer.from((await readBounded(f))!)).toEqual(png);
    expect(await readBounded(f, 4)).toBeNull(); // over the cap
    writeFileSync(join(root, 'empty'), '');
    expect(await readBounded(join(root, 'empty'))).toBeNull();
    expect(await readBounded(root)).toBeNull();
    expect(await readBounded(join(root, 'missing'))).toBeNull();
    const fifo = join(root, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(await readBounded(fifo)).toBeNull(); // would block forever if opened for reading
    const big = join(root, 'big.bin');
    writeFileSync(big, Buffer.alloc(LIMITS.attachmentBytes + 1));
    expect(await readBounded(big)).toBeNull();
  });
});

describe('MCP attachment resolution is confined to registered pane resources', () => {
  const dir = join(root, 'resources');
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  mkdirSync(join(dir, 'other-pane'), { recursive: true });
  writeFileSync(join(dir, 'mcp', 'shot.png'), png);
  writeFileSync(join(dir, 'other-pane', 'secret.png'), png);
  writeFileSync(join(root, 'outside.png'), png);
  symlinkSync(join(root, 'outside.png'), join(dir, 'mcp', 'link.png'));
  symlinkSync(join(dir, 'other-pane'), join(dir, 'mcp', 'dirlink'));
  const r = new PaneDirectoryResolver(dir);

  it("serves a file from the pane's own folder", async () => {
    expect(Buffer.from((await r.resolve(origin, 'shot.png'))!.bytes)).toEqual(png);
  });
  it("rejects absolute paths, traversal, symlink escapes and other panes' files", async () => {
    for (const id of [
      join(root, 'outside.png'),
      '/etc/hosts',
      '../outside.png',
      '../other-pane/secret.png',
      'link.png',
      'dirlink/secret.png',
      'a//b',
      '',
      'x\0y',
      '..',
    ]) {
      expect(await r.resolve(origin, id), id).toBeNull();
    }
    // a different pane cannot reach this pane's file by name
    expect(await r.resolve({ ...origin, pane_id: 'other-pane' }, 'shot.png')).toBeNull();
    expect(await r.resolve({ ...origin, pane_id: '../resources' }, 'mcp/shot.png')).toBeNull();
  });
  it("without a folder, agents get no attachments at all; the human's --attach stays unrestricted", async () => {
    expect(await noAttachmentsResolver.resolve(origin, join(root, 'outside.png'))).toBeNull();
    expect(
      Buffer.from((await humanFileResolver.resolve(origin, join(root, 'outside.png')))!.bytes),
    ).toEqual(png);
  });
});

describe('the MCP daemon: attachments and secrets over the wire', () => {
  function mkCtx(home: string) {
    const out: string[] = [];
    const calls: string[] = [];
    const ctx: Ctx = {
      home,
      json: false,
      out: (l) => void out.push(l),
      err: () => {},
      prompt: async () => '',
      env: {},
      now: Date.now,
      readStdin: async () => '',
      fetch: (async (u: unknown, init?: RequestInit) => {
        const url = new URL(String(u));
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (url.pathname === '/api/v1/setup/claim')
          return new Response(
            JSON.stringify({
              installation_id: body.installation_id,
              vapid_public_key: 'V'.repeat(87),
              server_time: new Date().toISOString(),
            }),
            { status: 201 },
          );
        if (url.pathname === '/api/v1/questions' && init?.method === 'POST')
          return new Response(
            JSON.stringify({
              question_id: body.question.record.question_id,
              revision: 0,
              status: 'open',
              event_seq: 1,
            }),
            { status: 201 },
          );
        return new Response(JSON.stringify({ code: 'not_found', message: 'x' }), { status: 404 });
      }) as typeof fetch,
    };
    return { ctx, out, calls };
  }

  async function withDaemon(
    opts: {
      attachmentsDir?: string;
      showToken?: boolean;
      tokenEnv?: string;
      path?: string;
      env?: Record<string, string>;
    },
    fn: (h: {
      url: string;
      token: string;
      out: string[];
      call: (
        name: string,
        args: unknown,
      ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
    }) => Promise<void>,
  ) {
    const home = mkdtempSync(join(root, 'home-'));
    const m = mkCtx(home);
    m.ctx.env = opts.env ?? {};
    await setup(m.ctx, {}, { url: 'https://relay.example', claimSecret: 'c'.repeat(32) });
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    let ready!: (h: { mcp: { url: string }; token: string | null }) => void;
    const up = new Promise<{ mcp: { url: string }; token: string | null }>(
      (r) => (ready = r as never),
    );
    const done = daemon(
      m.ctx,
      {},
      {
        socket: false,
        until,
        onReady: (h) => ready({ mcp: h.mcp!, token: h.token }),
        mcp: {
          port: 0,
          ...(opts.attachmentsDir ? { attachmentsDir: opts.attachmentsDir } : {}),
          ...(opts.showToken ? { showToken: true } : {}),
          ...(opts.tokenEnv ? { tokenEnv: opts.tokenEnv } : {}),
          ...(opts.path ? { path: opts.path } : {}),
        },
      },
    );
    // a daemon that fails to start rejects here instead of leaving `up` pending forever
    const h = await Promise.race([
      up,
      done.then(() => {
        throw new Error('daemon exited before it was ready');
      }),
    ]);
    const call = async (name: string, args: unknown) => {
      const r = await fetch(h.mcp.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      return ((await r.json()) as { result: { isError?: boolean; content: { text: string }[] } })
        .result;
    };
    try {
      await fn({ url: h.mcp.url, token: h.token!, out: m.out, call });
    } finally {
      release();
      await done;
    }
  }

  it('an agent cannot read an arbitrary path (no folder configured)', async () => {
    await withDaemon({}, async ({ call }) => {
      const r = await call('ask_human', {
        question: 'q',
        attachments: [{ local_resource_id: join(root, 'outside.png') }],
      });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('attachment_error');
    });
  });
  it("with a folder, only that pane's files attach; escapes are refused", async () => {
    const dir = join(root, 'resources');
    await withDaemon({ attachmentsDir: dir }, async ({ call }) => {
      const ok = await call('ask_human', {
        question: 'with shot',
        attachments: [{ local_resource_id: 'shot.png', role: 'after' }],
      });
      expect(ok.isError).toBeUndefined();
      for (const id of [join(root, 'outside.png'), '../outside.png', 'link.png']) {
        const r = await call('ask_human', {
          question: 'x',
          attachments: [{ local_resource_id: id }],
        });
        expect(r.isError, id).toBe(true);
      }
    });
  });
  it('never prints the bearer token by default; --show-token prints it once', async () => {
    await withDaemon({}, async ({ token, out }) => {
      expect(out.join('\n')).not.toContain(token);
      expect(out.join('\n')).toContain('$(cat ');
    });
    await withDaemon({ showToken: true }, async ({ token, out }) => {
      expect(out.join('\n')).toContain(`Authorization: Bearer ${token}`);
    });
  });
  it('can take the token from an environment variable', async () => {
    const t = 'env-token-' + 'E'.repeat(30);
    await withDaemon(
      { tokenEnv: 'MY_MCP_TOKEN', env: { MY_MCP_TOKEN: t } },
      async ({ token, out }) => {
        expect(token).toBe(t);
        expect(out.join('\n')).not.toContain(t);
      },
    );
  });
  it('serves /mcp by default and a custom mount path when asked, printing that URL', async () => {
    await withDaemon({}, async ({ url }) => {
      expect(new URL(url).pathname).toBe('/mcp');
    });
    await withDaemon({ path: '/mcp/decisions' }, async ({ url, token, out, call }) => {
      expect(new URL(url).pathname).toBe('/mcp/decisions');
      expect(out.join('\n')).toContain(`Decisions MCP listening on ${url} `);
      expect(out.join('\n')).toContain(`claude mcp add --transport http decisions ${url} `);
      expect((await call('ask_human', { question: 'on a custom path' })).isError).toBeUndefined();
      const old = await fetch(new URL('/mcp', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(old.status).toBe(404);
    });
  });
  it('refuses a malformed mount path before serving anything', async () => {
    await expect(withDaemon({ path: 'mcp/' }, async () => {})).rejects.toThrow(
      /^--path: invalid MCP mount path/,
    );
  });
});
