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
import { deploy } from './commands/deploy.js';
import { remove } from './commands/remove.js';
import { update } from './commands/update.js';
import { devices, pair, revoke, rotate, setup } from './commands/setup.js';
import { hostAccept, hostEnroll, hostRequest } from './commands/host.js';
import { VERSION } from './version.js';

const collect = (v: string, prev: string[] = []) => [...prev, v];

const SINK_HELP =
  'stdout | file:<path> | exec:<command> (the command reads the answer on stdin; exit 0 = delivered, 75 = retry later, anything else = may have been delivered, never retried)';

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
    .command('deploy')
    .description(
      'Deploy the relay that matches this CLI to your own Cloudflare account (checksummed; the claim secret is shown once, never saved).',
    )
    .option('--name <name>', 'Worker name', 'daintree-decisions')
    .option('--bucket <name>', 'R2 bucket name', 'daintree-decisions')
    .option('--dry-run', 'verify the bundle and print the plan without changing anything')
    .option(
      '--api-token',
      "ask for a Cloudflare API token (kept in memory) instead of Wrangler's browser login",
    )
    .option('--account-id <id>', 'Cloudflare account ID, if your login or token has several')
    .option(
      '--claim',
      'claim the relay from this computer once it is deployed (as `decisions setup`)',
    )
    .option('--label <name>', 'name for this computer when claiming', 'Daintree')
    .option('--outdir <dir>', 'only verify and write the deployable bundle to <dir>')
    .action((o) => run((c, g) => deploy(c, g, o))());

  program
    .command('remove <target>')
    .description(
      'Remove a deployed relay from Cloudflare: its Worker, Durable Object storage and R2 bucket (target: its URL or Worker name). Needs no relay keys.',
    )
    .option('--account-id <id>', 'Cloudflare account ID, if your login or token has several')
    .option(
      '--api-token',
      "ask for a Cloudflare API token (kept in memory) instead of Wrangler's browser login",
    )
    .option(
      '--bucket <name>',
      'finish removing this R2 bucket when the Worker is already gone (only needed without a record of the earlier run)',
    )
    .option('--dry-run', 'list what would be removed without deleting anything')
    .action((target, o) => run((c, g) => remove(c, g, target, o))());

  program
    .command('update')
    .description(
      'Update a deployed relay to the newest compatible release, keeping its claim, data, bucket, secrets and settings.',
    )
    .requiredOption('--url <origin>', 'the https URL of the relay')
    .option('--name <name>', 'the Worker name, when it cannot be found from the URL')
    .option('--account-id <id>', 'Cloudflare account ID, if your login or token has several')
    .option(
      '--protocol <range>',
      "protocol versions the caller supports, like 1 or 1-2 (default: this CLI's own)",
    )
    .option('--to <version>', 'update to exactly this release instead of the newest compatible one')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--dry-run', 'show what would change without changing anything')
    .option(
      '--api-token',
      "ask for a Cloudflare API token (kept in memory) instead of Wrangler's browser login",
    )
    .action((o) => run((c, g) => update(c, g, o))());

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

  const host = program
    .command('host')
    .description('Enroll another machine (a Daintree Host) as its own desktop-host device.');
  host
    .command('request')
    .description('On the Host: create its keys and print an enrollment request for the owner.')
    .option('--label <name>', 'name for this Host (default: the hostname)')
    .option('--new', 'discard any pending request and start over with new keys')
    .action((o) => run((c, g) => hostRequest(c, g, o))());
  host
    .command('enroll [request]')
    .description(
      'On the owner machine: check a request, register the Host with the relay and print its response (request from the argument, --request-file, or stdin with --yes).',
    )
    .option('--request-file <file>', 'read the request from a file')
    .option('-y, --yes', 'do not ask to confirm the code')
    .action((request, o) => run((c, g) => hostEnroll(c, g, { ...o, request }))());
  host
    .command('accept [response]')
    .description(
      "On the Host: check the owner's response and store it as this machine's identity (response from the argument, --response-file, or stdin).",
    )
    .option('--response-file <file>', 'read the response from a file')
    .option('--offline', 'do not confirm the enrollment with the relay')
    .action((response, o) => run((c, g) => hostAccept(c, g, { ...o, response }))());

  program
    .command('listen')
    .description(
      'Receive answers and print / pipe them (demo sink; Daintree types them into the agent pane).',
    )
    .option('--sink <sink>', SINK_HELP, 'stdout')
    .option('--no-socket', 'poll once over HTTP instead of keeping a live socket')
    .action((o) => run((c, g) => daemon(c, g, { sink: o.sink, socket: o.socket }))());

  program
    .command('mcp')
    .description(
      'Serve the Decisions HTTP MCP on 127.0.0.1 (plus the relay connection) and print how to add it.',
    )
    .option('--port <n>', 'port (default: a free one)', (v) => Number(v))
    .option(
      '--path <path>',
      'serve the MCP at exactly this path, e.g. /mcp/decisions (default: /mcp; subpaths are 404)',
    )
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
    .option('--sink <sink>', SINK_HELP, 'stdout')
    .action((o) =>
      run((c, g) =>
        daemon(c, g, {
          sink: o.sink,
          mcp: {
            ...(o.port ? { port: o.port } : {}),
            ...(o.path !== undefined ? { path: o.path } : {}),
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
    .option('--sink <sink>', SINK_HELP, 'stdout')
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
    .option('--out <file>', 'where to write the archive')
    .option('--plaintext', 'write an UNENCRYPTED zip (explicit opt-in)')
    .action((o) => run((c, g) => exportCmd(c, g, o))());
  program
    .command('import <file>')
    .description('Import an export as history only.')
    .action((f) => run((c, g) => importCmd(c, g, f))());

  const recovery = program.command('recovery').description('Back up and verify your keys.');
  const passphraseHelp =
    'The passphrase is asked for, or read from $DECISIONS_RECOVERY_PASSPHRASE when it is set.';
  recovery
    .command('export')
    .description('Write a passphrase-encrypted recovery kit of this installation’s keys.')
    .requiredOption('--out <file>', 'where to write the kit (mode 0600)')
    .addHelpText('after', `\n${passphraseHelp}`)
    .action((o) => run((c, g) => recoveryExport(c, g, o))());
  recovery
    .command('verify <file>')
    .description('Check a recovery kit without installing it.')
    .addHelpText('after', `\n${passphraseHelp}`)
    .action((f) => run((c) => recoveryVerify(c, f))());
  recovery
    .command('import <file>')
    .option('--overwrite', 'replace keys already on this machine')
    .description('Restore keys from a recovery kit.')
    .addHelpText('after', `\n${passphraseHelp}`)
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
