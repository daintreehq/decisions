import { spawn, type ChildProcess } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bytesToBase64Url } from '@daintreehq/decisions-protocol';
import {
  DecisionsBridge,
  FileSpool,
  PolicyRegistry,
  TokenMapAuthenticator,
  startDecisionsMcpServer,
  validateMcpPath,
  type AttachmentResolver,
  type HttpPollOptions,
  type HttpSyncStatus,
  type InjectResult,
  type LocateResult,
  type QuestionOrigin,
  type RunningMcp,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import {
  CliError,
  openRuntime,
  readSecretFile,
  type Ctx,
  type GlobalOptions,
  type Runtime,
} from '../runtime.js';
import { PaneDirectoryResolver, humanFileResolver, noAttachmentsResolver } from '../resolvers.js';

/**
 * The origin the CLI uses for everything it asks itself. Each named demo "pane" lives as long as the
 * installation and is never relaunched (a later `decisions listen` delivers what an earlier `decisions ask`
 * asked), so its run identity is fixed: the principal names the pane and the incarnation is constant.
 */
export function cliOrigin(name = 'cli'): QuestionOrigin {
  return {
    host_id: 'cli',
    pane_id: name,
    terminal_generation: 1,
    ownership_principal: `cli:${name}`,
    agent_incarnation: 'cli',
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

/** Exit status an exec sink command uses to say "nothing done, try again later" (sysexits EX_TEMPFAIL). */
export const EXEC_SINK_TEMPFAIL = 75;

/**
 * Demo sink so the whole loop works without Daintree: prints, appends to a file, or pipes the notice to a
 * command's stdin. Every CLI pane is "alive" and always idle. Daintree replaces this with its wake gate.
 *
 * Results are honest about what is known:
 * - stdout: delivered once the writer has confirmed the write (the real CLI waits for stdout's write
 *   callback); a write that fails is ambiguous.
 * - file: a file that cannot be opened is unavailable (nothing written); a failed write is ambiguous;
 *   delivered after the whole text has been written.
 * - exec: the command is the terminal, and its exit status is its own report. Exit 0 says "I took the
 *   text" and counts as delivered only if all of the input was also handed to it (a command that exits
 *   before the pipe drains is ambiguous). The bridge cannot see inside the command, so a command that exits
 *   0 without using its input is misreporting. Exit 75 means held (the command did nothing; retried later).
 *   Any other exit is ambiguous, because the command may have acted on the text. A command that cannot be
 *   started is unavailable.
 */
export class DemoSink implements TerminalSink {
  /** `exec:` commands still running, so shutdown can end them instead of waiting on them. */
  private readonly running = new Set<ChildProcess>();
  constructor(
    private readonly spec: SinkSpec,
    /** Writes one line; when it returns a promise, the line counts as written only once that resolves. */
    private readonly out: (line: string) => void | Promise<void>,
  ) {}
  async locate(o: QuestionOrigin): Promise<LocateResult> {
    if (o.host_id !== 'cli') return { state: 'gone' };
    return {
      state: 'alive',
      target: {
        hostId: o.host_id,
        paneId: o.pane_id,
        terminalGeneration: o.terminal_generation,
        ownershipPrincipal: o.ownership_principal,
        agentIncarnation: o.agent_incarnation,
        agentSessionId: o.agent_session_id,
        worktreeId: o.worktree_id,
      },
    };
  }
  async isIdle(): Promise<boolean> {
    return true;
  }
  async inject(_t: TerminalTarget, text: string, _injectionId?: string): Promise<InjectResult> {
    switch (this.spec.kind) {
      case 'stdout':
        try {
          await this.out('\n' + text + '\n');
          return { outcome: 'delivered', proof: 'stdout' };
        } catch {
          return { outcome: 'ambiguous', reason: 'stdout_write_failed' };
        }
      case 'file':
        return this.appendToFile(this.spec.path, text + '\n');
      case 'exec':
        return this.pipeToCommand(this.spec.cmd, text + '\n');
    }
  }
  private async appendToFile(path: string, data: string): Promise<InjectResult> {
    let fh;
    try {
      fh = await open(path, 'a', 0o600);
    } catch (e) {
      const code = ((e as NodeJS.ErrnoException).code ?? 'open_failed').toLowerCase();
      return { outcome: 'unavailable', reason: 'rejected', detail: code };
    }
    try {
      const bytes = Buffer.from(data, 'utf8');
      let written = 0;
      while (written < bytes.length) {
        const r = await fh.write(bytes, written, bytes.length - written);
        written += r.bytesWritten;
      }
      return { outcome: 'delivered', proof: `file:${written}` };
    } catch {
      return { outcome: 'ambiguous', reason: 'file_write_failed' };
    } finally {
      await fh.close().catch(() => undefined);
    }
  }
  private pipeToCommand(cmd: string, data: string): Promise<InjectResult> {
    return new Promise<InjectResult>((resolve) => {
      let spawned = false;
      let inputWritten = false;
      const p = spawn(cmd, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
      this.running.add(p);
      p.on('exit', () => this.running.delete(p));
      p.on('spawn', () => (spawned = true));
      p.on('error', () =>
        resolve(
          spawned
            ? { outcome: 'ambiguous', reason: 'exec_error' }
            : { outcome: 'unavailable', reason: 'rejected', detail: 'exec_spawn_failed' },
        ),
      );
      p.on('close', (code) => {
        if (code === EXEC_SINK_TEMPFAIL) resolve({ outcome: 'held', reason: 'exec_tempfail' });
        else if (code !== 0)
          resolve({ outcome: 'ambiguous', reason: `exec_exit_${code ?? 'signal'}` });
        else if (!inputWritten) resolve({ outcome: 'ambiguous', reason: 'exec_input_unread' });
        else resolve({ outcome: 'delivered', proof: 'exec:exit-0' });
      });
      // A command that exits before reading its input raises EPIPE on stdin; the exit decides the outcome.
      p.stdin.on('error', () => undefined);
      p.stdin.end(data, (err?: Error | null) => (inputWritten = !err));
    });
  }
  /**
   * Shutting down: end every `exec:` command still running (SIGTERM), so a command that never exits cannot keep the
   * process up. One that may already have acted settles as ambiguous, never retried.
   */
  close(): void {
    for (const p of this.running) p.kill('SIGTERM');
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
    // The CLI's sinks type the library's text as given, follow-up blocks included.
    followUps: true,
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
  /** `false`: no live socket; sync over HTTP continuously instead (`--no-socket`). */
  socket?: boolean;
  /** Sync over HTTP once, deliver what that brings, and return (`listen --once`; implies no socket). */
  once?: boolean;
  /** The HTTP polling cadence without a socket (tests); default `DEFAULT_POLL`. */
  poll?: HttpPollOptions;
  /** How long `once` may take before it stops (tests); default two minutes. */
  onceDeadlineMs?: number;
  mcp?: {
    port?: number;
    /** Path the MCP answers on, exactly (default `/mcp`). */
    path?: string;
    /** Name of an env var holding the bearer token. */
    tokenEnv?: string;
    tokenFile?: string;
    pane?: string;
    /** Folder whose `<pane>/` subfolder holds the files an agent may attach. Unset = no attachments over MCP. */
    attachmentsDir?: string;
    /** Print the literal bearer token. Off by default so logs never capture it. */
    showToken?: boolean;
  };
  /** Stop when this promise settles (tests); default stops on SIGINT/SIGTERM. A revocation stops it either way. */
  until?: Promise<void>;
  onReady?: (h: { bridge: DecisionsBridge; mcp: RunningMcp | null; token: string | null }) => void;
}

/** How long `listen --once` may take, start to end, before it gives up (a relay or sink that never answers). */
const ONCE_DEADLINE_MS = 120_000;
const ONCE_TIMED_OUT = 'listen --once did not finish within two minutes; stopped';

const REVOKED =
  'This device was revoked from the relay. Stopped; re-pair or restore from a recovery kit.';

/** Seconds until `at`, for a status line. */
const secondsUntil = (at: number, now: number) => Math.max(0, Math.round((at - now) / 1000));

/**
 * Reports a polling listener's HTTP syncs on stderr: the first success, each failure with its retry, and the
 * recovery. Only codes, cursors and times: nothing of any question.
 */
function reportSyncs(ctx: Ctx, bridge: DecisionsBridge): void {
  let last: HttpSyncStatus['outcome'] | null = null;
  bridge.on('sync', (s) => {
    if (s.outcome === 'ok' && last !== 'ok')
      ctx.err(
        `[relay] HTTP sync ${last === 'degraded' ? 'recovered' : 'ok'} (event ${s.last_success_cursor}); polling every ${secondsUntil(s.next_attempt_at ?? ctx.now(), ctx.now())}s`,
      );
    if (s.outcome === 'degraded')
      ctx.err(
        `[relay] HTTP sync failed (${s.reason}, ${s.failures} in a row)${s.next_attempt_at !== null ? `; retrying in ${secondsUntil(s.next_attempt_at, ctx.now())}s` : ''}`,
      );
    if (s.outcome === 'fatal') ctx.err(`[relay] HTTP sync failed (${s.reason}); stopping`);
    last = s.outcome;
  });
}

export async function daemon(ctx: Ctx, g: GlobalOptions, o: DaemonOptions): Promise<void> {
  // A bad mount path fails before the runtime opens or a token file is created.
  if (o.mcp?.path !== undefined) {
    try {
      validateMcpPath(o.mcp.path);
    } catch (e) {
      throw new CliError(`--path: ${(e as Error).message}`);
    }
  }
  const rt = await openRuntime(ctx, g);
  const sink = new DemoSink(parseSink(o.sink), ctx.outAcked ?? ctx.out);
  // Agents reach files only through a folder the human designated (per pane), never by naming a path.
  const bridge = buildBridge(rt, sink, {
    resolver: o.mcp?.attachmentsDir
      ? new PaneDirectoryResolver(o.mcp.attachmentsDir)
      : noAttachmentsResolver,
  });
  const http = o.once === true || o.socket === false;
  // One way to stop, whatever asks: a signal, the caller's `until`, a revocation or a sync no retry can fix. It
  // stops the bridge, so a sync it cuts short records nothing, and aborts every relay request still in flight, so a
  // relay that never answers cannot keep the process up.
  let stopping = false;
  /** Why the listener ended on its own, latched before stopping the bridge resets its state. */
  const ended: { revoked: boolean; fatal: HttpSyncStatus | null; timedOut: boolean } = {
    revoked: false,
    fatal: null,
    timedOut: false,
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let release!: () => void;
  const stopped = new Promise<void>((r) => (release = r));
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void bridge.stop();
    rt.client.close();
    sink.close();
    release();
  };
  if (o.until) void o.until.then(stop, stop);
  else {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  let mcp: RunningMcp | null = null;
  let token: string | null = null;
  try {
    bridge.on('delivered', (id) => ctx.out(`✓ delivered answer for ${id}`));
    bridge.on('error', (e) => !stopping && ctx.err(`warning: ${e.message}`));
    bridge.on('socket', (s, d) => ctx.err(`[relay] ${s}${d ? ` (${d})` : ''}`));
    bridge.on('state', (s) => {
      if (s !== 'revoked') return;
      ended.revoked = true;
      stop();
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
        ...(o.mcp.path !== undefined ? { path: o.mcp.path } : {}),
        // This host resolves an id inside the pane's human-designated folder, not the agent's worktree, so it says so.
        attachmentIdDescription: o.mcp.attachmentsDir
          ? 'The relative path the human gave you of an image in the attachments folder set up for this terminal; nothing else can be attached.'
          : 'This host accepts no attachments; leave attachments out.',
      });
      ctx.out(`Decisions MCP listening on ${mcp.url} (loopback only)\n`);
      for (const l of mcpAddLines(mcp.url, token, {
        show: o.mcp.showToken === true,
        file: o.mcp.tokenEnv ? '$' + o.mcp.tokenEnv : tokenFile,
      }))
        ctx.out(l);
      ctx.out('');
    }
    if (o.once) {
      // One pass: what the relay holds is fetched and delivered, then the command ends. An answer that arrives later
      // waits for the next run (or a listener that stays up). A signal, or the deadline, ends the wait even if the
      // relay or a sink never answers.
      deadline = setTimeout(() => {
        ended.timedOut = true;
        stop();
      }, o.onceDeadlineMs ?? ONCE_DEADLINE_MS);
      await bridge.start({ socket: false });
      const s = await Promise.race([bridge.sync({ settle: true }), stopped.then(() => null)]);
      if (ended.revoked || s?.outcome === 'revoked') throw new CliError(REVOKED);
      if (ended.timedOut) throw new CliError(ONCE_TIMED_OUT);
      if (!s || stopping) return;
      // What was already waiting here is delivered too, even when the relay could not be read.
      await Promise.race([bridge.pump(), stopped]);
      if (ended.revoked) throw new CliError(REVOKED);
      if (ended.timedOut) throw new CliError(ONCE_TIMED_OUT);
      if (stopping) return;
      if (s.outcome !== 'ok')
        throw new CliError(`could not sync with the relay over HTTP (${s.reason ?? 'unknown'})`);
      ctx.err(`[relay] HTTP sync ok (event ${s.last_success_cursor}); done.`);
      return;
    }
    if (http) {
      reportSyncs(ctx, bridge);
      bridge.on('sync', (s) => {
        if (s.outcome !== 'fatal') return;
        ended.fatal = s;
        stop();
      });
    }
    await bridge.start(http ? { socket: false, poll: o.poll ?? true } : {});
    ctx.out(
      `Listening for answers${http ? ' over HTTP (no live socket)' : ''}. Press Ctrl-C to stop.`,
    );
    o.onReady?.({ bridge, mcp, token });
    await stopped;
    if (ended.revoked) throw new CliError(REVOKED);
    if (ended.fatal)
      throw new CliError(
        `stopped listening: the relay refuses this client (${ended.fatal.reason}); update decisions`,
      );
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    stopping = true;
    sink.close();
    await mcp?.close();
    rt.client.close();
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
  const bridge = buildBridge(rt, new DemoSink(parseSink(o.sink), ctx.outAcked ?? ctx.out), {
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
