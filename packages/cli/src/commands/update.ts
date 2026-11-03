import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import { CloudflareApi, type Account, type WorkerSnapshot } from '../cloudflare.js';
import { stageRelayBundle, verifyRelayRelease, type VerifiedRelayBundle } from '../relay-bundle.js';
import {
  DEFAULT_REGISTRY,
  compareVersions,
  downloadRelease,
  extractTarball,
  formatRange,
  isPrerelease,
  isVersion,
  listRelayReleases,
  parseProtocolRange,
  type ProtocolRange,
  type RelayRelease,
} from '../relay-release.js';
import { CliError, type Ctx, type GlobalOptions } from '../runtime.js';
import {
  authModeFor,
  logIn,
  nodeSpawner,
  npxArgs,
  shown,
  wranglerCommands,
  wranglerEnv,
  type SpawnResult,
  type Spawner,
  type WranglerRun,
} from './deploy.js';
import { doctor } from './ops.js';

/**
 * `decisions update`: moves an already deployed relay to the newest published release that speaks
 * a protocol the caller supports, keeping everything the relay holds.
 *
 * Nothing changes until the user confirms: the relay is identified from its URL, the target release
 * is downloaded and verified, and the Worker's live configuration is read first. The deployment
 * then keeps the Worker's bucket, Durable Object, secrets, variables and settings; a release's
 * defaults only fill in variables the Worker does not have yet.
 */

export interface UpdateOptions {
  url: string;
  /** The Worker name, when it cannot be found from the URL. */
  name?: string;
  accountId?: string;
  /** The protocol range the caller supports (`1`, `1-2`). Defaults to this CLI's own. */
  protocol?: string;
  /** Update to exactly this version instead of the newest compatible one. */
  to?: string;
  yes?: boolean;
  dryRun?: boolean;
  apiToken?: boolean;
}

export interface UpdateDeps {
  spawn?: Spawner;
  tmpRoot?: string;
  sleep?: (ms: number) => Promise<void>;
  registry?: string;
}

const REPOSITORY = 'daintreehq/decisions';
const RELAY_NAME = 'daintree-decisions';
const WORKERS_DEV = /^([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

interface RelayInfo {
  version: string;
  protocol: ProtocolRange;
  claimed: boolean;
}

export const overlaps = (a: ProtocolRange, b: ProtocolRange) =>
  Math.max(a.min, b.min) <= Math.min(a.max, b.max);

/** The relay's origin: https (or http on localhost), no credentials, path, query or fragment. */
export function relayOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CliError(`--url "${raw}" is not a URL`);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
    throw new CliError('--url must be an https URL');
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== ''))
    throw new CliError(
      '--url must be just the relay origin, like https://<worker>.<you>.workers.dev',
    );
  return u.origin;
}

async function readInfo(ctx: Ctx, origin: string): Promise<RelayInfo> {
  let body: Record<string, unknown> | null = null;
  try {
    const res = await ctx.fetch(`${origin}/api/v1/info`);
    if (res.ok) body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* reported below */
  }
  const min = body?.protocol_min;
  const max = body?.protocol_max;
  const version = body?.worker_version;
  if (
    !body ||
    body.name !== RELAY_NAME ||
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    (min as number) < 1 ||
    (max as number) < (min as number) ||
    typeof version !== 'string' ||
    !isVersion(version)
  ) {
    throw new CliError(
      `${origin} did not answer as a Decisions relay (GET /api/v1/info); check the URL. Nothing was changed.`,
    );
  }
  return {
    version,
    protocol: { min: min as number, max: max as number },
    claimed: body.claimed === true,
  };
}

/** The relay, refused while its Worker and its Durable Object run different versions. */
async function readSettledInfo(ctx: Ctx, origin: string): Promise<RelayInfo> {
  const info = await readInfo(ctx, origin);
  const { worker } = await liveVersions(ctx, origin);
  if (worker !== info.version) {
    throw new CliError(
      `${origin} is in the middle of an update (the Worker reports ${worker ?? 'nothing'}, its storage ${info.version}); try again in a few minutes. Nothing was changed.`,
    );
  }
  return info;
}

/** The target release, or a reason there is nothing to do. */
export function chooseRelease(
  releases: RelayRelease[],
  current: string,
  caller: ProtocolRange,
  to?: string,
): { release: RelayRelease } | { none: string } {
  const fits = (r: RelayRelease): r is RelayRelease & { protocol: ProtocolRange } =>
    r.protocol !== null && overlaps(r.protocol, caller);
  if (to !== undefined) {
    const r = releases.find((x) => x.version === to);
    if (!r) throw new CliError(`relay ${to} is not published`);
    if (!r.protocol)
      throw new CliError(`relay ${to} does not declare a protocol range, so it cannot be checked`);
    if (!fits(r)) {
      throw new CliError(
        `relay ${to} speaks protocol ${formatRange(r.protocol)}, outside the supported ${formatRange(caller)}`,
      );
    }
    const c = compareVersions(to, current);
    if (c === 0) return { none: `The relay is already at ${current}.` };
    if (c < 0)
      throw new CliError(
        `relay ${to} is older than the deployed ${current}; downgrades are refused`,
      );
    return { release: r };
  }
  const compatible = releases.filter((r) => fits(r) && !isPrerelease(r.version));
  const newest = compatible[compatible.length - 1];
  if (!newest) {
    return {
      none: `No published release declares support for protocol ${formatRange(caller)}, so there is nothing to update to.`,
    };
  }
  if (compareVersions(newest.version, current) <= 0) {
    return {
      none:
        newest.version === current
          ? `The relay is already at ${current}, the newest release compatible with protocol ${formatRange(caller)}.`
          : `The relay is at ${current}, newer than ${newest.version}, the newest release compatible with protocol ${formatRange(caller)}.`,
    };
  }
  return { release: newest };
}

/** Release notes for every version after `current` up to and including `target`, best effort. */
async function releaseNotes(
  ctx: Ctx,
  releases: RelayRelease[],
  current: string,
  target: string,
): Promise<string[]> {
  const versions = releases
    .map((r) => r.version)
    .filter((v) => compareVersions(v, current) > 0 && compareVersions(v, target) <= 0)
    .reverse();
  const lines: string[] = [];
  for (const [i, v] of versions.entries()) {
    const link = `https://github.com/${REPOSITORY}/releases/tag/v${v}`;
    let body: string | null = null;
    if (i < 5) {
      try {
        const res = await ctx.fetch(
          `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${v}`,
          { headers: { accept: 'application/vnd.github+json' } },
        );
        if (res.ok) {
          const b = ((await res.json()) as { body?: unknown }).body;
          if (typeof b === 'string' && b.trim()) body = b.trim();
        }
      } catch {
        /* the link is enough */
      }
    }
    lines.push(`  ${v}  ${link}`);
    if (body) {
      const text = body.split(/\r?\n/).filter((l) => l.trim());
      for (const l of text.slice(0, 12)) lines.push(`      ${l}`);
      if (text.length > 12) lines.push('      …');
    }
  }
  return lines;
}

/* ---------- keeping the live configuration ---------- */

interface TargetConfig {
  vars?: Record<string, unknown>;
  assets?: { binding?: string };
  r2_buckets?: { binding: string; bucket_name: string }[];
  durable_objects?: { bindings?: { name: string; class_name: string; script_name?: string }[] };
  [k: string]: unknown;
}

export interface ConfigPlan {
  bucket: string;
  /** Changes made to the release's Wrangler config so the live Worker keeps what it has. */
  edit: (config: Record<string, unknown>) => void;
  /** Variables the Worker keeps with their current values. */
  kept: string[];
  /** Variables the release adds with its defaults, because the Worker does not have them. */
  added: string[];
  secrets: string[];
  carried: string[];
  /** Reasons the update cannot go ahead without losing something. */
  blockers: string[];
}

/**
 * How the release's Wrangler config has to change to keep everything the live Worker has, or why
 * it cannot: the bucket, the Durable Object namespace, every variable and secret, workers.dev and
 * preview exposure, and observability, placement, limits, tail and Logpush settings.
 */
export function planConfig(live: WorkerSnapshot, target: TargetConfig): ConfigPlan {
  const blockers: string[] = [];
  const defaults = target.vars ?? {};
  const assetsBinding = target.assets?.binding;
  const r2 = target.r2_buckets ?? [];
  const dos = target.durable_objects?.bindings ?? [];
  const declared = new Set<string>([
    ...(assetsBinding ? [assetsBinding] : []),
    ...r2.map((b) => b.binding),
    ...dos.map((b) => b.name),
  ]);

  let bucket: string | null = null;
  let jurisdiction: string | undefined;
  const liveVars = new Set<string>();
  const secrets: string[] = [];
  const seenDo = new Set<string>();
  for (const b of live.bindings) {
    if (b.type === 'plain_text' || b.type === 'json') {
      if (declared.has(b.name))
        blockers.push(`${b.name} is a variable on the Worker but a binding in this release`);
      liveVars.add(b.name);
    } else if (b.type === 'secret_text') {
      if (declared.has(b.name))
        blockers.push(`${b.name} is a secret on the Worker but a binding in this release`);
      secrets.push(b.name);
    } else if (b.type === 'assets' && b.name === assetsBinding) {
      /* replaced by the release's assets */
    } else if (b.type === 'r2_bucket' && r2.some((x) => x.binding === b.name)) {
      if (typeof b.bucket_name !== 'string') blockers.push(`the bucket of ${b.name} is unknown`);
      else bucket = b.bucket_name;
      if (typeof b.jurisdiction === 'string' && b.jurisdiction) jurisdiction = b.jurisdiction;
    } else if (b.type === 'durable_object_namespace' && dos.some((x) => x.name === b.name)) {
      const want = dos.find((x) => x.name === b.name)!;
      const external = typeof b.script_name === 'string' && b.script_name !== live.name;
      if (b.class_name !== want.class_name || external || want.script_name) {
        blockers.push(
          `the Durable Object ${b.name} is ${String(b.class_name)}${external ? ` in ${String(b.script_name)}` : ''} on the Worker but ${want.class_name} in this release; that needs a migration this command does not do`,
        );
      }
      seenDo.add(b.name);
    } else {
      blockers.push(
        `the Worker has a ${b.type} binding ${b.name} that this release does not declare, and deploying would remove it`,
      );
    }
  }
  for (const d of dos) {
    if (!seenDo.has(d.name))
      blockers.push(
        `the Worker has no Durable Object ${d.name}, so it is not a Decisions relay this command can update`,
      );
  }
  if (r2.length !== 1) blockers.push('the release does not declare exactly one R2 bucket');
  if (bucket === null && r2.length === 1)
    blockers.push(
      `the Worker has no ${r2[0]!.binding} bucket, so it is not a Decisions relay this command can update`,
    );

  const kept = Object.keys(defaults).filter((k) => liveVars.has(k));
  const added = Object.keys(defaults).filter((k) => !liveVars.has(k) && !secrets.includes(k));
  const extraVars = [...liveVars].filter((k) => !(k in defaults));
  const carried = { ...live.carried };
  if (carried.placement !== undefined) {
    const placement = wranglerPlacement(carried.placement);
    if (placement === 'unsupported')
      blockers.push(
        `the Worker's placement setting ${JSON.stringify(carried.placement)} cannot be carried into the deployment`,
      );
    else if (placement === null) delete carried.placement;
    else carried.placement = placement;
  }
  const edit = (config: Record<string, unknown>) => {
    // Wrangler would otherwise replace every variable with the release's defaults and delete the
    // rest. With keep_vars it leaves the Worker's variables alone, and only new ones are sent.
    config.keep_vars = true;
    const vars: Record<string, unknown> = {};
    for (const k of added) vars[k] = defaults[k];
    config.vars = vars;
    if (jurisdiction) {
      const b = (config.r2_buckets as Record<string, unknown>[] | undefined)?.[0];
      if (b) b.jurisdiction = jurisdiction;
    }
    config.workers_dev = live.workersDev;
    config.preview_urls = live.previewUrls;
    for (const [k, v] of Object.entries(carried)) config[k] = v;
  };
  return {
    bucket: bucket ?? '',
    edit,
    kept: [...kept, ...extraVars].sort(),
    added,
    secrets: secrets.sort(),
    carried: Object.keys(carried),
    blockers,
  };
}

/**
 * The settings API's placement in Wrangler's config shape: smart placement as it is, a single
 * targeted region, host or hostname flattened, no placement as null.
 */
function wranglerPlacement(p: unknown): Record<string, unknown> | null | 'unsupported' {
  if (!p || typeof p !== 'object') return null;
  const o = p as {
    mode?: unknown;
    target?: unknown;
    region?: unknown;
    host?: unknown;
    hostname?: unknown;
  };
  if (o.mode === undefined || o.mode === 'off') {
    for (const k of ['region', 'host', 'hostname'] as const)
      if (typeof o[k] === 'string') return { [k]: o[k] };
    return null;
  }
  if (o.mode === 'smart') return { mode: 'smart' };
  if (o.mode === 'targeted') {
    const t =
      Array.isArray(o.target) && o.target.length === 1
        ? (o.target[0] as Record<string, unknown>)
        : null;
    const keys = t ? Object.keys(t).filter((k) => typeof t[k] === 'string') : [];
    if (t && keys.length === 1 && ['region', 'host', 'hostname'].includes(keys[0]!))
      return { [keys[0]!]: t[keys[0]!] };
    for (const k of ['region', 'host', 'hostname'] as const)
      if (typeof o[k] === 'string') return { [k]: o[k] };
  }
  return 'unsupported';
}

/* ---------- finding the Worker ---------- */

async function apiToken(
  wr: WranglerRun,
  env: Record<string, string | undefined>,
  secrets: string[],
): Promise<string> {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  const r = await wr(['auth', 'token', '--json'], { env: { WRANGLER_WRITE_LOGS: 'false' } });
  let parsed: { type?: unknown; token?: unknown } | null = null;
  try {
    parsed = JSON.parse(r.stdout) as { type?: unknown; token?: unknown };
  } catch {
    /* reported below, without echoing what Wrangler printed */
  }
  if (typeof parsed?.token === 'string' && parsed.token) secrets.push(parsed.token);
  if (r.status !== 0 || !parsed) {
    throw new CliError('Wrangler did not hand over its Cloudflare login (wrangler auth token)');
  }
  if (parsed.type === 'api_key') {
    throw new CliError(
      'Wrangler is using a global API key, which this command does not use; set CLOUDFLARE_API_TOKEN to an API token or pass --api-token',
    );
  }
  if (typeof parsed.token !== 'string' || !parsed.token) {
    throw new CliError('Wrangler did not hand over its Cloudflare login (wrangler auth token)');
  }
  return parsed.token;
}

interface Resolved {
  snapshot: WorkerSnapshot;
  /**
   * How the Worker was found: its workers.dev URL names it, a custom domain is attached to it (a
   * Worker Route on the same host would take precedence), or the user named or picked it.
   */
  via: 'workers.dev' | 'custom domain' | 'name';
}

async function resolveWorker(
  ctx: Ctx,
  api: CloudflareApi,
  origin: string,
  o: UpdateOptions,
): Promise<Resolved> {
  const accountId = o.accountId ?? ctx.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts: Account[] = accountId
    ? [
        (await api.accounts().catch(() => [])).find((a) => a.id === accountId) ?? {
          id: accountId,
          name: accountId,
        },
      ]
    : await api.accounts();
  if (!accounts.length) throw new CliError('this Cloudflare login has no accounts');

  const host = new URL(origin).hostname.toLowerCase();
  let proven: WorkerSnapshot | null = null;
  let via: Resolved['via'] = 'workers.dev';
  const dev = WORKERS_DEV.exec(host);
  for (const account of accounts) {
    if (dev) {
      if ((await api.workersSubdomain(account.id)) !== dev[2]) continue;
      proven = await api.snapshot(account, dev[1]!);
    } else {
      const service = await api.customDomainService(account.id, host);
      if (service) {
        proven = await api.snapshot(account, service);
        via = 'custom domain';
      }
    }
    if (proven) break;
  }
  if (proven) {
    if (o.name && o.name !== proven.name) {
      throw new CliError(
        `${origin} is served by the Worker "${proven.name}", not "${o.name}"; drop --name or check the URL`,
      );
    }
    return { snapshot: proven, via };
  }

  if (o.name) {
    const found: WorkerSnapshot[] = [];
    for (const account of accounts) {
      const s = await api.snapshot(account, o.name);
      if (s) found.push(s);
    }
    if (found.length === 1) return { snapshot: found[0]!, via: 'name' };
    if (found.length > 1) {
      throw new CliError(
        `several accounts have a Worker named "${o.name}" (${found.map((s) => s.account.id).join(', ')}); pass --account-id`,
      );
    }
    throw new CliError(
      `no Worker named "${o.name}" in ${accounts.length === 1 ? `the account ${accounts[0]!.name}` : 'any account this login can see'}`,
    );
  }

  const why = dev
    ? `no account this login can see has the workers.dev subdomain "${dev[2]}" with a Worker "${dev[1]}"`
    : `${host} is not a custom domain of a Worker in any account this login can see`;
  if (ctx.interactive === false) {
    throw new CliError(
      `could not tell which Worker serves ${origin}: ${why}. Pass --name <worker> (and --account-id <id>), or log in to the account that owns it.`,
    );
  }
  const choices: { account: Account; name: string }[] = [];
  for (const account of accounts) {
    for (const name of await api.workerNames(account.id)) choices.push({ account, name });
  }
  ctx.out(`\nCould not tell which Worker serves ${origin}: ${why}.`);
  if (choices.length) {
    ctx.out('Pick the Worker to update, or type its name:');
    choices.forEach((c, i) =>
      ctx.out(
        `  [${i + 1}] ${c.name}${accounts.length > 1 ? `  (${c.account.name}, ${c.account.id})` : ''}`,
      ),
    );
  }
  const answer = (await ctx.prompt('Worker: ')).trim();
  const pick = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined;
  const name = pick?.name ?? answer;
  if (!name || !WORKER_NAME.test(name)) throw new CliError('no Worker chosen; nothing was changed');
  const found: WorkerSnapshot[] = [];
  for (const account of pick ? [pick.account] : accounts) {
    const s = await api.snapshot(account, name);
    if (s) found.push(s);
  }
  if (found.length > 1) {
    throw new CliError(
      `several accounts have a Worker named "${name}" (${found.map((s) => s.account.id).join(', ')}); pick it by number or pass --account-id. Nothing was changed.`,
    );
  }
  if (found.length === 1) return { snapshot: found[0]!, via: 'name' };
  throw new CliError(`no Worker named "${name}"; nothing was changed`);
}

/* ---------- after the deploy ---------- */

async function liveVersions(
  ctx: Ctx,
  origin: string,
): Promise<{ worker: string | null; room: string | null }> {
  const get = async (path: string, key: string) => {
    try {
      const r = await ctx.fetch(`${origin}${path}`);
      if (!r.ok) return null;
      const v = ((await r.json()) as Record<string, unknown>)[key];
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  };
  return {
    worker: await get('/health', 'version'),
    room: await get('/api/v1/info', 'worker_version'),
  };
}

/**
 * Waits for the Worker, then its Durable Object, to report the target version. Wrangler defers the
 * Durable Object's code update for up to five minutes, so the second wait is the long one.
 */
async function waitForVersion(
  ctx: Ctx,
  origin: string,
  target: string,
  sleep: (ms: number) => Promise<void>,
): Promise<{ worker: string | null; room: string | null }> {
  let seen = { worker: null as string | null, room: null as string | null };
  for (let i = 0; i < 20; i++) {
    seen = await liveVersions(ctx, origin);
    if (seen.worker === target) break;
    await sleep(3000);
  }
  if (seen.worker !== target) return seen;
  for (let i = 0; i < 40 && seen.room !== target; i++) {
    if (i === 1)
      ctx.out('    waiting for the relay to restart on the new version (up to 6 minutes)');
    await sleep(10_000);
    seen = await liveVersions(ctx, origin);
  }
  return seen;
}

/* ---------- the command ---------- */

export async function update(
  ctx: Ctx,
  g: GlobalOptions,
  o: UpdateOptions,
  deps: UpdateDeps = {},
): Promise<void> {
  const say = (l = '') => ctx.out(l);
  const origin = relayOrigin(o.url);
  if (o.accountId !== undefined && !ACCOUNT_ID.test(o.accountId))
    throw new CliError('--account-id must be a 32-character Cloudflare account ID');
  if (o.name !== undefined && !WORKER_NAME.test(o.name))
    throw new CliError(`--name "${o.name}" is not a valid Worker name`);
  if (o.to !== undefined && !isVersion(o.to)) throw new CliError(`--to "${o.to}" is not a version`);
  const caller: ProtocolRange = o.protocol
    ? parseProtocolRange(o.protocol)
    : { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION };

  // 1. The relay and the release to move it to. Nothing here needs Cloudflare.
  const info = await readSettledInfo(ctx, origin);
  say(
    `Relay ${origin}: version ${info.version}, protocol ${formatRange(info.protocol)}${info.claimed ? ', claimed' : ', not claimed yet'}`,
  );
  const releases = await listRelayReleases(ctx.fetch, deps.registry ?? DEFAULT_REGISTRY);
  const choice = chooseRelease(releases, info.version, caller, o.to);
  if ('none' in choice) {
    say(`${choice.none} Nothing was changed.`);
    return;
  }
  const target = choice.release as RelayRelease & { protocol: ProtocolRange };
  say(
    `Update available: ${info.version} -> ${target.version} (protocol ${formatRange(target.protocol)})`,
  );
  if (target.protocol.min > info.protocol.min) {
    say(
      `    note: ${target.version} drops protocol ${formatRange({ min: info.protocol.min, max: target.protocol.min - 1 })}; apps that only speak it will need updating too`,
    );
  }
  const notes = await releaseNotes(ctx, releases, info.version, target.version);
  if (notes.length) {
    say('\nWhat changed:');
    for (const l of notes) say(l);
  }

  // 2. The exact release, verified before anything else happens.
  const bundle: VerifiedRelayBundle = await verifyRelayRelease(
    extractTarball(await downloadRelease(ctx.fetch, target)),
    { version: target.version, protocol: target.protocol },
  );
  const wrangler = bundle.manifest.wrangler;
  say(
    `\nRelay ${target.version}: ${bundle.files.size} files verified against the registry's integrity digest and the release manifest`,
  );
  const targetConfig = JSON.parse(
    bundle.files.get(bundle.manifest.config)!.toString('utf8'),
  ) as TargetConfig;

  const spawn = deps.spawn ?? nodeSpawner;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const env = wranglerEnv(ctx, o.accountId, true);
  const secrets: string[] = [];
  const redact = (t: string) => secrets.reduce((acc, v) => acc.split(v).join('[redacted]'), t);
  const output = (r: SpawnResult) => redact(`${r.stdout}\n${r.stderr}`.trim());

  const staging = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'decisions-update-'));
  try {
    let cwd = staging;
    const wr: WranglerRun = (args, x = {}) => {
      if (x.capture !== false && !args.includes('token')) say(`    $ ${shown(wrangler, args)}`);
      return spawn({
        cmd: 'npx',
        args: npxArgs(wrangler, args),
        cwd,
        env: { ...env, ...x.env },
        capture: x.capture ?? true,
        ...(x.echo ? { echo: true } : {}),
        ...(x.input !== undefined ? { input: x.input } : {}),
      });
    };

    // 3. The Worker behind the URL and its live configuration (read-only).
    say('\nFinding the Worker in Cloudflare');
    const v = await wr(wranglerCommands.version());
    if (v.status !== 0) {
      throw new CliError(
        `could not run Wrangler ${wrangler} through npx (is npm installed and the registry reachable?)\n${output(v)}`,
      );
    }
    const auth = authModeFor(ctx, o.apiToken);
    if (!(await logIn(ctx, wr, auth, env, secrets, output, !o.dryRun))) {
      say(
        '\nNot logged in to Cloudflare, so the dry run stops here (run `npx wrangler login`). Nothing was changed.',
      );
      return;
    }
    const api = new CloudflareApi(ctx.fetch, await apiToken(wr, env, secrets));
    const { snapshot, via } = await resolveWorker(ctx, api, origin, o);
    const plan = planConfig(snapshot, targetConfig);
    if (plan.blockers.length) {
      throw new CliError(
        `the Worker "${snapshot.name}" cannot be updated without losing something:\n  ${plan.blockers.join('\n  ')}\nNothing was changed.`,
      );
    }

    say(
      `\nUpdate the Worker "${snapshot.name}" in ${snapshot.account.name} from ${info.version} to ${target.version}`,
    );
    if (via === 'name')
      say(`    chosen by name: it could not be matched to ${origin} through Cloudflare`);
    if (via === 'custom domain')
      say(
        `    found through its custom domain; a Worker Route on the same host would take precedence`,
      );
    say(
      `    deploys      ${shown(wrangler, wranglerCommands.deploy())}  (exactly relay ${target.version})`,
    );
    say(
      `    keeps        the claim, paired devices, questions and answers (Durable Object storage)`,
    );
    say(`    keeps        the bucket ${plan.bucket}`);
    if (plan.secrets.length) say(`    keeps        secrets ${plan.secrets.join(', ')}`);
    if (plan.kept.length)
      say(`    keeps        variables ${plan.kept.join(', ')} with their current values`);
    if (plan.added.length)
      say(`    adds         variables ${plan.added.join(', ')} with the release defaults`);
    if (plan.carried.length) say(`    keeps        settings ${plan.carried.join(', ')}`);
    say(
      `    keeps        workers.dev ${snapshot.workersDev ? 'on' : 'off'}, preview URLs ${snapshot.previewUrls ? 'on' : 'off'}`,
    );

    if (o.dryRun) {
      say('\nDry run: nothing was changed.');
      return;
    }
    if (!o.yes) {
      const a = (await ctx.prompt(`\nUpdate now? [y/N] `)).trim().toLowerCase();
      if (a !== 'y' && a !== 'yes') {
        say(`Cancelled. Nothing was changed; the relay is still ${info.version}.`);
        return;
      }
    }

    // 4. Deploy, unless the Worker changed while the user was reading.
    const again = await api.snapshot(snapshot.account, snapshot.name);
    if (!again || JSON.stringify(again) !== JSON.stringify(snapshot)) {
      throw new CliError(
        `the Worker "${snapshot.name}" changed in Cloudflare while waiting for confirmation; nothing was changed. Run the update again.`,
      );
    }
    const before = await liveVersions(ctx, origin);
    if (before.worker !== info.version) {
      throw new CliError(
        `${origin} now reports ${before.worker ?? 'nothing'} instead of ${info.version}: something else deployed it while waiting for confirmation. Nothing was changed; run the update again.`,
      );
    }
    await stageRelayBundle(bundle, join(staging, 'relay'), {
      name: snapshot.name,
      bucket: plan.bucket,
      edit: plan.edit,
    });
    cwd = join(staging, 'relay');
    env.CLOUDFLARE_ACCOUNT_ID = snapshot.account.id;
    say(`\nDeploying relay ${target.version}`);
    // Captured rather than streamed, so it is shown only after redaction.
    const dep = await wr(wranglerCommands.deploy());
    if (dep.status !== 0) {
      const now = await liveVersions(ctx, origin);
      const state =
        now.worker === null
          ? 'The relay did not answer afterwards, so its state is unknown: run `decisions doctor --url ' +
            origin +
            '`.'
          : now.worker === info.version
            ? `The relay still reports ${info.version}, so the update most likely did not take effect; parts of it may have been uploaded. Running the update again is safe.`
            : `The relay now reports ${now.worker}.`;
      throw new CliError(
        `Wrangler could not deploy relay ${target.version}. ${state}\n${output(dep)}`,
      );
    }

    for (const l of output(dep).split('\n').slice(-15)) if (l.trim()) say(`    ${l}`);

    // 5. Check it.
    say('\nChecking the relay');
    const seen = await waitForVersion(ctx, origin, target.version, sleep);
    if (seen.worker !== target.version) {
      throw new CliError(
        via === 'workers.dev'
          ? `Wrangler finished deploying relay ${target.version}, but ${origin} still reports ${seen.worker ?? 'nothing'}: the deploy may have been cancelled or not taken effect yet. Check with: decisions doctor --url ${origin}`
          : `Wrangler finished deploying relay ${target.version} to "${snapshot.name}", but ${origin} still reports ${seen.worker ?? 'nothing'}: that Worker may not be the one behind this URL, or the deploy did not take effect`,
      );
    }
    if (seen.room !== target.version) {
      throw new CliError(
        `the Worker runs ${target.version}, but the relay's storage still answers as ${seen.room ?? 'nothing'}; it normally switches within minutes. Check with: decisions doctor --url ${origin}`,
      );
    }
    const after = await readInfo(ctx, origin).catch(() => null);
    if (after && info.claimed && !after.claimed) {
      throw new CliError(
        `relay ${target.version} is live but no longer reports being claimed; run decisions doctor --url ${origin}`,
      );
    }
    const own = { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION };
    if (!overlaps(target.protocol, own)) {
      say(
        `    relay ${target.version} speaks protocol ${formatRange(target.protocol)} and this CLI ${formatRange(own)}, so its full check is left to the app`,
      );
    } else
      try {
        await doctor({ ...ctx, json: false }, g, { url: origin });
      } catch (e) {
        throw new CliError(
          `relay ${target.version} is live, but the health check found problems: ${(e as Error).message}. Run: decisions doctor --url ${origin}`,
        );
      }
    say(
      `\nUpdated ${origin} to relay ${target.version}. Paired phones keep working and reload the new app on their own.`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
