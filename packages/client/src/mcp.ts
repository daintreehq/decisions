import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BridgeError } from './content.js';
import { paneIdentityOf, type DecisionView, type DecisionsBridge } from './bridge.js';
import type { QuestionOrigin } from './types.js';

const SERVER_VERSION = '0.6.0';
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

/** The `get_decision` structured result: the decision fields first, in the MCP surface's snake_case. */
function decisionResult(v: DecisionView) {
  return {
    question_id: v.questionId,
    alias: v.alias,
    status: v.status,
    requirement: v.requirement,
    workflow_gate_id: v.workflowGateId,
    provenance: v.provenance,
    choice: v.choice,
    text: v.text,
    reviewed_digests_match: v.reviewedDigestsMatch,
    delivery_status: v.deliveryStatus,
    revision: v.revision,
    expires_at: v.expiresAt,
    answers: v.answers.map((a) => ({
      revision: a.revision,
      source: a.source,
      choices: a.choices,
      text: a.text,
      correction: a.correction,
      reason: a.reason,
      delivered: a.delivered,
      created_at: a.createdAt,
    })),
    thread: v.thread.map((t) =>
      t.kind === 'answer'
        ? {
            kind: t.kind,
            revision: t.revision,
            source: t.source,
            choices: t.choices,
            text: t.text,
            correction: t.correction,
            delivered: t.delivered,
            created_at: t.createdAt,
          }
        : {
            kind: t.kind,
            message_id: t.messageId,
            message_seq: t.messageSeq,
            side: t.side,
            expects_reply: t.expectsReply,
            text: t.text,
            images: t.images.map((i) => ({
              attachment_id: i.attachmentId,
              ...(i.alt ? { alt: i.alt } : {}),
              ...(i.path ? { path: i.path } : {}),
            })),
            created_at: t.createdAt,
            ...(t.unreadable ? { unreadable: true } : {}),
            delivery: t.delivery
              ? {
                  status: t.delivery.status,
                  received_at: t.delivery.receivedAt,
                  terminal_delivered_at: t.delivery.terminalDeliveredAt,
                  injection_id: t.delivery.injectionId,
                  error_code: t.delivery.errorCode,
                }
              : null,
          },
    ),
  };
}

/**
 * The `DecisionsBridge` operations the handler calls. A host that forwards them across a process boundary
 * (instead of passing a bridge) forwards exactly these, with the pane identity and any `BridgeError` intact.
 */
export const MCP_BRIDGE_METHODS = [
  'registerQuestion',
  'getDecision',
  'cancelQuestion',
  'postMessage',
] as const satisfies readonly (keyof DecisionsBridge)[];

/** What `createDecisionsMcpHandler` needs from a bridge: a `DecisionsBridge`, or a host's forwarder. */
export type DecisionsMcpBridge = Pick<DecisionsBridge, (typeof MCP_BRIDGE_METHODS)[number]>;

/** What agents are told when they connect: questions return at once, and each one is a conversation. */
export const SERVER_INSTRUCTIONS =
  'Use ask_human for decisions that belong to the human. It does not wait: carry on with work that does not depend on the answer, and end your turn when you cannot go further without it. The answer arrives as a new message in this terminal. A human answer is final, but the conversation goes on: the person may send follow-up messages, also after answering, which arrive in this terminal marked as follow-ups and never change the answer, so a reconsidered decision arrives as a follow-up. To clarify a question, reply to a follow-up or ask one of your own, use send_followup on the same question instead of asking a new one; a reply arrives the same way.';

/** The `ask_human` result text. */
export const askedInstruction = (alias: number) =>
  `Asked as q-${alias}. Carry on with anything that does not depend on the answer; once you cannot go further without it, end your turn. The answer arrives as a new message in this terminal, with your question quoted. The answer is final: the person may still send follow-ups, even after answering, which arrive here marked as follow-ups without changing it, so a reconsidered decision arrives as a follow-up. To clarify, reply or ask a follow-up, call send_followup with this question_id instead of asking a new question; replies arrive the same way.`;

/** The `send_followup` result text. */
export const followupInstruction = (alias: number, expectsReply: boolean) =>
  expectsReply
    ? `Queued in q-${alias}'s thread and sent in the background. Carry on with anything that does not depend on the reply; once you cannot go further without it, end your turn. The reply arrives in this terminal as a marked follow-up, and it does not change the answer.`
    : `Queued in q-${alias}'s thread and sent in the background. The person's follow-ups arrive in this terminal marked as follow-ups, and they do not change the answer.`;

/** Tool definitions. Descriptions stay under 400 bytes (Daintree's CI budget for tool lists). */
export const TOOLS = [
  {
    name: 'ask_human',
    description:
      'Ask the human owner a question you must not decide yourself (product choice, ambiguous requirement, approval of a design). Returns at once, never waiting: keep doing work that does not depend on the answer, and end your turn when you cannot go on without it. The answer is typed into this terminal later as a new message quoting your question.',
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
        kind: {
          type: 'string',
          enum: ['choice', 'approval', 'text', 'mixed'],
          description:
            'choice: pick one option. approval: yes/no, offered as Approve and Reject unless you give options. text: an open answer. mixed (the default with options): pick one option or write an answer instead. A note can go with any of them.',
        },
        options: {
          type: 'array',
          maxItems: 12,
          description: 'The answers to choose from; the human picks exactly one.',
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
        workflow_gate_id: {
          type: 'string',
          description:
            'A workflow gate the host registered (e.g. design-review/final). Its choices replace options; it may refuse free text and require attachments.',
        },
        expires_at: {
          type: 'string',
          description: 'ISO time; bounded by host and workflow policy. Omit for the host default.',
        },
        correlation_id: {
          type: 'string',
          maxLength: 64,
          description: 'Repeat calls with the same id return the same question.',
        },
      },
    },
    // Only adds a question to the owner's own inbox. Clients that gate tool calls on these hints
    // (Codex asks for approval of anything not read-only unless it is non-destructive and closed-world)
    // would otherwise make the agent wait in the terminal for permission to ask the human.
    annotations: {
      title: 'Ask the human',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'get_decision',
    description:
      'Check a question you asked with ask_human from this terminal, by question_id. Returns status, provenance, choice, text, reviewed_digests_match (true only if the human reviewed exactly the attached images) and the thread with follow-ups. Only status human-answered with provenance human is a human decision; a follow-up never is; expired never authorises anything.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question_id'],
      properties: { question_id: { type: 'string' } },
    },
    outputSchema: {
      type: 'object',
      properties: {
        question_id: { type: 'string' },
        status: {
          type: 'string',
          enum: [
            'queued',
            'open',
            'proxy-answered',
            'human-answered',
            'cancelled',
            'expired',
            'publish-failed',
          ],
        },
        requirement: { type: 'string', enum: ['human-required', 'proxy-ok', 'proxy-first'] },
        workflow_gate_id: { type: ['string', 'null'] },
        provenance: { type: ['string', 'null'], enum: ['human', 'proxy', null] },
        choice: { type: ['string', 'null'] },
        text: { type: 'string' },
        reviewed_digests_match: { type: 'boolean' },
        expires_at: { type: ['string', 'null'] },
        thread: {
          type: 'array',
          description:
            'Answers and follow-up messages in order. side agent: yours; side human: the person, with delivery. A message never changes the answer.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['answer', 'message'] },
              revision: { type: 'integer' },
              source: { type: 'string', enum: ['human', 'proxy', 'system'] },
              choices: { type: 'array', items: { type: 'string' } },
              message_id: { type: 'string' },
              message_seq: { type: 'integer' },
              side: { type: 'string', enum: ['agent', 'human'] },
              expects_reply: { type: 'boolean' },
              text: { type: 'string' },
              images: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    attachment_id: { type: 'string' },
                    alt: { type: 'string' },
                    path: { type: 'string' },
                  },
                },
              },
              created_at: { type: 'string' },
              delivery: {
                type: ['object', 'null'],
                properties: {
                  status: {
                    type: 'string',
                    enum: [
                      'received',
                      'terminal-delivered',
                      'needs-attention',
                      'delivery-uncertain',
                    ],
                  },
                  received_at: { type: 'string' },
                  terminal_delivered_at: { type: ['string', 'null'] },
                  injection_id: { type: ['string', 'null'] },
                  error_code: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
        error: { type: 'string' },
      },
    },
    annotations: { title: 'Check a decision', readOnlyHint: true, openWorldHint: false },
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
    // Withdraws a question for good, so clients that confirm destructive calls still confirm this one.
    annotations: {
      title: 'Cancel a question',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'send_followup',
    description:
      'Post in the thread of a question you asked with ask_human from this terminal, instead of a new question: clarify it, reply to a follow-up, or ask one. Returns at once; set expects_reply if you need a reply. Replies, and follow-ups the person sends even after answering, arrive here marked as follow-ups. A human answer is final: a reconsidered decision arrives as a follow-up, not a changed answer.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question_id', 'text', 'expects_reply'],
      properties: {
        question_id: { type: 'string', description: 'The question_id ask_human returned.' },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 16384,
          description: 'The message, self-contained; at most 16 KiB of UTF-8.',
        },
        expects_reply: {
          type: 'boolean',
          description:
            'true when you need the person to reply; false for a note that needs nothing back.',
        },
      },
    },
    // Only adds a message to the owner's own thread, like ask_human, so approval-gating clients run it unprompted.
    annotations: {
      title: 'Send a follow-up',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] as const;

export interface McpHandlerOptions {
  /** Exact `Host` header values accepted. Defaults to the loopback names on `port`. */
  allowedHosts?: () => string[];
  /**
   * The path the MCP endpoint answers on (default `/mcp`). Matched exactly against the request's
   * WHATWG-parsed pathname, ignoring the query string: no subpaths, no trailing slash,
   * case-sensitive, percent-encoding not decoded. Parsing resolves dot segments (`/x/../mcp`,
   * `/%2e/mcp`) first, so those aliases match; every check below still applies to them. Any other
   * path is 404 before any other check. A host that routes a prefix (such as `/mcp/decisions`) to
   * this handler passes the same path here. Must be one or more `/segment`s of unreserved URL
   * characters (`A-Z a-z 0-9 - . _ ~`), with no `.` or `..` segments; anything else throws.
   */
  path?: string;
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

export const DEFAULT_MCP_PATH = '/mcp';

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * Returns `path` if it is a valid MCP mount path, otherwise throws. Validated up front so a typo
 * fails at startup instead of serving 404 to every agent; see `McpHandlerOptions.path`.
 */
export function validateMcpPath(path: string): string {
  const segments = path.split('/');
  const ok =
    segments.length >= 2 &&
    segments[0] === '' &&
    segments.slice(1).every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
  if (!ok)
    throw new TypeError(
      `invalid MCP mount path ${JSON.stringify(path)}: use one or more /segments of letters, digits, '-', '.', '_' or '~', with no trailing slash (for example /mcp or /mcp/decisions)`,
    );
  return path;
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !/^Bearer\s+\S+$/i.test(h)) return null;
  return h.replace(/^Bearer\s+/i, '');
}

export function createDecisionsMcpHandler(
  bridge: DecisionsMcpBridge,
  authenticator: PaneAuthenticator,
  opts: McpHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const mountPath = validateMcpPath(opts.path ?? DEFAULT_MCP_PATH);
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
    const pane = paneIdentityOf(origin);
    const text = (t: string, structured: unknown, isError = false) => ({
      content: [{ type: 'text', text: t }],
      structuredContent: structured,
      ...(isError ? { isError: true } : {}),
    });
    try {
      if (name === 'ask_human') {
        const r = await bridge.registerQuestion({ origin, input: args });
        const instruction = askedInstruction(r.alias);
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
        const summary = v.provenance
          ? `q-${v.alias} is ${v.status}. Answer (${v.provenance}): ${v.choice ?? '(no choice)'}${v.text ? ` — ${v.text.slice(0, 500)}` : ''}. reviewed_digests_match: ${v.reviewedDigestsMatch}.`
          : v.status === 'expired'
            ? `q-${v.alias} expired without an answer; you are not authorised to continue the gated step.`
            : `q-${v.alias} is ${v.status}; no answer in force.`;
        const messages = v.thread.filter((t) => t.kind === 'message').length;
        return text(
          messages > 0
            ? `${summary} ${messages} follow-up message${messages === 1 ? '' : 's'} in the thread; none changes the answer.`
            : summary,
          decisionResult(v),
        );
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
      if (name === 'send_followup') {
        const r = await bridge.postMessage(args, pane);
        const instruction = followupInstruction(r.alias, r.expectsReply);
        return text(instruction, {
          question_id: r.questionId,
          message_id: r.messageId,
          status: r.status,
          expects_reply: r.expectsReply,
          instruction,
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
          instructions: SERVER_INSTRUCTIONS,
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
      if (url.pathname !== mountPath) return send(res, 404, { error: 'not_found' });

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
  bridge: DecisionsMcpBridge;
  authenticator: PaneAuthenticator;
  port?: number;
}

export interface RunningMcp {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

/** Own listener on 127.0.0.1 only, serving the handler at `o.path` (default `/mcp`). */
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
    url: `http://127.0.0.1:${port}${o.path ?? DEFAULT_MCP_PATH}`,
    port,
    server,
    close: () =>
      new Promise((resolve) => (server.closeAllConnections?.(), server.close(() => resolve()))),
  };
}
