import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PINNED_MANIFEST_SHA256, locateRelayBundle, verifyRelayBundle } from '../relay-bundle.js';
import { CliError, keyStoreFor, type Ctx, type GlobalOptions } from '../runtime.js';
import { VERSION } from '../version.js';
import {
  ACCOUNT_ID,
  BUCKET_NAME,
  WORKER_NAME,
  nodeSpawner,
  npxArgs,
  shown,
  wranglerCommands,
  type AuthMode,
  type SpawnResult,
  type Spawner,
} from './deploy.js';

/**
 * `decisions remove`: takes a deployed relay out of the user's Cloudflare account. It finds the
 * Worker from its URL or name, lists what belongs to it (the Worker, the Durable Object storage it
 * implements, its attachments bucket), states the consequences, and deletes only after the user has
 * typed the Worker name and said yes. It needs no relay keys and no claim secret, so it works on a
 * relay that was never claimed or whose owner keys are gone.
 *
 * Everything goes through the Cloudflare API. With Wrangler's browser login the token comes from
 * `wrangler auth token`; it is kept in memory, never printed, and redacted from any error.
 *
 * The Worker goes first, so the relay stops taking uploads before its bucket is emptied; deleting
 * it also deletes the Durable Object namespaces it implements. Before anything is deleted, the
 * bucket names are saved in `<home>/removals/`, so a run that stops part way can be repeated to
 * finish even after the Worker (which names the bucket) is gone.
 */

export interface RemoveOptions {
  accountId?: string;
  /** Ask for a Cloudflare API token instead of using Wrangler's browser login. */
  apiToken?: boolean;
  /** The bucket to finish removing when the Worker is already gone and no removal record exists. */
  bucket?: string;
  dryRun?: boolean;
}

export interface RemoveDeps {
  spawn?: Spawner;
  bundleDir?: string;
  pinnedManifestSha256?: string | undefined;
  version?: string;
  tmpRoot?: string;
  sleep?: (ms: number) => Promise<void>;
}

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

/** What the relay's Wrangler config declares; a Worker without all of it is not confirmed as a relay. */
const RELAY_BUCKET_BINDING = 'ATTACHMENTS';
const RELAY_DO_BINDING = 'DECISION_ROOM';
const RELAY_DO_CLASS = 'DecisionRoom';

export type RemoveTarget =
  | { kind: 'name'; worker: string }
  | { kind: 'workers.dev'; worker: string; subdomain: string }
  | { kind: 'domain'; hostname: string };

/** A Worker name, or the https URL the relay answers on (its workers.dev URL or a custom domain). */
export function parseTarget(input: string): RemoveTarget {
  const t = input.trim();
  if (WORKER_NAME.test(t)) return { kind: 'name', worker: t };
  let url: URL;
  try {
    url = new URL(t.includes('://') ? t : `https://${t}`);
  } catch {
    throw new CliError(`"${input}" is neither a Worker name nor a URL`);
  }
  if (url.protocol !== 'https:') throw new CliError('the relay URL must start with https://');
  if (url.username || url.password || url.port) {
    throw new CliError('the relay URL must be a plain https origin (no user, password or port)');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'workers.dev' || host.endsWith('.workers.dev')) {
    const labels = host.split('.');
    const [worker, subdomain] = labels;
    if (labels.length !== 4 || !worker || !subdomain || !WORKER_NAME.test(worker)) {
      throw new CliError(
        `${url.origin} is not a Worker URL of the form https://<worker>.<subdomain>.workers.dev`,
      );
    }
    return { kind: 'workers.dev', worker, subdomain };
  }
  return { kind: 'domain', hostname: host };
}

interface CfResult<T> {
  status: number;
  ok: boolean;
  result: T | null;
  info: { page?: number; total_pages?: number } | undefined;
  message: string;
}

/** A small Cloudflare API client: fixed origin, no redirects, bounded retries on 429 and 5xx. */
class Cloudflare {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly token: string,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly redact: (s: string) => string,
  ) {}

  async call<T>(
    method: 'GET' | 'DELETE',
    path: string,
    o: { query?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<CfResult<T>> {
    const url = new URL(CLOUDFLARE_API + path);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url.toString(), {
          method,
          headers: { Authorization: `Bearer ${this.token}`, ...o.headers },
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        if (attempt < 3) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new CliError(
          `could not reach the Cloudflare API (${method} ${path}): ${this.redact((e as Error).message)}`,
        );
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const after = Number(res.headers.get('retry-after'));
        await this.sleep(
          Number.isFinite(after) && after > 0
            ? Math.min(after, 30) * 1000
            : Math.min(1000 * 2 ** attempt, 10_000),
        );
        continue;
      }
      let body: {
        success?: unknown;
        result?: unknown;
        result_info?: CfResult<T>['info'];
        errors?: { code?: unknown; message?: unknown }[];
      } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        /* not JSON; the status decides */
      }
      const ok = res.ok && body.success !== false;
      const message = this.redact(
        (Array.isArray(body.errors) ? body.errors : [])
          .map((e) => `${String(e.code ?? '')} ${String(e.message ?? '')}`.trim())
          .join('; ') || `HTTP ${res.status}`,
      );
      return {
        status: res.status,
        ok,
        result: ok ? ((body.result ?? null) as T | null) : null,
        info: body.result_info,
        message,
      };
    }
  }

  /** A GET that must succeed; resolves to null on 404 when `missing` is allowed. */
  async get<T>(
    path: string,
    what: string,
    o: { query?: Record<string, string>; headers?: Record<string, string>; missing?: boolean } = {},
  ): Promise<T | null> {
    const r = await this.call<T>('GET', path, o);
    if (r.status === 404 && o.missing) return null;
    if (!r.ok) throw new CliError(`could not read ${what} from Cloudflare: ${r.message}`);
    return r.result;
  }

  /** Every page of a page-numbered list. */
  async list<T>(path: string, what: string, perPage: number): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 1000; page++) {
      const r = await this.call<T[]>('GET', path, {
        query: { page: String(page), per_page: String(perPage) },
      });
      if (!r.ok) throw new CliError(`could not list ${what} on Cloudflare: ${r.message}`);
      const items = Array.isArray(r.result) ? r.result : [];
      all.push(...items);
      const total = r.info?.total_pages;
      if (typeof total === 'number' ? page >= total : items.length < perPage) break;
    }
    return all;
  }
}

interface Account {
  id: string;
  name?: string;
}

interface Binding {
  type?: string;
  name?: string;
  bucket_name?: string;
  jurisdiction?: string;
  class_name?: string;
  script_name?: string;
}

interface Namespace {
  id: string;
  name?: string;
  script?: string;
  class?: string;
}

interface Bucket {
  name: string;
  jurisdiction?: string;
}

interface RemovalRecord {
  schema: 1;
  account_id: string;
  worker: string;
  buckets: Bucket[];
}

interface Inventory {
  account: Account;
  worker: string;
  workerExists: boolean;
  origin: string | undefined;
  namespaces: Namespace[];
  buckets: (Bucket & { exists: boolean })[];
  /** Bindings of the Worker this command leaves alone. */
  leftInPlace: string[];
  confirmed: boolean;
  /** Why the Worker could not be confirmed as a Decisions relay. */
  doubts: string[];
  claimed: boolean | undefined;
  record: RemovalRecord | null;
}

const bucketHeaders = (b: Bucket): Record<string, string> =>
  b.jurisdiction && b.jurisdiction !== 'default' ? { 'cf-r2-jurisdiction': b.jurisdiction } : {};

/** Object keys go into the path with `/` kept literal; dot segments would be rewritten by URL parsing. */
function objectPath(key: string): string | null {
  const segments = key.split('/');
  if (segments.some((s) => s === '.' || s === '..')) return null;
  return segments.map(encodeURIComponent).join('/');
}

const recordDir = (home: string) => join(home, 'removals');
const recordPath = (home: string, account: string, worker: string) =>
  join(recordDir(home), `${account}-${worker}.json`);

async function readRecord(path: string): Promise<RemovalRecord | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const r = JSON.parse(text) as Partial<RemovalRecord>;
  if (
    r.schema !== 1 ||
    typeof r.account_id !== 'string' ||
    typeof r.worker !== 'string' ||
    !Array.isArray(r.buckets) ||
    !r.buckets.every((b) => b && typeof b.name === 'string' && BUCKET_NAME.test(b.name))
  ) {
    throw new CliError(`the removal record ${path} is not valid; delete it and pass --bucket`);
  }
  return r as RemovalRecord;
}

/** Records of earlier, unfinished removals of a Worker with this name, in any account. */
async function recordsFor(home: string, worker: string): Promise<RemovalRecord[]> {
  const names = await readdir(recordDir(home)).catch(() => [] as string[]);
  const out: RemovalRecord[] = [];
  for (const n of names) {
    if (!n.endsWith(`-${worker}.json`)) continue;
    const r = await readRecord(join(recordDir(home), n));
    if (r && r.worker === worker) out.push(r);
  }
  return out;
}

async function saveRecord(home: string, r: RemovalRecord): Promise<void> {
  await mkdir(recordDir(home), { recursive: true, mode: 0o700 });
  const path = recordPath(home, r.account_id, r.worker);
  await writeFile(path, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function remove(
  ctx: Ctx,
  g: GlobalOptions,
  targetInput: string,
  o: RemoveOptions = {},
  deps: RemoveDeps = {},
): Promise<void> {
  const target = parseTarget(targetInput);
  const accountId = o.accountId ?? ctx.env.CLOUDFLARE_ACCOUNT_ID;
  if (accountId !== undefined && !ACCOUNT_ID.test(accountId)) {
    throw new CliError(
      o.accountId !== undefined
        ? '--account-id must be a 32-character Cloudflare account ID'
        : 'CLOUDFLARE_ACCOUNT_ID is not a 32-character Cloudflare account ID',
    );
  }
  if (o.bucket !== undefined && !BUCKET_NAME.test(o.bucket)) {
    throw new CliError(`--bucket "${o.bucket}" is not a valid R2 bucket name`);
  }
  if (!o.dryRun && !ctx.interactive) {
    throw new CliError(
      'remove asks you to confirm at a terminal, so it only runs interactively; --dry-run shows what it would remove',
    );
  }
  const say = (l = '') => ctx.out(l);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const secrets: string[] = [];
  const redact = (t: string) => secrets.reduce((acc, v) => acc.split(v).join('[redacted]'), t);

  say('Log in to Cloudflare');
  const token = await cloudflareToken(ctx, o, deps, secrets, redact);
  const cf = new Cloudflare(ctx.fetch, token, sleep, redact);

  const located = await locate(ctx, cf, target, accountId, o);
  const inv = await inventory(ctx, cf, located, o);

  showInventory(ctx, inv, o);
  const nothing = !inv.workerExists && !inv.namespaces.length && !inv.buckets.some((b) => b.exists);
  if (nothing) {
    say(`\nNothing of "${inv.worker}" is left in this account; there is nothing to remove.`);
    if (inv.record && !o.dryRun) {
      await rm(recordPath(ctx.home, inv.account.id, inv.worker), { force: true });
    }
    return;
  }
  if (o.dryRun) {
    say('\nDry run: nothing was deleted.');
    return;
  }

  if (!inv.confirmed) {
    say('');
    say('WARNING: this could not be confirmed as a Decisions relay:');
    for (const d of inv.doubts) say(`  - ${d}`);
    say('If it is something else, removing it deletes that instead, with all of its data.');
    const a = await ctx.prompt('Type "remove anyway" to continue: ');
    if (a.trim() !== 'remove anyway') throw new CliError('cancelled; nothing was deleted');
  }
  const typed = await ctx.prompt(`\nType the Worker name (${inv.worker}) to confirm: `);
  if (typed.trim() !== inv.worker) {
    throw new CliError('the name did not match; cancelled, nothing was deleted');
  }
  const yes = await ctx.prompt('Delete everything listed above now? This cannot be undone. [y/N] ');
  if (!/^(y|yes)$/i.test(yes.trim())) throw new CliError('cancelled; nothing was deleted');

  // Saved before the first deletion: once the Worker is gone, this is what still names the bucket.
  const record: RemovalRecord = {
    schema: 1,
    account_id: inv.account.id,
    worker: inv.worker,
    buckets: inv.buckets.map(({ name, jurisdiction }) =>
      jurisdiction ? { name, jurisdiction } : { name },
    ),
  };
  try {
    await saveRecord(ctx.home, record);
  } catch (e) {
    throw new CliError(
      `could not save the removal record in ${recordDir(ctx.home)} (${(e as Error).message}); nothing was deleted`,
    );
  }

  const left = await execute(ctx, cf, inv, sleep);

  if (left.length) {
    say('\nNot finished. Still in Cloudflare:');
    for (const l of left) say(`  - ${l}`);
    say('\nRun the same command again to finish:');
    say(`  decisions remove ${rerunArgs(targetInput, inv.account.id, o)}`);
    throw new CliError('the relay was only partly removed');
  }
  await rm(recordPath(ctx.home, inv.account.id, inv.worker), { force: true });
  say(`\nRemoved. Nothing of "${inv.worker}" is left in Cloudflare.`);
  say('A fresh `decisions deploy` sets up a new relay from nothing.');
  await localIdentityHint(ctx, g, inv.origin);
}

/** The Cloudflare API token: from the prompt, the environment, or Wrangler's browser login. */
async function cloudflareToken(
  ctx: Ctx,
  o: RemoveOptions,
  deps: RemoveDeps,
  secrets: string[],
  redact: (t: string) => string,
): Promise<string> {
  const auth: AuthMode = o.apiToken
    ? 'token-prompt'
    : ctx.env.CLOUDFLARE_API_TOKEN
      ? 'token-env'
      : 'browser';
  if (auth === 'token-prompt') {
    const t = (await ctx.prompt('Cloudflare API token (input hidden): ', { secret: true })).trim();
    if (!t) throw new CliError('no API token entered');
    secrets.push(t);
    ctx.out('    using the API token');
    return t;
  }
  if (auth === 'token-env') {
    secrets.push(ctx.env.CLOUDFLARE_API_TOKEN!);
    ctx.out('    using the API token in CLOUDFLARE_API_TOKEN');
    return ctx.env.CLOUDFLARE_API_TOKEN!;
  }

  // The browser login runs the exact Wrangler the relay was released with, as `decisions deploy` does.
  const bundle = await verifyRelayBundle(deps.bundleDir ?? locateRelayBundle(), {
    pinnedSha256:
      'pinnedManifestSha256' in deps ? deps.pinnedManifestSha256 : PINNED_MANIFEST_SHA256,
    version: deps.version ?? VERSION,
  });
  const wrangler = bundle.manifest.wrangler;
  const spawn = deps.spawn ?? nodeSpawner;
  const env: Record<string, string | undefined> = { ...ctx.env };
  delete env.npm_config_package;
  delete env.npm_config_call;
  env.WRANGLER_LOG_SANITIZE = 'true';
  env.WRANGLER_WRITE_LOGS = 'false';
  // An empty directory, so Wrangler never picks up a wrangler.json from wherever the user is.
  const cwd = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'decisions-remove-'));
  try {
    const wr = (args: string[], x: { capture?: boolean; quiet?: boolean } = {}) => {
      if (!x.quiet) ctx.out(`    $ ${shown(wrangler, args)}`);
      return spawn({
        cmd: 'npx',
        args: npxArgs(wrangler, args),
        cwd,
        env,
        capture: x.capture ?? true,
      });
    };
    const output = (r: SpawnResult) => redact(`${r.stdout}\n${r.stderr}`.trim());
    const v = await wr(wranglerCommands.version());
    if (v.status !== 0) {
      throw new CliError(
        `could not run Wrangler ${wrangler} through npx (is npm installed and the registry reachable?)\n${output(v)}`,
      );
    }
    const who = await wr(wranglerCommands.whoami());
    const loggedIn = who.status === 0 && !/not authenticated|not logged in/i.test(output(who));
    if (loggedIn) {
      ctx.out('    already logged in');
    } else {
      ctx.out('    a browser window opens to log in to Cloudflare');
      const login = await wr(wranglerCommands.login(), { capture: false });
      if (login.status !== 0) throw new CliError('Cloudflare login failed');
    }
    const args = ['auth', 'token', '--json'];
    ctx.out(`    $ ${shown(wrangler, args)}   (the token stays in memory)`);
    // Its output carries the token, so none of it is ever shown, even on failure.
    const t = await wr(args, { quiet: true });
    const token = t.status === 0 ? parseTokenOutput(t.stdout) : null;
    if (!token) {
      throw new CliError(
        'Wrangler did not hand over a Cloudflare token (with an API key login, use --api-token instead)',
      );
    }
    secrets.push(token);
    return token;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** The bearer token in `wrangler auth token --json` output, or null for anything else. */
export function parseTokenOutput(stdout: string): string | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(stdout.slice(start, end + 1)) as { type?: unknown; token?: unknown };
    if ((j.type === 'oauth' || j.type === 'api_token') && typeof j.token === 'string') {
      const token = j.token.trim();
      return /^[\x21-\x7e]{20,}$/.test(token) ? token : null;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

interface Located {
  account: Account;
  worker: string;
  subdomain: string | undefined;
  record: RemovalRecord | null;
}

/** Finds the account and the Worker name. Never guesses: an ambiguity asks for --account-id. */
async function locate(
  ctx: Ctx,
  cf: Cloudflare,
  target: RemoveTarget,
  accountId: string | undefined,
  o: RemoveOptions,
): Promise<Located> {
  const accounts: Account[] = accountId
    ? [{ id: accountId }]
    : await cf.list<Account>('/accounts', 'your accounts', 50);
  if (!accounts.length) throw new CliError('this Cloudflare login has no accounts');
  const named = new Map(accounts.map((a) => [a.id, a]));
  const label = (a: Account) => (a.name ? `"${a.name}" (${a.id})` : a.id);

  const subdomainOf = async (a: Account) =>
    (
      await cf.get<{ subdomain?: string }>(
        `/accounts/${a.id}/workers/subdomain`,
        `the workers.dev subdomain of ${label(a)}`,
        { missing: true },
      )
    )?.subdomain?.toLowerCase();

  const hits: { account: Account; worker: string }[] = [];
  const unreadable: string[] = [];
  for (const a of accounts) {
    try {
      if (target.kind === 'workers.dev') {
        if ((await subdomainOf(a)) === target.subdomain)
          hits.push({ account: a, worker: target.worker });
      } else if (target.kind === 'domain') {
        const domains =
          (await cf.get<{ hostname?: string; service?: string }[]>(
            `/accounts/${a.id}/workers/domains`,
            `the Worker custom domains of ${label(a)}`,
            { query: { hostname: target.hostname } },
          )) ?? [];
        const d = domains.find((x) => x.hostname?.toLowerCase() === target.hostname);
        if (d?.service) hits.push({ account: a, worker: d.service });
      } else {
        const s = await cf.get(
          `/accounts/${a.id}/workers/scripts/${target.worker}/settings`,
          `the Worker "${target.worker}" in ${label(a)}`,
          { missing: true },
        );
        if (s) hits.push({ account: a, worker: target.worker });
      }
    } catch (e) {
      if (accounts.length === 1) throw e;
      unreadable.push(`${label(a)}: ${(e as Error).message}`);
    }
  }

  if (hits.length > 1) {
    throw new CliError(
      `"${targetText(target)}" matches a Worker in more than one account (${hits.map((h) => label(h.account)).join(', ')}); pass --account-id`,
    );
  }
  if (hits.length === 0 && target.kind === 'name') {
    // The Worker may already be gone from an earlier, unfinished removal.
    const records = (await recordsFor(ctx.home, target.worker)).filter((r) =>
      accountId ? r.account_id === accountId : named.has(r.account_id),
    );
    if (records.length > 1) {
      throw new CliError(
        `unfinished removals of "${target.worker}" exist for several accounts; pass --account-id`,
      );
    }
    if (records.length === 1) {
      const r = records[0]!;
      hits.push({ account: named.get(r.account_id) ?? { id: r.account_id }, worker: r.worker });
    } else if (o.bucket && accounts.length === 1) {
      hits.push({ account: accounts[0]!, worker: target.worker });
    }
  }
  if (hits.length === 0) {
    const where =
      accounts.length === 1 ? `account ${label(accounts[0]!)}` : `${accounts.length} accounts`;
    const why = unreadable.length
      ? `\nSome accounts could not be checked:\n  ${unreadable.join('\n  ')}\nPass --account-id for the one the relay is in.`
      : target.kind === 'domain'
        ? '\nOnly custom domains attached to a Worker are found; otherwise pass the Worker name.'
        : '';
    throw new CliError(`no Worker for "${targetText(target)}" was found in ${where}${why}`);
  }
  const hit = hits[0]!;
  const subdomain =
    target.kind === 'workers.dev'
      ? target.subdomain
      : await subdomainOf(hit.account).catch(() => undefined);
  const record = await readRecord(recordPath(ctx.home, hit.account.id, hit.worker));
  return { account: hit.account, worker: hit.worker, subdomain, record };
}

const targetText = (t: RemoveTarget) =>
  t.kind === 'domain'
    ? t.hostname
    : t.kind === 'workers.dev'
      ? `${t.worker}.${t.subdomain}.workers.dev`
      : t.worker;

async function inventory(
  ctx: Ctx,
  cf: Cloudflare,
  l: Located,
  o: RemoveOptions,
): Promise<Inventory> {
  const a = l.account.id;
  const settings = await cf.get<{ bindings?: Binding[] }>(
    `/accounts/${a}/workers/scripts/${l.worker}/settings`,
    `the Worker "${l.worker}"`,
    { missing: true },
  );
  const workerExists = settings !== null;
  const bindings = Array.isArray(settings?.bindings) ? settings.bindings : [];
  const namespaces = (
    await cf.list<Namespace>(
      `/accounts/${a}/workers/durable_objects/namespaces`,
      'Durable Object namespaces',
      1000,
    )
  ).filter((n) => n.script === l.worker);

  const doubts: string[] = [];
  const attachments = bindings.find(
    (b) => b.type === 'r2_bucket' && b.name === RELAY_BUCKET_BINDING,
  );
  let buckets: Bucket[] = [];
  if (workerExists) {
    if (attachments?.bucket_name) {
      buckets = [
        attachments.jurisdiction
          ? { name: attachments.bucket_name, jurisdiction: attachments.jurisdiction }
          : { name: attachments.bucket_name },
      ];
    } else {
      doubts.push(`it has no R2 bucket bound as ${RELAY_BUCKET_BINDING}`);
    }
    if (o.bucket && o.bucket !== attachments?.bucket_name) {
      throw new CliError(
        `--bucket is only for finishing a removal after the Worker is gone; "${l.worker}" still exists` +
          (attachments?.bucket_name ? ` and uses the bucket "${attachments.bucket_name}"` : ''),
      );
    }
    const room = bindings.find(
      (b) => b.type === 'durable_object_namespace' && b.name === RELAY_DO_BINDING,
    );
    if (!room || room.class_name !== RELAY_DO_CLASS || (room.script_name ?? l.worker) !== l.worker)
      doubts.push(`it has no ${RELAY_DO_CLASS} Durable Object bound as ${RELAY_DO_BINDING}`);
    if (!namespaces.some((n) => n.class === RELAY_DO_CLASS))
      doubts.push(`it does not implement a ${RELAY_DO_CLASS} Durable Object`);
  } else if (l.record) {
    buckets = l.record.buckets;
  } else if (o.bucket) {
    buckets = [{ name: o.bucket }];
    doubts.push(
      `the Worker is already gone, so nothing shows that the bucket "${o.bucket}" belonged to it`,
    );
  }
  if (!workerExists && !l.record && !o.bucket) {
    doubts.push('the Worker is already gone, so it cannot be checked');
  }

  const kept = new Set(['assets', 'secret_text', 'plain_text', 'json', 'durable_object_namespace']);
  const leftInPlace = bindings
    .filter((b) => b !== attachments && !kept.has(b.type ?? ''))
    .map((b) =>
      `${b.type ?? 'binding'} ${b.name ?? ''}${b.bucket_name ? ` (bucket "${b.bucket_name}")` : ''}`.trim(),
    );

  const withState = [];
  for (const b of buckets) {
    const found = await cf.get(`/accounts/${a}/r2/buckets/${b.name}`, `the R2 bucket "${b.name}"`, {
      headers: bucketHeaders(b),
      missing: true,
    });
    withState.push({ ...b, exists: found !== null });
  }

  const origin = l.subdomain ? `https://${l.worker}.${l.subdomain}.workers.dev` : undefined;
  const claimed = workerExists && origin ? await probeInfo(ctx, origin) : undefined;
  return {
    account: l.account,
    worker: l.worker,
    workerExists,
    origin,
    namespaces,
    buckets: withState,
    leftInPlace,
    confirmed: doubts.length === 0,
    doubts,
    claimed,
    record: l.record,
  };
}

/** Whether the relay says it is claimed; undefined when it does not answer as a Decisions relay. */
async function probeInfo(ctx: Ctx, origin: string): Promise<boolean | undefined> {
  try {
    const r = await ctx.fetch(`${origin}/api/v1/info`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { name?: unknown; claimed?: unknown };
    return j.name === 'daintree-decisions' && typeof j.claimed === 'boolean'
      ? j.claimed
      : undefined;
  } catch {
    return undefined;
  }
}

function showInventory(ctx: Ctx, inv: Inventory, o: RemoveOptions): void {
  const say = (l = '') => ctx.out(l);
  const acct = inv.account.name ? `"${inv.account.name}" (${inv.account.id})` : inv.account.id;
  say(`\nRelay "${inv.worker}" in Cloudflare account ${acct}`);
  if (inv.origin) say(`  URL              ${inv.origin}`);
  if (inv.workerExists) {
    const state =
      inv.claimed === true
        ? 'answers as a Decisions relay, claimed'
        : inv.claimed === false
          ? 'answers as a Decisions relay, never claimed'
          : 'did not answer as a Decisions relay';
    say(`  Worker           ${inv.worker}  (${state})`);
  } else {
    say(`  Worker           ${inv.worker}  (already removed)`);
  }
  for (const n of inv.namespaces) {
    say(`  Durable Object   ${n.class ?? n.name ?? 'namespace'} ${n.id}  (all of its storage)`);
  }
  for (const b of inv.buckets) {
    const j =
      b.jurisdiction && b.jurisdiction !== 'default' ? `, jurisdiction ${b.jurisdiction}` : '';
    say(
      b.exists
        ? `  R2 bucket        ${b.name}  (every object in it, then the bucket${j})`
        : `  R2 bucket        ${b.name}  (already removed)`,
    );
  }
  for (const k of inv.leftInPlace) say(`  Left in place    ${k}`);
  if (inv.record && !inv.workerExists)
    say('  (finishing an earlier removal that did not complete)');
  if (o.dryRun || (!inv.workerExists && !inv.buckets.some((b) => b.exists))) return;
  say('');
  say('Removing it deletes, permanently:');
  say('  - every question, answer and attachment stored on this relay');
  say('  - every pairing: phones and tablets paired with it stop working');
  say('  - the claim and this relay itself. This cannot be undone.');
  say('Keys and history on this computer are not touched.');
}

/** Deletes in dependency order and reports each resource. Resolves to what is still left. */
async function execute(
  ctx: Ctx,
  cf: Cloudflare,
  inv: Inventory,
  sleep: (ms: number) => Promise<void>,
): Promise<string[]> {
  const say = (l: string) => ctx.out(l);
  const a = inv.account.id;
  const left: string[] = [];
  say('');

  if (inv.workerExists) {
    say(`Removing the Worker "${inv.worker}" and its Durable Object storage`);
    const r = await cf.call('DELETE', `/accounts/${a}/workers/services/${inv.worker}`, {
      query: { force: 'true' },
    });
    if (!r.ok && r.status !== 404) {
      say(`  ✗ the Worker was not removed: ${r.message}`);
      left.push(`the Worker "${inv.worker}"`);
      for (const n of inv.namespaces) left.push(`the Durable Object namespace ${n.id}`);
      for (const b of inv.buckets) if (b.exists) left.push(`the R2 bucket "${b.name}"`);
      // The bucket stays while the Worker that writes to it is still running.
      return left;
    }
    const still = await cf.get(
      `/accounts/${a}/workers/scripts/${inv.worker}/settings`,
      `the Worker "${inv.worker}"`,
      { missing: true },
    );
    if (still) {
      say('  ✗ Cloudflare still lists the Worker after deleting it');
      left.push(`the Worker "${inv.worker}"`);
      return left;
    }
    say(`  ✓ Worker "${inv.worker}" removed`);
  }

  if (inv.namespaces.length) {
    let remaining = inv.namespaces;
    for (let i = 0; i < 6; i++) {
      const listed = await cf.list<Namespace>(
        `/accounts/${a}/workers/durable_objects/namespaces`,
        'Durable Object namespaces',
        1000,
      );
      const ids = new Set(listed.filter((n) => n.script === inv.worker).map((n) => n.id));
      remaining = inv.namespaces.filter((n) => ids.has(n.id));
      if (!remaining.length) break;
      await sleep(2000);
    }
    for (const n of inv.namespaces) {
      if (remaining.includes(n)) {
        say(`  ✗ Durable Object namespace ${n.id} is still listed`);
        left.push(`the Durable Object namespace ${n.id} (Cloudflare may still be deleting it)`);
      } else {
        say(`  ✓ Durable Object storage ${n.class ?? n.id} removed`);
      }
    }
  }

  for (const b of inv.buckets) {
    if (!b.exists) continue;
    say(`Emptying and removing the R2 bucket "${b.name}"`);
    try {
      await emptyAndDeleteBucket(ctx, cf, a, b);
      say(`  ✓ R2 bucket "${b.name}" removed`);
    } catch (e) {
      say(`  ✗ ${(e as Error).message}`);
      left.push(`the R2 bucket "${b.name}"`);
    }
  }
  return left;
}

async function emptyAndDeleteBucket(ctx: Ctx, cf: Cloudflare, a: string, b: Bucket): Promise<void> {
  const base = `/accounts/${a}/r2/buckets/${b.name}`;
  const headers = bucketHeaders(b);
  for (let round = 0; round < 3; round++) {
    let deleted = 0;
    // Always list from the start: every key on a page is deleted before the next listing.
    for (let page = 0; ; page++) {
      if (page >= 100_000) throw new Error(`gave up emptying "${b.name}"`);
      const r = await cf.call<{ key?: unknown }[]>('GET', `${base}/objects`, {
        query: { per_page: '1000' },
        headers,
      });
      if (r.status === 404) return; // the bucket is already gone
      if (!r.ok) throw new Error(`could not list the objects in "${b.name}": ${r.message}`);
      const keys = (Array.isArray(r.result) ? r.result : [])
        .map((x) => x.key)
        .filter((k): k is string => typeof k === 'string');
      if (!keys.length) break;
      const failed: string[] = [];
      await pool(keys, 8, async (key) => {
        const p = objectPath(key);
        const d = p ? await cf.call('DELETE', `${base}/objects/${p}`, { headers }) : null;
        if (d && (d.ok || d.status === 404)) deleted++;
        else
          failed.push(
            d ? `${key}: ${d.message}` : `${key}: this key cannot be deleted through the API`,
          );
      });
      if (failed.length) {
        throw new Error(
          `${failed.length} object(s) in "${b.name}" could not be deleted, e.g. ${failed[0]}`,
        );
      }
      ctx.out(`    ${deleted} object(s) deleted`);
    }
    const r = await cf.call('DELETE', base, { headers });
    if (r.ok || r.status === 404) return;
    // A write that landed after the listing leaves the bucket non-empty; empty it again.
    if (!/not empty/i.test(r.message) || round === 2) {
      throw new Error(`the bucket "${b.name}" was emptied but not removed: ${r.message}`);
    }
  }
}

function rerunArgs(targetInput: string, accountId: string, o: RemoveOptions): string {
  const parts = [targetInput.trim(), `--account-id ${accountId}`];
  if (o.apiToken) parts.push('--api-token');
  if (o.bucket) parts.push(`--bucket ${o.bucket}`);
  return parts.join(' ');
}

/** Says so when this computer still holds keys for the relay that was just removed. */
async function localIdentityHint(
  ctx: Ctx,
  g: GlobalOptions,
  origin: string | undefined,
): Promise<void> {
  if (!origin) return;
  try {
    const id = await keyStoreFor(ctx, g.passphraseEnv).load();
    if (id?.config.relayOrigin !== origin) return;
  } catch {
    return;
  }
  ctx.out(
    [
      '',
      `This computer still holds its keys for the removed relay in ${ctx.home}; they were not deleted.`,
      'To claim a new relay from this computer, give it its own state directory:',
      '  decisions --home <new directory> deploy --claim',
    ].join('\n'),
  );
}
