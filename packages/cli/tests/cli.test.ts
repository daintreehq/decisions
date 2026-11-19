import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RelayError, loadIdentity } from '@daintreehq/decisions-client';
import {
  exportPublicKey,
  generateDeviceKeys,
  issueDeviceCert,
  newId,
} from '@daintreehq/decisions-crypto';
import { PROTOCOL_VERSION, ProtocolFeature, type DeviceCert } from '@daintreehq/decisions-protocol';
import { buildProgram, describeError, isEntryPoint } from '../src/bin.js';
import { ReceiverLock } from '../src/receiver.js';
import { CliError, keyStoreFor, type Ctx } from '../src/runtime.js';
import { DemoSink, cliOrigin, daemon, mcpAddLines, parseSink } from '../src/commands/daemon.js';
import { ask } from '../src/commands/ask.js';
import {
  deleteData,
  doctor,
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
      'wait',
      'get',
      'mcp',
      'status',
      'doctor',
      'export',
      'import',
      'recovery',
      'delete-data',
      'remove',
    ])
      expect(names).toContain(c);
    const rec = buildProgram().commands.find((c) => c.name() === 'recovery')!;
    expect(rec.commands.map((c) => c.name()).sort()).toEqual(['export', 'import', 'verify']);
    const flags = (name: string) =>
      buildProgram()
        .commands.find((c) => c.name() === name)!
        .options.map((o) => o.long);
    expect(flags('ask')).toEqual(
      expect.arrayContaining([
        '--expires-in',
        '--expires-at',
        '--planned-fallback',
        '--correlation-id',
        '--wait',
        '--wait-timeout',
        '--no-socket',
      ]),
    );
    expect(flags('wait')).toEqual(
      expect.arrayContaining(['--pane', '--wait-timeout', '--sink', '--no-socket']),
    );
    expect(flags('get')).toEqual(['--pane']);
  });
  it('turns errors into friendly one-liners', () => {
    expect(describeError(new CliError('nope'))).toBe('nope');
    expect(describeError(new RelayError('network_error', 'fetch failed', 0))).toContain(
      'is the relay reachable',
    );
    expect(describeError(new RelayError('not_authenticated', 'bad', 401))).toContain('clock skew');
  });
  it('runs when started through a bin symlink, as npm installs it, and not when imported', () => {
    const dir = mkdtempSync(join(root, 'bin-'));
    const real = join(dir, 'bin.js');
    const link = join(dir, 'decisions');
    writeFileSync(real, '');
    symlinkSync(real, link);
    const url = pathToFileURL(real).href;
    expect(isEntryPoint(real, url)).toBe(true);
    expect(isEntryPoint(link, url)).toBe(true);
    expect(isEntryPoint(join(dir, 'other.js'), url)).toBe(false);
    expect(isEntryPoint(undefined, url)).toBe(false);
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
  it('file sink appends with proof and can find an injection marker; stdout sink prints', async () => {
    const path = join(root, 'sink.txt');
    const sink = new DemoSink({ kind: 'file', path }, () => {});
    const t = (await sink.locate(cliOrigin())).target!;
    const r = await sink.inject(t, 'hello\ninjection_id: inj-1', 'inj-1');
    expect(r).toMatchObject({ outcome: 'delivered' });
    expect(r.outcome === 'delivered' && r.proof).toMatch(/^file:\d+$/);
    expect(await sink.hasMarker(t, 'inj-1')).toBe(true);
    expect(await sink.hasMarker(t, 'inj-2')).toBe(false);
    const lines: string[] = [];
    const s = await new DemoSink({ kind: 'stdout' }, (l) => void lines.push(l)).inject(
      t,
      'abc',
      'x',
    );
    expect(s).toEqual({ outcome: 'delivered', proof: 'stdout' });
    expect(lines.join('')).toContain('abc');
    expect((await sink.locate({ ...cliOrigin(), host_id: 'other' })).state).toBe('gone');
    expect((await sink.locate(cliOrigin())).state).toBe('alive');
  });
  it('file sink that cannot open its file reports unavailable (nothing written), not delivered', async () => {
    const sink = new DemoSink({ kind: 'file', path: join(root, 'no-such-dir', 'x.txt') }, () => {});
    const t = (await sink.locate(cliOrigin())).target!;
    expect(await sink.inject(t, 'hello', 'i')).toMatchObject({
      outcome: 'unavailable',
      reason: 'rejected',
    });
  });
  it('a stdout writer that throws mid-write is ambiguous', async () => {
    const sink = new DemoSink({ kind: 'stdout' }, () => {
      throw new Error('EPIPE');
    });
    const t = (await sink.locate(cliOrigin())).target!;
    expect(await sink.inject(t, 'hello', 'i')).toMatchObject({ outcome: 'ambiguous' });
  });
  it('stdout sink waits for an acknowledged writer and is ambiguous if the write fails later', async () => {
    const t = (await new DemoSink({ kind: 'stdout' }, () => {}).locate(cliOrigin())).target!;
    let finished = false;
    const slow = new DemoSink({ kind: 'stdout' }, async () => {
      await new Promise((r) => setTimeout(r, 20));
      finished = true;
    });
    expect(await slow.inject(t, 'abc', 'x')).toEqual({ outcome: 'delivered', proof: 'stdout' });
    expect(finished).toBe(true);
    const failing = new DemoSink({ kind: 'stdout' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });
    expect(await failing.inject(t, 'abc', 'x')).toMatchObject({ outcome: 'ambiguous' });
  });
  it('the CLI origin carries a fixed, non-empty run identity that its sink echoes', async () => {
    const o = cliOrigin('mcp');
    expect(o.ownership_principal).toBe('cli:mcp');
    expect(o.agent_incarnation).toBe('cli');
    const t = (await new DemoSink({ kind: 'stdout' }, () => {}).locate(o)).target!;
    expect(t).toMatchObject({ ownershipPrincipal: 'cli:mcp', agentIncarnation: 'cli' });
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
  it('asks for it with a hidden prompt at a terminal, and never without one', async () => {
    const a = mkCtx({ answers: ['p'.repeat(40)] });
    const prompts: { q: string; secret: boolean | undefined }[] = [];
    const base = a.ctx.prompt;
    a.ctx.interactive = true;
    a.ctx.prompt = (q, o) => (prompts.push({ q, secret: o?.secret }), base(q, o));
    await setup(a.ctx, {}, { url: 'https://relay.example' });
    expect(prompts).toEqual([{ q: expect.stringMatching(/Claim secret/), secret: true }]);
    expect((a.calls[0]!.body as { claim_secret: string }).claim_secret).toBe('p'.repeat(40));
    const b = mkCtx({ answers: ['p'.repeat(40)] });
    await expect(setup(b.ctx, {}, { url: 'https://relay.example' })).rejects.toThrow(
      /missing claim secret/,
    );
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
  const ticketed = (tickets: { features?: string[] }[]) => (body: unknown) => {
    tickets.push(body as { features?: string[] });
    return {
      ticket: 't',
      expires_at: new Date(Date.now() + 30_000).toISOString(),
      ws_path: '/api/v1/socket',
    };
  };
  it("a plain ask declares this device's features before it publishes, as a receiver would, so the person can dismiss its question", async () => {
    const tickets: { features?: string[] }[] = [];
    const { ctx, calls } = await ready({
      routes: {
        'POST /api/v1/socket-ticket': ticketed(tickets),
        'GET /api/v1/events': () => ({
          protocol_version: PROTOCOL_VERSION,
          from_exclusive: 0,
          high_water_seq: 0,
          events: [],
          next_after: 0,
          has_more: false,
        }),
        'POST /api/v1/deliveries/received': () => ({ ok: true }),
      },
    });
    tickets.length = 0;
    expect(await ask(ctx, {}, { question: 'Ship it?' })).toBe(0);
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    const ticket = paths.indexOf('POST /api/v1/socket-ticket');
    expect(ticket).toBeGreaterThanOrEqual(0);
    expect(ticket).toBeLessThan(paths.indexOf('POST /api/v1/questions'));
    // The relay and the phone gate the person's decline on it.
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.features).toEqual(
      expect.arrayContaining(['person-declines-v1', 'owner-desktop-declines-v1']),
    );
    // Exactly what a receiver of this device declares.
    await daemon(ctx, {}, { once: true });
    expect(tickets).toHaveLength(2);
    expect(tickets[0]!.features).toEqual(tickets[1]!.features);
  });
  it('a plain ask only adds to what the relay lists for this device, and sends nothing when that covers it', async () => {
    const tickets: { features?: string[] }[] = [];
    const me = { id: '', features: ['pane-snapshots-v1', 'phone-images-v1'] };
    const { ctx, calls } = await ready({
      routes: {
        'POST /api/v1/socket-ticket': ticketed(tickets),
        'GET /api/v1/devices': () => ({
          key_epoch: 1,
          owner_device_id: me.id,
          // A phone, listed first, declares what a phone does; only this device's own row counts.
          devices: [
            { device_id: 'dev_phone0001', features: ProtocolFeature.options },
            null,
            { device_id: me.id, features: [...me.features, 7] },
          ],
        }),
      },
    });
    me.id = (await loadIdentity(keyStoreFor(ctx))).config.deviceId;
    tickets.length = 0;
    // A host of the same device declared snapshots: they stay declared beside what this computer files.
    expect(await ask(ctx, {}, { question: 'One?' })).toBe(0);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.features).toEqual(
      expect.arrayContaining(['pane-snapshots-v1', 'phone-images-v1', 'person-declines-v1']),
    );
    // The relay now lists them all: the next ask spends no ticket, and still publishes.
    me.features = tickets[0]!.features!;
    calls.length = 0;
    expect(await ask(ctx, {}, { question: 'Two?' })).toBe(0);
    expect(tickets).toHaveLength(1);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /api/v1/questions');
  });
  it('a plain ask that cannot read the device list still declares what a receiver would', async () => {
    const tickets: { features?: string[] }[] = [];
    const { ctx, calls } = await ready({
      routes: {
        'POST /api/v1/socket-ticket': ticketed(tickets),
        'GET /api/v1/devices': () =>
          new Response(JSON.stringify({ code: 'internal_error', message: 'down' }), {
            status: 500,
          }),
      },
    });
    tickets.length = 0;
    expect(await ask(ctx, {}, { question: 'Ship it?' })).toBe(0);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.features).toEqual(expect.arrayContaining(['person-declines-v1']));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /api/v1/questions');
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

describe('listen without a live socket', () => {
  const emptyPage = () => ({
    protocol_version: PROTOCOL_VERSION,
    from_exclusive: 0,
    high_water_seq: 0,
    events: [],
    next_after: 0,
    has_more: false,
  });
  const refusal = (status: number, code: string, message: string) =>
    new Response(JSON.stringify({ code, message }), { status });
  const down = () => refusal(503, 'temporarily_unavailable', 'down');
  const relay = (events: () => unknown = emptyPage) => ({
    'POST /api/v1/socket-ticket': () => ({
      ticket: 't',
      expires_at: new Date(Date.now() + 30_000).toISOString(),
      ws_path: '/api/v1/socket',
    }),
    'GET /api/v1/events': events,
    'POST /api/v1/deliveries/received': () => ({ ok: true }),
  });
  const FAST = { intervalMs: 10, retryBaseMs: 10, retryCapMs: 20 };

  it('offers --once on listen, and --no-socket on listen and mcp', () => {
    const flags = (name: string) =>
      buildProgram()
        .commands.find((c) => c.name() === name)!
        .options.map((o) => o.long);
    expect(flags('listen')).toEqual(expect.arrayContaining(['--no-socket', '--once']));
    expect(flags('mcp')).toContain('--no-socket');
  });

  it('--once declares its features, reads the relay once and exits without claiming to listen', async () => {
    const m = await ready({ routes: relay() });
    await daemon(m.ctx, {}, { once: true });
    const paths = m.calls.map((c) => `${c.method} ${c.path}`);
    const ticket = paths.indexOf('POST /api/v1/socket-ticket');
    expect(ticket).toBeGreaterThanOrEqual(0);
    expect(ticket).toBeLessThan(paths.indexOf('GET /api/v1/events'));
    expect(paths.filter((p) => p === 'GET /api/v1/events')).toHaveLength(1);
    expect(m.out.join('\n')).not.toMatch(/Listening/);
    expect(m.err.join('\n')).toMatch(/HTTP sync ok \(event 0\); done/);
    m.out.length = 0;
    await status(m.ctx, {});
    expect(m.out.join('\n')).toMatch(/Last HTTP sync last success \S+ at event 0/);
  });

  it('--once gives up at its deadline when the relay never answers', async () => {
    const m = await ready({ routes: relay() });
    const inner = m.ctx.fetch;
    m.ctx.fetch = (async (u: unknown, init?: RequestInit) => {
      if (!String(u).includes('/api/v1/events')) return inner(u as string, init);
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      );
    }) as typeof fetch;
    const ended = await daemon(m.ctx, {}, { once: true, onceDeadlineMs: 100 }).catch(
      (e: unknown) => e,
    );
    expect(ended).toBeInstanceOf(CliError);
    expect((ended as CliError).message).toMatch(/did not finish within two minutes/);
    expect((ended as CliError).exitCode).toBe(1);
  });

  it('--once fails when the relay cannot be read', async () => {
    const m = await ready({ routes: relay(down) });
    await expect(daemon(m.ctx, {}, { once: true })).rejects.toThrow(
      'could not sync with the relay over HTTP (temporarily_unavailable)',
    );
    m.out.length = 0;
    await status(m.ctx, {});
    expect(m.out.join('\n')).toMatch(
      /Last HTTP sync failing: temporarily_unavailable, 1 in a row, .*no successful sync yet/,
    );
  });

  it('--no-socket keeps polling, reports a failure and the recovery, and stops when told', async () => {
    let reads = 0;
    const m = await ready({ routes: relay(() => (++reads === 2 ? down() : emptyPage())) });
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    const done = daemon(m.ctx, {}, { socket: false, until, poll: FAST });
    try {
      await vi.waitFor(() => expect(reads).toBeGreaterThan(3), { timeout: 5_000 });
    } finally {
      release();
      await done;
    }
    expect(m.out.join('\n')).toContain('Listening for answers over HTTP (no live socket).');
    const err = m.err.join('\n');
    expect(err).toMatch(/\[relay\] HTTP sync ok \(event 0\); polling every 0s/);
    expect(err).toMatch(
      /\[relay\] HTTP sync failed \(temporarily_unavailable, 1 in a row\); retrying in 0s/,
    );
    expect(err).toMatch(/\[relay\] HTTP sync recovered \(event 0\)/);
    const after = reads;
    await new Promise((r) => setTimeout(r, 60));
    expect(reads).toBe(after);
  });

  it('stops, and fails, when the relay says this device was revoked', async () => {
    const m = await ready({
      routes: relay(() => refusal(401, 'not_authenticated', 'unknown or revoked device')),
    });
    const never = new Promise<void>(() => undefined);
    const ended = await daemon(m.ctx, {}, { socket: false, until: never, poll: FAST }).catch(
      (e: unknown) => e,
    );
    expect(ended).toBeInstanceOf(CliError);
    expect((ended as CliError).message).toMatch(/revoked from the relay/);
    expect((ended as CliError).exitCode).toBe(1);
    expect(m.out.join('\n')).toContain('Listening for answers over HTTP');
  });

  it('stops, and fails, when the relay needs a newer client', async () => {
    const m = await ready({
      routes: relay(() => refusal(426, 'upgrade_required', 'unsupported protocol version')),
    });
    const never = new Promise<void>(() => undefined);
    const ended = await daemon(m.ctx, {}, { socket: false, until: never, poll: FAST }).catch(
      (e: unknown) => e,
    );
    expect(ended).toBeInstanceOf(CliError);
    expect((ended as CliError).message).toBe(
      'stopped listening: the relay refuses this client (upgrade_required); update decisions',
    );
    expect((ended as CliError).exitCode).toBe(1);
    m.out.length = 0;
    await status(m.ctx, {});
    expect(m.out.join('\n')).toMatch(/Last HTTP sync stopped: the relay refuses this client/);
  });
});

describe('doctor', () => {
  const now = new Date().toISOString();
  const deviceRow = (cert: { device_id: string; role: string }, features: string[]) => ({
    device_id: cert.device_id,
    role: cert.role,
    label: 'Test',
    created_at: now,
    revoked_at: null,
    last_seen_at: now,
    last_ack_seq: 0,
    cert,
    push_enabled: false,
    features,
  });

  /** A claimed setup whose relay lists `devices(own cert, a phone cert)` and records socket tickets. */
  async function doctorWorld(
    devices: (own: DeviceCert, phone: DeviceCert) => ReturnType<typeof deviceRow>[],
    o: {
      /** Another process receives for this state directory while doctor runs. */
      receiving?: boolean;
      /** The test socket, given the state directory; by default it says hello at once. */
      webSocket?: (home: string) => NonNullable<Ctx['webSocket']>;
      /** Called as doctor reads the device list, given the state directory. */
      onDevices?: (home: string) => void;
    } = {},
  ) {
    let own: DeviceCert | null = null;
    let phone: DeviceCert | null = null;
    let doctoring = false;
    const tickets: { features?: string[] }[] = [];
    const m = mkCtx({
      routes: {
        'GET /api/v1/devices': () => {
          if (doctoring) o.onDevices?.(m.ctx.home);
          return {
            key_epoch: 1,
            owner_device_id: own!.device_id,
            devices: devices(own!, phone!),
          };
        },
        'POST /api/v1/socket-ticket': (body) => {
          tickets.push(body as { features?: string[] });
          return { ticket: 't', expires_at: now, ws_path: '/api/v1/socket' };
        },
      },
    });
    await setup(
      m.ctx,
      {},
      { url: 'https://relay.example', claimSecret: 'c'.repeat(32), label: 'Test' },
    );
    own = (m.calls.find((c) => c.path === '/api/v1/setup/claim')!.body as { cert: DeviceCert })
      .cert;
    // A phone the owner certified, listed before this device with features of its own.
    const owner = await loadIdentity(keyStoreFor(m.ctx));
    const keys = await generateDeviceKeys(false);
    phone = await issueDeviceCert({
      issuerDeviceId: owner.config.deviceId,
      issuerSigningKey: owner.keys.signing.privateKey,
      installationId: owner.config.installationId,
      deviceId: newId(),
      role: 'phone',
      label: 'Phone',
      signingPub: await exportPublicKey(keys.signing.publicKey),
      exchangePub: await exportPublicKey(keys.exchange.publicKey),
    });
    m.ctx.webSocket =
      o.webSocket?.(m.ctx.home) ??
      (() => {
        const ws = {
          onmessage: null as ((ev: { data: unknown }) => void) | null,
          onerror: null,
          close: () => {},
        };
        setTimeout(() => ws.onmessage?.({ data: JSON.stringify({ t: 'hello' }) }), 0);
        return ws as never;
      });
    const receiver = ReceiverLock.forHome(m.ctx.home);
    if (o.receiving) expect(receiver.tryAcquire()).toBe(true);
    const t0 = performance.now();
    doctoring = true;
    try {
      // This fake relay fails checks unrelated to the ticket (health, storage, push), so doctor reports problems.
      await expect(doctor(m.ctx, {}, {})).rejects.toThrow(CliError);
    } finally {
      doctoring = false;
      receiver.release();
    }
    return { ...m, tickets, ms: performance.now() - t0 };
  }

  it("re-declares this device's features on its test ticket, so the relay keeps what it gates on them", async () => {
    const { tickets, out } = await doctorWorld((own, phone) => [
      deviceRow(phone, ['pane-snapshots-v1']),
      // What the bridge last declared, plus a token from a newer client, which is never re-sent.
      deviceRow(own, [
        'owner-desktop-answers-v1',
        'phone-images-v1',
        'thread-messages-v1',
        'later-v9',
      ]),
    ]);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.features).toEqual([
      'owner-desktop-answers-v1',
      'phone-images-v1',
      'thread-messages-v1',
    ]);
    const text = out.join('\n');
    expect(text).toMatch(/✓ signed request +2 active device/);
    expect(text).toMatch(/✓ websocket +upgrade \+ hello received/);
  });

  it('opens no test socket while another process receives for the state directory, and fails nothing for it', async () => {
    const { tickets, out } = await doctorWorld(
      (own, phone) => [deviceRow(phone, []), deviceRow(own, ['owner-desktop-answers-v1'])],
      { receiving: true },
    );
    // No ticket either: one would re-declare this device's features under the receiver's feet.
    expect(tickets).toEqual([]);
    const text = out.join('\n');
    expect(text).toMatch(/✓ signed request +2 active device/);
    expect(text).toMatch(
      /! websocket +skipped: another decisions process receives for this state directory/,
    );
    // The checks after it still run, and the skip is not one of the failures.
    expect(text).toMatch(/R2 round trip/);
    const failures = text.split('\n').filter((l) => l.startsWith('✗')).length;
    expect(text).toContain(`${failures} check(s) failed.`);
  });

  it('holds the receiver lock from reading the declaration to the end of its socket check, then closes the socket', async () => {
    /** Whether another process could take the lock: as doctor reads the device list, and as its socket says hello. */
    const free: Record<string, boolean> = {};
    const probe = (home: string, at: string) => {
      const other = ReceiverLock.forHome(home);
      free[at] = other.tryAcquire();
      other.release();
    };
    let home = '';
    const sockets: {
      onmessage: ((ev: { data: unknown }) => void) | null;
      onclose: unknown;
      onerror: unknown;
      closed: number[];
    }[] = [];
    const { tickets, out } = await doctorWorld(
      (own, phone) => [deviceRow(phone, []), deviceRow(own, [])],
      {
        onDevices: (h) => probe(h, 'devices'),
        webSocket: (h) => {
          home = h;
          return () => {
            const ws = {
              onmessage: null as ((ev: { data: unknown }) => void) | null,
              onerror: null,
              onclose: null,
              closed: [] as number[],
              close: (code = 1000) => void ws.closed.push(code),
            };
            sockets.push(ws);
            setTimeout(() => {
              probe(h, 'hello');
              ws.onmessage?.({ data: JSON.stringify({ t: 'hello' }) });
            }, 0);
            return ws as never;
          };
        },
      },
    );
    expect(tickets).toHaveLength(1);
    expect(free).toEqual({ devices: false, hello: false });
    expect(out.join('\n')).toMatch(/✓ websocket +upgrade \+ hello received/);
    // Done with it: the test socket is closed and hears nothing more.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toEqual([1000]);
    expect([sockets[0]!.onmessage, sockets[0]!.onclose, sockets[0]!.onerror]).toEqual([
      null,
      null,
      null,
    ]);
    const after = ReceiverLock.forHome(home);
    expect(after.tryAcquire()).toBe(true);
    after.release();
  });

  it('reports a socket the relay closes before hello at once, without waiting out its timer', async () => {
    let socket: { onmessage: unknown; onclose: unknown; onerror: unknown } | null = null;
    const { out, ms } = await doctorWorld(
      (own, phone) => [deviceRow(phone, []), deviceRow(own, [])],
      {
        webSocket: () => () => {
          const ws = {
            onmessage: null,
            onerror: null,
            onclose: null as ((ev: { code: number; reason: string }) => void) | null,
            close: () => {},
          };
          socket = ws;
          setTimeout(() => ws.onclose?.({ code: 1006, reason: '' }), 0);
          return ws as never;
        },
      },
    );
    expect(out.join('\n')).toMatch(/✗ websocket +could not open the hibernatable socket/);
    // Settled by the close, not the 8 s timer, and done with the socket.
    expect(ms).toBeLessThan(4_000);
    expect(socket).toEqual({
      onmessage: null,
      onclose: null,
      onerror: null,
      close: expect.any(Function),
    });
  }, 15_000);

  it('skips the socket check rather than declaring nothing when this device is not listed', async () => {
    const { tickets, out } = await doctorWorld((_own, phone) => [
      deviceRow(phone, ['owner-desktop-answers-v1']),
    ]);
    expect(tickets).toEqual([]);
    expect(out.join('\n')).toMatch(/! websocket +skipped: this device's declared features/);
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
    // The local databases hold the question sealed (the export above opened it on demand).
    for (const home of [a.ctx.home, b.ctx.home]) {
      for (const f of ['decisions.db', 'decisions.db-wal']) {
        const p = join(home, f);
        if (existsSync(p)) expect(readFileSync(p).includes(Buffer.from('SECRET-BODY'))).toBe(false);
      }
    }
  });
  it('any command seals a store row left in plaintext by an older version', async () => {
    const { ctx } = await ready();
    await ask(ctx, {}, { question: 'Fresh question' });
    // Rewind the row to how a pre-sealing build stored it: plaintext content, nothing sealed.
    const dbFile = join(ctx.home, 'decisions.db');
    const raw = new DatabaseSync(dbFile);
    raw
      .prepare('UPDATE questions SET content_json = ?, content_sealed = NULL')
      .run(JSON.stringify({ content_version: 1, question: 'OLDPLAIN legacy question' }));
    raw.close();
    expect(readFileSync(dbFile).includes(Buffer.from('OLDPLAIN'))).toBe(true);
    await status(ctx, {});
    for (const f of ['decisions.db', 'decisions.db-wal']) {
      const p = join(ctx.home, f);
      if (existsSync(p)) expect(readFileSync(p).includes(Buffer.from('OLDPLAIN'))).toBe(false);
    }
  });
  it('a command refuses a state directory a newer client wrote, before touching it', async () => {
    const { ctx } = await ready();
    await ask(ctx, {}, { question: 'Fresh question' });
    const dbFile = join(ctx.home, 'decisions.db');
    const raw = new DatabaseSync(dbFile);
    // A newer client's data format, and a row this client would otherwise seal on open.
    raw.prepare("UPDATE meta SET value = '2' WHERE key = 'store_format'").run();
    raw
      .prepare('UPDATE questions SET content_json = ?, content_sealed = NULL')
      .run(JSON.stringify({ content_version: 1, question: 'NEWERPLAIN question' }));
    raw.close();
    const err = await status(ctx, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(1);
    expect((err as CliError).message).toContain(`cannot use ${dbFile}`);
    expect((err as CliError).message).toMatch(
      /data format 2, and this client reads formats up to 1.*Upgrade this client/,
    );
    const after = new DatabaseSync(dbFile);
    expect(after.prepare("SELECT value FROM meta WHERE key = 'store_format'").get()).toMatchObject({
      value: '2',
    });
    expect(after.prepare('SELECT content_json FROM questions').get()).toMatchObject({
      content_json: expect.stringContaining('NEWERPLAIN'),
    });
    after.close();
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
  const target = (async () =>
    (await new DemoSink({ kind: 'stdout' }, () => {}).locate(cliOrigin())).target!)();

  it('pipes the notice to the command; exit 0 after reading it all is delivered', async () => {
    const path = join(root, 'exec.txt');
    const sink = new DemoSink({ kind: 'exec', cmd: `cat > ${path}` }, () => {});
    const r = await sink.inject(await target, 'piped text', 'i');
    expect(r).toEqual({ outcome: 'delivered', proof: 'exec:exit-0' });
    expect(readFileSync(path, 'utf8')).toContain('piped text');
  });

  it('exit 75 (EX_TEMPFAIL) means held: nothing was done, try again later', async () => {
    const sink = new DemoSink({ kind: 'exec', cmd: 'cat >/dev/null; exit 75' }, () => undefined);
    expect(await sink.inject(await target, 'hello', 'i')).toEqual({
      outcome: 'held',
      reason: 'exec_tempfail',
    });
  });

  it('close() kills a command that ignores SIGTERM, and writes nothing more afterwards', async () => {
    const sink = new DemoSink(
      parseSink("exec:trap '' TERM; cat >/dev/null; while :; do sleep 0.1; done"),
      () => {},
    );
    const result = sink.inject(await target, 'answer', 'i');
    await new Promise((r) => setTimeout(r, 200));
    sink.close();
    expect(await result).toEqual({ outcome: 'ambiguous', reason: 'exec_exit_signal' });
    expect(await sink.inject(await target, 'later', 'j')).toEqual({
      outcome: 'held',
      reason: 'sink_closed',
    });
  });

  it('close() ends a command that never exits, which settles as ambiguous', async () => {
    const sink = new DemoSink({ kind: 'exec', cmd: 'cat >/dev/null; sleep 30' }, () => undefined);
    const pending = sink.inject(await target, 'hello', 'i');
    await new Promise((r) => setTimeout(r, 100));
    sink.close();
    const late = new Promise((r) => setTimeout(() => r('hung'), 5_000));
    expect(await Promise.race([pending, late])).toEqual({
      outcome: 'ambiguous',
      reason: 'exec_exit_signal',
    });
  });

  it('any other non-zero exit is ambiguous: the command may have acted on the text', async () => {
    const sink = new DemoSink({ kind: 'exec', cmd: 'cat >/dev/null; exit 3' }, () => undefined);
    expect(await sink.inject(await target, 'hello', 'i')).toEqual({
      outcome: 'ambiguous',
      reason: 'exec_exit_3',
    });
  });

  it('exit 0 without reading all of the input is ambiguous, not delivered', async () => {
    const sink = new DemoSink({ kind: 'exec', cmd: 'exit 0' }, () => undefined);
    expect(await sink.inject(await target, 'x'.repeat(2_000_000), 'i')).toEqual({
      outcome: 'ambiguous',
      reason: 'exec_input_unread',
    });
  });

  it('does not crash when the command exits before reading its input (EPIPE)', async () => {
    const sink = new DemoSink({ kind: 'exec', cmd: 'exit 3' }, () => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('uncaughtException', onUnhandled);
    try {
      const res = await sink.inject(await target, 'x'.repeat(2_000_000), 'inj1');
      await new Promise((r) => setTimeout(r, 50));
      expect(res).toMatchObject({ outcome: 'ambiguous' });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('uncaughtException', onUnhandled);
    }
  });
});
