import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { RelayError } from '@daintreehq/decisions-client';
import { CliError, makeCtx, type GlobalOptions } from './runtime.js';
import { ask, daemon } from './commands/daemon.js';
import {
  deleteData,
  doctor,
  exportCmd,
  importCmd,
  recoveryExport,
  recoveryImport,
  recoveryVerify,
  status,
} from './commands/ops.js';
import { devices, pair, revoke, rotate, setup } from './commands/setup.js';

const VERSION = '0.1.0';
const collect = (v: string, prev: string[] = []) => [...prev, v];

export function buildProgram(): Command {
  const program = new Command('decisions')
    .description('Daintree Decisions: ask the human from your AI agents, answer from your phone.')
    .version(VERSION)
    .option('--home <dir>', 'state directory (default: $DECISIONS_HOME or ~/.decisions)')
    .option(
      '--key-passphrase-env <VAR>',
      'name of an env var holding a passphrase that protects the key file at rest',
    )
    .option('--json', 'machine-readable output where supported');

  const opts = (): GlobalOptions => {
    const o = program.opts<{ home?: string; keyPassphraseEnv?: string; json?: boolean }>();
    return {
      ...(o.home ? { home: o.home } : {}),
      ...(o.json ? { json: true } : {}),
      ...(o.keyPassphraseEnv ? { passphraseEnv: o.keyPassphraseEnv } : {}),
    };
  };
  const run =
    (fn: (ctx: ReturnType<typeof makeCtx>, g: GlobalOptions) => Promise<void>) => async () => {
      const g = opts();
      await fn(makeCtx(g), g);
    };

  program
    .command('setup')
    .description("Claim your deployed relay and create this machine's keys (once).")
    .requiredOption('--url <origin>', 'the https URL of your deployment')
    .option('--claim-secret-file <file>', 'read the CLAIM_SECRET from a file (recommended)')
    .option('--claim-secret-stdin', 'read the CLAIM_SECRET from standard input')
    .option(
      '--claim-secret <secret>',
      'the CLAIM_SECRET itself (visible in the process list and shell history: prefer the file, stdin or $DECISIONS_CLAIM_SECRET)',
    )
    .option('--label <name>', 'name for this machine', 'Daintree')
    .action((o) => run((c, g) => setup(c, g, o))());

  program
    .command('pair')
    .description('Show a QR code to pair a phone; confirm the 6-digit code on both screens.')
    .option('--role <role>', 'phone or tablet', 'phone')
    .action((o) => {
      if (o.role !== 'phone' && o.role !== 'tablet')
        throw new CliError('--role must be phone or tablet');
      return run((c, g) => pair(c, g, { role: o.role }))();
    });

  program
    .command('devices')
    .description('List paired devices.')
    .action(run((c, g) => devices(c, g)));
  program
    .command('revoke <deviceId>')
    .description('Revoke a paired device and rotate the content key.')
    .option('-y, --yes', 'do not ask for confirmation')
    .action((id, o) => run((c, g) => revoke(c, g, id, o))());
  program
    .command('rotate')
    .description('Rotate the content key without revoking anyone.')
    .action(run((c, g) => rotate(c, g)));

  program
    .command('listen')
    .description(
      'Receive answers and print / pipe them (demo sink; Daintree types them into the agent pane).',
    )
    .option('--sink <sink>', 'stdout | file:<path> | exec:<command>', 'stdout')
    .option('--no-socket', 'poll once over HTTP instead of keeping a live socket')
    .action((o) => run((c, g) => daemon(c, g, { sink: o.sink, socket: o.socket }))());

  program
    .command('mcp')
    .description(
      'Serve the Decisions HTTP MCP on 127.0.0.1 (plus the relay connection) and print how to add it.',
    )
    .option('--port <n>', 'port (default: a free one)', (v) => Number(v))
    .option(
      '--token-env <VAR>',
      'read the bearer token agents must present from this environment variable',
    )
    .option(
      '--token-file <file>',
      'read/create the bearer token in this file (default: ~/.decisions/mcp-token, mode 0600)',
    )
    .option(
      '--attachments-dir <dir>',
      'let agents attach files from <dir>/<pane name>/ (default: none)',
    )
    .option(
      '--show-token',
      'print the literal bearer token once (otherwise only the token file is named)',
    )
    .option('--sink <sink>', 'stdout | file:<path> | exec:<command>', 'stdout')
    .action((o) =>
      run((c, g) =>
        daemon(c, g, {
          sink: o.sink,
          mcp: {
            ...(o.port ? { port: o.port } : {}),
            ...(o.tokenEnv ? { tokenEnv: o.tokenEnv } : {}),
            ...(o.tokenFile ? { tokenFile: o.tokenFile } : {}),
            ...(o.attachmentsDir ? { attachmentsDir: o.attachmentsDir } : {}),
            ...(o.showToken ? { showToken: true } : {}),
          },
        }),
      )(),
    );

  program
    .command('ask <question>')
    .description('Ask a question from the command line.')
    .option('--context <text>')
    .option('--option <id=label>', 'an answer option (repeatable)', collect)
    .option(
      '--require <level>',
      'human-required | proxy-ok | proxy-first (can only strengthen policy)',
    )
    .option('--attach <file>', 'attach an image (repeatable)', collect)
    .option('--wait', 'stay connected until the answer is delivered')
    .option('--sink <sink>', 'stdout | file:<path> | exec:<command>', 'stdout')
    .action((q, o) => run((c, g) => ask(c, g, { question: q, ...o }))());

  program
    .command('status')
    .description('Show relay, queue and delivery state.')
    .action(run((c, g) => status(c, g)));
  program
    .command('doctor')
    .description('Check a deployment end to end.')
    .option('--url <origin>', 'relay origin (defaults to the configured one)')
    .action((o) => run((c, g) => doctor(c, g, o))());

  program
    .command('export')
    .description('Export decisions as a password-encrypted archive.')
    .option('--out <file>')
    .option('--plaintext', 'write an UNENCRYPTED zip (explicit opt-in)')
    .action((o) => run((c, g) => exportCmd(c, g, o))());
  program
    .command('import <file>')
    .description('Import an export as history only.')
    .action((f) => run((c, g) => importCmd(c, g, f))());

  const recovery = program.command('recovery').description('Back up and verify your keys.');
  recovery
    .command('export')
    .requiredOption('--out <file>')
    .action((o) => run((c, g) => recoveryExport(c, g, o))());
  recovery
    .command('verify <file>')
    .description('Check a recovery kit without installing it.')
    .action((f) => run((c) => recoveryVerify(c, f))());
  recovery
    .command('import <file>')
    .option('--overwrite')
    .description('Restore keys from a recovery kit.')
    .action((f, o) => run((c, g) => recoveryImport(c, g, f, o))());

  program
    .command('delete-data')
    .description('Delete data stored on the relay.')
    .option('--scope <scope>', 'questions | everything', 'questions')
    .option('-y, --yes', 'skip the typed confirmation')
    .action((o) => {
      if (o.scope !== 'questions' && o.scope !== 'everything')
        throw new CliError('--scope must be questions or everything');
      return run((c, g) => deleteData(c, g, o))();
    });

  return program;
}

export function describeError(e: unknown): string {
  if (e instanceof CliError) return e.message;
  if (e instanceof RelayError) {
    const hint =
      e.code === 'network_error'
        ? ' (is the relay reachable?)'
        : e.code === 'not_authenticated'
          ? ' (clock skew or a revoked device?)'
          : '';
    return `${e.code}: ${e.message}${hint}`;
  }
  return (e as Error).message ?? String(e);
}

async function main(): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (
      code === 'commander.helpDisplayed' ||
      code === 'commander.version' ||
      code === 'commander.help'
    )
      return;
    if (typeof code === 'string' && code.startsWith('commander.')) {
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`error: ${describeError(e)}\n`);
    process.exitCode = e instanceof CliError ? e.exitCode : 1;
  }
}

/**
 * True when `moduleUrl` is the script Node was started with. npm runs the CLI through a symlink
 * (`node_modules/.bin/decisions`, or the global bin directory), so both sides are resolved first.
 */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) void main();
