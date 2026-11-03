import { spawn as spawnChild } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PINNED_MANIFEST_SHA256,
  locateRelayBundle,
  stageRelayBundle,
  verifyRelayBundle,
  type VerifiedRelayBundle,
} from '../relay-bundle.js';
import { CliError, keyStoreFor, type Ctx, type GlobalOptions } from '../runtime.js';
import { VERSION } from '../version.js';
import {
  KEY_SECRET,
  MODEL_VAR,
  askDeployQuestions,
  type CloudflareAccount,
  type DeployAnswers,
  type KeyProvider,
} from './deploy-questions.js';
import { doctor } from './ops.js';
import { setup } from './setup.js';

/**
 * `decisions deploy`: puts the relay this CLI was released with into the user's own Cloudflare
 * account with Wrangler, from a verified copy of `@daintreehq/decisions-relay` in a temp directory.
 *
 * The claim secret is generated in memory, handed to `wrangler secret put` on standard input, and
 * shown once at the end. It is never written to a file, a command line or an environment variable.
 * A Cloudflare API token, if the user chooses one, stays in memory and reaches Wrangler only through
 * the environment of its child processes.
 *
 * Run at a terminal, it first logs in, then asks the setup questions (names, account, the optional
 * dictation providers and their keys) and changes nothing in the account until the user confirms a
 * summary. Provider keys follow the claim secret's path: hidden input, memory, Wrangler's stdin.
 * Without a terminal it asks nothing and runs the default steps, as it always has.
 */

export interface DeployOptions {
  name?: string;
  bucket?: string;
  dryRun?: boolean;
  /** Ask for a Cloudflare API token instead of using Wrangler's browser login. */
  apiToken?: boolean;
  accountId?: string;
  /** Claim the relay from this machine (`decisions setup`) once it is deployed. */
  claim?: boolean;
  label?: string;
  /** Verify and write the deployable bundle here, then stop. */
  outdir?: string;
}

export interface SpawnRequest {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Written to the child's standard input (then closed). */
  input?: string;
  /** Capture stdout/stderr (true) or hand the terminal to the child (false, for the browser login). */
  capture: boolean;
  /** Also copy captured output to this process's terminal as it arrives. */
  echo?: boolean;
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Spawner = (req: SpawnRequest) => Promise<SpawnResult>;

export interface DeployDeps {
  spawn?: Spawner;
  bundleDir?: string;
  pinnedManifestSha256?: string | undefined;
  version?: string;
  tmpRoot?: string;
  generateSecret?: () => string;
  sleep?: (ms: number) => Promise<void>;
  nodeVersion?: string;
}

export const DEFAULT_NAME = 'daintree-decisions';

/** Worker names: lowercase letters, digits and dashes, 1–63 characters, no leading/trailing dash. */
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** R2 bucket names: lowercase letters, digits and dashes, 3–63 characters. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

/** The Wrangler argv for each step, shared by the plan and the run so what is shown is what runs. */
export const wranglerCommands = {
  version: () => ['--version'],
  whoami: () => ['whoami'],
  /** The guided run reads the accounts from this; it exits non-zero when not logged in. */
  whoamiJson: () => ['whoami', '--json'],
  login: () => ['login'],
  bucket: (bucket: string) => ['r2', 'bucket', 'create', bucket],
  deploy: () => ['deploy', '--config', 'wrangler.json'],
  secret: (name: string) => wranglerCommands.putSecret('CLAIM_SECRET', name),
  putSecret: (secret: string, name: string) => ['secret', 'put', secret, '--name', name],
};

const npxArgs = (wrangler: string, args: string[]) => ['--yes', `wrangler@${wrangler}`, ...args];
const shown = (wrangler: string, args: string[]) => ['npx', ...npxArgs(wrangler, args)].join(' ');

export type AuthMode = 'browser' | 'token-env' | 'token-prompt';

export type PlanStepId =
  'tools' | 'login' | 'bucket' | 'deploy' | 'claim-secret' | 'keys' | 'check' | 'claim';

export interface PlanStep {
  id: PlanStepId;
  title: string;
  commands: string[];
  notes: string[];
}

export function buildDeployPlan(p: {
  name: string;
  bucket: string;
  wrangler: string;
  auth: AuthMode;
  claim: boolean;
  /** Worker secrets holding provider keys (XAI_API_KEY, ...), set after the claim secret. */
  keySecrets?: string[];
}): PlanStep[] {
  const w = (args: string[]) => shown(p.wrangler, args);
  const steps: PlanStep[] = [
    {
      id: 'tools',
      title: 'Check Node and Wrangler',
      commands: [w(wranglerCommands.version())],
      notes: [`Node 22 or newer; Wrangler ${p.wrangler} exactly (npx downloads it once)`],
    },
    {
      id: 'login',
      title: 'Log in to Cloudflare',
      commands:
        p.auth === 'browser'
          ? [
              w(wranglerCommands.whoami()),
              `${w(wranglerCommands.login())}   (only if not logged in)`,
            ]
          : [w(wranglerCommands.whoami())],
      notes:
        p.auth === 'browser'
          ? ['a browser window opens if you are not logged in yet']
          : p.auth === 'token-prompt'
            ? [
                'asks for an API token; it is kept in memory and passed to Wrangler in its environment',
              ]
            : ['uses the API token already in CLOUDFLARE_API_TOKEN'],
    },
    {
      id: 'bucket',
      title: `Create the private R2 bucket "${p.bucket}"`,
      commands: [w(wranglerCommands.bucket(p.bucket))],
      notes: ['an existing bucket with this name is reused'],
    },
    {
      id: 'deploy',
      title: `Deploy the Worker "${p.name}", its Durable Object and the phone app`,
      commands: [w(wranglerCommands.deploy())],
      notes: ['from a verified copy of the relay bundle in a temporary directory'],
    },
    {
      id: 'claim-secret',
      title: 'Set the one-time claim secret',
      commands: [w(wranglerCommands.secret(p.name))],
      notes: [
        'generated in memory and sent to Wrangler on standard input; never saved, shown once at the end',
        'skipped when the relay is already claimed',
      ],
    },
    ...(p.keySecrets?.length
      ? [
          {
            id: 'keys' as const,
            title: 'Set the dictation provider keys',
            commands: p.keySecrets.map((s) => w(wranglerCommands.putSecret(s, p.name))),
            notes: ['each key is sent to Wrangler on standard input; never saved or shown'],
          },
        ]
      : []),
    {
      id: 'check',
      title: 'Check the deployment',
      commands: [`decisions doctor --url <the Worker URL>`],
      notes: [],
    },
  ];
  if (p.claim) {
    steps.push({
      id: 'claim',
      title: 'Claim the relay from this computer',
      commands: [`decisions setup --url <the Worker URL>   (with the claim secret, in memory)`],
      notes: ["creates this computer's keys and makes it the owner"],
    });
  }
  return steps;
}

const SAFE_SHELL_ARG = /^[A-Za-z0-9@._:=/-]+$/;

/** Runs a child process. Input goes to stdin; it never appears in argv. */
export function nodeSpawner(
  req: SpawnRequest,
  platform: NodeJS.Platform = process.platform,
): Promise<SpawnResult> {
  // Windows only runs npx (a .cmd shim) through a shell. Every argument here is a fixed word or a
  // validated name, never a secret; refuse anything a shell could reinterpret.
  const shell = platform === 'win32';
  if (shell) {
    for (const a of [req.cmd, ...req.args]) {
      if (!SAFE_SHELL_ARG.test(a)) {
        return Promise.reject(
          new CliError(`refusing to pass an unsafe argument to the shell: ${a}`),
        );
      }
    }
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawnChild(req.cmd, req.args, {
      cwd: req.cwd,
      env: req.env,
      shell,
      stdio: [
        req.input !== undefined ? 'pipe' : 'inherit',
        req.capture ? 'pipe' : 'inherit',
        req.capture ? 'pipe' : 'inherit',
      ],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      if (req.echo) process.stdout.write(d);
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      if (req.echo) process.stderr.write(d);
    });
    if (req.input !== undefined && child.stdin) {
      // A child that exits before reading its input must not crash us with EPIPE.
      child.stdin.on('error', () => {});
      child.stdin.end(req.input);
    }
    child.on('error', reject);
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

const WORKERS_DEV_URL = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i;

export async function deploy(
  ctx: Ctx,
  g: GlobalOptions,
  o: DeployOptions,
  deps: DeployDeps = {},
): Promise<void> {
  let name = o.name ?? DEFAULT_NAME;
  let bucket = o.bucket ?? DEFAULT_NAME;
  if (!WORKER_NAME.test(name)) {
    throw new CliError(
      `--name "${name}" is not a valid Worker name (lowercase letters, digits and dashes, up to 63)`,
    );
  }
  if (!BUCKET_NAME.test(bucket)) {
    throw new CliError(
      `--bucket "${bucket}" is not a valid R2 bucket name (lowercase letters, digits and dashes, 3 to 63)`,
    );
  }
  if (o.dryRun && o.outdir) throw new CliError('--dry-run and --outdir cannot be combined');
  if (o.accountId !== undefined && !ACCOUNT_ID.test(o.accountId)) {
    throw new CliError('--account-id must be a 32-character Cloudflare account ID');
  }
  const say = (l = '') => ctx.out(l);
  const version = deps.version ?? VERSION;

  // The bundle is verified on every path, the dry run included: a tampered install fails closed.
  const bundle = await verifyRelayBundle(deps.bundleDir ?? locateRelayBundle(), {
    pinnedSha256:
      'pinnedManifestSha256' in deps ? deps.pinnedManifestSha256 : PINNED_MANIFEST_SHA256,
    version,
  });
  const wrangler = bundle.manifest.wrangler;
  say(
    `Relay ${bundle.manifest.version}: ${bundle.files.size} files verified against manifest SHA-256 ${bundle.manifestSha256}`,
  );

  if (o.outdir) return writeOutdir(ctx, bundle, resolve(o.outdir), { name, bucket });

  if (o.claim) {
    const existing = await keyStoreFor(ctx, g.passphraseEnv).load();
    if (existing && existing.claimed !== false) {
      throw new CliError(
        `this computer already has a Decisions identity (for ${existing.config.relayOrigin}) in ${ctx.home}; ` +
          'drop --claim, or use --home <dir> for a separate identity',
      );
    }
  }

  const auth: AuthMode = o.apiToken
    ? 'token-prompt'
    : ctx.env.CLOUDFLARE_API_TOKEN
      ? 'token-env'
      : 'browser';
  let plan = buildDeployPlan({ name, bucket, wrangler, auth, claim: o.claim === true });
  // A person at the terminal is asked the setup questions before anything is created.
  const guided = ctx.interactive === true;

  if (o.dryRun) {
    say('\nPlan (dry run: nothing is changed, nothing is run):');
    plan.forEach((s, i) => {
      say(`\n[${i + 1}] ${s.title}`);
      for (const c of s.commands) say(`    $ ${c}`);
      for (const n of s.notes) say(`    ${n}`);
    });
    say(`\nEverything is created in your own Cloudflare account. Nothing is sent to anyone else.`);
    return;
  }

  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  if (Number(nodeVersion.split('.')[0]) < 22) {
    throw new CliError(`Node 22 or newer is required (you have ${nodeVersion}).`);
  }

  const spawn = deps.spawn ?? nodeSpawner;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const env: Record<string, string | undefined> = { ...ctx.env };
  // Run as `npx -p @daintreehq/decisions-cli decisions deploy`, npm exports the package list to its
  // children, and the nested `npx wrangler@…` would then run the CLI's package instead of Wrangler.
  delete env.npm_config_package;
  delete env.npm_config_call;
  // Wrangler's debug log (terminal and ~/.wrangler/logs) includes request bodies, such as the
  // secret upload, when sanitizing is turned off; keep it on whatever the user's shell says.
  env.WRANGLER_LOG_SANITIZE = 'true';
  if (o.accountId) env.CLOUDFLARE_ACCOUNT_ID = o.accountId;

  /** Values that must never be echoed back, even inside Wrangler's own error output. */
  const secrets: string[] = [];
  // Longest first, so a shorter value (a rejected key that is a prefix of the accepted one) cannot
  // break up a longer one before it is replaced.
  const redact = (t: string) =>
    [...secrets]
      .sort((x, y) => y.length - x.length)
      .reduce((acc, v) => acc.split(v).join('[redacted]'), t);

  const staging = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'decisions-deploy-'));
  try {
    // A guided run stages the bundle once the names are confirmed; until then Wrangler runs in the
    // empty staging directory, so no config of the user's own can steer the login.
    let cwd = staging;
    if (!guided) {
      await stageRelayBundle(bundle, join(staging, 'relay'), { name, bucket });
      cwd = join(staging, 'relay');
    }
    const at = (id: PlanStepId) => plan.findIndex((s) => s.id === id);
    const heading = (id: PlanStepId) => `\n[${at(id) + 1}] ${plan[at(id)]!.title}`;
    const step = (i: number) => say(`\n[${i + 1}] ${plan[i]!.title}`);
    const wr = (
      args: string[],
      x: {
        capture?: boolean;
        echo?: boolean;
        input?: string;
        env?: Record<string, string>;
      } = {},
    ) => {
      say(`    $ ${shown(wrangler, args)}`);
      return spawn({
        cmd: 'npx',
        args: npxArgs(wrangler, args),
        cwd,
        env: { ...env, ...x.env },
        capture: x.capture ?? true,
        ...(x.echo ? { echo: true } : {}),
        ...(x.input !== undefined ? { input: x.input } : {}),
      });
    };
    const output = (r: SpawnResult) => redact(`${r.stdout}\n${r.stderr}`.trim());

    step(0);
    say(`    Node ${nodeVersion}`);
    const v = await wr(wranglerCommands.version());
    if (v.status !== 0) {
      throw new CliError(
        `could not run Wrangler ${wrangler} through npx (is npm installed and the registry reachable?)\n${output(v)}`,
      );
    }
    say(`    Wrangler ${v.stdout.trim().split('\n').pop()}`);

    step(1);
    if (auth === 'token-prompt') {
      const token = (
        await ctx.prompt('Cloudflare API token (input hidden): ', { secret: true })
      ).trim();
      if (!token) throw new CliError('no API token entered');
      secrets.push(token);
      env.CLOUDFLARE_API_TOKEN = token;
    } else if (auth === 'token-env') {
      secrets.push(ctx.env.CLOUDFLARE_API_TOKEN!);
    }
    const whoArgs = guided ? wranglerCommands.whoamiJson() : wranglerCommands.whoami();
    let who = await wr(whoArgs);
    const loggedIn = who.status === 0 && !/not authenticated|not logged in/i.test(output(who));
    if (auth !== 'browser') {
      if (!loggedIn) throw new CliError(`Cloudflare refused the API token:\n${output(who)}`);
      say('    using the API token');
    } else if (loggedIn) {
      say('    already logged in');
    } else {
      say('    a browser window opens to log in to Cloudflare');
      const login = await wr(wranglerCommands.login(), { capture: false });
      if (login.status !== 0) throw new CliError('Cloudflare login failed');
      if (guided) who = await wr(whoArgs);
    }

    let answers: DeployAnswers | null = null;
    if (guided) {
      const accounts = accountsFromWhoami(who.stdout);
      const fixed = o.accountId ?? ctx.env.CLOUDFLARE_ACCOUNT_ID;
      const account: CloudflareAccount | null = fixed
        ? (accounts.find((a) => a.id.toLowerCase() === fixed.toLowerCase()) ?? {
            id: fixed,
            name: '',
          })
        : accounts.length === 1
          ? accounts[0]!
          : null;
      answers = await askDeployQuestions(
        ctx,
        { name, bucket, account, accounts },
        {
          name: { pattern: WORKER_NAME, hint: 'lowercase letters, digits and dashes, up to 63' },
          bucket: { pattern: BUCKET_NAME, hint: 'lowercase letters, digits and dashes, 3 to 63' },
        },
        (v) => secrets.push(v),
      );
      if (!answers) {
        say('\nCancelled: nothing in your Cloudflare account was changed.');
        return;
      }
      name = answers.name;
      bucket = answers.bucket;
      if (answers.account) env.CLOUDFLARE_ACCOUNT_ID = answers.account.id;
      plan = buildDeployPlan({
        name,
        bucket,
        wrangler,
        auth,
        claim: o.claim === true,
        keySecrets: keySecretsOf(answers).map((k) => k.secret),
      });
      const cleanup = answers.cleanup;
      await stageRelayBundle(bundle, join(staging, 'relay'), {
        name,
        bucket,
        ...(cleanup ? { vars: { [MODEL_VAR[cleanup.provider]]: cleanup.model } } : {}),
      });
      cwd = join(staging, 'relay');
    }
    const keySecrets = answers ? keySecretsOf(answers) : [];

    /** Sets each chosen provider key as a Worker secret, the value on stdin only. */
    const setKeys = async (): Promise<CliError | null> => {
      if (!keySecrets.length) return null;
      say(heading('keys'));
      for (const k of keySecrets) {
        const r = await wr(wranglerCommands.putSecret(k.secret, name), {
          input: k.value + '\n',
          env: { WRANGLER_WRITE_LOGS: 'false' },
        });
        if (r.status !== 0) {
          return new CliError(
            `Wrangler reported an error while setting ${k.secret}; run the deploy again to set it.\n${output(r)}`,
          );
        }
        say(`    ${k.secret} set`);
      }
      return null;
    };

    step(at('bucket'));
    const b = await wr(wranglerCommands.bucket(bucket));
    if (b.status === 0) say('    created');
    else if (/already exists|already own/i.test(output(b))) say('    already exists, reusing it');
    else {
      throw new CliError(
        `could not create the R2 bucket. If R2 is not enabled on your account yet, enable it in the Cloudflare dashboard first.\n${output(b)}`,
      );
    }

    step(at('deploy'));
    const dep = await wr(wranglerCommands.deploy(), { echo: true });
    if (dep.status !== 0) throw new CliError(`deploy failed:\n${output(dep)}`);
    const url = output(dep).match(WORKERS_DEV_URL)?.[0];
    say(url ? `    deployed: ${url}` : '    deployed (no workers.dev URL in the output)');

    step(at('claim-secret'));
    const state = url ? await claimState(ctx, url, sleep) : 'unknown';
    if (state === 'claimed') {
      say('    the relay is already claimed: this was an update, the claim secret is unchanged');
      const keyFailure = await setKeys();
      const healthy = await check(ctx, g, url!, sleep, heading('check'));
      summary(ctx, {
        url,
        claimSecret: null,
        claimedHere: false,
        state,
        problems: !healthy || keyFailure !== null,
      });
      if (keyFailure) throw keyFailure;
      if (!healthy) throw new CliError('deployed, but the health check found problems');
      return;
    }
    const claimSecret = (deps.generateSecret ?? (() => randomBytes(32).toString('hex')))();
    secrets.push(claimSecret);

    // From the moment the upload starts the secret may be live on the Worker, so whatever happens
    // next, it is shown (once) before the command ends.
    let claimedHere = false;
    let failure: CliError | null = null;
    const afterSecret = async (): Promise<CliError | null> => {
      const sec = await wr(wranglerCommands.secret(name), {
        input: claimSecret + '\n',
        // Belt and braces: no debug log file at all for the one command that carries the secret.
        env: { WRANGLER_WRITE_LOGS: 'false' },
      });
      if (sec.status !== 0) {
        return new CliError(
          `Wrangler reported an error while setting the claim secret; it may or may not have been set. Run the deploy again if claiming fails.\n${output(sec)}`,
        );
      }
      say('    set (the value is shown once at the end)');
      const keyFailure = await setKeys();
      if (keyFailure) return keyFailure;
      if (!url) {
        return o.claim
          ? new CliError(
              'deployed, but Wrangler did not print the Worker URL, so the relay was not claimed',
            )
          : null;
      }
      const healthy = await check(ctx, g, url, sleep, heading('check'));
      if (o.claim) {
        say(heading('claim'));
        try {
          await setup({ ...ctx, env: { ...ctx.env, DECISIONS_CLAIM_SECRET: claimSecret } }, g, {
            url,
            label: o.label ?? 'Daintree',
          });
          claimedHere = true;
        } catch (e) {
          return new CliError(
            `deployed, but claiming from this computer failed: ${redact((e as Error).message)}`,
          );
        }
      }
      return healthy ? null : new CliError('deployed, but the health check found problems');
    };
    let finished = false;
    try {
      failure = await afterSecret();
      finished = true;
    } finally {
      summary(ctx, {
        url,
        claimSecret: claimedHere ? null : claimSecret,
        claimedHere,
        state,
        problems: !finished || failure !== null,
      });
    }
    if (failure) throw failure;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The Worker secrets for the answers' provider keys, one per provider however many features use it. */
function keySecretsOf(a: DeployAnswers): { secret: string; value: string }[] {
  return (Object.keys(KEY_SECRET) as KeyProvider[]).flatMap((p) => {
    const value = a.keys[p];
    return value ? [{ secret: KEY_SECRET[p], value }] : [];
  });
}

/** The accounts in `wrangler whoami --json` output; empty when it cannot be read. */
export function accountsFromWhoami(stdout: string): CloudflareAccount[] {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as { accounts?: unknown };
    if (!Array.isArray(parsed.accounts)) return [];
    return parsed.accounts.flatMap((a: unknown) => {
      const { id, name } = (a ?? {}) as { id?: unknown; name?: unknown };
      return typeof id === 'string' && ACCOUNT_ID.test(id)
        ? [{ id, name: typeof name === 'string' ? name : '' }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * Whether the freshly deployed relay is already claimed. A new workers.dev route can take a moment
 * to answer, so this retries for a while; 'unknown' means it never gave a clear answer.
 */
async function claimState(
  ctx: Ctx,
  url: string,
  sleep: (ms: number) => Promise<void>,
): Promise<'claimed' | 'unclaimed' | 'unknown'> {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await ctx.fetch(`${url}/api/v1/info`);
      if (r.ok) {
        const claimed = ((await r.json()) as { claimed?: unknown }).claimed;
        if (claimed === true) return 'claimed';
        if (claimed === false) return 'unclaimed';
      }
    } catch {
      /* not reachable yet */
    }
    await sleep(2000);
  }
  return 'unknown';
}

/** Waits for the new Worker to answer, then runs the doctor. Resolves to whether it passed. */
async function check(
  ctx: Ctx,
  g: GlobalOptions,
  url: string,
  sleep: (ms: number) => Promise<void>,
  heading: string,
): Promise<boolean> {
  ctx.out(heading);
  for (let i = 0; i < 10; i++) {
    try {
      if ((await ctx.fetch(`${url}/health`)).ok) break;
    } catch {
      /* not reachable yet */
    }
    await sleep(3000);
  }
  try {
    await doctor({ ...ctx, json: false }, g, { url });
    return true;
  } catch (e) {
    ctx.err(
      `    ${(e as Error).message}; a new deployment can take a minute, then run: decisions doctor --url ${url}`,
    );
    return false;
  }
}

function summary(
  ctx: Ctx,
  s: {
    url: string | undefined;
    claimSecret: string | null;
    claimedHere: boolean;
    state: 'claimed' | 'unclaimed' | 'unknown';
    problems: boolean;
  },
): void {
  const url = s.url ?? '<your Worker URL, from the Cloudflare dashboard>';
  const lines = [
    '',
    s.problems ? 'Deployed, with problems (see above).' : 'Done.',
    '',
    `  Worker URL    ${url}`,
  ];
  if (s.state === 'claimed') {
    lines.push(
      '',
      'The relay was already claimed, so nothing else is needed. Paired phones keep working.',
    );
  } else if (s.claimedHere) {
    lines.push(
      '',
      'This computer claimed the relay, so the claim secret has been used and is not needed again.',
      'Next: pair your phone with `decisions pair`.',
    );
  } else if (s.claimSecret) {
    lines.push(
      `  Claim secret  ${s.claimSecret}`,
      '',
      'Copy the claim secret now: it is shown only this once and is not saved anywhere.',
      'Next: in Daintree, open Settings > Decisions and enter the Worker URL and the claim secret.',
      'Without Daintree, claim the relay from this computer; it asks for the claim secret:',
      `  npx @daintreehq/decisions-cli setup --url ${url}`,
    );
    if (s.state === 'unknown') {
      lines.push(
        '',
        'The relay did not answer yet, so it could not be checked whether it was already claimed.',
        'If it was, it stays claimed by the same owner and this new secret has no effect.',
      );
    }
  }
  ctx.out(lines.join('\n'));
}

async function writeOutdir(
  ctx: Ctx,
  bundle: VerifiedRelayBundle,
  dir: string,
  o: { name: string; bucket: string },
): Promise<void> {
  const entries = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  if (entries.length) throw new CliError(`${dir} is not empty`);
  await stageRelayBundle(bundle, dir, o);
  ctx.out(
    [
      `Wrote the verified relay to ${dir}`,
      'Deploy it yourself with:',
      `  cd ${dir} && ${shown(bundle.manifest.wrangler, wranglerCommands.deploy())}`,
    ].join('\n'),
  );
}
