/**
 * Packing and scratch installs shared by `pack-check.mjs` and `../compat-check/compat-check.mjs`:
 * the published packages as `pnpm pack` writes them, installed with plain npm into a project
 * outside the workspace, the way a consumer gets them from the registry.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');

/** Builds every library, the relay bundle and the CLI (`packages/*`), as the release does. */
export function buildPackages(root = ROOT) {
  execFileSync('pnpm', ['-r', '--filter', './packages/*', 'build'], {
    cwd: root,
    stdio: 'inherit',
  });
}

/** Packs one workspace package into `dest` with `pnpm pack` and returns the tarball's path. */
export function packPackage(dir, dest, root = ROOT) {
  const out = execFileSync('pnpm', ['pack', '--json', '--pack-destination', dest], {
    cwd: join(root, dir),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out.slice(out.indexOf('{'))).filename;
}

/**
 * Writes a private ESM project at `dir` that depends on `dependencies` (name to version range or
 * `file:` tarball) and installs it with npm. With tarballs, `overrides` pins every listed package
 * to its own entry, because inter-package dependencies name versions that may not be on the
 * registry yet (or name the published ones, which are not what is being checked).
 */
export function installConsumer(dir, dependencies, { devDependencies = {}, name } = {}) {
  mkdirSync(dir, { recursive: true });
  const tarballs = Object.entries(dependencies).filter(([, v]) => v.startsWith('file:'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: name ?? 'decisions-scratch-consumer',
        private: true,
        type: 'module',
        dependencies,
        devDependencies,
        ...(tarballs.length
          ? { overrides: Object.fromEntries(tarballs.map(([n]) => [n, `$${n}`])) }
          : {}),
      },
      null,
      2,
    ),
  );
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    stdio: 'inherit',
  });
}
