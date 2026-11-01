import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TOOLS,
  TokenMapAuthenticator,
  startDecisionsMcpServer,
  type RunningMcp,
} from '../src/index.js';
import { origin, setupBridge } from './helpers.js';

const TOKEN = 'pane-token-AAAAAAAAAAAAAAAAAAAAAAAA';
let running: RunningMcp | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function boot(opts: { rate?: number; maxBody?: number } = {}) {
  const env = await setupBridge();
  const auth = new TokenMapAuthenticator();
  auth.register(TOKEN, origin());
  auth.register('other-pane-token-BBBBBBBBBBBBBBBBBB', origin({ pane_id: 'pane-2' }));
  running = await startDecisionsMcpServer({
    bridge: env.bridge,
    authenticator: auth,
    ...(opts.rate ? { rateLimitPerMinute: opts.rate } : {}),
    ...(opts.maxBody ? { maxBodyBytes: opts.maxBody } : {}),
  });
  return { ...env, mcp: running };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw HTTP so we can control Host/Origin exactly like a browser or DNS-rebinding page would. */
function raw(
  mcp: RunningMcp,
  o: { method?: string; headers?: Record<string, string>; body?: string; auth?: string | null },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(o.headers ?? {}),
    };
    if (o.auth !== null) headers.authorization = `Bearer ${o.auth ?? TOKEN}`;
    const req = httpRequest(
      { host: '127.0.0.1', port: mcp.port, path: '/mcp', method: o.method ?? 'POST', headers },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
      },
    );
    req.on('error', reject);
    req.end(o.body);
  });
}

const rpc = (method: string, params?: unknown, id: number | undefined = 1) =>
  JSON.stringify({
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    method,
    ...(params ? { params } : {}),
  });
const call = async (mcp: RunningMcp, name: string, args: unknown, auth?: string) =>
  JSON.parse(
    (
      await raw(mcp, {
        body: rpc('tools/call', { name, arguments: args }),
        ...(auth ? { auth } : {}),
      })
    ).body,
  ).result;

describe('HTTP MCP: protocol', () => {
  it('initialize echoes a supported version and advertises tools', async () => {
    const { mcp } = await boot();
    const r = JSON.parse(
      (
        await raw(mcp, {
          body: rpc('initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 't', version: '1' },
          }),
        })
      ).body,
    );
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(r.result.capabilities.tools).toBeTruthy();
    const unknown = JSON.parse(
      (await raw(mcp, { body: rpc('initialize', { protocolVersion: '1999-01-01' }) })).body,
    );
    expect(unknown.result.protocolVersion).toBe('2025-06-18');
  });
  it('tools/list: exactly the three tools, descriptions under 400 bytes', async () => {
    const { mcp } = await boot();
    const r = JSON.parse((await raw(mcp, { body: rpc('tools/list') })).body);
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'ask_human',
      'get_decision',
      'cancel_question',
    ]);
    for (const t of TOOLS) expect(new TextEncoder().encode(t.description).length).toBeLessThan(400);
    expect(r.result.tools[0].inputSchema.required).toEqual(['question']);
  });
  it('notifications get 202 with no body; batches return arrays; ping works', async () => {
    const { mcp } = await boot();
    const n = await raw(mcp, { body: rpc('notifications/initialized', undefined, undefined) });
    expect(n.status).toBe(202);
    expect(n.body).toBe('');
    const b = JSON.parse(
      (
        await raw(mcp, {
          body: `[${rpc('ping', undefined, 1)},${rpc('ping', undefined, 2)},${rpc('notifications/initialized', undefined, undefined)}]`,
        })
      ).body,
    );
    expect(b).toHaveLength(2);
  });
  it('JSON-RPC errors: parse error, invalid request, unknown method, unknown tool', async () => {
    const { mcp } = await boot();
    const bad = await raw(mcp, { body: '{nope' });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error.code).toBe(-32700);
    expect(JSON.parse((await raw(mcp, { body: '{"foo":1}' })).body).error.code).toBe(-32600);
    expect(JSON.parse((await raw(mcp, { body: rpc('nope/nothing') })).body).error.code).toBe(
      -32601,
    );
    expect(
      JSON.parse(
        (await raw(mcp, { body: rpc('tools/call', { name: 'rm_rf', arguments: {} }) })).body,
      ).error.code,
    ).toBe(-32602);
    expect((await raw(mcp, { body: '[]' })).status).toBe(400);
  });
  it('GET/DELETE/OPTIONS are 405 without CORS headers', async () => {
    const { mcp } = await boot();
    for (const method of ['GET', 'DELETE', 'OPTIONS']) {
      const r = await raw(mcp, { method });
      expect(r.status).toBe(405);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});

describe('HTTP MCP: ask_human / get_decision / cancel_question', () => {
  it('ask_human returns immediately with the exact guidance text', async () => {
    const { mcp, store } = await boot();
    const res = await call(mcp, 'ask_human', {
      question: 'Which colour?',
      options: [{ id: 'red', label: 'Red' }],
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(
      /^Asked as q-1\. End your turn now \(or continue with unrelated work\); the answer will arrive as a message in this terminal\.$/,
    );
    expect(res.structuredContent).toMatchObject({
      status: 'queued',
      enforced_requirement: 'human-required',
    });
    expect(await store.listQuestions()).toHaveLength(1);
  });
  it('the pane comes from the credential; a caller-supplied pane id is ignored', async () => {
    const { mcp, store } = await boot();
    await call(mcp, 'ask_human', { question: 'q', pane_id: 'pane-2', host_id: 'evil' });
    const [q] = await store.listQuestions();
    expect(q!.origin.pane_id).toBe('pane-1');
    expect(q!.origin.host_id).toBe('host-local');
  });
  it('validation problems come back as tool errors, not crashes', async () => {
    const { mcp } = await boot();
    const res = await call(mcp, 'ask_human', { question: '' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('validation_error');
  });
  it('get_decision and cancel_question only work for the owning pane', async () => {
    const { mcp } = await boot();
    const ask = await call(mcp, 'ask_human', { question: 'mine?' });
    const id = ask.structuredContent.question_id;
    const own = await call(mcp, 'get_decision', { question_id: id });
    expect(own.structuredContent.status).toMatch(/queued|open/);
    const other = await call(
      mcp,
      'get_decision',
      { question_id: id },
      'other-pane-token-BBBBBBBBBBBBBBBBBB',
    );
    expect(other.isError).toBe(true);
    expect(other.content[0].text).toContain('not_found');
    const cancelOther = await call(
      mcp,
      'cancel_question',
      { question_id: id },
      'other-pane-token-BBBBBBBBBBBBBBBBBB',
    );
    expect(cancelOther.isError).toBe(true);
    expect((await call(mcp, 'cancel_question', { question_id: id })).isError).toBeUndefined();
  });
});

describe('HTTP MCP: a relaunched terminal is a different asker', () => {
  it('a fresh credential for the same pane id (new generation) cannot read or cancel the old question', async () => {
    const { mcp, bridge } = await boot();
    const ask = await call(mcp, 'ask_human', { question: 'old session question' });
    const id = ask.structuredContent.question_id;
    // simulate Daintree relaunching the terminal: same pane id, new generation, new bearer
    const auth = new TokenMapAuthenticator();
    auth.register(
      'relaunched-token-CCCCCCCCCCCCCCCC',
      origin({ terminal_generation: 2, agent_session_id: 'sess-2' }),
    );
    const second = await startDecisionsMcpServer({ bridge, authenticator: auth });
    try {
      const r = await call(
        second,
        'get_decision',
        { question_id: id },
        'relaunched-token-CCCCCCCCCCCCCCCC',
      );
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('not_found');
      const c = await call(
        second,
        'cancel_question',
        { question_id: id },
        'relaunched-token-CCCCCCCCCCCCCCCC',
      );
      expect(c.isError).toBe(true);
    } finally {
      await second.close();
    }
  });
});

describe('HTTP MCP: security', () => {
  it('requires the pane bearer; never echoes it', async () => {
    const { mcp } = await boot();
    const none = await raw(mcp, { auth: null, body: rpc('ping') });
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toContain('Bearer');
    const wrong = await raw(mcp, { auth: 'totally-wrong-token', body: rpc('ping') });
    expect(wrong.status).toBe(401);
    expect(wrong.body).not.toContain('totally-wrong-token');
    expect(
      (await raw(mcp, { headers: { authorization: 'Basic abc' }, auth: null, body: rpc('ping') }))
        .status,
    ).toBe(401);
  });
  it('rejects DNS-rebinding Host headers and any browser Origin', async () => {
    const { mcp } = await boot();
    const rebinding = await raw(mcp, {
      headers: { host: `evil.example:${mcp.port}` },
      body: rpc('ping'),
    });
    expect(rebinding.status).toBe(403);
    expect((await raw(mcp, { headers: { host: 'evil.example' }, body: rpc('ping') })).status).toBe(
      403,
    );
    expect(
      (await raw(mcp, { headers: { origin: 'https://evil.example' }, body: rpc('ping') })).status,
    ).toBe(403);
    expect(
      (await raw(mcp, { headers: { origin: `http://127.0.0.1:${mcp.port}` }, body: rpc('ping') }))
        .status,
    ).toBe(403);
    expect(
      (await raw(mcp, { headers: { host: `localhost:${mcp.port}` }, body: rpc('ping') })).status,
    ).toBe(200);
  });
  it('a rebinding request cannot create questions even with a valid token', async () => {
    const { mcp, store } = await boot();
    await raw(mcp, {
      headers: { host: 'evil.example' },
      body: rpc('tools/call', { name: 'ask_human', arguments: { question: 'steer the agent' } }),
    });
    expect(await store.listQuestions()).toHaveLength(0);
  });
  it('enforces content type, body size and per-pane rate limits', async () => {
    const { mcp } = await boot({ maxBody: 2048, rate: 3 });
    expect(
      (await raw(mcp, { headers: { 'content-type': 'text/plain' }, body: rpc('ping') })).status,
    ).toBe(415);
    expect(
      (
        await raw(mcp, {
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'ping',
            params: { pad: 'x'.repeat(5000) },
          }),
        })
      ).status,
    ).toBe(413);
    // 2 requests used above count toward the window (auth passed); the next ones hit the limit
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await raw(mcp, { body: rpc('ping') })).status);
    expect(codes).toContain(429);
  });
  it('binds loopback only', async () => {
    const { mcp } = await boot();
    const addr = mcp.server.address() as { address: string };
    expect(addr.address).toBe('127.0.0.1');
    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });
});
