import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RelayError } from '@daintreehq/decisions-client';
import { buildProgram, describeError } from '../src/bin.js';
import { CliError, type Ctx } from '../src/runtime.js';
import { DemoSink, ask, cliOrigin, mcpAddLines, parseSink } from '../src/commands/daemon.js';
import {
  deleteData,
  exportCmd,
  importCmd,
  recoveryExport,
  recoveryImport,
  recoveryVerify,
  status,
} from '../src/commands/ops.js';
import { devices, setup } from '../src/commands/setup.js';

const root = mkdtempSync(join(tmpdir(), 'decisions-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function mkCtx(
  over: Partial<Ctx> & {
    answers?: string[];
    routes?: Record<string, (body: unknown) => unknown>;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { method: string; path: string; body: unknown }[] = [];
  const answers = [...(over.answers ?? [])];
  const routes = over.routes ?? {};
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
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method: init?.method ?? 'GET', path: url.pathname, body });
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      const h = routes[key];
      if (h) {
        const r = h(body);
        return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
      }
      if (key === 'POST /api/v1/setup/claim')
        return new Response(
          JSON.stringify({
            installation_id: (body as { installation_id: string }).installation_id,
            vapid_public_key: 'V'.repeat(87),
            server_time: new Date().toISOString(),
          }),
          { status: 201 },
        );
      if (key === 'POST /api/v1/questions') {
        const q = (body as { question: { record: { question_id: string } } }).question;
        return new Response(
          JSON.stringify({
            question_id: q.record.question_id,
            revision: 0,
            status: 'open',
            event_seq: 1,
          }),
          { status: 201 },
        );
      }
      if (key === 'GET /api/v1/info')
        return new Response(
          JSON.stringify({
            name: 'daintree-decisions',
            protocol_min: 1,
            protocol_max: 1,
            worker_version: '0.1.0',
            claimed: true,
            claim_configured: true,
            voice: { xai: false, anthropic: false, openai: false },
          }),
        );
      if (key === 'GET /api/v1/devices')
        return new Response(JSON.stringify({ key_epoch: 1, owner_device_id: 'x', devices: [] }));
      return new Response(JSON.stringify({ code: 'not_found', message: 'nope' }), { status: 404 });
    }) as typeof fetch,
  };
  return { ctx, out, err, calls };
}

async function ready(over: Parameters<typeof mkCtx>[0] = {}) {
  const m = mkCtx(over);
  await setup(
    m.ctx,
    {},
    { url: 'https://relay.example', claimSecret: 'c'.repeat(32), label: 'Test' },
  );
  m.out.length = 0;
  m.calls.length = 0;
  return m;
}

describe('program surface', () => {
  it('exposes every documented command', () => {
    const names = buildProgram().commands.map((c) => c.name());
    for (const c of [
      'setup',
      'pair',
      'devices',
      'revoke',
      'listen',
      'ask',
      'mcp',
      'status',
      'doctor',
      'export',
      'import',
      'recovery',
      'delete-data',
    ])
      expect(names).toContain(c);
    const rec = buildProgram().commands.find((c) => c.name() === 'recovery')!;
    expect(rec.commands.map((c) => c.name()).sort()).toEqual(['export', 'import', 'verify']);
  });
  it('turns errors into friendly one-liners', () => {
    expect(describeError(new CliError('nope'))).toBe('nope');
    expect(describeError(new RelayError('network_error', 'fetch failed', 0))).toContain(
      'is the relay reachable',
    );
    expect(describeError(new RelayError('not_authenticated', 'bad', 401))).toContain('clock skew');
  });
});

describe('setup', () => {
  it('claims, stores keys with private permissions and prints next steps', async () => {
    const { ctx, out, calls } = mkCtx();
    await setup(
      ctx,
      {},
      { url: 'https://relay.example/', claimSecret: 'c'.repeat(32), label: 'My Mac' },
    );
    expect(calls.map((c) => c.path)).toEqual(['/api/v1/setup/claim']);
    expect(existsSync(join(ctx.home, 'identity.json'))).toBe(true);
    expect(out.join('\n')).toContain('decisions recovery export');
    expect(out.join('\n')).toContain('decisions pair');
  });
  it('needs a claim secret (flag or env) and refuses to run twice', async () => {
    const { ctx } = mkCtx();
    await expect(setup(ctx, {}, { url: 'https://relay.example' })).rejects.toThrow(/claim secret/);
    const withEnv = mkCtx({ env: { DECISIONS_CLAIM_SECRET: 'e'.repeat(32) } });
    await setup(withEnv.ctx, {}, { url: 'https://relay.example' });
    await expect(setup(withEnv.ctx, {}, { url: 'https://relay.example' })).rejects.toThrow(
      /already exists/,
    );
  });
  it('rejects plain http for non-local relays', async () => {
    const { ctx } = mkCtx();
    await expect(
      setup(ctx, {}, { url: 'http://evil.example', claimSecret: 'c'.repeat(32) }),
    ).rejects.toThrow(/https/);
  });
});

describe('sinks and MCP instructions', () => {
  it('parses sink specs', () => {
    expect(parseSink(undefined)).toEqual({ kind: 'stdout' });
    expect(parseSink('file:/tmp/x')).toEqual({ kind: 'file', path: '/tmp/x' });
    expect(parseSink('exec:cat')).toEqual({ kind: 'exec', cmd: 'cat' });
    expect(() => parseSink('file:')).toThrow();
    expect(() => parseSink('ftp:x')).toThrow();
  });
  it('prints the exact claude mcp add line only when asked to show the token', () => {
    const shown = mcpAddLines('http://127.0.0.1:8123/mcp', 'TOKEN123', { show: true }).join('\n');
    expect(shown).toContain(
      'claude mcp add --transport http decisions http://127.0.0.1:8123/mcp --header "Authorization: Bearer TOKEN123"',
    );
    expect(shown).toContain('"type": "http"');
    const hidden = mcpAddLines('http://127.0.0.1:8123/mcp', 'TOKEN123', {
      file: '/h/mcp-token',
    }).join('\n');
    expect(hidden).not.toContain('TOKEN123');
    expect(hidden).toContain(
      'claude mcp add --transport http decisions http://127.0.0.1:8123/mcp --header "Authorization: Bearer $(cat /h/mcp-token)"',
    );
    expect(hidden).toContain('/h/mcp-token');
    expect(hidden).toContain('--show-token');
  });
  it('file sink appends and can find an injection marker; stdout sink prints', async () => {
    const path = join(root, 'sink.txt');
    const sink = new DemoSink({ kind: 'file', path }, () => {});
    const t = {
      hostId: 'cli',
      paneId: 'cli',
      terminalGeneration: 1,
      agentSessionId: null,
      worktreeId: 'cli',
    };
    expect((await sink.inject(t, 'hello\ninjection_id: inj-1', 'inj-1')).ok).toBe(true);
    expect(await sink.hasMarker(t, 'inj-1')).toBe(true);
    expect(await sink.hasMarker(t, 'inj-2')).toBe(false);
    const lines: string[] = [];
    await new DemoSink({ kind: 'stdout' }, (l) => lines.push(l)).inject(t, 'abc', 'x');
    expect(lines.join('')).toContain('abc');
    expect((await sink.locate({ ...cliOrigin(), host_id: 'other' })).state).toBe('gone');
    expect((await sink.locate(cliOrigin())).state).toBe('alive');
  });
  it('exec sink pipes the notice to the command and reports failure', async () => {
    const path = join(root, 'exec.txt');
    const t = {
      hostId: 'cli',
      paneId: 'cli',
      terminalGeneration: 1,
      agentSessionId: null,
      worktreeId: 'cli',
    };
    expect(
      (
        await new DemoSink({ kind: 'exec', cmd: `cat > ${path}` }, () => {}).inject(
          t,
          'piped text',
          'i',
        )
      ).ok,
    ).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('piped text');
    expect(
      (await new DemoSink({ kind: 'exec', cmd: 'exit 3' }, () => {}).inject(t, 'x', 'i')).ok,
    ).toBe(false);
  });
});

describe('setup: the claim secret does not have to be on the command line', () => {
  it('reads it from a file, or from stdin, and warns about argv', async () => {
    const file = join(root, 'claim-secret.txt');
    writeFileSync(file, 'f'.repeat(40) + '\n');
    const a = mkCtx();
    await setup(a.ctx, {}, { url: 'https://relay.example', claimSecretFile: file });
    expect((a.calls[0]!.body as { claim_secret: string }).claim_secret).toBe('f'.repeat(40));
    expect(a.err.join('')).not.toContain('warning');
    const b = mkCtx({ readStdin: async () => 's'.repeat(40) + '\n' });
    await setup(b.ctx, {}, { url: 'https://relay.example', claimSecretStdin: true });
    expect((b.calls[0]!.body as { claim_secret: string }).claim_secret).toBe('s'.repeat(40));
    const c = mkCtx();
    await setup(c.ctx, {}, { url: 'https://relay.example', claimSecret: 'a'.repeat(40) });
    expect(c.err.join('\n')).toContain('visible in the process list');
  });
  it('does not accept the secret only through argv: the flag set offers file, stdin and env', () => {
    const setupCmd = buildProgram().commands.find((c) => c.name() === 'setup')!;
    const flags = setupCmd.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--claim-secret-file', '--claim-secret-stdin']));
    const mcpCmd = buildProgram().commands.find((c) => c.name() === 'mcp')!;
    const mflags = mcpCmd.options.map((o) => o.long);
    expect(mflags).not.toContain('--token'); // a bearer in argv is visible to every local user
    expect(mflags).toEqual(
      expect.arrayContaining([
        '--token-env',
        '--token-file',
        '--show-token',
        '--attachments-dir',
        '--path',
      ]),
    );
  });
});

describe('ask / status / devices', () => {
  it('ask queues, publishes, and enforces human-required by default', async () => {
    const { ctx, out, calls } = await ready();
    await ask(
      ctx,
      {},
      { question: 'Tabs or spaces?', option: ['tabs=Tabs', 'spaces=Spaces'], require: 'proxy-ok' },
    );
    expect(out.join('\n')).toMatch(/Asked as q-1 .*requirement: human-required/);
    const create = calls.find((c) => c.path === '/api/v1/questions')!;
    expect(JSON.stringify(create.body)).not.toContain('Tabs or spaces?'); // encrypted
  });
  it('ask rejects malformed --option values', async () => {
    const { ctx } = await ready();
    await expect(ask(ctx, {}, { question: 'q', option: ['nolabel'] })).rejects.toThrow(/id=Label/);
  });
  it('status reports counts and --json is parseable', async () => {
    const { ctx, out } = await ready({ json: true });
    await ask(ctx, {}, { question: 'q' });
    out.length = 0;
    await status(ctx, {});
    const j = JSON.parse(out.join('\n'));
    expect(j.questions.open).toBe(1);
    expect(j.reachable).toBe(true);
    expect(j.protocol).toBe('1-1');
  });
  it('status flags answers that could not be typed', async () => {
    const { ctx, out } = await ready();
    await status(ctx, {});
    expect(out.join('\n')).toContain('Questions');
  });
  it('devices requires setup', async () => {
    const { ctx } = mkCtx();
    await expect(devices(ctx, {})).rejects.toThrow(/not set up/);
  });
});

describe('export / import / recovery / delete-data', () => {
  it('encrypted export round-trips through import; plaintext needs the explicit flag', async () => {
    const a = await ready({ env: { DECISIONS_EXPORT_PASSPHRASE: 'a long export passphrase' } });
    await ask(a.ctx, {}, { question: 'Remember me? SECRET-BODY' });
    const file = join(root, 'export.dxz.json');
    await exportCmd(a.ctx, {}, { out: file });
    expect(readFileSync(file, 'utf8')).not.toContain('SECRET-BODY');
    const b = await ready({ env: { DECISIONS_EXPORT_PASSPHRASE: 'a long export passphrase' } });
    await importCmd(b.ctx, {}, file);
    expect(b.out.join('\n')).toContain('Imported 1 decision');
    const plain = join(root, 'plain.zip');
    await exportCmd(a.ctx, {}, { out: plain, plaintext: true });
    expect(a.err.join('\n')).toContain('UNENCRYPTED');
    expect(readFileSync(plain).subarray(0, 2).toString('latin1')).toBe('PK');
  });
  it('recovery kit export, verify and restore', async () => {
    const env = { DECISIONS_RECOVERY_PASSPHRASE: 'a long recovery passphrase' };
    const a = await ready({ env });
    const kit = join(root, 'kit.json');
    await recoveryExport(a.ctx, {}, { out: kit });
    await recoveryVerify(a.ctx, kit);
    expect(a.out.join('\n')).toContain('Recovery kit is valid');
    const fresh = mkCtx({ env });
    await recoveryImport(fresh.ctx, {}, kit, {});
    expect(existsSync(join(fresh.ctx.home, 'identity.json'))).toBe(true);
    await expect(recoveryImport(fresh.ctx, {}, kit, {})).rejects.toThrow(/already exists/);
    const wrong = mkCtx({ env: { DECISIONS_RECOVERY_PASSPHRASE: 'definitely not the one' } });
    await expect(recoveryVerify(wrong.ctx, kit)).rejects.toThrow(/failed/);
    writeFileSync(join(root, 'junk.json'), '{}');
  });
  it('delete-data needs the typed confirmation', async () => {
    const no = await ready({ answers: ['nope'] });
    await expect(deleteData(no.ctx, {}, { scope: 'questions' })).rejects.toThrow(/cancelled/);
    expect(no.calls.some((c) => c.path.endsWith('delete-data'))).toBe(false);
    const yes = await ready({
      answers: ['DELETE'],
      routes: { 'POST /api/v1/admin/delete-data': () => ({ ok: true }) },
    });
    await deleteData(yes.ctx, {}, { scope: 'everything' });
    expect(yes.calls.find((c) => c.path.endsWith('delete-data'))!.body).toMatchObject({
      confirm: 'DELETE',
      scope: 'everything',
    });
  });
});

describe('exec sink', () => {
  const target = {
    hostId: 'cli',
    paneId: 'p',
    terminalGeneration: 1,
    agentSessionId: null,
    worktreeId: 'w',
  };

  it('does not crash when the command exits before reading its input (EPIPE)', async () => {
    const sink = new DemoSink({ kind: 'exec', cmd: 'exit 3' }, () => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('uncaughtException', onUnhandled);
    try {
      const res = await sink.inject(target as never, 'x'.repeat(2_000_000), 'inj1');
      await new Promise((r) => setTimeout(r, 50));
      expect(res).toEqual({ ok: false, reason: 'exec_failed' });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('uncaughtException', onUnhandled);
    }
  });

  it('reports success when the command accepts the notice', async () => {
    const sink = new DemoSink({ kind: 'exec', cmd: 'cat >/dev/null' }, () => undefined);
    expect(await sink.inject(target as never, 'hello', 'inj2')).toEqual({ ok: true });
  });
});
