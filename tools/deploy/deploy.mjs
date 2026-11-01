#!/usr/bin/env node
// Guided deploy of the Decisions relay to your own Cloudflare account using Wrangler.
//   node tools/deploy/deploy.mjs [--name daintree-decisions] [--bucket daintree-decisions] [--dry-run] [--yes]
// Everything it creates lives in your account. Nothing is sent to anyone else. Use --dry-run to print the plan.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DRY = flag('dry-run');
const name = opt('name', 'daintree-decisions');
const bucket = opt('bucket', 'daintree-decisions');

const say = (m) => console.log(m);
const step = (n, m) => say(`\n[${n}] ${m}`);

function run(cmd, cmdArgs, o = {}) {
  const shown = [cmd, ...cmdArgs].join(' ');
  if (DRY) {
    say(`  (dry run) ${shown}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  const r = spawnSync(cmd, cmdArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: o.inherit ? 'inherit' : 'pipe',
    input: o.input,
    env: process.env,
  });
  if (r.error) throw r.error;
  return r;
}

function fail(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) fail(`Node 22 or newer is required (you have ${process.versions.node}).`);

step(1, 'Checking tools');
const pnpm = run('pnpm', ['--version']);
if (pnpm.status !== 0)
  fail('pnpm is required (corepack enable && corepack prepare pnpm@10 --activate).');
const wr = run('pnpm', ['exec', 'wrangler', '--version']);
if (wr.status !== 0) fail('wrangler is not installed. Run `pnpm install` first.');
say(`  pnpm ${pnpm.stdout.trim()} / wrangler ${wr.stdout.trim()}`);

step(2, 'Logging in to Cloudflare (a browser window may open)');
const who = run('pnpm', ['exec', 'wrangler', 'whoami']);
if (DRY || who.status !== 0 || /not authenticated/i.test(who.stdout + who.stderr)) {
  const login = run('pnpm', ['exec', 'wrangler', 'login'], { inherit: true });
  if (login.status !== 0) fail('Cloudflare login failed.');
} else {
  say('  already logged in');
}

step(3, `Creating the private R2 bucket "${bucket}" (an existing one is reused)`);
const b = run('pnpm', ['exec', 'wrangler', 'r2', 'bucket', 'create', bucket]);
if (b.status !== 0 && !/already exists/i.test(b.stdout + b.stderr)) {
  fail(
    `could not create the R2 bucket. If R2 is not enabled yet, enable it in the Cloudflare dashboard first.\n${b.stderr}`,
  );
}

step(4, 'Building');
if (run('pnpm', ['install', '--frozen-lockfile'], { inherit: true }).status !== 0)
  fail('install failed');
if (run('pnpm', ['build'], { inherit: true }).status !== 0) fail('build failed');

step(5, 'Deploying the Worker, Durable Object and web app');
const dep = run('pnpm', ['exec', 'wrangler', 'deploy', '--name', name]);
if (dep.status !== 0) fail(`deploy failed:\n${dep.stdout}\n${dep.stderr}`);
const url =
  (dep.stdout + dep.stderr).match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i)?.[0] ??
  '(see the output above)';
say(`  deployed: ${url}`);

step(6, 'Setting your one-time claim secret');
const claim = randomBytes(32).toString('hex');
const sec = run('pnpm', ['exec', 'wrangler', 'secret', 'put', 'CLAIM_SECRET', '--name', name], {
  input: claim + '\n',
});
if (sec.status !== 0) fail(`could not set the secret:\n${sec.stderr}`);

if (!DRY) {
  const dir = join(process.env.DECISIONS_HOME ?? join(homedir(), '.decisions'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'deploy.json');
  writeFileSync(
    file,
    JSON.stringify({ url, claim_secret: claim, created_at: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  say(`  saved to ${file} (readable only by you; delete it after setup)`);
}

step(7, 'Checking the deployment');
if (!DRY && url.startsWith('https://')) {
  const doc = run(process.execPath, [join(root, 'tools/doctor/doctor.mjs'), '--url', url]);
  say(doc.stdout || doc.stderr);
}

say(`
Done. Next:
  1. Tell Daintree (Settings > Decisions) or run:
       pnpm decisions setup --url ${url} --claim-secret <value from ${join('~', '.decisions', 'deploy.json')}>
  2. Pair your phone:  pnpm decisions pair
  3. On iPhone: open the link in Safari, Share > Add to Home Screen, then open the installed app to enable notifications.
`);
void existsSync;
void readFileSync;
