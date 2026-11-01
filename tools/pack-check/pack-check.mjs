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
 * 4. Imports each library entry point alone in a fresh Node process and proves it is free of
 *    import-time side effects: only the `/sqlite` subpaths load `node:sqlite`, and no entry point
 *    creates a timer, socket or other async resource, calls into `node:fs`, leaves a handle open
 *    or creates a file in the working, home or temp directory.
 *
 * Usage: node tools/pack-check/pack-check.mjs [--no-build] [--keep]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
import { SqliteLocalStore } from '@daintreehq/decisions-client/sqlite';
import { SqliteHistoryStore } from '@daintreehq/decisions-model/sqlite';
import { createRequire } from 'node:module';

assert.equal(typeof protocol.PROTOCOL_VERSION, 'number');
assert.equal(typeof protocol.ApiError, 'function');
const keys = await crypto.generateDeviceKeys(true);
assert.match(await crypto.fingerprint(await crypto.exportPublicKey(keys.signing.publicKey)), /\\S/);
assert.equal(typeof client.DecisionsBridge, 'function');
assert.equal(typeof new client.MemoryLocalStore(), 'object');
assert.equal(typeof model.createDecisionModel, 'function');
// The SQLite stores are only reachable through their own entry points.
assert.equal('SqliteLocalStore' in client, false);
assert.equal('SqliteHistoryStore' in model, false);
const local = new SqliteLocalStore(':memory:');
assert.equal(await local.getCursor(), 0);
await local.close();
assert.equal(new SqliteHistoryStore(':memory:').count(), 0);

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
import { createDecisionModel, type DecisionModelPolicy, type HistoryStore } from '@daintreehq/decisions-model';
import { SqliteLocalStore } from '@daintreehq/decisions-client/sqlite';
import { SqliteHistoryStore, type SqliteHistoryOptions } from '@daintreehq/decisions-model/sqlite';
import type { LocalStore } from '@daintreehq/decisions-client';

const version: number = PROTOCOL_VERSION;
const body: ApiErrorBody | undefined = undefined;
const keys: DeviceKeys = await generateDeviceKeys(true);
const fp: string = await fingerprint(await exportPublicKey(keys.signing.publicKey));
const store = new MemoryLocalStore();
const bridge: typeof DecisionsBridge = DecisionsBridge;
const opts: Partial<BridgeOptions> = {};
const policy: Partial<DecisionModelPolicy> = {};
const err: Error = new ApiError('validation_error', 'x');
const local: LocalStore = new SqliteLocalStore(':memory:');
const historyOpts: SqliteHistoryOptions = { disableFts: true };
const history: HistoryStore = new SqliteHistoryStore(':memory:', historyOpts);
void [version, body, fp, store, bridge, opts, policy, err, createDecisionModel, local, history];
`;

/** The only entry points allowed to load `node:sqlite`; each is also the probe's positive control. */
const SQLITE_ENTRIES = [
  '@daintreehq/decisions-client/sqlite',
  '@daintreehq/decisions-model/sqlite',
];

/**
 * Preloaded with `--import`: refuses to resolve `node:sqlite`, so importing it anywhere in the graph
 * (statically, dynamically or through `require`) fails the probe.
 */
const NO_SQLITE_HOOK = `
import { registerHooks } from 'node:module';
if (typeof registerHooks !== 'function') {
  throw new Error('pack-check needs Node 22.15 or later (module.registerHooks)');
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:sqlite' || specifier === 'sqlite') {
      throw new Error('import-purity: ' + specifier + ' was imported');
    }
    return nextResolve(specifier, context);
  },
});
`;

/**
 * Imports one entry point in a fresh process and reports what the import alone did:
 * - `sqlite`: SQLite modules Node loaded (from `process.moduleLoadList`, so a caught import counts);
 * - `resources`: async resources (timers, immediates, sockets, servers, watchers, fs requests),
 *   referenced or not, created by code under `node_modules` (the packages and their dependencies);
 * - `fs`: calls into `node:fs` made by that code (Node's own module loader is not counted);
 * - `opened`: handles left keeping the process alive;
 * - `created`: files in the working, home and temp directories (each an empty directory of its own).
 */
const PROBE = `
import { createHook } from 'node:async_hooks';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const watched = [process.cwd(), process.env.HOME, process.env.TMPDIR];
// Open the stdio pipes first: loading node:http opens one lazily, which is Node's doing, not ours.
void [process.stdout, process.stderr];

let recording = true;
const fromPackages = () => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 200;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  return stack.split('\\n').some((frame) => frame.includes('/node_modules/'));
};
const resources = [];
const hook = createHook({
  init(_id, type) {
    if (recording && type !== 'PROMISE' && fromPackages()) resources.push(type);
  },
}).enable();
const fsCalls = [];
for (const [prefix, api] of [['fs.', fs], ['fs.promises.', fs.promises]]) {
  for (const [name, fn] of Object.entries(api)) {
    if (typeof fn !== 'function' || !/^[a-z]/.test(name)) continue;
    api[name] = Object.assign(function (...args) {
      if (recording && fromPackages()) fsCalls.push(prefix + name + '(' + String(args[0]) + ')');
      return fn.apply(this, args);
    }, fn);
  }
}
syncBuiltinESMExports();

const before = process.getActiveResourcesInfo();
await import(process.argv[2]);
// Give anything scheduled at import time (an immediate, a promise chain) the chance to start.
await new Promise((resolve) => setImmediate(resolve));
recording = false;
hook.disable();
const opened = process.getActiveResourcesInfo();
for (const r of before) {
  const i = opened.indexOf(r);
  if (i >= 0) opened.splice(i, 1);
}
const report = {
  sqlite: process.moduleLoadList.filter((m) => /sqlite/i.test(m)),
  resources,
  fs: fsCalls,
  opened,
  created: watched.flatMap((d) => fs.readdirSync(d)),
};
// Written synchronously so exiting cannot cut it short; exiting keeps a leftover handle (reported
// above) from hanging the check.
fs.writeSync(1, JSON.stringify(report) + '\\n');
process.exit(0);
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

  step('Importing each entry point alone: no node:sqlite at a root, no timers, sockets or files');
  writeFileSync(join(app, 'no-sqlite-hook.mjs'), NO_SQLITE_HOOK);
  writeFileSync(join(app, 'probe.mjs'), PROBE);
  const probe = (specifier, guard) => {
    const sandbox = mkdtempSync(join(work, 'probe-'));
    const [cwd, home, temp] = ['cwd', 'home', 'tmp'].map((d) => {
      mkdirSync(join(sandbox, d));
      return join(sandbox, d);
    });
    const preload = guard ? ['--import', pathToFileURL(join(app, 'no-sqlite-hook.mjs')).href] : [];
    const r = spawnSync(process.execPath, [...preload, join(app, 'probe.mjs'), specifier], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    let report;
    try {
      if (r.status === 0) report = JSON.parse(r.stdout.trim().split('\n').at(-1));
    } catch {
      /* reported by the caller as a failed import */
    }
    const outcome = r.error ? r.error.message : `exit ${r.status ?? r.signal}`;
    return { outcome, stderr: r.stderr, report };
  };
  const checkClean = (specifier, report) => {
    if (report.resources.length)
      fail(`${specifier}: importing it creates ${report.resources.join(', ')}`);
    if (report.fs.length) fail(`${specifier}: importing it touches files: ${report.fs.join(', ')}`);
    if (report.opened.length)
      fail(`${specifier}: importing it leaves handles open: ${report.opened.join(', ')}`);
    if (report.created.length)
      fail(`${specifier}: importing it creates files: ${report.created.join(', ')}`);
  };
  const entries = packed.flatMap(({ pkg }) =>
    Object.keys(pkg.exports ?? {})
      .filter((k) => !k.endsWith('.json'))
      .map((k) => (k === '.' ? pkg.name : `${pkg.name}/${k.slice(2)}`)),
  );
  for (const specifier of entries.filter((e) => !SQLITE_ENTRIES.includes(e))) {
    // Unguarded, so the load list shows node:sqlite even if an import of it is caught...
    const open = probe(specifier, false);
    if (!open.report) {
      fail(`${specifier}: import failed (${open.outcome}):\n${open.stderr}`);
      continue;
    }
    if (open.report.sqlite.length) fail(`${specifier}: loads ${open.report.sqlite.join(', ')}`);
    checkClean(specifier, open.report);
    // ...and guarded, so an uncaught import of it fails with the importing module in the stack.
    const guarded = probe(specifier, true);
    if (!guarded.report)
      fail(
        `${specifier}: import failed under the no-sqlite guard (${guarded.outcome}):\n${guarded.stderr}`,
      );
    console.log(`  ${specifier} ok`);
  }
  for (const specifier of SQLITE_ENTRIES) {
    if (!entries.includes(specifier)) {
      fail(`${specifier}: not exported`);
      continue;
    }
    // Positive controls: both detectors must see a SQLite entry point load node:sqlite.
    const open = probe(specifier, false);
    if (!open.report) fail(`${specifier}: import failed (${open.outcome}):\n${open.stderr}`);
    else {
      if (!open.report.sqlite.length) fail(`${specifier}: the probe did not see node:sqlite load`);
      checkClean(specifier, open.report);
    }
    const guarded = probe(specifier, true);
    if (guarded.report || !guarded.stderr.includes('import-purity: node:sqlite'))
      fail(`${specifier}: the no-sqlite guard did not refuse it (${guarded.outcome})`);
    console.log(`  ${specifier} checked (loads node:sqlite, as it may)`);
  }

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
