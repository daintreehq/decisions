#!/usr/bin/env node
/**
 * Publishes every public workspace package to npm, dependencies first, at one shared version.
 *
 *   node tools/release/publish.mjs --dry-run [--tag vX.Y.Z] [--no-build]
 *   node tools/release/publish.mjs --tag vX.Y.Z [--no-build]          (release workflow only)
 *   node tools/release/publish.mjs --check [--tag vX.Y.Z]               (checks only, offline)
 *   node tools/release/publish.mjs --bootstrap [--dry-run]              (one-time, from a laptop)
 *
 * Packages are packed with `pnpm pack` (which turns `workspace:*` into the real version) and the
 * tarballs are uploaded with `npm publish <tarball> --provenance`, because npm >= 11.5.1 is what
 * performs the trusted-publishing (OIDC) token exchange. A name@version that is already on the
 * registry is skipped, so a failed run can simply be re-run.
 *
 * --dry-run     Do everything except upload: check versions and metadata, pack, inspect each
 *               tarball, query the registry and run `npm publish --dry-run`. CI runs this on
 *               every pull request.
 * --check       Only check the shared version, the tag and package metadata, then stop.
 * --tag <tag>   The git tag being released; must equal `v<version>`. Required to publish.
 * --no-build    Use the existing `dist` output instead of building first.
 * --out <dir>   Write the tarballs here instead of a temp directory (kept afterwards).
 * --bootstrap   Publish a placeholder `0.0.0-bootstrap.0` (dist-tag `bootstrap`, deprecated) for
 *               each package that does not exist on npm yet, using your own `npm login`. npm only
 *               lets you configure a trusted publisher on a package that already exists. npm also
 *               makes a first version `latest`, so the placeholder is `latest` until the first
 *               real release.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  REPOSITORY,
  ROOT,
  RUNTIME_DEP_FIELDS,
  compareVersions,
  distTagFor,
  listWorkspace,
  parseNpmView,
  publishInOrder,
  publishOrder,
  readVersionConstants,
  releaseProblems,
} from './workspace.mjs';

const MIN_NPM = '11.5.1';
const BOOTSTRAP_VERSION = '0.0.0-bootstrap.0';

const { values: opts } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    tag: { type: 'string' },
    'no-build': { type: 'boolean', default: false },
    out: { type: 'string' },
    bootstrap: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
  },
  strict: true,
});
const dryRun = opts['dry-run'];

const log = (msg) => console.log(msg);
const step = (msg) => console.log(`\n> ${msg}`);

/** Creates a temp directory that is removed however the process exits (die() exits directly). */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function die(msg) {
  console.error(`\npublish: ${msg}`);
  process.exit(1);
}

/**
 * The environment for a child process. `pnpm run` exports its own settings as `npm_config_*`,
 * which npm would then read (and warn about); npm gets a clean environment instead.
 */
function envFor(cmd) {
  if (cmd !== 'npm' || !process.env.npm_config_user_agent?.startsWith('pnpm')) return process.env;
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith('npm_config_')),
  );
}

/** Runs a command and returns its stdout; stderr streams through unless `quiet`. */
function capture(cmd, args, { cwd = ROOT, quiet = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    env: envFor(cmd),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'],
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout };
}

function run(cmd, args, { cwd = ROOT } = {}) {
  execFileSync(cmd, args, { cwd, env: envFor(cmd), stdio: 'inherit' });
}

/** Whether name@version is on the registry. Throws on registry or network errors. */
function isPublished(name, version, cwd) {
  const { status, stdout } = capture('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    cwd,
    quiet: true,
  });
  return parseNpmView(stdout, version, status);
}

/** Whether the package exists on npm at all (`npm view <name> name` prints the name). */
function packageExists(name, cwd) {
  const { status, stdout } = capture('npm', ['view', name, 'name', '--json'], {
    cwd,
    quiet: true,
  });
  return parseNpmView(stdout, name, status);
}

function npmVersion() {
  return capture('npm', ['--version'], { cwd: tmpdir(), quiet: true }).stdout.trim();
}

const workspace = listWorkspace();
let order;
try {
  order = publishOrder(workspace);
} catch (err) {
  die(err.message);
}
step(`Publishable packages, in publish order`);
for (const p of order) log(`  ${p.name}@${p.version}  (${p.dir})`);

if (opts.bootstrap) {
  bootstrap(order);
  process.exit(0);
}

// ---- Release checks -------------------------------------------------------------------------

if (!dryRun && !opts.check && !opts.tag)
  die('--tag vX.Y.Z is required to publish (or pass --dry-run)');
let constants;
try {
  constants = readVersionConstants();
} catch (err) {
  die(err.message);
}
const problems = releaseProblems(order, { tag: opts.tag, constants, workspace });
if (problems.length) die(`not releasable:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
const version = order[0].version;
const distTag = distTagFor(version);
log(`\n  version ${version}, dist-tag ${distTag}${opts.tag ? `, tag ${opts.tag}` : ''}`);
if (opts.check) {
  log('\nRelease checks passed.');
  process.exit(0);
}

if (!dryRun) {
  const npm = npmVersion();
  if (compareVersions(npm, MIN_NPM) < 0) {
    die(`npm ${npm} cannot do trusted publishing; npm >= ${MIN_NPM} is required`);
  }
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    die(
      'publishing runs only in GitHub Actions with `permissions: id-token: write` ' +
        '(trusted publishing); use --dry-run locally',
    );
  }
  if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN) {
    log('  warning: NODE_AUTH_TOKEN/NPM_TOKEN is set; trusted publishing does not need it');
  }
}

// ---- Build and pack -------------------------------------------------------------------------

if (!opts['no-build']) {
  step('Building the publishable packages');
  run('pnpm', ['-r', ...order.flatMap((p) => ['--filter', p.name]), 'build']);
}

const out = opts.out ? resolve(opts.out) : tempDir('decisions-release-');
mkdirSync(out, { recursive: true });
step(`Packing into ${out}`);
const own = new Map(order.map((p) => [p.name, p.version]));
const packed = [];
const tarballProblems = [];
for (const pkg of order) {
  const { status, stdout } = capture('pnpm', ['pack', '--json', '--pack-destination', out], {
    cwd: join(ROOT, pkg.dir),
  });
  if (status !== 0) die(`pnpm pack failed for ${pkg.name}`);
  const { filename } = JSON.parse(stdout.slice(stdout.indexOf('{')));
  const manifest = JSON.parse(
    execFileSync('tar', ['-xzOf', filename, 'package/package.json'], { encoding: 'utf8' }),
  );
  if (manifest.name !== pkg.name || manifest.version !== version) {
    tarballProblems.push(`${filename}: holds ${manifest.name}@${manifest.version}`);
  }
  if (manifest.private) tarballProblems.push(`${pkg.name}: tarball manifest is private`);
  for (const field of RUNTIME_DEP_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (range.startsWith('workspace:')) {
        tarballProblems.push(`${pkg.name}: ${field}.${dep} is still ${range}`);
      } else if (own.has(dep) && range !== own.get(dep)) {
        tarballProblems.push(`${pkg.name}: ${field}.${dep} is ${range}, expected ${own.get(dep)}`);
      }
    }
  }
  log(`  ${pkg.name}@${version} -> ${filename}`);
  packed.push({ pkg, tarball: filename });
}
if (tarballProblems.length) {
  die(`bad tarballs:\n${tarballProblems.map((p) => `  - ${p}`).join('\n')}`);
}

// ---- Publish ------------------------------------------------------------------------------

step(dryRun ? 'Dry run: checking the registry and npm publish --dry-run' : 'Publishing to npm');
let summary;
try {
  summary = publishInOrder(packed, {
    version,
    dryRun,
    log,
    isPublished: (name) => isPublished(name, version, out),
    publish: (tarball) =>
      run('npm', ['publish', tarball, '--access', 'public', '--tag', distTag, '--provenance'], {
        cwd: out,
      }),
    dryRunPublish: (tarball) =>
      run('npm', ['publish', tarball, '--access', 'public', '--tag', distTag, '--dry-run'], {
        cwd: out,
      }),
  });
} catch (err) {
  die(err.message);
}

step('Summary');
for (const line of summary) log(`  ${line}`);
if (dryRun) log(`\nDry run complete: nothing was published.`);

// ---- Bootstrap ------------------------------------------------------------------------------

function bootstrap(packages) {
  const work = tempDir('decisions-bootstrap-');
  step(`Placeholder ${BOOTSTRAP_VERSION} for packages that are not on npm yet`);
  const missing = packages.filter((p) => !packageExists(p.name, work));
  for (const p of packages) {
    log(`  ${p.name}: ${missing.includes(p) ? 'not on npm' : 'exists, nothing to do'}`);
  }
  if (missing.length === 0) {
    log('\nEvery package exists on npm. Configure the trusted publishers (docs/operations.md).');
    return;
  }
  if (!dryRun) {
    const who = capture('npm', ['whoami'], { cwd: work, quiet: true });
    if (who.status !== 0) die('run `npm login` first (an account in the daintreehq npm org)');
    log(`\n  publishing as ${who.stdout.trim()}`);
  }
  for (const p of missing) {
    const dir = join(work, p.name.replace('/', '__'));
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: p.name,
          version: BOOTSTRAP_VERSION,
          description: `Placeholder that reserves ${p.name} so its trusted publisher can be configured. Install a real release instead.`,
          license: p.manifest.license,
          repository: {
            type: 'git',
            url: `https://github.com/${REPOSITORY}.git`,
            directory: p.dir,
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(dir, 'README.md'),
      `# ${p.name}\n\nPlaceholder. Real releases are published from https://github.com/${REPOSITORY}.\n`,
    );
    const args = ['publish', '--access', 'public', '--tag', 'bootstrap'];
    if (dryRun) {
      run('npm', [...args, '--dry-run'], { cwd: dir });
      continue;
    }
    run('npm', args, { cwd: dir });
    const dep = spawnSync(
      'npm',
      [
        'deprecate',
        `${p.name}@${BOOTSTRAP_VERSION}`,
        'Placeholder, not a release. Install a real version.',
      ],
      { cwd: dir, env: envFor('npm'), stdio: 'inherit' },
    );
    if (dep.status !== 0) log(`  warning: could not deprecate ${p.name}@${BOOTSTRAP_VERSION}`);
  }
  log(
    dryRun
      ? '\nDry run complete: nothing was published.'
      : '\nPlaceholders published. Now configure a trusted publisher for each package (docs/operations.md).',
  );
}
