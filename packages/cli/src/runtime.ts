import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  FileKeyStore,
  RelayClient,
  defaultHome,
  loadIdentity,
  sealStoredContent,
  type Identity,
  type KeyStore,
  type LocalStore,
  type WebSocketFactory,
} from '@daintreehq/decisions-client';
import { SqliteLocalStore } from '@daintreehq/decisions-client/sqlite';

/** Everything a command needs from its environment, so commands are testable without a terminal. */
export interface Ctx {
  home: string;
  json: boolean;
  fetch: typeof fetch;
  webSocket?: WebSocketFactory;
  out(line: string): void;
  /** Like `out`, but resolves only once the line has really been written (rejects if the write fails). */
  outAcked?(line: string): Promise<void>;
  err(line: string): void;
  /** Ask a question on the terminal; resolves to the answer text. */
  prompt(question: string, opts?: { secret?: boolean }): Promise<string>;
  env: Record<string, string | undefined>;
  now(): number;
  /** Read all of standard input (for secrets that must not appear in argv). */
  readStdin(): Promise<string>;
  /** True when a person is at the terminal, so a hidden prompt can stand in for a missing secret. */
  interactive?: boolean;
  keyStore?: KeyStore;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export interface GlobalOptions {
  home?: string;
  json?: boolean;
  passphraseEnv?: string;
}

export function makeCtx(g: GlobalOptions): Ctx {
  return {
    home: g.home ?? defaultHome(),
    json: g.json === true,
    fetch: globalThis.fetch,
    out: (l) => process.stdout.write(l + '\n'),
    outAcked: (l) =>
      new Promise<void>((resolve, reject) =>
        process.stdout.write(l + '\n', (e) => (e ? reject(e) : resolve())),
      ),
    err: (l) => process.stderr.write(l + '\n'),
    prompt: promptLine,
    interactive: process.stdin.isTTY === true,
    env: process.env,
    now: Date.now,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

export function promptLine(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Ctrl-C or the end of input settles the prompt as an error, so the caller's cleanup runs
    // instead of the process exiting with the question still pending.
    let answered = false;
    rl.on('SIGINT', () => {
      process.stdout.write('\n');
      rl.close();
    });
    rl.on('close', () => {
      if (!answered) reject(new CliError('cancelled', 130));
    });
    if (opts.secret) {
      const anyRl = rl as unknown as { _writeToOutput: (s: string) => void };
      let first = true;
      anyRl._writeToOutput = (s: string) => {
        if (first) {
          process.stdout.write(s);
          first = false;
        }
      };
    }
    rl.question(question, (a) => {
      answered = true;
      rl.close();
      if (opts.secret) process.stdout.write('\n');
      resolve(a.trim());
    });
  });
}

export function keyStoreFor(ctx: Ctx, passphraseEnv?: string): KeyStore {
  if (ctx.keyStore) return ctx.keyStore;
  const pass = passphraseEnv ? ctx.env[passphraseEnv] : undefined;
  if (passphraseEnv && !pass) throw new CliError(`environment variable ${passphraseEnv} is empty`);
  return new FileKeyStore(ctx.home, pass);
}

export interface Runtime {
  ctx: Ctx;
  keyStore: KeyStore;
  identity: Identity;
  client: RelayClient;
  store: LocalStore;
  auditPath: string;
}

export async function openRuntime(ctx: Ctx, g: GlobalOptions = {}): Promise<Runtime> {
  const keyStore = keyStoreFor(ctx, g.passphraseEnv);
  let identity: Identity;
  try {
    identity = await loadIdentity(keyStore);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  await mkdir(ctx.home, { recursive: true, mode: 0o700 });
  const store = new SqliteLocalStore(join(ctx.home, 'decisions.db'));
  try {
    // A store written before content was sealed is sealed (and compacted) on first open, whatever the command.
    await sealStoredContent({ store, identity });
  } catch (e) {
    await store.close();
    throw new CliError(`could not seal the local store: ${(e as Error).message}`);
  }
  const client = new RelayClient({ identity, fetch: ctx.fetch });
  return { ctx, keyStore, identity, client, store, auditPath: join(ctx.home, 'audit.jsonl') };
}

export async function readSecretFile(path: string, create: () => string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const v = create();
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, v + '\n', { mode: 0o600 });
    await chmod(path, 0o600);
    return v;
  }
}

export function print(ctx: Ctx, human: string, json: unknown): void {
  ctx.out(ctx.json ? JSON.stringify(json, null, 2) : human);
}

export async function secretFromEnvOrPrompt(
  ctx: Ctx,
  envName: string,
  question: string,
  confirm = false,
): Promise<string> {
  const fromEnv = ctx.env[envName];
  if (fromEnv) return fromEnv;
  const a = await ctx.prompt(question, { secret: true });
  if (confirm) {
    const b = await ctx.prompt('Repeat it: ', { secret: true });
    if (a !== b) throw new CliError('passphrases do not match');
  }
  if (!a) throw new CliError('a passphrase is required');
  return a;
}
