/**
 * Workspace discovery and the release rules shared by the publish and version scripts.
 *
 * The publishable set is never hard-coded: it is every workspace package without
 * `"private": true`, as pnpm itself resolves the workspace. Everything below `listWorkspace` is
 * pure so it can be unit-tested without pnpm or the registry.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const SCOPE = '@daintreehq/';
export const REPOSITORY = 'daintreehq/decisions';

/** Dependency fields that must be installable from the registry when a package is published. */
export const RUNTIME_DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * `MAJOR.MINOR.PATCH` with an optional SemVer prerelease (numeric identifiers without leading
 * zeros); no build metadata, which npm ignores.
 */
const PRERELEASE_ID = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION_RE = new RegExp(
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)` +
    String.raw`(?:-(${PRERELEASE_ID}(?:\.${PRERELEASE_ID})*))?$`,
);

export function isValidVersion(version) {
  return typeof version === 'string' && VERSION_RE.test(version);
}

/**
 * The npm dist-tag to publish under. npm 11 refuses to publish a prerelease without an explicit
 * tag, and a prerelease must never become `latest`.
 */
export function distTagFor(version) {
  return VERSION_RE.exec(version)?.[4] ? 'next' : 'latest';
}

/**
 * Source constants that report the release version at run time. They are bumped with the
 * packages and checked by the publish script, so the MCP server info and
 * the Worker's health check always name the version that was released (`decisions --version` reads
 * the CLI's package.json). Each pattern must match
 * exactly once; capture group 2 is the version.
 */
export const VERSION_CONSTANTS = [
  { file: 'packages/client/src/mcp.ts', pattern: /(const SERVER_VERSION = ')([^']*)(')/g },
  { file: 'worker/src/env.ts', pattern: /(export const WORKER_VERSION = ')([^']*)(')/g },
];

/** Every workspace package, including the root, as `{ name, version, private, dir, manifest }`. */
export function listWorkspace(root = ROOT) {
  const out = execFileSync('pnpm', ['-r', 'ls', '--depth', '-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out).map((entry) => {
    const manifest = JSON.parse(readFileSync(join(entry.path, 'package.json'), 'utf8'));
    return {
      name: manifest.name,
      version: manifest.version,
      private: manifest.private === true,
      dir: relative(root, entry.path) || '.',
      manifest,
    };
  });
}

/** Reads each version constant; throws if a pattern no longer matches exactly once. */
export function readVersionConstants(root = ROOT) {
  return VERSION_CONSTANTS.map(({ file, pattern }) => {
    const matches = [...readFileSync(join(root, file), 'utf8').matchAll(pattern)];
    if (matches.length !== 1) {
      throw new Error(
        `${file}: expected exactly one match for ${pattern}, found ${matches.length}. ` +
          'Update VERSION_CONSTANTS in tools/release/workspace.mjs.',
      );
    }
    return { file, version: matches[0][2] };
  });
}

/**
 * The workspace package a dependency entry points at: the key itself, or the target of a pnpm
 * workspace alias such as `"helper": "workspace:@daintreehq/decisions-x@*"`.
 */
export function dependencyTarget(key, range) {
  const alias = /^workspace:((?:@[^/@]+\/)?[^/@]+)@/.exec(String(range));
  return alias ? alias[1] : key;
}

/** The names in `names` that a manifest depends on at run time. */
function workspaceDeps(manifest, names) {
  const deps = new Set();
  for (const field of RUNTIME_DEP_FIELDS) {
    for (const [key, range] of Object.entries(manifest[field] ?? {})) {
      const target = dependencyTarget(key, range);
      if (names.has(target)) deps.add(target);
    }
  }
  return deps;
}

/**
 * The packages to publish, dependencies first. Throws if a publishable package depends at run
 * time on a private workspace package (it would be uninstallable from npm), or on a cycle.
 * Ties are broken by name so the order is stable.
 */
export function publishOrder(packages) {
  const all = new Map(packages.map((p) => [p.name, p]));
  const publishable = packages.filter((p) => !p.private);
  const names = new Set(publishable.map((p) => p.name));
  const problems = [];
  const edges = new Map();
  for (const pkg of publishable) {
    for (const dep of workspaceDeps(pkg.manifest, new Set(all.keys()))) {
      if (!names.has(dep)) problems.push(`${pkg.name} depends on the private package ${dep}`);
    }
    edges.set(pkg.name, [...workspaceDeps(pkg.manifest, names)].sort());
  }
  if (problems.length) throw new Error(problems.join('\n'));

  const order = [];
  const state = new Map(); // name -> 'visiting' | 'done'
  const visit = (name, path) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw new Error(`workspace dependency cycle: ${[...path, name].join(' -> ')}`);
    }
    state.set(name, 'visiting');
    for (const dep of edges.get(name)) visit(dep, [...path, name]);
    state.set(name, 'done');
    order.push(all.get(name));
  };
  for (const name of [...names].sort()) visit(name, []);
  return order;
}

/**
 * Release-shape problems with the publishable packages: one shared valid version (equal to the
 * tag when a tag is given, to every version constant, and to every package in `workspace`, private
 * ones included), the `@daintreehq` scope, and the repository metadata npm provenance needs.
 * Returns a list of messages; empty means ready.
 */
export function releaseProblems(publishable, { tag, constants = [], workspace = [] } = {}) {
  const problems = [];
  if (publishable.length === 0) problems.push('no publishable workspace packages found');
  const versions = new Set(publishable.map((p) => p.version));
  if (versions.size > 1) {
    problems.push(
      `packages are not at one shared version: ${publishable
        .map((p) => `${p.name}@${p.version}`)
        .join(', ')} (run pnpm release:version <version>)`,
    );
  }
  const [version] = versions;
  if (versions.size === 1 && !isValidVersion(version)) {
    problems.push(`${version} is not a valid release version`);
  }
  if (tag !== undefined && versions.size === 1 && tag !== `v${version}`) {
    problems.push(
      `tag ${tag} does not match the package version ${version} (expected v${version})`,
    );
  }
  for (const c of constants) {
    if (versions.size === 1 && c.version !== version) {
      problems.push(`${c.file} reports version ${c.version}, expected ${version}`);
    }
  }
  for (const p of workspace) {
    if (versions.size === 1 && p.version !== version) {
      problems.push(
        `${p.name ?? p.dir} (${p.dir}) is at ${p.version}, expected ${version} (run pnpm release:version ${version})`,
      );
    }
  }
  for (const p of publishable) {
    if (!p.name?.startsWith(SCOPE))
      problems.push(`${p.name ?? p.dir}: not under the ${SCOPE} scope`);
    const url = repositoryUrl(p.manifest);
    if (!url || normaliseRepo(url) !== `github.com/${REPOSITORY}`) {
      problems.push(
        `${p.name}: repository.url must point at https://github.com/${REPOSITORY} for npm provenance (found ${url ?? 'nothing'})`,
      );
    }
    if (
      p.manifest.repository?.directory !== undefined &&
      p.manifest.repository.directory !== p.dir
    ) {
      problems.push(
        `${p.name}: repository.directory is ${p.manifest.repository.directory}, expected ${p.dir}`,
      );
    }
  }
  return problems;
}

function repositoryUrl(manifest) {
  const repo = manifest.repository;
  return typeof repo === 'string' ? repo : repo?.url;
}

function normaliseRepo(url) {
  return url
    .replace(/^git\+/, '')
    .replace(/^(https?|ssh|git):\/\/(git@)?/, '')
    .replace(/^git@github\.com:/, 'github.com/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

/** Compares two release versions numerically (prerelease identifiers compared as strings). */
export function compareVersions(a, b) {
  const pa = VERSION_RE.exec(a);
  const pb = VERSION_RE.exec(b);
  if (!pa || !pb) throw new Error(`cannot compare ${a} and ${b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

/**
 * Interprets `npm view <name>@<version> version --json` and its exit status. Returns true when
 * that exact version is on the registry, false when the package or version is missing (an E404
 * error, or empty output with exit 0 from older npm versions), and throws on anything else, so
 * an npm, registry or auth failure never turns into a publish attempt or a silent skip.
 */
export function parseNpmView(stdout, version, status = 0) {
  const text = (stdout ?? '').trim();
  if (text === '') {
    if (status === 0) return false;
    throw new Error(`npm view exited with ${status ?? 'a signal'} and printed nothing`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`unexpected npm view output: ${text.slice(0, 200)}`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
    if (data.error.code === 'E404') return false;
    throw new Error(`npm view failed: ${data.error.code ?? ''} ${data.error.summary ?? ''}`.trim());
  }
  const found = Array.isArray(data) ? data : [data];
  if (status === 0 && found.includes(version)) return true;
  throw new Error(
    `npm view exited with ${status ?? 'a signal'} and printed ${text.slice(0, 200)} for ${version}`,
  );
}

/**
 * Publishes packed packages in order, skipping any name@version already on the registry.
 * Stops at the first package that fails to publish, since later packages may depend on it; a
 * publish that reports an error but did land (a timeout after the registry accepted it) counts
 * as published. In a dry run nothing is uploaded and a registry error is only reported.
 * Returns one summary line per package.
 *
 * @param {{ pkg: { name: string }, tarball: string }[]} packed
 * @param {{ version: string, dryRun: boolean, log: (msg: string) => void,
 *   isPublished: (name: string) => boolean, publish: (tarball: string) => void,
 *   dryRunPublish: (tarball: string) => void }} io
 */
export function publishInOrder(
  packed,
  { version, dryRun, log, isPublished, publish, dryRunPublish },
) {
  const summary = [];
  for (const { pkg, tarball } of packed) {
    const id = `${pkg.name}@${version}`;
    let published;
    try {
      published = isPublished(pkg.name);
    } catch (err) {
      if (!dryRun) throw new Error(`${id}: cannot read the registry: ${err.message}`);
      log(`  ${id}: registry check failed (${err.message}); continuing the dry run`);
      published = false;
    }
    if (published) {
      log(`  ${id}: already on npm, skipping`);
      summary.push(`${id} skipped (already published)`);
      continue;
    }
    if (dryRun) {
      log(`  ${id}: would publish`);
      dryRunPublish(tarball);
      summary.push(`${id} would be published`);
      continue;
    }
    log(`  ${id}: publishing`);
    try {
      publish(tarball);
    } catch {
      let landed = false;
      try {
        landed = isPublished(pkg.name);
      } catch {
        // Treated as not landed: fail below.
      }
      if (!landed) {
        throw new Error(
          `${id}: npm publish failed. Packages after it in the order were not attempted; ` +
            're-run the workflow once the cause is fixed (published packages are skipped).',
        );
      }
      log(`  ${id}: publish reported an error but the version is on npm; continuing`);
    }
    summary.push(`${id} published`);
  }
  return summary;
}
