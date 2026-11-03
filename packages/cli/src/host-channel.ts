import { createConnection, type Socket } from 'node:net';
import { CliError } from './runtime.js';
import type {
  CleanupProvider,
  KeyProvider,
  TranscriptionProvider,
} from './commands/deploy-questions.js';

/**
 * The private channel a host app (Daintree) uses to run `decisions deploy --host-channel <path>`:
 * prefilled answers in, the result out. The host listens on a local socket (a Unix domain socket
 * in a directory only the user can open, or a Windows named pipe restricted to the user) and passes
 * its path, which is not a secret, on the command line. Keys and the claim secret travel only over
 * the socket, never in argv, the environment, a file or on screen.
 *
 * Messages are single-line JSON objects, each ending in a newline and carrying `v`, the contract
 * version: the CLI sends `hello`, the host answers `prefill`, and at the end the CLI sends `result`
 * and the host confirms it with `received`. docs/self-host.md describes them for host authors.
 */

/** The contract versions this CLI speaks. */
export const HOST_CONTRACT_VERSIONS = [1] as const;
export const HOST_CONTRACT_VERSION = 1;

/**
 * No message in this contract comes close; a longer one (not counting its newline) is refused
 * before it is parsed.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_FIELD = 1024;
/** Keeps a result's error message, and so the result, well inside MAX_MESSAGE_BYTES. */
const MAX_ERROR = 4096;

export interface HostPrefill {
  name?: string;
  bucket?: string;
  accountId?: string;
  /** null: the host has dictation off; absent: no default. */
  transcription?: { provider: TranscriptionProvider } | null;
  cleanup?: { provider: CleanupProvider; model: string } | null;
  keys: Partial<Record<KeyProvider, string>>;
}

export type HostOutcome = 'completed' | 'cancelled' | 'failed';
export type ClaimState = 'claimed' | 'unclaimed' | 'unknown';

export interface HostResult {
  status: HostOutcome;
  /** The Worker URL, once the deploy printed it, even when a later step failed. */
  url: string | null;
  /**
   * The claim secret, once its upload to the Worker started, even when a later step failed (it may
   * then be live). Null when none was set: before that step, or for a relay already claimed.
   */
  claimSecret: string | null;
  /** Whether the relay was already claimed when the deploy reached it ('unknown' before then). */
  claimState: ClaimState;
  /** For a failure: what went wrong, with every secret redacted. */
  error?: string;
}

export interface HostChannel {
  readonly prefill: HostPrefill;
  /** False once the host has closed the connection or broken the contract. */
  isOpen(): boolean;
  /**
   * Sends the result and resolves to whether the host confirmed it received it. Never rejects, and
   * closes the channel afterwards.
   */
  sendResult(r: HostResult): Promise<boolean>;
  /** Closes the channel without a result. Idempotent. */
  close(): void;
}

export interface HostChannelOptions {
  cliVersion: string;
  /** How long the connection and the host's prefill may take, in all. */
  openTimeoutMs?: number;
  /** How long sending the result and receiving the host's receipt may take, in all. */
  resultTimeoutMs?: number;
  connect?: (path: string) => Socket;
}

const invalid = (what: string) => new CliError(`the host app sent an invalid prefill: ${what}`);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function only(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k)) throw invalid(`unknown field ${where}${k}`);
}

function optString(o: Record<string, unknown>, k: string, where = ''): string | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > MAX_FIELD || /[\x00-\x1f\x7f]/.test(v))
    throw invalid(`${where}${k} must be a single-line string`);
  return v.trim() || undefined;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v))
    throw invalid(`${what} must be one of ${allowed.join(', ')}`);
  return v as T;
}

/**
 * Checks a `prefill` message's `answers`. Every field is optional; a field this version does not
 * know, or a known one of the wrong shape, is refused, so a host never believes it set a default
 * this CLI ignored. Values never appear in the error.
 */
export function parsePrefill(answers: unknown): HostPrefill {
  if (answers === undefined || answers === null) return { keys: {} };
  if (!isObject(answers)) throw invalid('answers must be an object');
  only(answers, ['name', 'bucket', 'account_id', 'transcription', 'cleanup', 'keys'], '');
  const out: HostPrefill = { keys: {} };
  const name = optString(answers, 'name');
  const bucket = optString(answers, 'bucket');
  const accountId = optString(answers, 'account_id');
  if (name !== undefined) out.name = name;
  if (bucket !== undefined) out.bucket = bucket;
  if (accountId !== undefined) out.accountId = accountId;

  const t = answers.transcription;
  if (t === null) out.transcription = null;
  else if (t !== undefined) {
    if (!isObject(t)) throw invalid('transcription must be an object or null');
    only(t, ['provider'], 'transcription.');
    out.transcription = {
      provider: oneOf(t.provider, ['xai', 'openai'] as const, 'transcription.provider'),
    };
  }
  const c = answers.cleanup;
  if (c === null) out.cleanup = null;
  else if (c !== undefined) {
    if (!isObject(c)) throw invalid('cleanup must be an object or null');
    only(c, ['provider', 'model'], 'cleanup.');
    const provider = oneOf(c.provider, ['anthropic', 'openai'] as const, 'cleanup.provider');
    const model = optString(c, 'model', 'cleanup.');
    if (model === undefined) throw invalid('cleanup.model is required');
    out.cleanup = { provider, model };
  }
  const keys = answers.keys;
  if (keys !== undefined && keys !== null) {
    if (!isObject(keys)) throw invalid('keys must be an object');
    only(keys, ['xai', 'openai', 'anthropic'], 'keys.');
    for (const p of ['xai', 'openai', 'anthropic'] as const) {
      // A key reaches Wrangler as one line on stdin, so it may not carry a line break of its own.
      const v = optString(keys, p, 'keys.');
      if (v !== undefined) out.keys[p] = v;
    }
  }
  return out;
}

/**
 * Reads newline-terminated JSON messages from `sock`, one at a time. The host speaks only when
 * asked: one message after `expect()`, and anything else ends the channel.
 */
function messageReader(sock: Socket) {
  let buf = Buffer.alloc(0);
  let ended: CliError | null = null;
  let expecting = false;
  const queue: unknown[] = [];
  let waiter: { resolve: (v: unknown) => void; reject: (e: Error) => void } | null = null;
  const fail = (e: CliError) => {
    if (ended) return;
    ended = e;
    waiter?.reject(e);
    waiter = null;
    sock.destroy();
  };
  sock.on('data', (d: Buffer) => {
    if (ended) return;
    buf = Buffer.concat([buf, d]);
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10)) {
      const line = buf.subarray(0, i);
      buf = buf.subarray(i + 1);
      if (line.length > MAX_MESSAGE_BYTES)
        return fail(new CliError('the host app sent a message that is too long'));
      const textLine = line.toString('utf8').trim();
      if (!textLine) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(textLine);
      } catch {
        return fail(new CliError('the host app sent a message that is not JSON'));
      }
      if (!expecting) return fail(new CliError('the host app sent a message it was not asked for'));
      expecting = false;
      if (waiter) {
        waiter.resolve(msg);
        waiter = null;
      } else queue.push(msg);
    }
    if (buf.length > MAX_MESSAGE_BYTES)
      fail(new CliError('the host app sent a message that is too long'));
  });
  sock.on('error', () => fail(new CliError('the connection to the host app failed')));
  sock.on('close', () => fail(new CliError('the host app closed the connection')));
  return {
    isOpen: () => ended === null,
    /** Allows the host's next message; call it before sending what it answers. */
    expect: () => {
      expecting = true;
    },
    /** The next message, rejecting at `deadline` (an absolute time) or when the channel ends. */
    next(deadline: number, what: string): Promise<unknown> {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.reject(ended);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            waiter = null;
            reject(new CliError(`the host app did not send ${what} in time`));
          },
          Math.max(0, deadline - Date.now()),
        );
        waiter = {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
      });
    },
  };
}

/** Writes one message, rejecting at `deadline` (an absolute time) if it cannot be flushed. */
function send(sock: Socket, msg: Record<string, unknown>, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CliError('timed out writing to the host app')),
      Math.max(0, deadline - Date.now()),
    );
    sock.write(JSON.stringify({ v: HOST_CONTRACT_VERSION, ...msg }) + '\n', (e) => {
      clearTimeout(timer);
      if (e) reject(new CliError('could not write to the host app'));
      else resolve();
    });
  });
}

function resultMessage(r: HostResult): Record<string, unknown> {
  return {
    type: 'result',
    status: r.status,
    url: r.url,
    claim_secret: r.claimSecret,
    claim_state: r.claimState,
    ...(r.error !== undefined ? { error: r.error.slice(0, MAX_ERROR) } : {}),
  };
}

/**
 * Connects to the host's socket, introduces this CLI and waits for the host's prefill. Rejects with
 * a CliError, leaving nothing open, when the host cannot be reached or answers wrongly; a prefill
 * this CLI cannot accept is first answered with a failed result, so the host learns why.
 */
export async function openHostChannel(path: string, o: HostChannelOptions): Promise<HostChannel> {
  const openDeadline = Date.now() + (o.openTimeoutMs ?? 15_000);
  const resultTimeoutMs = o.resultTimeoutMs ?? 10_000;
  const sock = (o.connect ?? ((p) => createConnection(p)))(path);
  const reader = messageReader(sock);
  let closed = false;
  const close = () => {
    closed = true;
    sock.destroy();
  };
  const sendResult = async (r: HostResult): Promise<boolean> => {
    if (closed || !reader.isOpen()) return false;
    const deadline = Date.now() + resultTimeoutMs;
    try {
      reader.expect();
      await send(sock, resultMessage(r), deadline);
      const ack = await reader.next(deadline, 'a receipt for the result');
      return isObject(ack) && ack.type === 'received' && ack.v === HOST_CONTRACT_VERSION;
    } catch {
      return false;
    } finally {
      close();
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CliError(`could not connect to the host app at ${path}: timed out`));
      }, openDeadline - Date.now());
      sock.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      sock.once('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new CliError(`could not connect to the host app at ${path} (${e.code ?? 'error'})`));
      });
    });
    reader.expect();
    await send(
      sock,
      { type: 'hello', cli: o.cliVersion, versions: [...HOST_CONTRACT_VERSIONS] },
      openDeadline,
    );
    const msg = await reader.next(openDeadline, 'its prefill');
    let prefill: HostPrefill;
    try {
      if (!isObject(msg) || msg.type !== 'prefill')
        throw new CliError('the host app did not answer with a prefill message');
      if (msg.v !== HOST_CONTRACT_VERSION)
        throw new CliError(
          `the host app speaks contract version ${Number.isSafeInteger(msg.v) ? String(msg.v) : '(not a number)'}; this CLI speaks ${HOST_CONTRACT_VERSIONS.join(', ')}`,
        );
      only(msg, ['v', 'type', 'answers'], '');
      prefill = parsePrefill(msg.answers);
    } catch (e) {
      const error = (e as Error).message;
      await sendResult({
        status: 'failed',
        url: null,
        claimSecret: null,
        claimState: 'unknown',
        error,
      });
      throw e;
    }
    return { prefill, isOpen: () => !closed && reader.isOpen(), sendResult, close };
  } catch (e) {
    close();
    throw e instanceof CliError ? e : new CliError('the channel to the host app failed');
  }
}
