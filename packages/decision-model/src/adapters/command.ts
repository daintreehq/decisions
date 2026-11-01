import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { ModelPrompt } from '../prompt.js';
import {
  AdapterError,
  AdapterTimeoutError,
  TransientAdapterError,
  abortError,
  type DecisionModelAdapter,
} from './types.js';

/**
 * Environment variables passed to the child by default. Everything else (notably DAINTREE_MCP_TOKEN and
 * DAINTREE_PANE_ID, which would let the child talk to this very app) is dropped. Add what your CLI needs
 * to authenticate (for example its API key variable) through `envAllow`.
 */
export const DEFAULT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'SystemRoot',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

export interface CommandAdapterOptions {
  id?: string;
  modelId?: string;
  command: string;
  /** Arguments. The literal `{{model}}` is replaced by `model` when set. No shell is involved. */
  args?: string[];
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  envAllow?: string[];
  /** Extra fixed variables to set (not read from the parent). */
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Runs a user-installed agent CLI non-interactively: prompt on stdin, JSON reply on stdout.
 * No shell, scrubbed environment, hard timeout, output cap, and the whole process group is killed on abort.
 */
export class CommandAdapter implements DecisionModelAdapter {
  readonly id: string;
  readonly modelId?: string;
  private readonly o: Required<
    Pick<CommandAdapterOptions, 'command' | 'timeoutMs' | 'maxOutputBytes'>
  > &
    CommandAdapterOptions;

  constructor(opts: CommandAdapterOptions) {
    this.o = { timeoutMs: 120_000, maxOutputBytes: 256 * 1024, ...opts };
    this.id = opts.id ?? `command:${opts.command}`;
    if (opts.modelId ?? opts.model) this.modelId = opts.modelId ?? opts.model!;
  }

  suggest(prompt: ModelPrompt, signal?: AbortSignal): Promise<string> {
    const o = this.o;
    const args = (o.args ?? []).map((a) => a.split('{{model}}').join(o.model ?? ''));
    const env: Record<string, string> = {};
    for (const k of [...DEFAULT_ENV_ALLOWLIST, ...(o.envAllow ?? [])]) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, o.env ?? {});
    const stdin = `${prompt.system}\n\n${prompt.user}\n`;

    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      let child;
      try {
        child = spawn(o.command, args, {
          shell: false,
          detached: process.platform !== 'win32',
          env,
          cwd: o.cwd ?? tmpdir(),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        return reject(new AdapterError(`could not start ${o.command}: ${(e as Error).message}`));
      }

      let settled = false;
      const out: Buffer[] = [];
      let outBytes = 0;
      let errText = '';

      const killTree = (): void => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      };
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = (): void => {
        killTree();
        finish(() => reject(abortError()));
      };
      const timer = setTimeout(() => {
        killTree();
        finish(() =>
          reject(new AdapterTimeoutError(`${o.command} timed out after ${o.timeoutMs} ms`)),
        );
      }, o.timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d: Buffer) => {
        outBytes += d.length;
        if (outBytes > o.maxOutputBytes) {
          killTree();
          finish(() =>
            reject(
              new AdapterError(
                `${o.command} produced more than ${o.maxOutputBytes} bytes of output`,
              ),
            ),
          );
          return;
        }
        out.push(d);
      });
      child.stderr.on('data', (d: Buffer) => {
        if (errText.length < 400) errText += d.toString('utf8');
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        finish(() =>
          reject(
            e.code === 'EAGAIN' || e.code === 'EMFILE'
              ? new TransientAdapterError(`could not start ${o.command}: ${e.code}`)
              : new AdapterError(`could not run ${o.command}: ${e.code ?? e.message}`),
          ),
        );
      });
      child.on('close', (code) => {
        finish(() => {
          if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
          else
            reject(
              new AdapterError(
                `${o.command} exited with code ${code}${errText ? `: ${errText.slice(0, 200).trim()}` : ''}`,
              ),
            );
        });
      });
      // The child may exit before reading stdin; that is reported through the exit code instead.
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    });
  }
}

/**
 * Example presets. These are STARTING POINTS: CLI flags change between releases, so verify each one against
 * your installed version (`claude --help`, `codex exec --help`, `gemini --help`) and override `args` freely.
 * Each CLI also needs its own authentication, usually already present in your home directory; pass
 * any API key variable explicitly via `envAllow`.
 */
export const commandPresets = {
  /** `claude -p` (print mode); prompt is read from stdin. */
  claude: (o: Partial<CommandAdapterOptions> = {}): CommandAdapter =>
    new CommandAdapter({ id: 'command:claude', command: 'claude', args: ['-p'], ...o }),
  /** `codex exec -` reads the prompt from stdin; sandboxed read-only; skips the git-repo requirement. */
  codex: (o: Partial<CommandAdapterOptions> = {}): CommandAdapter =>
    new CommandAdapter({
      id: 'command:codex',
      command: 'codex',
      args: ['exec', '--skip-git-repo-check', '-s', 'read-only', '-'],
      ...o,
    }),
  /** `gemini -p` takes a short instruction; the full prompt arrives on stdin and is appended to it. */
  gemini: (o: Partial<CommandAdapterOptions> = {}): CommandAdapter =>
    new CommandAdapter({
      id: 'command:gemini',
      command: 'gemini',
      args: [
        '-p',
        'Follow the instructions given on stdin and reply with the single JSON object only.',
      ],
      ...o,
    }),
} as const;
