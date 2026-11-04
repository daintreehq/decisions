import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptEnvelope } from '@daintreehq/decisions-crypto';
import { AgentMessageContentV1, type SignedMessage } from '@daintreehq/decisions-protocol';
import {
  MCP_BRIDGE_METHODS,
  PolicyRegistry,
  SERVER_INSTRUCTIONS,
  TOOLS,
  TokenMapAuthenticator,
  askedInstruction,
  createDecisionsMcpHandler,
  followupInstruction,
  startDecisionsMcpServer,
  type DecisionsMcpBridge,
  type RunningMcp,
} from '../src/index.js';
import { origin, setupBridge, tick } from './helpers.js';

const TOKEN = 'pane-token-AAAAAAAAAAAAAAAAAAAAAAAA';
let running: RunningMcp | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function boot(
  opts: {
    rate?: number;
    maxBody?: number;
    path?: string;
    bridge?: Parameters<typeof setupBridge>[0];
    /** Serve this instead of the bridge itself (a host's forwarder). */
    wrap?: (b: Awaited<ReturnType<typeof setupBridge>>['bridge']) => DecisionsMcpBridge;
  } = {},
) {
  const env = await setupBridge(opts.bridge);
  const auth = new TokenMapAuthenticator();
  auth.register(TOKEN, origin());
  auth.register('other-pane-token-BBBBBBBBBBBBBBBBBB', origin({ pane_id: 'pane-2' }));
  running = await startDecisionsMcpServer({
    bridge: opts.wrap ? opts.wrap(env.bridge) : env.bridge,
    authenticator: auth,
    ...(opts.rate ? { rateLimitPerMinute: opts.rate } : {}),
    ...(opts.maxBody ? { maxBodyBytes: opts.maxBody } : {}),
    ...(opts.path ? { path: opts.path } : {}),
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
  mcp: Pick<RunningMcp, 'port' | 'url'>,
  o: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    auth?: string | null;
    /** Request path; defaults to the path the server says it is mounted at. */
    path?: string;
  },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(o.headers ?? {}),
    };
    if (o.auth !== null) headers.authorization = `Bearer ${o.auth ?? TOKEN}`;
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: mcp.port,
        path: o.path ?? new URL(mcp.url).pathname,
        method: o.method ?? 'POST',
        headers,
      },
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
    expect(r.result.instructions).toBe(SERVER_INSTRUCTIONS);
    const unknown = JSON.parse(
      (await raw(mcp, { body: rpc('initialize', { protocolVersion: '1999-01-01' }) })).body,
    );
    expect(unknown.result.protocolVersion).toBe('2025-06-18');
  });
  it('tools/list: exactly the four tools, descriptions under 400 bytes', async () => {
    const { mcp } = await boot();
    const r = JSON.parse((await raw(mcp, { body: rpc('tools/list') })).body);
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'ask_human',
      'get_decision',
      'cancel_question',
      'send_followup',
    ]);
    for (const t of TOOLS) expect(new TextEncoder().encode(t.description).length).toBeLessThan(400);
    expect(r.result.tools[0].inputSchema.required).toEqual(['question']);
  });
  it('tools/list: annotations let approval-gating clients run ask_human and get_decision unprompted', async () => {
    // MCP defaults an unannotated tool to destructive and open-world. Codex then asks for approval of
    // every ask_human, so the agent would sit waiting in the terminal for permission to ask the human.
    const { mcp } = await boot();
    const r = JSON.parse((await raw(mcp, { body: rpc('tools/list') })).body);
    const by = Object.fromEntries(
      r.result.tools.map((t: { name: string; annotations?: Record<string, unknown> }) => [
        t.name,
        t.annotations,
      ]),
    );
    expect(by.ask_human).toEqual({
      title: 'Ask the human',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(by.get_decision).toEqual({
      title: 'Check a decision',
      readOnlyHint: true,
      openWorldHint: false,
    });
    // a follow-up only adds to the owner's own thread, like a question
    expect(by.send_followup).toEqual({
      title: 'Send a follow-up',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    // cancelling cannot be undone, so it stays a call a cautious client confirms
    expect(by.cancel_question).toEqual({
      title: 'Cancel a question',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
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
    expect(res.content[0].text).toBe(askedInstruction(1));
    expect(res.content[0].text).toMatch(
      /^Asked as q-1\. Carry on with anything that does not depend on the answer; once you cannot go further without it, end your turn\. The answer arrives as a new message in this terminal, with your question quoted\. /,
    );
    expect(res.structuredContent.instruction).toBe(askedInstruction(1));
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

describe('HTTP MCP: send_followup', () => {
  const OTHER = 'other-pane-token-BBBBBBBBBBBBBBBBBB';
  const ask = async (mcp: RunningMcp) =>
    (await call(mcp, 'ask_human', { question: 'Which colour?' })).structuredContent
      .question_id as string;
  /** Let the background pumps the calls started finish, then flush what is left. */
  const settle = async (bridge: Awaited<ReturnType<typeof boot>>['bridge']) => {
    await tick();
    await bridge.pump();
    await bridge.pump();
  };

  it('lists the question id, the text and the reply flag, all required', async () => {
    const { mcp } = await boot();
    const r = JSON.parse((await raw(mcp, { body: rpc('tools/list') })).body);
    const tool = r.result.tools.find((t: { name: string }) => t.name === 'send_followup');
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['question_id', 'text', 'expects_reply'],
      properties: {
        question_id: { type: 'string' },
        text: { type: 'string', minLength: 1, maxLength: 16384 },
        expects_reply: { type: 'boolean' },
      },
    });
  });

  it('a message from the asking pane is queued at once and published with its reply flag', async () => {
    const { mcp, bridge, relay, identity } = await boot();
    const id = await ask(mcp);
    const res = await call(mcp, 'send_followup', {
      question_id: id,
      text: 'Do you mean the dark red?',
      expects_reply: true,
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(followupInstruction(1, true));
    expect(res.structuredContent).toMatchObject({
      question_id: id,
      status: 'queued',
      expects_reply: true,
      instruction: followupInstruction(1, true),
    });
    const quiet = await call(mcp, 'send_followup', {
      question_id: id,
      text: 'Going with red otherwise.',
      expects_reply: false,
    });
    expect(quiet.content[0].text).toBe(followupInstruction(1, false));
    await settle(bridge);

    const sent = relay.messages.map((m) => m.message as SignedMessage);
    expect(sent.map((m) => m.record.message_id)).toEqual([
      res.structuredContent.message_id,
      quiet.structuredContent.message_id,
    ]);
    expect(sent.map((m) => [m.record.side, m.record.expects_reply])).toEqual([
      ['agent', true],
      ['agent', false],
    ]);
    const content = AgentMessageContentV1.parse(
      await decryptEnvelope(sent[0]!.envelope, identity.epochs, { questionId: id, revision: 0 }),
    );
    expect(content.text).toBe('Do you mean the dark red?');
    // the question is untouched: still open, no answer
    const d = await call(mcp, 'get_decision', { question_id: id });
    expect(d.structuredContent).toMatchObject({ status: 'open', provenance: null, answers: [] });
  });

  it("another pane's question and an unknown id are refused with the same error", async () => {
    const { mcp, bridge, relay } = await boot();
    const id = await ask(mcp);
    const args = { text: 'hi', expects_reply: false };
    const other = await call(mcp, 'send_followup', { question_id: id, ...args }, OTHER);
    const unknown = await call(mcp, 'send_followup', { question_id: 'q_nope_1234', ...args });
    expect(other.isError).toBe(true);
    expect(other).toEqual(unknown);
    expect(other.content[0].text).toBe('not_found: unknown question');
    await settle(bridge);
    expect(relay.messages).toHaveLength(0);
  });

  it('refuses an over-limit, blank or flagless message with a clear error', async () => {
    const { mcp, bridge, relay } = await boot();
    const id = await ask(mcp);
    // 8193 characters, within maxLength, but 16386 bytes of UTF-8
    const big = await call(mcp, 'send_followup', {
      question_id: id,
      text: 'é'.repeat(8193),
      expects_reply: false,
    });
    expect(big.isError).toBe(true);
    expect(big.content[0].text).toBe('validation_error: text: text exceeds 16 KiB (UTF-8)');
    const blank = await call(mcp, 'send_followup', {
      question_id: id,
      text: ' ',
      expects_reply: false,
    });
    expect(blank.content[0].text).toBe('validation_error: text: text is empty');
    const flagless = await call(mcp, 'send_followup', { question_id: id, text: 'hi' });
    expect(flagless.isError).toBe(true);
    expect(flagless.content[0].text).toContain('expects_reply');
    await settle(bridge);
    expect(relay.messages).toHaveLength(0);
  });

  it('a withdrawn question takes no follow-ups', async () => {
    const { mcp, store, bridge } = await boot();
    const id = await ask(mcp);
    await settle(bridge); // published first, so the publish cannot reopen it below
    await store.updateQuestion(id, { local_status: 'cancelled' });
    const res = await call(mcp, 'send_followup', {
      question_id: id,
      text: 'hi',
      expects_reply: true,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      'invalid_state: q-1 was cancelled, so its thread takes no more messages',
    );
  });

  it('the agent is told that threads exist, both ways, and that answers are final', () => {
    for (const t of [SERVER_INSTRUCTIONS, askedInstruction(1)]) {
      expect(t).toContain('send_followup'); // reply, clarify or ask in the same thread
      expect(t).toMatch(/instead of asking a new/);
      expect(t).toMatch(/even after answering|also after answering/); // the person may follow up
      expect(t).toMatch(/marked as follow-ups/); // how they arrive
      expect(t).toMatch(/never change the answer|without changing it/);
      expect(t).toMatch(/final/);
      expect(t).toMatch(/reconsidered decision arrives as a follow-up/);
      expect(t).toMatch(/arrives? the same way/); // replies to the agent's follow-ups
    }
    const desc = TOOLS.find((t) => t.name === 'send_followup')!.description;
    expect(desc).toMatch(/clarify it, reply to the person's follow-up, or ask a follow-up/);
    expect(desc).toMatch(/Returns at once/);
    expect(desc).toMatch(/marked follow-up/);
    expect(desc).toMatch(/never changes the answer: a human answer is final/);
    expect(followupInstruction(3, true)).toMatch(/^Queued in q-3's thread/);
    expect(followupInstruction(3, true)).toMatch(/end your turn/);
    expect(followupInstruction(3, false)).not.toMatch(/end your turn/);
  });

  it('a host that forwards exactly MCP_BRIDGE_METHODS serves every tool', async () => {
    const forwarded: string[] = [];
    let forwarder: DecisionsMcpBridge | null = null;
    const { mcp, bridge, relay } = await boot({
      // A forwarder like Daintree's: plain functions across a boundary, no bridge object.
      wrap: (b) =>
        (forwarder = Object.fromEntries(
          MCP_BRIDGE_METHODS.map((m) => [
            m,
            (...a: unknown[]) => {
              forwarded.push(m);
              return (b[m] as (...x: unknown[]) => unknown).apply(b, a);
            },
          ]),
        ) as unknown as DecisionsMcpBridge),
    });
    expect(Object.keys(forwarder!).sort()).toEqual([...MCP_BRIDGE_METHODS].sort());
    const id = await ask(mcp);
    expect(
      (await call(mcp, 'send_followup', { question_id: id, text: 'hi', expects_reply: true }))
        .isError,
    ).toBeUndefined();
    expect((await call(mcp, 'get_decision', { question_id: id })).isError).toBeUndefined();
    expect((await call(mcp, 'cancel_question', { question_id: id })).isError).toBeUndefined();
    expect(new Set(forwarded)).toEqual(new Set(MCP_BRIDGE_METHODS));
    await settle(bridge);
    expect(relay.messages).toHaveLength(1);
  });
});

describe('HTTP MCP: workflow gates', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  it('the schemas expose the gate and the decision fields', async () => {
    const { mcp } = await boot();
    const r = JSON.parse((await raw(mcp, { body: rpc('tools/list') })).body);
    const [ask, get] = r.result.tools;
    expect(ask.inputSchema.properties.workflow_gate_id.description).toMatch(/choices/);
    expect(Object.keys(get.outputSchema.properties)).toEqual(
      expect.arrayContaining(['status', 'provenance', 'choice', 'text', 'reviewed_digests_match']),
    );
  });
  it('get_decision reports a design-review approval bound to the reviewed images', async () => {
    const policy = new PolicyRegistry();
    policy.register({
      gateId: 'design-review/final',
      minRequirement: 'human-required',
      policyVersion: 1,
      choices: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      allowText: false,
      bindArtifacts: true,
    });
    const { mcp, bridge, relay, phone, store } = await boot({
      bridge: { policy, resolver: { resolve: async () => ({ bytes: PNG }) } },
    });
    const ask = await call(mcp, 'ask_human', {
      question: 'Approve the final design?',
      workflow_gate_id: 'design-review/final',
      attachments: [{ local_resource_id: 'after', role: 'after' }],
    });
    expect(ask.isError).toBeUndefined();
    const id = ask.structuredContent.question_id;
    await bridge.pump();
    const open = await call(mcp, 'get_decision', { question_id: id });
    expect(open.structuredContent).toMatchObject({
      status: 'open',
      workflow_gate_id: 'design-review/final',
      provenance: null,
      choice: null,
      text: '',
      reviewed_digests_match: false,
    });
    await relay.answerEvent({
      questionId: id,
      phone,
      options: ['approve'],
      extra: { reviewed_attachment_digests: (await store.getQuestion(id))!.attachment_digests },
    });
    await bridge.catchUp();
    const done = await call(mcp, 'get_decision', { question_id: id });
    expect(done.structuredContent).toMatchObject({
      status: 'human-answered',
      provenance: 'human',
      choice: 'approve',
      reviewed_digests_match: true,
    });
    expect(done.content[0].text).toContain('reviewed_digests_match: true');
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

  it('a relaunch that keeps pane id, generation and session but changes the principal is still a stranger', async () => {
    const { mcp, bridge } = await boot();
    const ask = await call(mcp, 'ask_human', { question: 'old run question' });
    const id = ask.structuredContent.question_id;
    const auth = new TokenMapAuthenticator();
    auth.register('new-principal-token-DDDDDDDDDDDDDD', origin({ ownership_principal: 'p-2' }));
    auth.register('new-incarnation-token-EEEEEEEEEEEE', origin({ agent_incarnation: 'inc-2' }));
    const second = await startDecisionsMcpServer({ bridge, authenticator: auth });
    try {
      for (const token of [
        'new-principal-token-DDDDDDDDDDDDDD',
        'new-incarnation-token-EEEEEEEEEEEE',
      ]) {
        const r = await call(second, 'get_decision', { question_id: id }, token);
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toContain('not_found');
        const c = await call(second, 'cancel_question', { question_id: id }, token);
        expect(c.isError).toBe(true);
      }
      // the original credential still owns it
      expect((await call(mcp, 'get_decision', { question_id: id })).isError).toBeUndefined();
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

describe('HTTP MCP: mount path', () => {
  it('defaults to exactly /mcp', async () => {
    const { mcp } = await boot();
    expect(new URL(mcp.url).pathname).toBe('/mcp');
    expect((await raw(mcp, { body: rpc('ping') })).status).toBe(200);
    expect((await raw(mcp, { path: '/mcp?x=1', body: rpc('ping') })).status).toBe(200);
    for (const path of ['/', '/mcp/', '/mcp/decisions', '/mcpx', '/MCP'])
      expect((await raw(mcp, { path, body: rpc('ping') })).status, path).toBe(404);
  });

  it('rejects malformed mount paths when the handler is created', async () => {
    const env = await setupBridge();
    const auth = new TokenMapAuthenticator();
    for (const path of [
      '',
      '/',
      'mcp',
      'mcp/decisions',
      '/mcp/',
      '//mcp',
      '/mcp//decisions',
      '/mcp/./decisions',
      '/mcp/../decisions',
      '/..',
      '/mcp?x=1',
      '/mcp#x',
      '/mcp decisions',
      '/mcp%2Fdecisions',
      '/mcp\\decisions',
      'http://127.0.0.1/mcp',
    ])
      expect(() => createDecisionsMcpHandler(env.bridge, auth, { path }), path).toThrow(
        /mount path/,
      );
    for (const path of ['/mcp', '/mcp/decisions', '/a-b_c.d~e/0'])
      expect(() => createDecisionsMcpHandler(env.bridge, auth, { path }), path).not.toThrow();
    await expect(
      startDecisionsMcpServer({ bridge: env.bridge, authenticator: auth, path: '/mcp/' }),
    ).rejects.toThrow(/mount path/);
  });

  it('serves only the configured path, exactly: /mcp and subpaths are 404', async () => {
    const { mcp } = await boot({ path: '/mcp/decisions' });
    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/decisions$/);
    const tools = JSON.parse((await raw(mcp, { body: rpc('tools/list') })).body);
    expect(tools.result.tools).toHaveLength(TOOLS.length);
    expect((await raw(mcp, { path: '/mcp/decisions?session=1', body: rpc('ping') })).status).toBe(
      200,
    );
    for (const path of [
      '/mcp',
      '/',
      '/mcp/decisions/',
      '/mcp/decisions/x',
      '/mcp/decisionsx',
      '/mcp/Decisions',
      '/decisions',
    ]) {
      const r = await raw(mcp, { path, body: rpc('ping') });
      expect(r.status, path).toBe(404);
      expect(JSON.parse(r.body)).toEqual({ error: 'not_found' });
    }
    // percent-encoding is not decoded, but URL parsing resolves dot segments before the match
    for (const path of ['/mcp%2Fdecisions', '/mcp/decision%73'])
      expect((await raw(mcp, { path, body: rpc('ping') })).status, path).toBe(404);
    for (const path of ['/a/../mcp/decisions', '/mcp/x/../decisions', '/mcp/%2e/decisions']) {
      expect((await raw(mcp, { path, body: rpc('ping') })).status, path).not.toBe(404);
      expect((await raw(mcp, { path, auth: null, body: rpc('ping') })).status, path).toBe(401);
    }
    // 404 is decided before auth, Host or Origin, so a wrong path leaks nothing about them
    expect((await raw(mcp, { path: '/mcp', auth: null, body: rpc('ping') })).status).toBe(404);
  });

  it('keeps every Host, Origin, method, bearer, content-type, body-size and rate check on a custom path', async () => {
    const { mcp, store } = await boot({ path: '/mcp/decisions', maxBody: 2048, rate: 5 });
    const ping = rpc('ping');
    expect((await raw(mcp, { headers: { host: 'evil.example' }, body: ping })).status).toBe(403);
    expect(
      (await raw(mcp, { headers: { host: `evil.example:${mcp.port}` }, body: ping })).status,
    ).toBe(403);
    expect(
      (await raw(mcp, { headers: { origin: `http://127.0.0.1:${mcp.port}` }, body: ping })).status,
    ).toBe(403);
    await raw(mcp, {
      headers: { host: 'evil.example' },
      body: rpc('tools/call', { name: 'ask_human', arguments: { question: 'steer the agent' } }),
    });
    expect(await store.listQuestions()).toHaveLength(0);
    for (const method of ['GET', 'DELETE', 'OPTIONS']) {
      const r = await raw(mcp, { method });
      expect(r.status).toBe(405);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
    const none = await raw(mcp, { auth: null, body: ping });
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toContain('Bearer');
    expect((await raw(mcp, { auth: 'totally-wrong-token', body: ping })).status).toBe(401);
    // the checks below run after auth, so each one uses up the pane's rate budget
    expect((await raw(mcp, { headers: { 'content-type': 'text/plain' }, body: ping })).status).toBe(
      415,
    );
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
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await raw(mcp, { body: ping })).status);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  it('a host can route its own prefix to the handler beside its own /mcp', async () => {
    const env = await setupBridge();
    const auth = new TokenMapAuthenticator();
    auth.register(TOKEN, origin());
    let port = 0;
    const handler = createDecisionsMcpHandler(env.bridge, auth, {
      path: '/mcp/decisions',
      allowedHosts: () => [`127.0.0.1:${port}`],
    });
    // Like Daintree's listener: its own control surface at /mcp, Decisions under /mcp/decisions.
    const server = createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      if (p === '/mcp/decisions' || p.startsWith('/mcp/decisions/')) return void handler(req, res);
      res.writeHead(p === '/mcp' ? 200 : 404, { 'content-type': 'text/plain' });
      res.end(p === '/mcp' ? 'host control surface' : 'host 404');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
    try {
      const target = { port, url: `http://127.0.0.1:${port}/mcp/decisions` };
      const ok = await raw(target, { body: rpc('tools/list') });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body).result.tools).toHaveLength(TOOLS.length);
      expect((await raw(target, { path: '/mcp', body: rpc('ping') })).body).toBe(
        'host control surface',
      );
      const sub = await raw(target, { path: '/mcp/decisions/extra', body: rpc('ping') });
      expect(sub.status).toBe(404);
      expect(JSON.parse(sub.body)).toEqual({ error: 'not_found' });
      expect((await raw(target, { auth: null, body: rpc('ping') })).status).toBe(401);
      expect(
        (await raw(target, { headers: { host: 'evil.example' }, body: rpc('ping') })).status,
      ).toBe(403);
    } finally {
      await new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
    }
  });
});
