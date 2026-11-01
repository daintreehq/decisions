#!/usr/bin/env node
/**
 * Sets one version on every workspace package (the root, the private app/worker/e2e packages and
 * every published package) and on the source constants that report it at run time.
 *
 *   pnpm release:version 0.2.0
 *
 * Only the `"version"` line of each package.json is rewritten, so formatting is preserved. The
 * lockfile does not record workspace versions, so it does not change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT,
  VERSION_CONSTANTS,
  isValidVersion,
  listWorkspace,
  readVersionConstants,
} from './workspace.mjs';

const version = process.argv[2]?.replace(/^v/, '');
if (!version || process.argv.length > 3) {
  console.error('usage: pnpm release:version <version>   e.g. pnpm release:version 0.2.0');
  process.exit(1);
}
if (!isValidVersion(version)) {
  console.error(`release:version: ${version} is not MAJOR.MINOR.PATCH[-prerelease]`);
  process.exit(1);
}

// Fail before writing anything if a constant can no longer be found.
readVersionConstants();

const TOP_LEVEL_VERSION = /^( {2}"version":\s*")([^"]*)(",?)$/m;
for (const pkg of listWorkspace()) {
  const file = join(ROOT, pkg.dir, 'package.json');
  const src = readFileSync(file, 'utf8');
  if (!TOP_LEVEL_VERSION.test(src)) {
    console.error(`release:version: no top-level "version" line in ${file}`);
    process.exit(1);
  }
  const next = src.replace(TOP_LEVEL_VERSION, `$1${version}$3`);
  if (JSON.parse(next).version !== version) {
    console.error(`release:version: rewriting ${file} did not set its version`);
    process.exit(1);
  }
  writeFileSync(file, next);
  console.log(`  ${pkg.name}: ${pkg.version} -> ${version}`);
}

for (const { file, pattern } of VERSION_CONSTANTS) {
  const path = join(ROOT, file);
  writeFileSync(path, readFileSync(path, 'utf8').replace(pattern, `$1${version}$3`));
  console.log(`  ${file}: -> ${version}`);
}

console.log(`
Every package is at ${version}. Commit this and land it on main, then tag that commit:
  git tag v${version} && git push origin v${version}`);
