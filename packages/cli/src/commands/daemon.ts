import { spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bytesToBase64Url } from '@daintree/decisions-protocol';
import {
  DecisionsBridge,
  FileSpool,
  PolicyRegistry,
  TokenMapAuthenticator,
  startDecisionsMcpServer,
  type AttachmentResolver,
  type InjectResult,
  type LocateResult,
  type QuestionOrigin,
  type RunningMcp,
  type TerminalSink,
  type TerminalTarget,
} from '@daintree/decisions-client';
import {
  CliError,
  openRuntime,
  readSecretFile,
  type Ctx,
  type GlobalOptions,
  type Runtime,
} from '../runtime.js';
import { PaneDirectoryResolver, humanFileResolver, noAttachmentsResolver } from '../resolvers.js';

/** The origin the CLI uses for everything it asks itself; there is only ever one demo "pane". */
export function cliOrigin(name = 'cli'): QuestionOrigin {
  return {
    host_id: 'cli',
    pane_id: name,
    terminal_generation: 1,
    agent_kind: 'cli',
    agent_session_id: null,
    project_id: 'cli',
    worktree_id: 'cli',
    worktree_root: process.cwd(),
    workflow_gate_id: null,
  };
}

export type SinkSpec =
  { kind: 'stdout' } | { kind: 'file'; path: string } | { kind: 'exec'; cmd: string };

export function parseSink(spec: string | undefined): SinkSpec {
  if (!spec || spec === 'stdout') return { kind: 'stdout' };
  if (spec.startsWith('file:') && spec.length > 5) return { kind: 'file', path: spec.slice(5) };
  if (spec.startsWith('exec:') && spec.length > 5) return { kind: 'exec', cmd: spec.slice(5) };
  throw new CliError('--sink must be stdout, file:<path> or exec:<command>');
}

/**
 * Demo sink so the whole loop works without Daintree: prints, appends to a file, or pipes the notice to a
 * command's stdin. Every CLI pane is "alive" and always idle. Daintree replaces this with its wake gate.
 */
export class DemoSink implements TerminalSink {
  constructor(
    private readonly spec: SinkSpec,
    private readonly out: (line: string) => void,
  ) {}
  async locate(o: QuestionOrigin): Promise<LocateResult> {
    if (o.host_id !== 'cli') return { state: 'gone' };
    return {
      state: 'alive',
      target: {
        hostId: o.host_id,
        paneId: o.pane_id,
        terminalGeneration: o.terminal_generation,
        agentSessionId: o.agent_session_id,
        worktreeId: o.worktree_id,
      },
    };
  }
  async isIdle(): Promise<boolean> {
    return true;
  }
  async inject(_t: TerminalTarget, text: string, _injectionId?: string): Promise<InjectResult> {
    try {
      switch (this.spec.kind) {
        case 'stdout':
          this.out('\n' + text + '\n');
          return { ok: true };
        case 'file':
          await appendFile(this.spec.path, text + '\n', { mode: 0o600 });
          return { ok: true };
        case 'exec': {
          const cmd = this.spec.cmd;
          return await new Promise<InjectResult>((resolve) => {
            const p = spawn(cmd, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
            p.on('error', () => resolve({ ok: false, reason: 'exec_failed' }));
            p.on('close', (code) =>
              resolve(code === 0 ? { ok: true } : { ok: false, reason: 'exec_failed' }),
            );
            p.stdin.end(text + '\n');
          });
        }
      }
    } catch {
      return { ok: false, reason: 'write_failed' };
    }
  }
  async hasMarker(_t: TerminalTarget, injectionId: string): Promise<boolean> {
    if (this.spec.kind !== 'file') return false;
    try {
      return (await readFile(this.spec.path, 'utf8')).includes(`injection_id: ${injectionId}`);
    } catch {
      return false;
    }
  }
}

export function buildBridge(
  rt: Runtime,
  sink: TerminalSink,
  extra: { policy?: PolicyRegistry; resolver?: AttachmentResolver } = {},
): DecisionsBridge {
  return new DecisionsBridge({
    identity: rt.identity,
    keyStore: rt.keyStore, // pick up epoch keys rotated by another `decisions` process
    store: rt.store,
    sink,
    client: rt.client,
    // Queued attachment ciphertext must survive a restart, like the SQLite store does.
    spool: new FileSpool(join(rt.ctx.home, 'spool')),
    // Default: no attachments. Callers choose between the human's unrestricted --attach and a pane folder.
    resolver: extra.resolver ?? noAttachmentsResolver,
    auditPath: rt.auditPath,
    policy: extra.policy ?? new PolicyRegistry(),
    ...(rt.ctx.webSocket ? { webSocket: rt.ctx.webSocket } : {}),
    now: rt.ctx.now,
  });
}

/**
 * How to register the MCP with an agent. By default the bearer token is NOT printed (logs get captured):
 * the commands read it from the token file / environment. `show` prints the literal value, once, on request.
 */
export function mcpAddLines(
  url: string,
  token: string,
  o: { show?: boolean; file?: string } = {},
): string[] {
  const file = o.file ?? '~/.decisions/mcp-token';
  const bearer = o.show ? token : `$(cat ${file})`;
  const jsonBearer = o.show ? token : '${DECISIONS_MCP_TOKEN}';
  const lines = [
    'Add it to Claude Code:',
    `  claude mcp add --transport http decisions ${url} --header "Authorization: Bearer ${bearer}"`,
    '',
    'Or put this in a project .mcp.json (Claude Code and other clients that read the common format):',
    JSON.stringify(
      {
        mcpServers: {
          decisions: { type: 'http', url, headers: { Authorization: `Bearer ${jsonBearer}` } },
        },
      },
      null,
      2,
    )
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  ];
  if (!o.show) {
    lines.push(
      '',
      `The bearer token lives in ${file} (mode 0600) and is not printed. Export it for .mcp.json with:`,
      `  export DECISIONS_MCP_TOKEN="$(cat ${file})"`,
      'Pass --show-token to print it once here.',
    );
  }
  lines.push(
    '',
    'Codex, Gemini CLI and other agents: add an HTTP (Streamable HTTP) MCP server named "decisions" with the URL above',
    "and the header  Authorization: Bearer <token>  using your CLI's own MCP configuration (check its docs for the exact key names).",
  );
  return lines;
}

export interface DaemonOptions {
  sink?: string;
  socket?: boolean;
  mcp?: {
    port?: number;
    /** Name of an env var holding the bearer token. */
    tokenEnv?: string;
    tokenFile?: string;
    pane?: string;
    /** Folder whose `<pane>/` subfolder holds the files an agent may attach. Unset = no attachments over MCP. */
    attachmentsDir?: string;
    /** Print the literal bearer token. Off by default so logs never capture it. */
    showToken?: boolean;
  };
  /** Resolve when this promise settles (tests); default waits for SIGINT/SIGTERM. */
  until?: Promise<void>;
  onReady?: (h: { bridge: DecisionsBridge; mcp: RunningMcp | null; token: string | null }) => void;
}

export async function daemon(ctx: Ctx, g: GlobalOptions, o: DaemonOptions): Promise<void> {
  const rt = await openRuntime(ctx, g);
  const sink = new DemoSink(parseSink(o.sink), ctx.out);
  // Agents reach files only through a folder the human designated (per pane), never by naming a path.
  const bridge = buildBridge(rt, sink, {
    resolver: o.mcp?.attachmentsDir
      ? new PaneDirectoryResolver(o.mcp.attachmentsDir)
      : noAttachmentsResolver,
  });
  let mcp: RunningMcp | null = null;
  let token: string | null = null;
  try {
    bridge.on('delivered', (id) => ctx.out(`✓ delivered answer for ${id}`));
    bridge.on('error', (e) => ctx.err(`warning: ${e.message}`));
    bridge.on('socket', (s, d) => ctx.err(`[relay] ${s}${d ? ` (${d})` : ''}`));
    bridge.on('state', (s) => {
      if (s === 'revoked')
        ctx.err(
          'This device was revoked from the relay. Stopping; re-pair or restore from a recovery kit.',
        );
    });
    if (o.mcp) {
      const tokenFile = o.mcp.tokenFile ?? join(ctx.home, 'mcp-token');
      if (o.mcp.tokenEnv) {
        const fromEnv = ctx.env[o.mcp.tokenEnv];
        if (!fromEnv) throw new CliError(`environment variable ${o.mcp.tokenEnv} is empty`);
        token = fromEnv;
      } else {
        token = await readSecretFile(tokenFile, () => bytesToBase64Url(randomBytes(32)));
      }
      if (token.length < 24) throw new CliError('MCP token must be at least 24 characters');
      const auth = new TokenMapAuthenticator();
      auth.register(token, cliOrigin(o.mcp.pane ?? 'mcp'));
      mcp = await startDecisionsMcpServer({
        bridge,
        authenticator: auth,
        ...(o.mcp.port !== undefined ? { port: o.mcp.port } : {}),
      });
      ctx.out(`Decisions MCP listening on ${mcp.url} (loopback only)\n`);
      for (const l of mcpAddLines(mcp.url, token, {
        show: o.mcp.showToken === true,
        file: o.mcp.tokenEnv ? '$' + o.mcp.tokenEnv : tokenFile,
      }))
        ctx.out(l);
      ctx.out('');
    }
    await bridge.start({ socket: o.socket !== false });
    if (o.socket === false)
      await bridge.catchUp().catch((e) => ctx.err(`warning: ${(e as Error).message}`));
    ctx.out(
      `Listening for answers${o.socket === false ? ' (no live socket)' : ''}. Press Ctrl-C to stop.`,
    );
    o.onReady?.({ bridge, mcp, token });
    await (o.until ??
      new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      }));
  } finally {
    await mcp?.close();
    await bridge.stop();
    await rt.store.close();
  }
}

export async function ask(
  ctx: Ctx,
  g: GlobalOptions,
  o: {
    question: string;
    context?: string;
    option?: string[];
    require?: string;
    attach?: string[];
    wait?: boolean;
    sink?: string;
    until?: Promise<void>;
  },
): Promise<void> {
  const rt = await openRuntime(ctx, g);
  const bridge = buildBridge(rt, new DemoSink(parseSink(o.sink), ctx.out), {
    resolver: humanFileResolver,
  });
  try {
    const options = (o.option ?? []).map((s) => {
      const i = s.indexOf('=');
      if (i < 1) throw new CliError(`--option must look like id=Label, got "${s}"`);
      return { id: s.slice(0, i), label: s.slice(i + 1) };
    });
    const r = await bridge.registerQuestion({
      origin: cliOrigin(),
      input: {
        question: o.question,
        ...(o.context ? { context: o.context } : {}),
        ...(options.length ? { options } : {}),
        ...(o.require ? { requested_requirement: o.require } : {}),
        ...(o.attach?.length
          ? { attachments: o.attach.map((p) => ({ local_resource_id: p })) }
          : {}),
      },
    });
    await bridge.pump();
    ctx.out(
      ctx.json
        ? JSON.stringify({
            question_id: r.questionId,
            alias: r.alias,
            enforced_requirement: r.requirement,
          })
        : `Asked as q-${r.alias} (${r.questionId}), requirement: ${r.requirement}.`,
    );
    if (!o.wait) {
      ctx.out(
        ctx.json
          ? ''
          : 'The answer is delivered by a running `decisions listen`. Use --wait to wait here.',
      );
      return;
    }
    await bridge.start();
    const done = new Promise<void>((resolve) => {
      bridge.on('delivered', (id) => id === r.questionId && resolve());
    });
    await Promise.race([
      done,
      o.until ?? new Promise<void>((resolve) => process.once('SIGINT', () => resolve())),
    ]);
  } finally {
    await bridge.stop();
    await rt.store.close();
  }
}
