import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CliError } from './runtime.js';

/**
 * The prebuilt relay (`@daintreehq/decisions-relay`) that `decisions deploy` uploads, and the checks
 * that make it the exact relay this CLI was released with:
 *
 * 1. The SHA-256 of the bundle's manifest.json must equal the digest embedded in this CLI at build
 *    time (tsup.config.ts). The relay package is a dependency at the exact same version.
 * 2. Every file the manifest lists must be present with the listed SHA-256 and size.
 * 3. Only the bytes that were hashed are staged for Wrangler, so nothing can change in between.
 *
 * Any mismatch refuses the deploy.
 */

declare const __RELAY_MANIFEST_SHA256__: string | undefined;

/** The manifest digest this build of the CLI deploys, or undefined when running from source. */
export const PINNED_MANIFEST_SHA256: string | undefined =
  typeof __RELAY_MANIFEST_SHA256__ === 'string' ? __RELAY_MANIFEST_SHA256__ : undefined;

export interface RelayManifest {
  schema: 1;
  name: string;
  version: string;
  /** The exact Wrangler version the bundle was built with, used to deploy it. */
  wrangler: string;
  /** The Wrangler config file, relative to the bundle. */
  config: string;
  files: Record<string, { sha256: string; bytes: number }>;
}

export interface VerifiedRelayBundle {
  dir: string;
  manifest: RelayManifest;
  manifestSha256: string;
  /** Path (relative, `/`-separated) to the verified bytes. */
  files: Map<string, Buffer>;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Where the installed `@daintreehq/decisions-relay` keeps its files. */
export function locateRelayBundle(): string {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve('@daintreehq/decisions-relay/manifest.json'));
  } catch {
    throw new CliError(
      'the relay bundle (@daintreehq/decisions-relay) is not installed next to the CLI; reinstall @daintreehq/decisions-cli' +
        ' (in a clone of the repository: pnpm build:all)',
    );
  }
}

/** A relative, forward-slash path with no `.`/`..` segments that stays inside the bundle. */
function safeRelative(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[A-Za-z]:/.test(p))
    return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function parseManifest(text: string): RelayManifest {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    throw new CliError('the relay bundle manifest is not valid JSON; refusing to deploy');
  }
  const bad = (why: string) =>
    new CliError(`the relay bundle manifest is invalid (${why}); refusing to deploy`);
  if (!m || typeof m !== 'object') throw bad('not an object');
  const r = m as Partial<RelayManifest>;
  if (r.schema !== 1) throw bad(`unknown schema ${String(r.schema)}`);
  if (typeof r.version !== 'string') throw bad('no version');
  // The version ends up in the npx command line, so it must be a plain semver.
  if (typeof r.wrangler !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(r.wrangler))
    throw bad('the Wrangler version is not an exact version');
  // Staging writes the config next to worker/ and app/, which its relative paths point at.
  if (r.config !== 'wrangler.json') throw bad('the config must be wrangler.json');
  if (!r.files || typeof r.files !== 'object' || Array.isArray(r.files)) throw bad('no file list');
  for (const [p, e] of Object.entries(r.files)) {
    if (!safeRelative(p)) throw bad(`unsafe path ${JSON.stringify(p)}`);
    if (!e || typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256))
      throw bad(`bad SHA-256 for ${p}`);
    if (typeof e.bytes !== 'number' || !Number.isSafeInteger(e.bytes) || e.bytes < 0)
      throw bad(`bad size for ${p}`);
  }
  if (!r.files[r.config]) throw bad(`the config ${r.config} is not listed`);
  return r as RelayManifest;
}

export async function verifyRelayBundle(
  dir: string,
  opts: { pinnedSha256: string | undefined; version: string },
): Promise<VerifiedRelayBundle> {
  if (!opts.pinnedSha256) {
    throw new CliError(
      'this build of the CLI does not pin a relay bundle, so it cannot deploy one (build it with `pnpm build:all`)',
    );
  }
  let raw: Buffer;
  try {
    raw = await readFile(join(dir, 'manifest.json'));
  } catch {
    throw new CliError(`the relay bundle manifest is missing from ${dir}`);
  }
  const manifestSha256 = sha256(raw);
  if (manifestSha256 !== opts.pinnedSha256) {
    throw new CliError(
      `the relay bundle in ${dir} does not match the relay this CLI was built with ` +
        `(manifest SHA-256 ${manifestSha256}, expected ${opts.pinnedSha256}); refusing to deploy. ` +
        'Reinstall @daintreehq/decisions-cli (in a clone: pnpm build:all).',
    );
  }
  const manifest = parseManifest(raw.toString('utf8'));
  if (manifest.version !== opts.version) {
    throw new CliError(
      `the relay bundle is version ${manifest.version} but this CLI is ${opts.version}; refusing to deploy`,
    );
  }
  const files = new Map<string, Buffer>();
  const problems: string[] = [];
  for (const [rel, want] of Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(dir, ...rel.split('/')));
    } catch {
      problems.push(`${rel} is missing`);
      continue;
    }
    if (bytes.length !== want.bytes || sha256(bytes) !== want.sha256) {
      problems.push(`${rel} does not match its SHA-256 in the manifest`);
      continue;
    }
    files.set(rel, bytes);
  }
  if (problems.length) {
    throw new CliError(
      `the relay bundle in ${dir} has been modified or is incomplete; refusing to deploy:\n  ${problems.join('\n  ')}`,
    );
  }
  return { dir, manifest, manifestSha256, files };
}

/**
 * Writes the verified bytes to `dest` (created; must be empty or absent) and sets the Worker name
 * and the R2 bucket in the Wrangler config. Nothing else in the config changes.
 */
export async function stageRelayBundle(
  bundle: VerifiedRelayBundle,
  dest: string,
  o: { name: string; bucket: string },
): Promise<void> {
  await mkdir(dest, { recursive: true, mode: 0o700 });
  for (const [rel, bytes] of bundle.files) {
    if (rel === bundle.manifest.config) continue;
    const target = join(dest, ...rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  const config = JSON.parse(bundle.files.get(bundle.manifest.config)!.toString('utf8')) as {
    name?: string;
    r2_buckets?: { binding: string; bucket_name: string }[];
  };
  if (!Array.isArray(config.r2_buckets) || config.r2_buckets.length !== 1) {
    throw new CliError('the relay bundle config does not declare exactly one R2 bucket');
  }
  config.name = o.name;
  config.r2_buckets = [{ ...config.r2_buckets[0]!, bucket_name: o.bucket }];
  await writeFile(join(dest, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n', {
    flag: 'wx',
  });
}
