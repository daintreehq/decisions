import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../src/bin.js';
import { hostAccept, hostEnroll, hostRequest } from '../src/commands/host.js';
import { setup } from '../src/commands/setup.js';
import type { Ctx } from '../src/runtime.js';

const root = mkdtempSync(join(tmpdir(), 'decisions-cli-host-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function mkCtx(over: Partial<Ctx> & { answers?: string[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const answers = [...(over.answers ?? [])];
  const ctx: Ctx = {
    home: over.home ?? join(root, `h${n++}`),
    json: over.json ?? false,
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    prompt: async () => answers.shift() ?? '',
    env: over.env ?? {},
    now: Date.now,
    readStdin: over.readStdin ?? (async () => ''),
    fetch: (async (u: unknown, init?: RequestInit) => {
      const url = new URL(String(u));
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/api/v1/setup/claim') {
        const body = JSON.parse(String(init!.body)) as { installation_id: string };
        return new Response(
          JSON.stringify({
            installation_id: body.installation_id,
            vapid_public_key: 'V'.repeat(87),
            server_time: new Date().toISOString(),
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ code: 'not_found', message: 'nope' }), {
        status: 404,
      });
    }) as typeof fetch,
  };
  return { ctx, out, err, calls };
}

describe('decisions host', () => {
  it('is wired into the program with request, enroll and accept', () => {
    const host = buildProgram().commands.find((c) => c.name() === 'host')!;
    expect(host.commands.map((c) => c.name()).sort()).toEqual(['accept', 'enroll', 'request']);
  });

  it('request prints a copyable request and code, keeps the keys private, and re-prints the same identity', async () => {
    const m = mkCtx({ json: true });
    await hostRequest(m.ctx, {}, { label: 'Build box' });
    const first = JSON.parse(m.out.join('\n'));
    expect(first.request).toMatch(/^decisions-host-request\.v1\.[A-Za-z0-9_-]+$/);
    expect(first.code).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    expect(first.label).toBe('Build box');
    expect(first.reused).toBe(false);
    const file = join(m.ctx.home, 'host-request.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(join(m.ctx.home, 'identity.json'))).toBe(false);
    m.out.length = 0;
    await hostRequest(m.ctx, {}, { label: 'Build box' });
    const second = JSON.parse(m.out.join('\n'));
    expect(second.device_id).toBe(first.device_id);
    expect(second.code).toBe(first.code);
    expect(second.reused).toBe(true);
    m.out.length = 0;
    await hostRequest(m.ctx, {}, { label: 'Build box', new: true });
    expect(JSON.parse(m.out.join('\n')).device_id).not.toBe(first.device_id);
    // human output names the next commands
    const h = mkCtx();
    await hostRequest(h.ctx, {}, { label: 'Box' });
    expect(h.out.join('\n')).toContain('decisions host enroll');
    expect(h.out.join('\n')).toContain('decisions host accept');
  });

  it('request refuses on a machine that is already set up', async () => {
    const m = mkCtx();
    await setup(m.ctx, {}, { url: 'https://relay.example', claimSecret: 'c'.repeat(32) });
    await expect(hostRequest(m.ctx, {}, { label: 'Box' })).rejects.toThrow(
      /already has a Decisions identity/,
    );
  });

  it('enroll rejects garbage before touching the relay, and stops when the code is not confirmed', async () => {
    const owner = mkCtx({ answers: ['n'] });
    await setup(owner.ctx, {}, { url: 'https://relay.example', claimSecret: 'c'.repeat(32) });
    owner.calls.length = 0;
    await expect(hostEnroll(owner.ctx, {}, { request: 'not a request' })).rejects.toThrow(
      /not a Decisions Host enrollment request/,
    );
    const host = mkCtx({ json: true });
    await hostRequest(host.ctx, {}, { label: 'Box' });
    const { request, code } = JSON.parse(host.out.join('\n'));
    // read from a file, with the line wraps a terminal copy adds
    const file = join(root, 'req.txt');
    writeFileSync(file, request.replace(/(.{64})/g, '$1\n') + '\n');
    await expect(hostEnroll(owner.ctx, {}, { requestFile: file })).rejects.toThrow(/cancelled/);
    expect(owner.err.join('\n')).toContain(code);
    expect(owner.calls).toEqual([]);
    // from stdin, which leaves nothing to read a confirmation from: shows the code and asks for --yes
    const piped = mkCtx({ home: owner.ctx.home, readStdin: async () => request, answers: ['y'] });
    await expect(hostEnroll(piped.ctx, {}, { request: '-' })).rejects.toThrow(/--yes/);
    expect(piped.err.join('\n')).toContain(code);
    expect(piped.calls).toEqual([]);
  });

  it('accept refuses garbage and a response with no pending request', async () => {
    const m = mkCtx();
    await expect(hostAccept(m.ctx, {}, { response: 'nope' })).rejects.toThrow(
      /not a Decisions Host enrollment response/,
    );
    await expect(hostAccept(m.ctx, {}, {})).rejects.toThrow(/nothing to read/);
  });
});
