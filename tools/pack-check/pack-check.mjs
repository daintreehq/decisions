#!/usr/bin/env node
/**
 * Proves the published packages work outside the workspace.
 *
 * 1. Builds every library and the CLI.
 * 2. Packs each one with `pnpm pack` into a temp directory and checks the tarball holds only the
 *    intended files, that `main`/`types`/`exports`/`bin` point at files that are in it, and that no
 *    `workspace:` range survived.
 * 3. Creates a scratch project outside the workspace, installs the tarballs with npm, imports every
 *    package under Node, runs the CLI, and type-checks a TypeScript file against the declarations
 *    (NodeNext and Bundler resolution, without the workspace's source condition).
 *
 * Usage: node tools/pack-check/pack-check.mjs [--no-build] [--keep]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listWorkspace } from '../release/workspace.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const args = new Set(process.argv.slice(2));
const build = !args.has('--no-build');
const keep = args.has('--keep');

/** The export condition the workspace uses to resolve packages to TypeScript source. */
const SOURCE_CONDITION = '@daintreehq/source';

/**
 * Every published package, with the files it may ship beyond package.json, README.md, LICENSE,
 * NOTICE and compiled `dist/**.js` / `dist/**.d.ts`.
 */
const PACKAGES = [
  { dir: 'packages/protocol', extra: ['openapi.json', 'schemas.json'] },
  { dir: 'packages/crypto', extra: ['fixtures/vectors.json'] },
  { dir: 'packages/client', extra: [] },
  { dir: 'packages/decision-model', extra: [] },
  { dir: 'packages/cli', extra: [] },
];
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'NOTICE'];

const failures = [];
const fail = (msg) => failures.push(msg);
const step = (msg) => console.log(`\n> ${msg}`);

function run(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, {
    stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    ...opts,
  });
}

/** Collects every file path an `exports` value can resolve to, skipping the source condition. */
function exportTargets(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => exportTargets(v, out));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key !== SOURCE_CONDITION) exportTargets(v, out);
    }
  }
  return out;
}

const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

function checkTarball(spec, tarball, ownVersions) {
  const name = spec.dir;
  const files = run('tar', ['-tzf', tarball], { capture: true })
    .split('\n')
    .filter((f) => f && !f.endsWith('/'))
    .map((f) => f.replace(/^package\//, ''));
  const fileSet = new Set(files);
  const allowed = new Set([...REQUIRED, ...spec.extra]);
  for (const f of files) {
    const ok = allowed.has(f) || /^dist\/.+\.(js|d\.ts)$/.test(f);
    if (!ok) fail(`${name}: unexpected file in tarball: ${f}`);
  }
  for (const f of [...REQUIRED, ...spec.extra]) {
    if (!fileSet.has(f)) fail(`${name}: missing from tarball: ${f}`);
  }
  for (const f of ['LICENSE', 'NOTICE']) {
    const local = readFileSync(join(ROOT, spec.dir, f), 'utf8');
    if (local !== readFileSync(join(ROOT, f), 'utf8'))
      fail(`${name}: ${f} differs from the root ${f}`);
  }

  const pkg = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json'], { capture: true }));
  const has = (p) => fileSet.has(p.replace(/^\.\//, ''));
  for (const field of ['main', 'types']) {
    if (pkg[field] !== undefined && !has(pkg[field]))
      fail(`${name}: ${field} -> ${pkg[field]} is not in the tarball`);
  }
  for (const target of exportTargets(pkg.exports)) {
    if (!has(target)) fail(`${name}: exports -> ${target} is not in the tarball`);
  }
  for (const target of Object.values(
    typeof pkg.bin === 'string' ? { x: pkg.bin } : (pkg.bin ?? {}),
  )) {
    if (!has(target)) fail(`${name}: bin -> ${target} is not in the tarball`);
  }
  if (pkg.private) fail(`${name}: package is private`);
  for (const field of DEP_FIELDS) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (range.startsWith('workspace:')) fail(`${name}: ${field}.${dep} is still ${range}`);
      if (ownVersions.has(dep) && range !== ownVersions.get(dep)) {
        fail(`${name}: ${field}.${dep} is ${range}, expected ${ownVersions.get(dep)}`);
      }
    }
  }
  console.log(`  ${pkg.name}@${pkg.version}: ${files.length} files`);
  return pkg;
}

const SMOKE = `
import assert from 'node:assert/strict';
import * as protocol from '@daintreehq/decisions-protocol';
import * as crypto from '@daintreehq/decisions-crypto';
import * as client from '@daintreehq/decisions-client';
import * as model from '@daintreehq/decisions-model';
import { createRequire } from 'node:module';

assert.equal(typeof protocol.PROTOCOL_VERSION, 'number');
assert.equal(typeof protocol.ApiError, 'function');
const keys = await crypto.generateDeviceKeys(true);
assert.match(await crypto.fingerprint(await crypto.exportPublicKey(keys.signing.publicKey)), /\\S/);
assert.equal(typeof client.DecisionsBridge, 'function');
assert.equal(typeof new client.MemoryLocalStore(), 'object');
assert.equal(typeof model.createDecisionModel, 'function');

const require = createRequire(import.meta.url);
const vectors = require('@daintreehq/decisions-crypto/fixtures/vectors.json');
assert.equal(typeof vectors, 'object');
const openapi = require('@daintreehq/decisions-protocol/openapi.json');
assert.equal(typeof openapi.openapi, 'string');
console.log('  runtime imports ok');
`;

const CHECK_TS = `
import { PROTOCOL_VERSION, ApiError, type ApiErrorBody } from '@daintreehq/decisions-protocol';
import { generateDeviceKeys, exportPublicKey, fingerprint, type DeviceKeys } from '@daintreehq/decisions-crypto';
import { DecisionsBridge, MemoryLocalStore, type BridgeOptions } from '@daintreehq/decisions-client';
import { createDecisionModel, type DecisionModelPolicy } from '@daintreehq/decisions-model';

const version: number = PROTOCOL_VERSION;
const body: ApiErrorBody | undefined = undefined;
const keys: DeviceKeys = await generateDeviceKeys(true);
const fp: string = await fingerprint(await exportPublicKey(keys.signing.publicKey));
const store = new MemoryLocalStore();
const bridge: typeof DecisionsBridge = DecisionsBridge;
const opts: Partial<BridgeOptions> = {};
const policy: Partial<DecisionModelPolicy> = {};
const err: Error = new ApiError('validation_error', 'x');
void [version, body, fp, store, bridge, opts, policy, err, createDecisionModel];
`;

function tsconfig(moduleKind, resolution) {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: moduleKind,
        moduleResolution: resolution,
        // The declarations name WebCrypto's global `CryptoKey`, which @types/node does not declare.
        lib: ['ES2023', 'DOM'],
        types: ['node'],
        strict: true,
        noEmit: true,
        // Check the shipped .d.ts files themselves, not just their use from check.ts.
        skipLibCheck: false,
      },
      files: ['check.ts'],
    },
    null,
    2,
  );
}

// The publish script releases every non-private workspace package; each one needs an entry above.
{
  const listed = new Set(PACKAGES.map((p) => p.dir));
  for (const pkg of listWorkspace(ROOT)) {
    if (!pkg.private && !listed.has(pkg.dir)) {
      fail(`${pkg.name} (${pkg.dir}) is published but missing from PACKAGES in pack-check.mjs`);
    }
  }
}

const work = mkdtempSync(join(tmpdir(), 'decisions-pack-check-'));
try {
  if (build) {
    step('Building the libraries and the CLI');
    run('pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: ROOT });
  }

  step(`Packing into ${work}`);
  const tarballDir = join(work, 'tarballs');
  mkdirSync(tarballDir);
  const ownVersions = new Map(
    PACKAGES.map((p) => {
      const pkg = JSON.parse(readFileSync(join(ROOT, p.dir, 'package.json'), 'utf8'));
      return [pkg.name, pkg.version];
    }),
  );
  const packed = [];
  for (const spec of PACKAGES) {
    const out = run('pnpm', ['pack', '--json', '--pack-destination', tarballDir], {
      cwd: join(ROOT, spec.dir),
      capture: true,
    });
    const { filename } = JSON.parse(out.slice(out.indexOf('{')));
    packed.push({ spec, tarball: filename, pkg: checkTarball(spec, filename, ownVersions) });
  }

  step('Installing the tarballs into a scratch project outside the workspace');
  const app = join(work, 'consumer');
  mkdirSync(app);
  const deps = Object.fromEntries(packed.map(({ pkg, tarball }) => [pkg.name, `file:${tarball}`]));
  const typesNode = JSON.parse(readFileSync(join(ROOT, 'packages/client/package.json'), 'utf8'))
    .devDependencies['@types/node'];
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'decisions-pack-check-consumer',
        private: true,
        type: 'module',
        dependencies: deps,
        devDependencies: { '@types/node': typesNode },
        // Inter-package dependencies name real versions that are not on the registry yet.
        overrides: Object.fromEntries(Object.keys(deps).map((n) => [n, `$${n}`])),
      },
      null,
      2,
    ),
  );
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: app });

  step('Importing every package under Node');
  writeFileSync(join(app, 'smoke.mjs'), SMOKE);
  run(process.execPath, ['smoke.mjs'], { cwd: app });

  step('Running the installed CLI');
  const help = run(join(app, 'node_modules/.bin/decisions'), ['--help'], {
    cwd: app,
    capture: true,
  });
  if (!/Usage: decisions/.test(help)) fail(`cli: unexpected --help output:\n${help}`);
  else console.log('  decisions --help ok');

  step('Type-checking against the published declarations');
  writeFileSync(join(app, 'check.ts'), CHECK_TS);
  writeFileSync(join(app, 'tsconfig.json'), tsconfig('NodeNext', 'NodeNext'));
  writeFileSync(join(app, 'tsconfig.bundler.json'), tsconfig('ESNext', 'Bundler'));
  const tsc = createRequire(join(ROOT, 'package.json')).resolve('typescript/bin/tsc');
  for (const project of ['tsconfig.json', 'tsconfig.bundler.json']) {
    try {
      run(process.execPath, [tsc, '-p', project], { cwd: app });
      console.log(`  ${project} ok`);
    } catch {
      fail(`type-check failed with ${project}`);
    }
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  if (keep) console.log(`\nKept ${work}`);
  else if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\npack-check failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\npack-check passed');
