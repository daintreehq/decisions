#!/usr/bin/env node
/**
 * Builds the deployable relay that `decisions deploy` ships:
 *
 *   dist/worker/index.js(.map)  the Worker, bundled by Wrangler exactly as `wrangler deploy` would
 *   dist/app/**                 the phone app's static assets (a fresh `vite build`)
 *   dist/wrangler.json          the repository's wrangler.jsonc, pointed at the two above, `no_bundle`
 *   dist/manifest.json          SHA-256 and size of every file above, the version, the Wrangler version
 *
 * The output is deterministic for a given commit (no timestamps, no absolute paths), because the CLI
 * embeds the SHA-256 of manifest.json at build time and refuses to deploy a bundle that differs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const PKG = resolve(import.meta.dirname, '..');
const ROOT = resolve(PKG, '../..');
const DIST = join(PKG, 'dist');
const require = createRequire(join(PKG, 'package.json'));

const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: ROOT, stdio: 'inherit' });

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 1. The phone app, built fresh so a stale app/dist can never be shipped.
run('pnpm', ['--filter', '@daintreehq/decisions-app', 'build']);
cpSync(join(ROOT, 'app/dist'), join(DIST, 'app'), { recursive: true });

// 2. The Worker, bundled by the same Wrangler that will deploy it, from the repository config.
const wranglerPkgPath = require.resolve('wrangler/package.json');
const wranglerPkg = JSON.parse(readFileSync(wranglerPkgPath, 'utf8'));
const wranglerBin = join(dirname(wranglerPkgPath), wranglerPkg.bin.wrangler);
const wranglerVersion = wranglerPkg.version;
const workerOut = join(DIST, 'worker');
run(process.execPath, [
  wranglerBin,
  'deploy',
  '--dry-run',
  '--config',
  join(ROOT, 'wrangler.jsonc'),
  '--outdir',
  workerOut,
]);
// Wrangler writes a README with a timestamp next to the bundle; it is not part of the deployment.
rmSync(join(workerOut, 'README.md'), { force: true });
const mapFile = join(workerOut, 'index.js.map');
const map = JSON.parse(readFileSync(mapFile, 'utf8'));
// sourceRoot is the absolute output path on the build machine; the sources are already relative.
delete map.sourceRoot;
writeFileSync(mapFile, JSON.stringify(map));
for (const f of readdirSync(workerOut)) {
  if (f !== 'index.js' && f !== 'index.js.map') {
    throw new Error(
      `unexpected file in the Worker bundle: ${f} (update the relay build and the CLI)`,
    );
  }
}

// 3. The Wrangler config, identical to wrangler.jsonc except where the files now live.
const source = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', source);
if (parsed.error)
  throw new Error(
    `wrangler.jsonc: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')}`,
  );
const { $schema: _schema, alias: _alias, ...config } = parsed.config;
const deployConfig = {
  ...config,
  main: './worker/index.js',
  // The bundle is already built; Wrangler uploads it as is (with its source map).
  no_bundle: true,
  assets: { ...config.assets, directory: './app' },
};
writeFileSync(join(DIST, 'wrangler.json'), JSON.stringify(deployConfig, null, 2) + '\n');

// 4. The manifest.
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}
const files = {};
for (const abs of walk(DIST).sort()) {
  const rel = relative(DIST, abs).split(sep).join('/');
  const bytes = readFileSync(abs);
  files[rel] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const manifest = {
  schema: 1,
  name: pkg.name,
  version: pkg.version,
  wrangler: wranglerVersion,
  config: 'wrangler.json',
  files,
};
writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const digest = createHash('sha256')
  .update(readFileSync(join(DIST, 'manifest.json')))
  .digest('hex');
console.log(
  `\nrelay ${pkg.version}: ${Object.keys(files).length} files, wrangler ${wranglerVersion}, manifest sha256 ${digest}`,
);
