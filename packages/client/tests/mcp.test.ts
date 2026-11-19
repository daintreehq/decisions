import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSignedInvolvement, decryptEnvelope } from '@daintreehq/decisions-crypto';
import { AgentMessageContentV1, type SignedMessage } from '@daintreehq/decisions-protocol';
import {
  MCP_BRIDGE_METHODS,
  PolicyRegistry,
  DEFAULT_ATTACHMENT_ID_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  TOOLS,
  TokenMapAuthenticator,
  askedInstruction,
  createDecisionsMcpHandler,
  followupInstruction,
  involvementText,
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
    attachmentIdDescription?: string;
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
    ...(opts.attachmentIdDescription
      ? { attachmentIdDescription: opts.attachmentIdDescription }
      : {}),
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
  it('tools/list: exactly the five tools, descriptions under 400 bytes', async () => {
    const { mcp } = await boot();
    const r = JSON.parse((await raw(mcp, { body: rpc('tools/list') })).body);
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'ask_human',
      'get_decision',
      'cancel_question',
      'send_followup',
      'get_involvement',
    ]);
    for (const t of TOOLS) expect(new TextEncoder().encode(t.description).length).toBeLessThan(400);
    expect(r.result.tools[0].inputSchema.required).toEqual(['question']);
  });
  it('tools/list: agents are told to attach screenshots when the decision is visual, and how', async () => {
    // An agent that cannot tell what an attachment id is asks in words about something the person
    // has to see, so every layer says when to attach and the id is described as a path it can write.
    const { mcp } = await boot();
    const init = JSON.parse((await raw(mcp, { body: rpc('initialize') })).body);
    const instructions: string = init.result.instructions;
    expect(instructions).toMatch(/see something to decide .* attach screenshots to ask_human/);
    expect(instructions).toMatch(/roles before and after/);
    expect(instructions).toMatch(/approval covers only the images it was given/);
    const r = JSON.parse((await raw(mcp, { body: rpc('tools/list') })).body);
    const ask = r.result.tools.find((t: { name: string }) => t.name === 'ask_human');
    expect(ask).toBeDefined();
    expect(ask.description).toMatch(/see something to decide, attach screenshots/);
    expect(ask.inputSchema.properties.attachments.description).toMatch(/screenshots/i);
    expect(ask.inputSchema.properties.attachments.description).toMatch(/visual/);
    const id: string =
      ask.inputSchema.properties.attachments.items.properties.local_resource_id.description;
    expect(id).toMatch(/PNG, JPEG or WebP/);
    expect(id).toMatch(/path relative to the folder this terminal started in/);
    expect(id).not.toMatch(/registered/);
  });
  it('tools/list: a host replaces the attachment id description without touching TOOLS', async () => {
    const before = structuredClone(TOOLS);
    const { mcp } = await boot({ attachmentIdDescription: 'A file name in your pane folder.' });
    const r = JSON.parse((await raw(mcp, { body: rpc('tools/list') })).body);
    // Exactly one field differs from the defaults; every sibling and every other tool is served as is.
    const expected = structuredClone(before) as unknown as Array<Record<string, any>>;
    const ask = expected.find((t) => t.name === 'ask_human')!;
    ask.inputSchema.properties.attachments.items.properties.local_resource_id.description =
      'A file name in your pane folder.';
    expect(r.result.tools).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(TOOLS).toEqual(before);
    expect(
      before[0].inputSchema.properties.attachments.items.properties.local_resource_id.description,
    ).toBe(DEFAULT_ATTACHMENT_ID_DESCRIPTION);
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
    // reading the preference changes nothing, so no client needs to ask before it
    expect(by.get_involvement).toEqual({
      title: 'Read the involvement preference',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
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
  it("a pane's bearer token cannot reach answerQuestion, as a tool or as a method", async () => {
    const { mcp, relay, bridge } = await boot();
    relay.features = ['thread-messages-v1', 'owner-desktop-answers-v1'];
    const asked = await call(mcp, 'ask_human', { question: 'Ship it?' });
    const questionId = asked.structuredContent.question_id as string;
    const args = { questionId, question_id: questionId, expectedRevision: 0, text: 'yes' };
    for (const name of ['answer_question', 'answerQuestion']) {
      const r = await raw(mcp, { body: rpc('tools/call', { name, arguments: args }) });
      expect(JSON.parse(r.body).error.code).toBe(-32602);
    }
    for (const method of ['answerQuestion', 'answer_question']) {
      expect(JSON.parse((await raw(mcp, { body: rpc(method, args) })).body).error.code).toBe(
        -32601,
      );
    }
    await bridge.pump();
    expect(relay.answers).toEqual([]);
    expect(
      (await bridge.ctx.store.dueOutbox(Number.MAX_SAFE_INTEGER, 100)).filter(
        (o) => o.kind === 'owner-answer',
      ),
    ).toEqual([]);
  });
  it("a pane's bearer token cannot read or set the whole involvement preference, as a tool or as a method", async () => {
    const { mcp, relay, bridge } = await boot();
    await bridge.start({ socket: false });
    const args = { expectedRevision: 0, normalMode: 'recommend', consultCount: 3, override: null };
    for (const name of [
      'set_involvement',
      'set_involvement_preference',
      'setInvolvementPreference',
      'get_involvement_preference',
    ]) {
      const r = await raw(mcp, { body: rpc('tools/call', { name, arguments: args }) });
      expect(JSON.parse(r.body).error.code).toBe(-32602);
    }
    for (const method of ['setInvolvementPreference', 'getInvolvementPreference']) {
      expect(JSON.parse((await raw(mcp, { body: rpc(method, args) })).body).error.code).toBe(
        -32601,
      );
    }
    // A host's forwarder forwards only these, so neither reaches the bridge through a pane.
    expect([...MCP_BRIDGE_METHODS]).not.toContain('setInvolvementPreference');
    expect([...MCP_BRIDGE_METHODS]).not.toContain('getInvolvementPreference');
    expect(relay.calls.filter((c) => c.method === 'PUT')).toEqual([]);
    await bridge.stop();
  });
  it("a pane's bearer token cannot reach declineQuestion, as a tool or as a method", async () => {
    const { mcp, relay, bridge } = await boot();
    relay.features = ['thread-messages-v1', 'owner-desktop-declines-v1'];
    const asked = await call(mcp, 'ask_human', { question: 'Ship it?' });
    const questionId = asked.structuredContent.question_id as string;
    const args = { questionId, question_id: questionId, expectedRevision: 0 };
    for (const name of ['decline_question', 'declineQuestion']) {
      const r = await raw(mcp, { body: rpc('tools/call', { name, arguments: args }) });
      expect(JSON.parse(r.body).error.code).toBe(-32602);
    }
    for (const method of ['declineQuestion', 'decline_question', 'getDeclineResult']) {
      expect(JSON.parse((await raw(mcp, { body: rpc(method, args) })).body).error.code).toBe(
        -32601,
      );
    }
    await bridge.pump();
    expect(relay.declines).toEqual([]);
    expect(
      (await bridge.ctx.store.dueOutbox(Number.MAX_SAFE_INTEGER, 100)).filter(
        (o) => o.kind === 'owner-decline',
      ),
    ).toEqual([]);
  });
  it("a pane's bearer token cannot ask for an agent-stopped push, as a tool or as a method", async () => {
    const { mcp, relay, bridge } = await boot();
    relay.features = ['thread-messages-v1', 'agent-stopped-push-v1'];
    await bridge.start({ socket: false });
    const asked = vi.spyOn(bridge, 'requestAgentStoppedPush');
    const names = [
      'request_agent_stopped_push',
      'requestAgentStoppedPush',
      'agent_stopped',
      'agent_stopped_push',
    ];
    for (const name of names) {
      const r = await raw(mcp, { body: rpc('tools/call', { name, arguments: {} }) });
      expect(JSON.parse(r.body).error.code).toBe(-32602);
    }
    for (const method of names) {
      expect(JSON.parse((await raw(mcp, { body: rpc(method, {}) })).body).error.code).toBe(-32601);
    }
    expect(asked).not.toHaveBeenCalled();
    // A host's forwarder forwards only these, so it never reaches the bridge through a pane.
    expect([...MCP_BRIDGE_METHODS]).not.toContain('requestAgentStoppedPush');
    expect(relay.calls.filter((c) => c.path === '/api/v1/push/agent-stopped')).toEqual([]);
    await bridge.stop();
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
  it('get_decision says plainly when the person declined, and reports no answer', async () => {
    const { mcp, bridge, relay, phone } = await boot();
    const ask = await call(mcp, 'ask_human', { question: 'Ship it?' });
    const id = ask.structuredContent.question_id as string;
    await bridge.pump();
    await relay.plainActionEvent({ questionId: id, signer: phone, action: 'cancel' });
    await bridge.catchUp();
    const r = await call(mcp, 'get_decision', { question_id: id });
    expect(r.structuredContent).toMatchObject({
      status: 'cancelled',
      closed_reason: 'declined',
      provenance: null,
      choice: null,
      text: '',
    });
    expect(r.content[0].text).toContain('the person chose not to answer');
    expect(r.content[0].text).toContain('Nothing was approved');
  });
  it('get_decision reports the revision and deadline each signed reopen set, down to none at all', async () => {
    const { mcp, bridge, relay, identity } = await boot();
    const tools = JSON.parse((await raw(mcp, { body: rpc('tools/list') })).body).result.tools as {
      name: string;
      outputSchema: { properties: Record<string, { type: unknown }> };
    }[];
    const schema = tools.find((t) => t.name === 'get_decision')!.outputSchema.properties;
    expect(schema.revision!.type).toBe('integer');
    expect(schema.expires_at!.type).toEqual(['string', 'null']);
    const owner = { deviceId: identity.config.deviceId, keys: identity.keys };
    const ask = await call(mcp, 'ask_human', { question: 'Ship it?' });
    const id = ask.structuredContent.question_id as string;
    await bridge.pump();
    const first = (await call(mcp, 'get_decision', { question_id: id })).structuredContent;
    expect(first).toMatchObject({ status: 'open', revision: 0 });
    const later = new Date(Date.parse(first.expires_at as string) + 86_400_000).toISOString();
    for (const [round, expiresAt] of [
      [1, later],
      [2, null],
    ] as const) {
      await relay.plainActionEvent({
        questionId: id,
        signer: owner,
        action: 'cancel',
        expectedRevision: round - 1,
      });
      await relay.plainActionEvent({
        questionId: id,
        signer: owner,
        action: 'reopen',
        expectedRevision: round - 1,
        expiresAt,
      });
      await bridge.catchUp();
      expect(
        (await call(mcp, 'get_decision', { question_id: id })).structuredContent,
      ).toMatchObject({ status: 'open', revision: round, expires_at: expiresAt });
    }
  });
  it("get_decision reports the owner desktop's answer as the person's, made on their computer", async () => {
    const { mcp, bridge, relay, phone, identity } = await boot();
    const owner = { deviceId: identity.config.deviceId, keys: identity.keys };
    const ids: string[] = [];
    for (const signer of [owner, phone]) {
      const ask = await call(mcp, 'ask_human', {
        question: 'Ship it?',
        options: [{ id: 'approve', label: 'Approve' }],
      });
      ids.push(ask.structuredContent.question_id as string);
      await bridge.pump();
      await relay.answerEvent({
        questionId: ids.at(-1)!,
        phone: signer,
        options: ['approve'],
        ...(signer === owner ? { provenance: 'human-desktop' as const } : {}),
      });
    }
    await bridge.catchUp();
    const computer = await call(mcp, 'get_decision', { question_id: ids[0] });
    expect(computer.structuredContent).toMatchObject({
      status: 'human-answered',
      provenance: 'human',
      answered_on: 'computer',
      choice: 'approve',
      answers: [{ source: 'human', answered_on: 'computer' }],
      thread: [{ kind: 'answer', source: 'human', answered_on: 'computer' }],
    });
    expect(computer.content[0].text).toContain('Answer (human, made on their computer): approve');
    const fromPhone = await call(mcp, 'get_decision', { question_id: ids[1] });
    expect(fromPhone.structuredContent).toMatchObject({
      provenance: 'human',
      answered_on: 'phone',
      answers: [{ source: 'human', answered_on: 'phone' }],
    });
    expect(fromPhone.content[0].text).toContain('Answer (human): approve');
  });
  it('get_decision says where the person sent each follow-up from, and lists the agent’s own as neither', async () => {
    const { mcp, bridge, relay, phone, identity } = await boot({ bridge: { followUps: true } });
    relay.postMessageEvents = true;
    const ask = await call(mcp, 'ask_human', { question: 'Ship it?' });
    const id = ask.structuredContent.question_id as string;
    await bridge.pump();
    const owner = { deviceId: identity.config.deviceId, keys: identity.keys };
    await relay.messageEvent({ questionId: id, signer: owner, text: 'From the computer' });
    await relay.messageEvent({ questionId: id, signer: phone, text: 'From the phone' });
    await call(mcp, 'send_followup', { question_id: id, text: 'Thanks', expects_reply: false });
    await bridge.pump();
    await bridge.catchUp();
    const r = await call(mcp, 'get_decision', { question_id: id });
    expect(
      (r.structuredContent.thread as { side: string; sent_from: unknown; text: string }[]).map(
        (t) => [t.side, t.sent_from, t.text],
      ),
    ).toEqual([
      ['human', 'computer', 'From the computer'],
      ['human', 'phone', 'From the phone'],
      ['agent', null, 'Thanks'],
    ]);
    // The advertised schema allows exactly those values.
    const list = JSON.parse((await raw(mcp, { body: rpc('tools/list') })).body);
    const tool = list.result.tools.find((t: { name: string }) => t.name === 'get_decision');
    expect(tool.outputSchema.properties.thread.items.properties.sent_from).toEqual({
      type: ['string', 'null'],
      enum: ['phone', 'computer', null],
    });
  });
});

describe('HTTP MCP: get_involvement', () => {
  const read = async (mcp: RunningMcp) => call(mcp, 'get_involvement', {});

  it('says when no preference is available, and what to do then', async () => {
    const { mcp } = await boot();
    const res = await read(mcp);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({
      status: 'unavailable',
      mode: null,
      normal_mode: null,
      consult_count: null,
      revision: null,
      override_active: false,
      until: null,
      set_at: null,
      last_synced_at: null,
      stale: true,
      reason: 'not-synced',
    });
    expect(res.content[0].text).toMatch(/not-synced.*Use your normal configured behaviour/);
  });

  it('returns the latest preference within one session, and the end of a temporary mode', async () => {
    const clock = { t: Date.parse('2026-11-17T09:00:00.000Z') };
    const { mcp, bridge, relay, phone, identity } = await boot({ bridge: { now: () => clock.t } });
    const until = new Date(clock.t + 3_600_000).toISOString();
    const sign = (revision: number, normal: 'recommend' | 'involve-early') =>
      buildSignedInvolvement({
        installationId: identity.config.installationId,
        signerDeviceId: phone.deviceId,
        signingKey: phone.keys.signing.privateKey,
        revision,
        normalMode: normal,
        consultCount: 3,
        override: revision === 1 ? { mode: 'involve-early', until } : null,
      });
    relay.involvement = { preference: await sign(1, 'recommend'), received_at: null };
    await bridge.start({ socket: false });
    await bridge.involvement.refresh();
    const first = await read(mcp);
    expect(first.structuredContent).toMatchObject({
      status: 'available',
      mode: 'involve-early',
      normal_mode: 'recommend',
      consult_count: 3,
      revision: 1,
      override_active: true,
      until,
      stale: false,
      reason: null,
    });
    expect(first.content[0].text).toMatch(/involve the person early/);
    expect(first.content[0].text).toMatch(/temporary until .*; then it returns to recommend/);

    // The temporary mode ends: same revision, the normal mode, nothing asked of the relay.
    const reads = relay.calls.length;
    clock.t += 3_600_000;
    const ended = await read(mcp);
    expect(ended.structuredContent).toMatchObject({
      mode: 'recommend',
      revision: 1,
      override_active: false,
      until: null,
    });
    expect(ended.content[0].text).toMatch(/consult 3 other agents first/);
    expect(relay.calls.length).toBe(reads);

    // The person changes it while the session goes on.
    relay.involvement = { preference: await sign(2, 'involve-early'), received_at: null };
    await bridge.involvement.refresh();
    expect((await read(mcp)).structuredContent).toMatchObject({
      mode: 'involve-early',
      revision: 2,
    });
    await bridge.stop();
  });

  it('reads a preference set on the computer exactly as one set on a phone', async () => {
    const clock = { t: Date.parse('2026-11-17T09:00:00.000Z') };
    const { mcp, bridge, relay, phone, identity } = await boot({ bridge: { now: () => clock.t } });
    relay.involvement = {
      preference: await buildSignedInvolvement({
        installationId: identity.config.installationId,
        signerDeviceId: phone.deviceId,
        signingKey: phone.keys.signing.privateKey,
        revision: 1,
        normalMode: 'recommend',
        consultCount: 3,
        override: null,
        createdAt: new Date(clock.t).toISOString(),
      }),
      received_at: null,
    };
    await bridge.start({ socket: false });
    await bridge.involvement.refresh();
    const fromPhone = await read(mcp);
    expect(fromPhone.structuredContent).toMatchObject({ status: 'available', revision: 1 });

    expect(
      await bridge.setInvolvementPreference({
        expectedRevision: 1,
        normalMode: 'recommend',
        consultCount: 3,
        override: null,
      }),
    ).toEqual({ status: 'saved', revision: 2 });
    await bridge.involvement.refresh();
    const fromComputer = await read(mcp);
    expect(fromComputer.structuredContent).toEqual({
      ...fromPhone.structuredContent,
      revision: 2,
    });
    expect(fromComputer.content[0].text).toBe(
      fromPhone.content[0].text.replace('revision 1', 'revision 2'),
    );
    await bridge.stop();
  });

  it('reading it asks nothing of the relay and creates no question', async () => {
    const { mcp, relay, store } = await boot();
    const calls = relay.calls.length;
    for (let i = 0; i < 3; i++) await read(mcp);
    expect(relay.calls.length).toBe(calls);
    expect(await store.listQuestions()).toHaveLength(0);
  });

  it('keeps the pane credential and host checks of every other tool', async () => {
    const { mcp } = await boot();
    const anon = await raw(mcp, {
      body: rpc('tools/call', { name: 'get_involvement', arguments: {} }),
      auth: null,
    });
    expect(anon.status).toBe(401);
  });

  it('the result text says when the copy may be out of date', () => {
    const base = {
      status: 'available' as const,
      mode: 'recommend' as const,
      normalMode: 'recommend' as const,
      consultCount: 1,
      revision: 2,
      overrideActive: false,
      until: null,
      setAt: '2026-11-17T09:00:00.000Z',
      lastSyncedAt: '2026-11-17T09:00:00.000Z',
    };
    expect(involvementText({ ...base, stale: false })).toBe(
      'Involvement (revision 2): bring a recommendation: consult 1 other agent first, try to agree, then ask with the recommendation and its reasoning, or with the disagreement and the alternatives.',
    );
    expect(involvementText({ ...base, stale: true })).toMatch(
      /out of date: last confirmed with the relay at 2026-11-17T09:00:00.000Z\.$/,
    );
  });

  it('the instructions say to read it before preparing and again before asking, and that it grants nothing', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(
      /call get_involvement .* and call it again just before ask_human/,
    );
    expect(SERVER_INSTRUCTIONS).toMatch(/temporary setting ends without a new revision/);
    expect(SERVER_INSTRUCTIONS).toMatch(/outcome not-run when you could not consult/);
    expect(SERVER_INSTRUCTIONS).toMatch(/unavailable or stale, use your normal behaviour/);
    expect(SERVER_INSTRUCTIONS).toMatch(/still goes to them without delay/);
    expect(SERVER_INSTRUCTIONS).toMatch(/recommendation, not an answer/);
  });
});

describe('HTTP MCP: the preparation report', () => {
  it('travels encrypted with the question and changes nothing about who must answer', async () => {
    const { mcp, bridge, relay } = await boot();
    const preparation = {
      preference_revision: 3,
      agents_consulted: 3,
      outcome: 'agreed',
      summary: 'All three prefer the smaller migration.',
    };
    const res = await call(mcp, 'ask_human', {
      question: 'Which migration?',
      options: [
        { id: 'small', label: 'Small' },
        { id: 'big', label: 'Big' },
      ],
      requested_requirement: 'proxy-ok',
      preparation,
    });
    expect(res.isError).toBeUndefined();
    // An agreed recommendation is not an answer: with no trusted allowance it stays human-required.
    expect(res.structuredContent.enforced_requirement).toBe('human-required');
    await tick();
    await bridge.pump();
    const id = res.structuredContent.question_id as string;
    const signed = relay.questions.get(id)!.signed;
    expect(signed.record.requirement).toBe('human-required');
    expect(JSON.stringify(signed.record)).not.toContain('preparation');
    expect(
      ((await relay.decryptQuestion(id)) as unknown as { preparation: unknown }).preparation,
    ).toEqual(preparation);
    await expect(bridge.runProxy(id)).rejects.toThrow(/human-required/);
  });

  it('is optional, and a question without one is published as before', async () => {
    const { mcp, bridge, relay } = await boot();
    const res = await call(mcp, 'ask_human', { question: 'Plain?' });
    await tick();
    await bridge.pump();
    const content = await relay.decryptQuestion(res.structuredContent.question_id);
    expect('preparation' in content).toBe(false);
  });

  it('a malformed report is refused at once, so the agent can fix it', async () => {
    const { mcp, store } = await boot();
    const res = await call(mcp, 'ask_human', {
      question: 'q',
      preparation: { agents_consulted: 2, outcome: 'unanimous' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/validation_error: preparation\.outcome/);
    expect(await store.listQuestions()).toHaveLength(0);
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

  it('returns before the relay has seen the message', async () => {
    const { mcp, bridge, relay } = await boot();
    const id = await ask(mcp);
    await settle(bridge);
    let release!: () => void;
    relay.holdMessages = new Promise<void>((r) => (release = r));
    const res = await call(mcp, 'send_followup', {
      question_id: id,
      text: 'Quick one.',
      expects_reply: true,
    });
    expect(res.structuredContent.status).toBe('queued');
    expect(relay.messages).toHaveLength(0);
    release();
    relay.holdMessages = null;
    await settle(bridge);
    expect(relay.messages).toHaveLength(1);
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
    const desc: string = TOOLS.find((t) => t.name === 'send_followup')!.description;
    expect(desc).toMatch(/even after answering/);
    expect(desc).toMatch(/reconsidered decision arrives as a follow-up, not a changed answer/);
    expect(desc).toMatch(/Replies.*arrive here marked as follow-ups/);
    expect(desc).toMatch(/instead of a new question/);
    for (const flag of [true, false]) {
      const t = followupInstruction(3, flag);
      expect(t).toMatch(/marked (as )?follow-ups?/);
      expect(t).toMatch(/do(es)? not change the answer/);
    }
    expect(desc).toMatch(/clarify it, reply to a follow-up, or ask one/);
    expect(desc).toMatch(/Returns at once/);
    expect(desc).toMatch(/A human answer is final/);
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
              return (b[m] as unknown as (...x: unknown[]) => unknown).apply(b, a);
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
    expect((await call(mcp, 'get_involvement', {})).isError).toBeUndefined();
    expect(new Set(forwarded)).toEqual(new Set(MCP_BRIDGE_METHODS));
    await settle(bridge);
    expect(relay.messages).toHaveLength(1);
  });

  it('get_decision returns the thread: the agent’s follow-ups and the person’s, with delivery, the answer unchanged', async () => {
    const { mcp, bridge, relay, phone, sink } = await boot({ bridge: { followUps: true } });
    relay.postMessageEvents = true;
    const id = await ask(mcp);
    await settle(bridge);
    const early = await relay.messageEvent({ questionId: id, signer: phone, text: 'One sec.' });
    await bridge.catchUp();
    await relay.answerEvent({ questionId: id, phone, options: [], text: 'Dark red.' });
    await bridge.catchUp();
    const answered = (await call(mcp, 'get_decision', { question_id: id })).structuredContent;
    await call(mcp, 'send_followup', {
      question_id: id,
      text: 'The burgundy or the maroon?',
      expects_reply: true,
    });
    await settle(bridge);
    await bridge.catchUp();
    const reply = await relay.messageEvent({ questionId: id, signer: phone, text: 'Maroon.' });
    await bridge.catchUp();
    // Both of the person's follow-ups and the answer, in thread order; never the agent's own message.
    expect(sink.typed).toHaveLength(3);
    const idOf = (ev: { data: unknown }) =>
      (ev.data as { record: { message_id: string } }).record.message_id;

    const d = await call(mcp, 'get_decision', { question_id: id });
    const { thread, ...decision } = d.structuredContent;
    const { thread: _was, ...was } = answered;
    void _was;
    expect(decision).toEqual(was);
    expect(d.content[0].text).toContain(
      '3 follow-up messages in the thread; none changes the answer.',
    );
    expect(thread).toEqual([
      expect.objectContaining({
        kind: 'message',
        side: 'human',
        message_id: idOf(early),
        message_seq: 1,
        text: 'One sec.',
        delivery: expect.objectContaining({ injection_id: sink.typed[0]!.id }),
      }),
      expect.objectContaining({ kind: 'answer', revision: 1, source: 'human', text: 'Dark red.' }),
      expect.objectContaining({
        kind: 'message',
        side: 'agent',
        message_seq: 2,
        expects_reply: true,
        text: 'The burgundy or the maroon?',
        images: [],
        delivery: null,
      }),
      expect.objectContaining({
        kind: 'message',
        side: 'human',
        message_id: idOf(reply),
        message_seq: 3,
        expects_reply: false,
        text: 'Maroon.',
        delivery: expect.objectContaining({
          status: 'terminal-delivered',
          injection_id: sink.typed[2]!.id,
          error_code: null,
        }),
      }),
    ]);
    // Another pane still sees nothing of it.
    expect((await call(mcp, 'get_decision', { question_id: id }, OTHER)).isError).toBe(true);
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
