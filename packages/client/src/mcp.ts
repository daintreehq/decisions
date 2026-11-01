import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BridgeError } from './content.js';
import type { DecisionsBridge } from './bridge.js';
import type { QuestionOrigin } from './types.js';

const SERVER_VERSION = '0.1.0';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * Resolves the per-pane bearer to the pane it was minted for. The origin comes from the host's own
 * registry, never from anything the agent sends.
 */
export interface PaneAuthenticator {
  authenticate(
    token: string,
  ): Promise<{ origin: QuestionOrigin } | null> | { origin: QuestionOrigin } | null;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Token → origin map with constant-time lookup. Daintree uses its own authenticator over its pane bearer. */
export class TokenMapAuthenticator implements PaneAuthenticator {
  private entries: { d: Buffer; origin: QuestionOrigin }[] = [];
  register(token: string, origin: QuestionOrigin): void {
    this.entries.push({ d: digest(token), origin });
  }
  revoke(token: string): void {
    const d = digest(token);
    this.entries = this.entries.filter((e) => !timingSafeEqual(e.d, d));
  }
  authenticate(token: string) {
    const d = digest(token);
    let found: QuestionOrigin | null = null;
    for (const e of this.entries) if (timingSafeEqual(e.d, d)) found = e.origin; // no early exit
    return found ? { origin: found } : null;
  }
}

/** Tool definitions. Descriptions stay under 400 bytes (Daintree's CI budget for tool lists). */
export const TOOLS = [
  {
    name: 'ask_human',
    description:
      'Ask the human owner a question you must not decide yourself (product choice, ambiguous requirement, approval of a design). Returns immediately: end your turn after calling. The answer is typed into this terminal later.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: {
          type: 'string',
          minLength: 1,
          maxLength: 8000,
          description: 'The question, self-contained.',
        },
        context: {
          type: 'string',
          maxLength: 32768,
          description: 'Background the human needs to decide.',
        },
        kind: { type: 'string', enum: ['choice', 'approval', 'text', 'mixed'] },
        options: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label'],
            properties: {
              id: { type: 'string', maxLength: 64 },
              label: { type: 'string', maxLength: 240 },
              description: { type: 'string', maxLength: 1000 },
            },
          },
        },
        attachments: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['local_resource_id'],
            properties: {
              local_resource_id: {
                type: 'string',
                description: 'Id of an image Daintree has registered for you.',
              },
              role: { type: 'string', enum: ['before', 'after', 'reference', 'other'] },
              alt: { type: 'string', maxLength: 500 },
            },
          },
        },
        requested_requirement: {
          type: 'string',
          enum: ['human-required', 'proxy-ok', 'proxy-first'],
          description: 'Can only make the question stricter; the workflow decides the final level.',
        },
        workflow_gate_id: { type: 'string' },
        expires_at: { type: 'string', description: 'ISO time; bounded by workflow policy.' },
        correlation_id: {
          type: 'string',
          maxLength: 64,
          description: 'Repeat calls with the same id return the same question.',
        },
      },
    },
  },
  {
    name: 'get_decision',
    description:
      'Check the status and answer of a question you asked with ask_human, by question_id. Only works for questions asked from this terminal.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question_id'],
      properties: { question_id: { type: 'string' } },
    },
  },
  {
    name: 'cancel_question',
    description:
      'Cancel a question you asked with ask_human that is no longer needed. It cannot undo a question the human already answered.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question_id'],
      properties: { question_id: { type: 'string' }, reason: { type: 'string', maxLength: 500 } },
    },
  },
] as const;

export interface McpHandlerOptions {
  /** Exact `Host` header values accepted. Defaults to the loopback names on `port`. */
  allowedHosts?: () => string[];
  maxBodyBytes?: number;
  /** Requests per minute per pane. */
  rateLimitPerMinute?: number;
  now?: () => number;
}

type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const rpcErr = (id: Rpc['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});
const rpcOk = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !/^Bearer\s+\S+$/i.test(h)) return null;
  return h.replace(/^Bearer\s+/i, '');
}

export function createDecisionsMcpHandler(
  bridge: DecisionsBridge,
  authenticator: PaneAuthenticator,
  opts: McpHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBody = opts.maxBodyBytes ?? 256 * 1024;
  const limit = opts.rateLimitPerMinute ?? 60;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();

  const limited = (key: string): boolean => {
    const t = now();
    const arr = (hits.get(key) ?? []).filter((x) => t - x < 60_000);
    arr.push(t);
    hits.set(key, arr);
    return arr.length > limit;
  };

  async function callTool(origin: QuestionOrigin, name: string, args: Record<string, unknown>) {
    const pane = { host_id: origin.host_id, pane_id: origin.pane_id };
    const text = (t: string, structured: unknown, isError = false) => ({
      content: [{ type: 'text', text: t }],
      structuredContent: structured,
      ...(isError ? { isError: true } : {}),
    });
    try {
      if (name === 'ask_human') {
        const r = await bridge.registerQuestion({ origin, input: args });
        const instruction = `Asked as q-${r.alias}. End your turn now (or continue with unrelated work); the answer will arrive as a message in this terminal.`;
        return text(instruction, {
          question_id: r.questionId,
          status: r.status,
          enforced_requirement: r.requirement,
          instruction,
        });
      }
      if (name === 'get_decision') {
        if (typeof args.question_id !== 'string')
          throw new BridgeError('validation_error', 'question_id is required');
        const v = await bridge.getDecision(args.question_id, pane);
        const last = v.answers.at(-1);
        const summary = last
          ? `q-${v.alias} is ${v.status}. Latest answer (${last.source}): ${last.choices.join(', ') || '(no choice)'}${last.text ? ` — ${last.text.slice(0, 500)}` : ''}`
          : `q-${v.alias} is ${v.status}; no answer yet.`;
        return text(summary, v);
      }
      if (name === 'cancel_question') {
        if (typeof args.question_id !== 'string')
          throw new BridgeError('validation_error', 'question_id is required');
        await bridge.cancelQuestion(args.question_id, pane);
        return text('Cancellation requested.', {
          question_id: args.question_id,
          status: 'cancelling',
        });
      }
    } catch (e) {
      if (e instanceof BridgeError) return text(`${e.code}: ${e.message}`, { error: e.code }, true);
      return text(
        'internal_error: the Decisions bridge failed; try again later.',
        { error: 'internal_error' },
        true,
      );
    }
    return null;
  }

  async function handleOne(origin: QuestionOrigin, m: Rpc): Promise<unknown | null> {
    const isNotification = m.id === undefined;
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string')
      return rpcErr(m.id, -32600, 'Invalid Request');
    switch (m.method) {
      case 'initialize': {
        const asked = typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '';
        return rpcOk(m.id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'daintree-decisions', version: SERVER_VERSION },
          instructions:
            'Use ask_human for decisions that belong to the human, then end your turn; the answer arrives in this terminal.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return isNotification ? null : rpcOk(m.id, {});
      case 'tools/list':
        return rpcOk(m.id, { tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name))
          return rpcErr(m.id, -32602, 'Unknown tool');
        if (typeof args !== 'object' || Array.isArray(args))
          return rpcErr(m.id, -32602, 'arguments must be an object');
        return rpcOk(m.id, await callTool(origin, name, args));
      }
      default:
        return isNotification ? null : rpcErr(m.id, -32601, 'Method not found');
    }
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/mcp') return send(res, 404, { error: 'not_found' });

      // 1. DNS-rebinding / browser defences first: exact Host, and no Origin at all.
      const host = (req.headers.host ?? '').toLowerCase();
      const allowed = (opts.allowedHosts?.() ?? []).map((h) => h.toLowerCase());
      if (allowed.length === 0 || !allowed.includes(host))
        return send(res, 403, { error: 'forbidden_host' });
      if (req.headers.origin !== undefined) return send(res, 403, { error: 'forbidden_origin' });

      if (req.method !== 'POST')
        return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });

      // 2. Pane credential.
      const token = bearer(req);
      const auth = token ? await authenticator.authenticate(token) : null;
      if (!auth)
        return send(
          res,
          401,
          { error: 'unauthorized' },
          { 'www-authenticate': 'Bearer realm="daintree-decisions"' },
        );
      const paneKey = `${auth.origin.host_id}\u0000${auth.origin.pane_id}`;
      if (limited(paneKey))
        return send(res, 429, { error: 'rate_limited' }, { 'retry-after': '30' });

      const ct = (req.headers['content-type'] ?? '').toLowerCase();
      if (!ct.startsWith('application/json'))
        return send(res, 415, { error: 'unsupported_media_type' });
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > maxBody) return send(res, 413, { error: 'payload_too_large' });
      const body = await readBody(req, maxBody);
      if (body === null) return send(res, 413, { error: 'payload_too_large' });

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(res, 400, rpcErr(null, -32700, 'Parse error'));
      }
      const batch = Array.isArray(parsed);
      const msgs = (batch ? parsed : [parsed]) as Rpc[];
      if (batch && msgs.length === 0)
        return send(res, 400, rpcErr(null, -32600, 'Invalid Request'));
      if (msgs.length > 20) return send(res, 400, rpcErr(null, -32600, 'Batch too large'));
      const out: unknown[] = [];
      for (const m of msgs) {
        if (typeof m !== 'object' || m === null) {
          out.push(rpcErr(null, -32600, 'Invalid Request'));
          continue;
        }
        const r = await handleOne(auth.origin, m);
        if (r !== null) out.push(r);
      }
      if (out.length === 0) return send(res, 202);
      return send(res, 200, batch ? out : out[0]);
    } catch {
      if (!res.headersSent) send(res, 500, rpcErr(null, -32603, 'Internal error'));
    }
  };
}

export interface StartMcpOptions extends McpHandlerOptions {
  bridge: DecisionsBridge;
  authenticator: PaneAuthenticator;
  port?: number;
}

export interface RunningMcp {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

/** Own listener on 127.0.0.1 only. */
export async function startDecisionsMcpServer(o: StartMcpOptions): Promise<RunningMcp> {
  let port = 0;
  const handler = createDecisionsMcpHandler(o.bridge, o.authenticator, {
    ...o,
    allowedHosts: o.allowedHosts ?? (() => [`127.0.0.1:${port}`, `localhost:${port}`]),
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    server,
    close: () =>
      new Promise((resolve) => (server.closeAllConnections?.(), server.close(() => resolve()))),
  };
}
