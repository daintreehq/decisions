import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { CliError } from './runtime.js';

/**
 * Published releases of the relay (`@daintreehq/decisions-relay` on npm), for `decisions update`:
 * which versions exist, which protocol range each one speaks, and the exact tarball of one of them,
 * checked against the integrity digest the registry publishes for it.
 */

export const RELAY_PACKAGE = '@daintreehq/decisions-relay';
/** The official registry, the one the CLI itself is published to. Mirrors are not consulted. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
/** Bounds on a relay tarball: compressed, unpacked, and number of files. */
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 2000;

/** An inclusive range of wire protocol majors. */
export interface ProtocolRange {
  min: number;
  max: number;
}

export interface RelayRelease {
  version: string;
  /** The protocol range the release declares in its package.json, or null when it declares none. */
  protocol: ProtocolRange | null;
  tarball: string;
  /** Subresource-integrity string (`sha512-<base64>`) the registry publishes for the tarball. */
  integrity: string;
  /** The repository URL the release names, used for release notes. */
  repository: string | null;
}

/* ---------- versions ---------- */

const NUM = '(0|[1-9]\\d*)';
const SEMVER = new RegExp(
  `^${NUM}\\.${NUM}\\.${NUM}(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export function isVersion(v: string): boolean {
  return SEMVER.test(v);
}

export function isPrerelease(v: string): boolean {
  return SEMVER.exec(v)?.[4] !== undefined;
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new CliError(`not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  const pa = x[4];
  const pb = y[4];
  if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
  const sa = pa.split('.');
  const sb = pb.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const ia = sa[i];
    const ib = sb[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb) {
      // Numeric identifiers have no size limit, so compare them as integers of any length.
      const d = BigInt(ia) - BigInt(ib);
      if (d) return d < 0n ? -1 : 1;
    } else if (na !== nb) return na ? -1 : 1;
    else if (ia !== ib) return ia < ib ? -1 : 1;
  }
  return 0;
}

/** Parses `1`, `1-2` or `1..2` into an inclusive range of positive integers. */
export function parseProtocolRange(s: string): ProtocolRange {
  const m = /^\s*(\d+)\s*(?:(?:-|\.\.)\s*(\d+)\s*)?$/.exec(s);
  if (!m) throw new CliError(`--protocol "${s}" must be a version or a range like 1-2`);
  const min = Number(m[1]);
  const max = Number(m[2] ?? m[1]);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min)
    throw new CliError(`--protocol "${s}" is not a valid range`);
  return { min, max };
}

export const formatRange = (r: ProtocolRange) =>
  r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`;

/* ---------- the registry ---------- */

function protocolOf(meta: unknown): ProtocolRange | null {
  const p = (meta as { decisions?: { protocol?: { min?: unknown; max?: unknown } } } | null)
    ?.decisions?.protocol;
  if (!p || !Number.isSafeInteger(p.min) || !Number.isSafeInteger(p.max)) return null;
  const min = p.min as number;
  const max = p.max as number;
  return min >= 1 && max >= min ? { min, max } : null;
}

function repositoryOf(meta: unknown): string | null {
  const r = (meta as { repository?: unknown } | null)?.repository;
  const url = typeof r === 'string' ? r : (r as { url?: unknown } | undefined)?.url;
  return typeof url === 'string' ? url : null;
}

/** Every published release of the relay, oldest first. */
export async function listRelayReleases(
  fetchFn: typeof fetch,
  registry: string,
): Promise<RelayRelease[]> {
  const url = `${registry}/${RELAY_PACKAGE.replace('/', '%2f')}`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    throw new CliError(`could not reach the npm registry (${url}): ${(e as Error).message}`);
  }
  if (!res.ok) throw new CliError(`the npm registry answered HTTP ${res.status} for ${url}`);
  const doc = (await res.json().catch(() => null)) as {
    versions?: Record<string, unknown>;
    time?: Record<string, unknown>;
  } | null;
  if (!doc || typeof doc.versions !== 'object' || doc.versions === null) {
    throw new CliError(`the npm registry returned no versions of ${RELAY_PACKAGE}`);
  }
  const out: RelayRelease[] = [];
  for (const [version, meta] of Object.entries(doc.versions)) {
    if (!isVersion(version)) continue;
    const dist = (meta as { dist?: { tarball?: unknown; integrity?: unknown } } | null)?.dist;
    if (typeof dist?.tarball !== 'string' || typeof dist.integrity !== 'string') continue;
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dist.integrity.split(/\s+/)[0] ?? '')) continue;
    out.push({
      version,
      protocol: protocolOf(meta),
      tarball: dist.tarball,
      integrity: dist.integrity,
      repository: repositoryOf(meta),
    });
  }
  return out.sort((a, b) => compareVersions(a.version, b.version));
}

/** Downloads a release's tarball and checks it against the registry's sha512 integrity. */
export async function downloadRelease(fetchFn: typeof fetch, r: RelayRelease): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetchFn(r.tarball);
  } catch (e) {
    throw new CliError(`could not download relay ${r.version}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new CliError(`downloading relay ${r.version} failed with HTTP ${res.status}`);
  const tooLarge = () => new CliError(`relay ${r.version} is too large to download`);
  if (Number(res.headers.get('content-length')) > MAX_TARBALL_BYTES) throw tooLarge();
  // Read it in chunks and stop at the cap, whatever the server claims the size is.
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TARBALL_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = Buffer.concat(chunks);
  const want = r.integrity
    .split(/\s+/)
    .filter((s) => s.startsWith('sha512-'))
    .map((s) => s.slice('sha512-'.length));
  const got = createHash('sha512').update(bytes).digest('base64');
  if (!want.includes(got)) {
    throw new CliError(
      `relay ${r.version} does not match the integrity digest the registry publishes for it; refusing to deploy`,
    );
  }
  return bytes;
}

/* ---------- tarballs ---------- */

/** A relative, forward-slash path with no empty, `.` or `..` segments. */
function safeRelative(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[A-Za-z]:/.test(p))
    return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const cstr = (b: Buffer) => {
  const z = b.indexOf(0);
  return (z === -1 ? b : b.subarray(0, z)).toString('utf8');
};
const octal = (b: Buffer) => {
  const s = cstr(b).trim();
  if (!/^[0-7]*$/.test(s)) throw new CliError('the relay tarball is malformed (bad number field)');
  return s ? parseInt(s, 8) : 0;
};

/** The records of a pax extended header. Anything malformed refuses the tarball. */
function paxRecords(data: Buffer): Map<string, string> {
  const bad = () => new CliError('the relay tarball is malformed (bad pax header)');
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) throw bad();
    const digits = data.subarray(i, sp).toString('ascii');
    if (!/^[1-9]\d*$/.test(digits)) throw bad();
    const len = Number(digits);
    if (!Number.isSafeInteger(len) || i + len > data.length || sp + 1 >= i + len) throw bad();
    if (data[i + len - 1] !== 0x0a) throw bad();
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq <= 0) throw bad();
    out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

/**
 * The regular files of a gzipped npm tarball, keyed by their path inside the package (without the
 * leading `package/`). Directories and pax headers are understood; links and anything else, any
 * path outside `package/`, malformed pax records and an archive without its end marker refuse it.
 */
export function extractTarball(gz: Buffer): Map<string, Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw new CliError('the relay tarball is not valid gzip, or unpacks too large');
  }
  const files = new Map<string, Buffer>();
  let off = 0;
  // Attributes of consecutive pax headers apply together to the next entry.
  let pax = new Map<string, string>();
  let ended = false;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      // The end is two zero blocks, then only zero padding; nothing may be left pending.
      ended = off + 1024 <= tar.length && tar.subarray(off).every((b) => b === 0) && !pax.size;
      break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== octal(h.subarray(148, 156)))
      throw new CliError('the relay tarball is malformed (bad header checksum)');
    const size = octal(h.subarray(124, 136));
    const type = String.fromCharCode(h[156]!);
    const prefix = h.subarray(257, 263).toString('ascii').startsWith('ustar')
      ? cstr(h.subarray(345, 500))
      : '';
    const name = cstr(h.subarray(0, 100));
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new CliError('the relay tarball is truncated');
    const data = tar.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      for (const [k, v] of paxRecords(data)) pax.set(k, v);
      continue;
    }
    if (type === 'g') {
      paxRecords(data);
      continue;
    }
    const full = pax.get('path') ?? (prefix ? `${prefix}/${name}` : name);
    pax = new Map();
    if (type === '5') continue;
    if (type !== '0' && type !== '\0') {
      throw new CliError(`the relay tarball contains a non-file entry (${full}); refusing it`);
    }
    const rel = full.startsWith('package/') ? full.slice('package/'.length) : '';
    if (!safeRelative(rel))
      throw new CliError(`the relay tarball contains an unsafe path: ${full}`);
    if (files.size >= MAX_FILES) throw new CliError('the relay tarball has too many files');
    if (files.has(rel)) throw new CliError(`the relay tarball lists ${rel} twice`);
    files.set(rel, Buffer.from(data));
  }
  if (!ended) throw new CliError('the relay tarball is truncated or has trailing data');
  return files;
}
