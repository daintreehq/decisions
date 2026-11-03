import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../src/bin.js';
import { CliError, type Ctx } from '../src/runtime.js';
import type { SpawnRequest, SpawnResult } from '../src/commands/deploy.js';
import {
  parseTarget,
  parseTokenOutput,
  remove,
  type RemoveDeps,
  type RemoveOptions,
} from '../src/commands/remove.js';

const root = mkdtempSync(join(tmpdir(), 'decisions-remove-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const TOKEN = 'cf-token-' + 'q'.repeat(40);
const A1 = 'a1'.repeat(16);
const A2 = 'b2'.repeat(16);
const WRANGLER = '4.156.0';

interface FakeWorker {
  bindings: Record<string, unknown>[];
}

interface FakeAccount {
  id: string;
  name: string;
  subdomain: string;
  workers: Record<string, FakeWorker>;
  namespaces: { id: string; name: string; script: string; class: string }[];
  /** Keyed `${jurisdiction}:${name}`. */
  buckets: Map<string, Set<string>>;
  domains: { hostname: string; service: string }[];
  /** What the Worker answers on /api/v1/info (default: an unclaimed relay). */
  info?: unknown;
}

const relayBindings = (bucket = 'daintree-decisions', extra: Record<string, unknown> = {}) => [
  { type: 'assets', name: 'ASSETS' },
  { type: 'r2_bucket', name: 'ATTACHMENTS', bucket_name: bucket, ...extra },
  { type: 'durable_object_namespace', name: 'DECISION_ROOM', class_name: 'DecisionRoom' },
  { type: 'secret_text', name: 'CLAIM_SECRET' },
  { type: 'plain_text', name: 'PUSH_SUBJECT' },
];

function account(
  over: Partial<FakeAccount> & { relay?: string | null; bucket?: string; keys?: string[] } = {},
): FakeAccount {
  const relay = over.relay === undefined ? 'daintree-decisions' : over.relay;
  const bucket = over.bucket ?? 'daintree-decisions';
  return {
    id: over.id ?? A1,
    name: over.name ?? 'Personal',
    subdomain: over.subdomain ?? 'someone',
    workers: over.workers ?? (relay ? { [relay]: { bindings: relayBindings(bucket) } } : {}),
    namespaces:
      over.namespaces ??
      (relay
        ? [{ id: 'ns-1', name: `${relay}_DecisionRoom`, script: relay, class: 'DecisionRoom' }]
        : []),
    buckets:
      over.buckets ?? new Map([[`default:${bucket}`, new Set(over.keys ?? ['att/1', 'att/2'])]]),
    domains: over.domains ?? [],
    ...(over.info !== undefined ? { info: over.info } : {}),
  };
}

interface Faults {
  /** Respond to matching `${method} ${path}` with this error, or this raw response. */
  fail?: (method: string, path: string) => { status: number; message: string } | Response | null;
}

/** Cloudflare pages lists; the fake uses tiny pages so every list has to be followed. */
const PAGE = 2;

function fakeCloudflare(accounts: FakeAccount[], faults: Faults = {}) {
  const requests: { method: string; path: string; auth: string; headers: Headers }[] = [];
  const probes: { url: string; headers: Headers }[] = [];
  const ok = (result: unknown, info?: unknown) =>
    new Response(JSON.stringify({ success: true, errors: [], result, result_info: info }));
  const no = (status: number, message: string) =>
    new Response(
      JSON.stringify({ success: false, errors: [{ code: 10000, message }], result: null }),
      {
        status,
      },
    );
  const fetchFn = (async (u: unknown, init?: RequestInit) => {
    const url = new URL(String(u));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    if (url.hostname !== 'api.cloudflare.com') {
      // The relay itself. Checked after each run (see setup): an assertion thrown in here would
      // only be swallowed by the probe's own error handling.
      probes.push({ url: url.toString(), headers });
      const [worker, sub] = url.hostname.split('.');
      const a = accounts.find(
        (x) =>
          (x.subdomain === sub && x.workers[worker!]) ||
          x.domains.some((d) => d.hostname === url.hostname && x.workers[d.service]),
      );
      if (!a || url.pathname !== '/api/v1/info') return new Response('nope', { status: 404 });
      return new Response(JSON.stringify(a.info ?? { name: 'daintree-decisions', claimed: false }));
    }
    expect(url.origin).toBe('https://api.cloudflare.com');
    expect(init?.redirect).toBe('error');
    const path = url.pathname.replace(/^\/client\/v4/, '');
    requests.push({ method, path, auth: headers.get('authorization') ?? '', headers });
    if (headers.get('authorization') !== `Bearer ${TOKEN}`) return no(401, 'bad token');
    const f = faults.fail?.(method, path);
    if (f) return f instanceof Response ? f : no(f.status, f.message);

    if (method === 'GET' && path === '/accounts') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const per = Math.min(Number(url.searchParams.get('per_page') ?? '20'), PAGE);
      const slice = accounts
        .slice((page - 1) * per, page * per)
        .map((a) => ({ id: a.id, name: a.name }));
      return ok(slice, { page, per_page: per, total_pages: Math.ceil(accounts.length / per) || 1 });
    }
    const m = path.match(/^\/accounts\/([^/]+)(\/.*)$/);
    const a = m && accounts.find((x) => x.id === m[1]);
    if (!m || !a) return no(403, 'no access to this account');
    const rest = m[2]!;
    const jur = headers.get('cf-r2-jurisdiction') ?? 'default';
    let r: RegExpMatchArray | null;
    if (method === 'GET' && rest === '/workers/subdomain') return ok({ subdomain: a.subdomain });
    if (method === 'GET' && rest === '/workers/domains') {
      const h = url.searchParams.get('hostname');
      return ok(a.domains.filter((d) => !h || d.hostname === h));
    }
    if ((r = rest.match(/^\/workers\/scripts\/([^/]+)\/settings$/)) && method === 'GET') {
      const w = a.workers[r[1]!];
      return w
        ? ok({ bindings: w.bindings })
        : no(404, 'This Worker does not exist on your account.');
    }
    if (method === 'GET' && rest === '/workers/durable_objects/namespaces') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const per = Math.min(Number(url.searchParams.get('per_page') ?? '20'), PAGE);
      return ok(a.namespaces.slice((page - 1) * per, page * per), {
        page,
        per_page: per,
        total_pages: Math.ceil(a.namespaces.length / per) || 1,
      });
    }
    if ((r = rest.match(/^\/workers\/services\/([^/]+)$/)) && method === 'DELETE') {
      const name = r[1]!;
      if (!a.workers[name]) return no(404, 'This Worker does not exist on your account.');
      expect(url.searchParams.get('force')).toBe('true');
      delete a.workers[name];
      a.namespaces = a.namespaces.filter((x) => x.script !== name);
      return ok(null);
    }
    if ((r = rest.match(/^\/r2\/buckets\/([^/]+)\/objects$/)) && method === 'GET') {
      const keys = a.buckets.get(`${jur}:${r[1]}`);
      if (!keys) return no(404, 'The specified bucket does not exist.');
      const per = Number(url.searchParams.get('per_page') ?? '20');
      return ok(
        [...keys].slice(0, per).map((key) => ({ key, size: 1 })),
        {
          is_truncated: keys.size > per,
        },
      );
    }
    if ((r = rest.match(/^\/r2\/buckets\/([^/]+)\/objects\/(.+)$/)) && method === 'DELETE') {
      const keys = a.buckets.get(`${jur}:${r[1]}`);
      if (!keys) return no(404, 'The specified bucket does not exist.');
      const key = r[2]!.split('/').map(decodeURIComponent).join('/');
      keys.delete(key);
      return ok({});
    }
    if ((r = rest.match(/^\/r2\/buckets\/([^/]+)$/))) {
      const id = `${jur}:${r[1]}`;
      const keys = a.buckets.get(id);
      if (!keys) return no(404, 'The specified bucket does not exist.');
      if (method === 'GET') return ok({ name: r[1] });
      if (method === 'DELETE') {
        if (keys.size) return no(409, 'The bucket you tried to delete is not empty.');
        a.buckets.delete(id);
        return ok({});
      }
    }
    return no(404, `unexpected ${method} ${path}`);
  }) as typeof fetch;
  return { fetchFn, requests, probes };
}

function setup(
  accounts: FakeAccount[],
  over: {
    answers?: string[];
    interactive?: boolean;
    env?: Record<string, string>;
    faults?: Faults;
    home?: string;
  } = {},
) {
  const out: string[] = [];
  const prompts: string[] = [];
  const promptOpts: ({ secret?: boolean } | undefined)[] = [];
  /** The state of things at each prompt: what had been said and whether anything had changed. */
  const atPrompt: { output: string; deletes: number; record: boolean }[] = [];
  const answers = [...(over.answers ?? [])];
  const cf = fakeCloudflare(accounts, over.faults);
  const home = over.home ?? join(root, `home${n++}`);
  const ctx: Ctx = {
    home,
    json: false,
    out: (l) => void out.push(l),
    err: (l) => void out.push(l),
    prompt: async (q, opts) => {
      prompts.push(q);
      promptOpts.push(opts);
      atPrompt.push({
        output: out.join('\n'),
        deletes: cf.requests.filter((r) => r.method === 'DELETE').length,
        record:
          existsSync(join(home, 'removals')) && readdirSync(join(home, 'removals')).length > 0,
      });
      return answers.shift() ?? '';
    },
    env: over.env ?? { CLOUDFLARE_API_TOKEN: TOKEN },
    now: Date.now,
    readStdin: async () => '',
    interactive: over.interactive ?? true,
    fetch: cf.fetchFn,
  };
  const deps: RemoveDeps = { sleep: async () => {}, tmpRoot: mkdtempSync(join(root, 'tmp-')) };
  const run = async (target: string, o: RemoveOptions = {}) => {
    try {
      return await remove(ctx, {}, target, o, deps);
    } finally {
      // The relay must never see a Cloudflare credential, whatever the outcome.
      for (const p of cf.probes) {
        expect(p.headers.get('authorization')).toBeNull();
        const sent: string[] = [];
        p.headers.forEach((v, k) => sent.push(`${k}: ${v}`));
        expect(sent.join('\n')).not.toContain(TOKEN);
      }
    }
  };
  const deletes = () => cf.requests.filter((r) => r.method === 'DELETE');
  return {
    ctx,
    out,
    prompts,
    promptOpts,
    atPrompt,
    run,
    requests: cf.requests,
    probes: cf.probes,
    deletes,
    deps,
  };
}

const text = (lines: string[]) => lines.join('\n');

describe('parseTarget', () => {
  it('reads a Worker name, a workers.dev URL and a custom domain', () => {
    expect(parseTarget('daintree-decisions')).toEqual({
      kind: 'name',
      worker: 'daintree-decisions',
    });
    expect(parseTarget('https://my-relay.someone.workers.dev/')).toEqual({
      kind: 'workers.dev',
      worker: 'my-relay',
      subdomain: 'someone',
    });
    expect(parseTarget('my-relay.someone.workers.dev')).toMatchObject({ kind: 'workers.dev' });
    expect(parseTarget('https://relay.example.com')).toEqual({
      kind: 'domain',
      hostname: 'relay.example.com',
    });
  });

  it('refuses http, credentials, ports and malformed workers.dev hosts', () => {
    expect(() => parseTarget('http://my-relay.someone.workers.dev')).toThrow(/https/);
    expect(() => parseTarget('https://u:p@my-relay.someone.workers.dev')).toThrow(/plain https/);
    expect(() => parseTarget('https://my-relay.someone.workers.dev:8443')).toThrow(/plain https/);
    expect(() => parseTarget('https://a.my-relay.someone.workers.dev')).toThrow(/workers\.dev/);
    expect(() => parseTarget('https://someone.workers.dev')).toThrow(/workers\.dev/);
  });
});

describe('parseTokenOutput', () => {
  it('accepts an OAuth or API token and nothing else', () => {
    expect(parseTokenOutput(JSON.stringify({ type: 'oauth', token: TOKEN }))).toBe(TOKEN);
    expect(parseTokenOutput(`note\n${JSON.stringify({ type: 'api_token', token: TOKEN })}\n`)).toBe(
      TOKEN,
    );
    expect(parseTokenOutput(JSON.stringify({ type: 'api_key', key: 'k', email: 'e' }))).toBeNull();
    expect(parseTokenOutput('Not logged in')).toBeNull();
    expect(parseTokenOutput(JSON.stringify({ type: 'oauth', token: 'short' }))).toBeNull();
  });
});

describe('decisions remove', () => {
  it('is a command of the CLI that runs with its target and options', async () => {
    const cmd = buildProgram().commands.find((c) => c.name() === 'remove')!;
    expect(cmd).toBeDefined();
    expect(cmd.options.map((o) => o.long).sort()).toEqual(
      ['--account-id', '--api-token', '--bucket', '--dry-run'].sort(),
    );
    // Rejected by the command's own validation, before anything touches the network.
    await expect(
      buildProgram().parseAsync(['node', 'decisions', 'remove', 'relay', '--bucket', 'B!']),
    ).rejects.toThrow(/--bucket "B!" is not a valid R2 bucket name/);
    await expect(
      buildProgram().parseAsync(['node', 'decisions', 'remove', 'http://x.y.workers.dev']),
    ).rejects.toThrow(/https/);
  });

  it('lists every resource in a dry run and deletes nothing', async () => {
    const acct = account();
    const t = setup([acct], { interactive: false });
    await t.run('https://daintree-decisions.someone.workers.dev', { dryRun: true });
    const o = text(t.out);
    expect(o).toContain('Relay "daintree-decisions" in Cloudflare account "Personal"');
    expect(o).toContain('https://daintree-decisions.someone.workers.dev');
    expect(o).toMatch(
      /Worker\s+daintree-decisions\s+\(answers as a Decisions relay, never claimed\)/,
    );
    expect(o).toMatch(/Durable Object\s+DecisionRoom ns-1/);
    expect(o).toMatch(/R2 bucket\s+daintree-decisions\s+\(every object in it/);
    expect(o).toContain('Dry run: nothing was deleted.');
    expect(t.prompts).toEqual([]);
    expect(t.deletes()).toEqual([]);
    expect(acct.workers['daintree-decisions']).toBeDefined();
  });

  it('removes the Worker first, then empties and removes its bucket, and reports each', async () => {
    const acct = account({ bucket: 'my-attachments', keys: ['a/1', 'a b/c?d#e%f', 'x'] });
    const t = setup([acct], { answers: ['daintree-decisions', 'y'] });
    await t.run('daintree-decisions');
    const o = text(t.out);
    // The consequences come before the first confirmation, and nothing changes before the last.
    expect(t.atPrompt[0]!.output).toContain(
      'every question, answer and attachment stored on this relay',
    );
    expect(t.atPrompt[0]!.output).toContain('phones and tablets paired with it stop working');
    expect(t.atPrompt[0]!.output).toContain('This cannot be undone');
    expect(t.atPrompt).toHaveLength(2);
    for (const p of t.atPrompt) expect(p).toMatchObject({ deletes: 0, record: false });
    expect(t.prompts[0]).toContain('Type the Worker name (daintree-decisions)');
    expect(t.prompts[1]).toMatch(/\[y\/N\]/);
    const order = t.deletes().map((r) => r.path.replace(`/accounts/${A1}`, ''));
    expect(order[0]).toBe('/workers/services/daintree-decisions');
    expect(order.at(-1)).toBe('/r2/buckets/my-attachments');
    expect(order.filter((p) => p.includes('/objects/'))).toHaveLength(3);
    expect(o).toContain('✓ Worker "daintree-decisions" removed');
    expect(o).toContain('✓ Durable Object storage DecisionRoom removed');
    expect(o).toContain('✓ R2 bucket "my-attachments" removed');
    expect(o).toContain('A fresh `decisions deploy` sets up a new relay from nothing.');
    expect(acct.workers).toEqual({});
    expect(acct.namespaces).toEqual([]);
    expect(acct.buckets.size).toBe(0);
    expect(existsSync(join(t.ctx.home, 'removals'))).toBe(true);
    expect(readdirSync(join(t.ctx.home, 'removals'))).toEqual([]);
  });

  it('empties a bucket with more objects than one listing returns', async () => {
    const keys = Array.from({ length: 2500 }, (_, i) => `att/${i}`);
    const acct = account({ keys });
    const t = setup([acct], { answers: ['daintree-decisions', 'yes'] });
    await t.run('daintree-decisions');
    expect(acct.buckets.size).toBe(0);
    expect(t.deletes().filter((r) => r.path.includes('/objects/'))).toHaveLength(2500);
  });

  it('deletes nothing unless both the name and the final yes are given', async () => {
    for (const answers of [['daintree-decision', 'y'], ['daintree-decisions', 'n'], ['', ''], []]) {
      const acct = account();
      const t = setup([acct], { answers });
      await expect(t.run('daintree-decisions')).rejects.toThrow(/cancelled/);
      expect(t.deletes()).toEqual([]);
      expect(acct.workers['daintree-decisions']).toBeDefined();
      expect(existsSync(join(t.ctx.home, 'removals'))).toBe(false);
    }
  });

  it('refuses to run without a terminal, before touching Cloudflare', async () => {
    const t = setup([account()], { interactive: false });
    await expect(t.run('daintree-decisions')).rejects.toThrow(/interactively/);
    expect(t.requests).toEqual([]);
  });

  it('asks for a separate acknowledgement before removing a Worker that is not a relay', async () => {
    const other = (): FakeAccount =>
      account({
        relay: null,
        workers: {
          'my-api': {
            bindings: [
              { type: 'r2_bucket', name: 'ATTACHMENTS', bucket_name: 'daintree-decisions' },
            ],
          },
        },
      });
    const refused = setup([other()], { answers: ['my-api', 'y'] });
    await expect(refused.run('my-api')).rejects.toThrow(/cancelled/);
    expect(text(refused.out)).toContain(
      'WARNING: this could not be confirmed as a Decisions relay',
    );
    expect(text(refused.out)).toContain('no DecisionRoom Durable Object bound as DECISION_ROOM');
    expect(refused.prompts[0]).toContain('remove anyway');
    expect(refused.deletes()).toEqual([]);

    const acct = other();
    const forced = setup([acct], { answers: ['remove anyway', 'my-api', 'y'] });
    await forced.run('my-api');
    expect(acct.workers).toEqual({});
  });

  it('never needs relay keys: works with an empty state directory and an unclaimed relay', async () => {
    const t = setup([account()], { answers: ['daintree-decisions', 'y'] });
    expect(existsSync(t.ctx.home)).toBe(false);
    await t.run('https://daintree-decisions.someone.workers.dev');
    expect(text(t.out)).toContain('Removed.');
  });

  it('names what is left when a step fails, and a rerun finishes after the Worker is gone', async () => {
    const acct = account({ bucket: 'custom-bucket' });
    let broken = true;
    const faults: Faults = {
      fail: (m, p) =>
        broken && m === 'DELETE' && p.endsWith('/r2/buckets/custom-bucket')
          ? { status: 403, message: 'bucket is locked' }
          : null,
    };
    const first = setup([acct], { answers: ['daintree-decisions', 'y'], faults });
    await expect(first.run('daintree-decisions')).rejects.toThrow(/only partly removed/);
    const o = text(first.out);
    expect(o).toContain('✓ Worker "daintree-decisions" removed');
    expect(o).toContain(
      '✗ the bucket "custom-bucket" was emptied but not removed: 10000 bucket is locked',
    );
    expect(o).toContain('Not finished. Still in Cloudflare:');
    expect(o).toContain('the R2 bucket "custom-bucket"');
    expect(o).toContain(`decisions remove daintree-decisions --account-id ${A1}`);

    // The Worker, which named the bucket, is gone; the record from the first run still names it.
    broken = false;
    const again = setup([acct], {
      answers: ['daintree-decisions', 'y'],
      home: first.ctx.home,
      faults,
    });
    await again.run('daintree-decisions');
    const o2 = text(again.out);
    expect(o2).toMatch(/Worker\s+daintree-decisions\s+\(already removed\)/);
    expect(o2).toContain('finishing an earlier removal');
    expect(o2).toContain('✓ R2 bucket "custom-bucket" removed');
    expect(o2).not.toContain('WARNING');
    expect(acct.buckets.size).toBe(0);
    expect(readdirSync(join(first.ctx.home, 'removals'))).toEqual([]);

    const done = setup([acct], { home: first.ctx.home });
    await expect(done.run('daintree-decisions', { dryRun: true })).rejects.toThrow(
      /no Worker for "daintree-decisions" was found/,
    );
  });

  it('leaves the bucket alone when the Worker cannot be removed', async () => {
    const acct = account();
    const t = setup([acct], {
      answers: ['daintree-decisions', 'y'],
      faults: {
        fail: (m, p) =>
          m === 'DELETE' && p.includes('/workers/services/')
            ? { status: 403, message: 'denied' }
            : null,
      },
    });
    await expect(t.run('daintree-decisions')).rejects.toThrow(CliError);
    const o = text(t.out);
    expect(o).toContain('✗ the Worker was not removed: 10000 denied');
    expect(o).toContain('the Worker "daintree-decisions"');
    expect(o).toContain('the R2 bucket "daintree-decisions"');
    expect(t.deletes().filter((r) => r.path.includes('/r2/'))).toEqual([]);
    expect(acct.buckets.size).toBe(1);
  });

  it('finishes from --bucket when the Worker is gone and nothing recorded it, with the warning', async () => {
    const acct = account({ relay: null, bucket: 'left-over' });
    const t = setup([acct], { answers: ['remove anyway', 'daintree-decisions', 'y'] });
    await t.run('daintree-decisions', { bucket: 'left-over' });
    expect(text(t.out)).toContain('nothing shows that the bucket "left-over" belonged to it');
    expect(acct.buckets.size).toBe(0);
  });

  it('refuses --bucket while the Worker still exists', async () => {
    const t = setup([account()], { answers: ['daintree-decisions', 'y'] });
    await expect(t.run('daintree-decisions', { bucket: 'other-bucket' })).rejects.toThrow(
      /--bucket is only for finishing a removal/,
    );
    expect(t.deletes()).toEqual([]);
  });

  it('resolves the account from the workers.dev subdomain and asks when a name is ambiguous', async () => {
    const one = account({ id: A1, name: 'Work', subdomain: 'work' });
    const two = account({ id: A2, name: 'Home', subdomain: 'home' });
    const t = setup([one, two], { interactive: false });
    await t.run('https://daintree-decisions.home.workers.dev', { dryRun: true });
    expect(text(t.out)).toContain(`"Home" (${A2})`);

    const amb = setup([account({ id: A1 }), account({ id: A2 })], { interactive: false });
    await expect(amb.run('daintree-decisions', { dryRun: true })).rejects.toThrow(/--account-id/);

    const pinned = setup([account({ id: A1 }), account({ id: A2, name: 'Two' })], {
      interactive: false,
    });
    await pinned.run('daintree-decisions', { dryRun: true, accountId: A2 });
    expect(text(pinned.out)).toContain(A2);
    expect(pinned.requests.some((r) => r.path === '/accounts')).toBe(false);
  });

  it('finds a relay by its custom domain', async () => {
    const acct = account({
      domains: [{ hostname: 'relay.example.com', service: 'daintree-decisions' }],
    });
    const t = setup([acct], { interactive: false });
    await t.run('https://relay.example.com', { dryRun: true });
    expect(text(t.out)).toContain('Relay "daintree-decisions"');
  });

  it('sends the jurisdiction with every request for an EU bucket', async () => {
    const acct = account();
    acct.workers['daintree-decisions'] = {
      bindings: relayBindings('daintree-decisions', { jurisdiction: 'eu' }),
    };
    acct.buckets = new Map([['eu:daintree-decisions', new Set(['k'])]]);
    const t = setup([acct], { answers: ['daintree-decisions', 'y'] });
    await t.run('daintree-decisions');
    const r2 = t.requests.filter((r) => r.path.includes('/r2/'));
    expect(r2.length).toBeGreaterThan(0);
    for (const r of r2) expect(r.headers.get('cf-r2-jurisdiction')).toBe('eu');
    expect(acct.buckets.size).toBe(0);
  });

  it('retries a rate-limited request', async () => {
    const acct = account();
    let limited = 2;
    const t = setup([acct], {
      answers: ['daintree-decisions', 'y'],
      faults: {
        fail: (m, p) =>
          m === 'DELETE' && p.includes('/objects/') && limited-- > 0
            ? { status: 429, message: 'slow down' }
            : null,
      },
    });
    await t.run('daintree-decisions');
    expect(acct.buckets.size).toBe(0);
  });

  it('says so when nothing is left', async () => {
    const acct = account({ relay: null, buckets: new Map() });
    const t = setup([acct]);
    await t.run('https://daintree-decisions.someone.workers.dev');
    expect(text(t.out)).toContain('there is nothing to remove');
    expect(t.deletes()).toEqual([]);
  });

  function wranglerFake(o: { loggedIn: boolean; token?: SpawnResult }) {
    const calls: SpawnRequest[] = [];
    let loggedIn = o.loggedIn;
    const spawn = async (req: SpawnRequest): Promise<SpawnResult> => {
      calls.push({ ...req, env: { ...req.env } });
      expect(existsSync(req.cwd)).toBe(true);
      const sub = req.args.slice(2).join(' ');
      if (sub === '--version') return { status: 0, stdout: WRANGLER, stderr: '' };
      if (sub === 'whoami')
        return loggedIn
          ? { status: 0, stdout: 'You are logged in with an OAuth Token', stderr: '' }
          : { status: 1, stdout: '', stderr: 'You are not authenticated.' };
      if (sub === 'login') {
        loggedIn = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (sub === 'auth token --json')
        return (
          o.token ?? {
            status: 0,
            stdout: JSON.stringify({ type: 'oauth', token: TOKEN }),
            stderr: '',
          }
        );
      return { status: 1, stdout: '', stderr: `unexpected ${sub}` };
    };
    return { spawn, calls };
  }

  function withWrangler(t: ReturnType<typeof setup>, spawn: RemoveDeps['spawn']) {
    const bundle = makeBundle();
    Object.assign(t.deps, {
      spawn,
      bundleDir: bundle.dir,
      pinnedManifestSha256: bundle.digest,
      version: '9.9.9',
    });
  }

  it('gets the token from Wrangler after a browser login and never prints it', async () => {
    const w = wranglerFake({ loggedIn: false });
    const acct = account();
    const t = setup([acct], {
      env: { PATH: '/usr/bin', CLOUDFLARE_API_BASE_URL: 'http://evil.example' },
      answers: ['daintree-decisions', 'y'],
    });
    withWrangler(t, w.spawn);
    await t.run('daintree-decisions');
    expect(w.calls.map((c) => [c.args.join(' '), c.capture])).toEqual([
      [`--yes wrangler@${WRANGLER} --version`, true],
      [`--yes wrangler@${WRANGLER} whoami`, true],
      // The browser login gets the terminal; everything else is captured.
      [`--yes wrangler@${WRANGLER} login`, false],
      [`--yes wrangler@${WRANGLER} auth token --json`, true],
    ]);
    for (const c of w.calls) {
      expect(c.env.WRANGLER_LOG_SANITIZE).toBe('true');
      expect(c.env.WRANGLER_WRITE_LOGS).toBe('false');
      expect(c.env.CLOUDFLARE_API_BASE_URL).toBeUndefined();
      expect(existsSync(c.cwd)).toBe(false); // the empty working directory is cleaned up
    }
    expect(text(t.out)).not.toContain(TOKEN);
    expect(t.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(t.probes.length).toBeGreaterThan(0);
    expect(acct.workers).toEqual({});
  });

  it('shows nothing of a failed token command and cleans up', async () => {
    const w = wranglerFake({
      loggedIn: true,
      token: { status: 1, stdout: `{"type":"oauth","token":"${TOKEN}"`, stderr: TOKEN },
    });
    const t = setup([account()], { env: { PATH: '/usr/bin' }, interactive: false });
    withWrangler(t, w.spawn);
    const e = await t.run('daintree-decisions', { dryRun: true }).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/did not hand over a Cloudflare token/);
    expect((e as Error).message + text(t.out)).not.toContain(TOKEN);
    expect(t.requests).toEqual([]);
    for (const c of w.calls) expect(existsSync(c.cwd)).toBe(false);
  });

  it('asks for an API token with --api-token and redacts it from errors', async () => {
    const t = setup([account()], {
      env: { PATH: '/usr/bin' },
      answers: [TOKEN],
      interactive: false,
      faults: { fail: () => ({ status: 403, message: `token ${TOKEN} lacks permission` }) },
    });
    const e = await t
      .run('daintree-decisions', { apiToken: true, dryRun: true })
      .catch((x: Error) => x);
    expect(e).toBeInstanceOf(CliError);
    expect((e as Error).message).toContain('[redacted]');
    expect((e as Error).message).not.toContain(TOKEN);
    expect(t.prompts[0]).toContain('API token');
    expect(t.promptOpts[0]).toEqual({ secret: true });
  });

  it('warns when a Worker with the relay bindings answers as something else', async () => {
    const acct = account({ info: { name: 'my-other-app', claimed: false } });
    const t = setup([acct], { answers: ['daintree-decisions', 'y'] });
    await expect(t.run('daintree-decisions')).rejects.toThrow(/cancelled/);
    expect(text(t.out)).toContain(
      'https://daintree-decisions.someone.workers.dev answers, but not as a Decisions relay',
    );
    expect(t.deletes()).toEqual([]);
  });

  it('keeps the warning on a rerun of a removal that was never confirmed', async () => {
    const acct = account({
      relay: null,
      workers: {
        'my-api': { bindings: [{ type: 'r2_bucket', name: 'ATTACHMENTS', bucket_name: 'b-1' }] },
      },
      buckets: new Map([['default:b-1', new Set(['k'])]]),
    });
    let broken = true;
    const faults: Faults = {
      fail: (m, p) =>
        broken && m === 'DELETE' && p.endsWith('/r2/buckets/b-1')
          ? { status: 403, message: 'locked' }
          : null,
    };
    const first = setup([acct], { answers: ['remove anyway', 'my-api', 'y'], faults });
    await expect(first.run('my-api')).rejects.toThrow(/only partly removed/);
    broken = false;
    const again = setup([acct], { answers: ['my-api', 'y'], home: first.ctx.home, faults });
    await expect(again.run('my-api')).rejects.toThrow(/cancelled/);
    expect(text(again.out)).toContain('could not confirm it as a relay either');
    expect(again.deletes()).toEqual([]);
  });

  it('finds the relay and its storage on later pages of every list', async () => {
    const filler = (i: number) =>
      account({ id: String(i).padStart(32, 'c'), name: `F${i}`, relay: null, buckets: new Map() });
    const acct = account({ id: A2, name: 'Last' });
    acct.namespaces = [
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `other-${i}`,
        name: 'x',
        script: 'other',
        class: 'X',
      })),
      ...acct.namespaces,
    ];
    const t = setup([filler(1), filler(2), filler(3), acct], {
      answers: ['daintree-decisions', 'y'],
    });
    await t.run('daintree-decisions');
    expect(text(t.out)).toContain(`"Last" (${A2})`);
    expect(text(t.out)).toContain('✓ Durable Object storage DecisionRoom removed');
    expect(acct.namespaces.map((x) => x.id)).toEqual(['other-0', 'other-1', 'other-2']);
  });

  it('keeps the bucket and reports everything when the Worker removal cannot be checked', async () => {
    const acct = account();
    let deleted = false;
    const t = setup([acct], {
      answers: ['daintree-decisions', 'y'],
      faults: {
        fail: (m, p) => {
          if (m === 'DELETE' && p.includes('/workers/services/')) deleted = true;
          return deleted && m === 'GET' && p.endsWith('/settings')
            ? { status: 403, message: 'denied' }
            : null;
        },
      },
    });
    await expect(t.run('daintree-decisions')).rejects.toThrow(/only partly removed/);
    const o = text(t.out);
    expect(o).toContain('✗ it is not known whether the Worker was removed');
    expect(o).toContain('the R2 bucket "daintree-decisions"');
    expect(o).toContain('decisions remove daintree-decisions --account-id');
    expect(t.deletes().filter((r) => r.path.includes('/r2/'))).toEqual([]);
  });

  it('treats an unreadable answer as a failure, never as a missing Worker', async () => {
    const acct = account();
    const t = setup([acct], {
      answers: ['daintree-decisions', 'y'],
      faults: {
        fail: (m, p) => (m === 'GET' && p.endsWith('/settings') ? new Response('<html>') : null),
      },
    });
    await expect(t.run('daintree-decisions')).rejects.toThrow(/could not be read/);
    expect(t.deletes()).toEqual([]);
  });

  it('names the Worker in the rerun command when it was found by its custom domain', async () => {
    const acct = account({
      domains: [{ hostname: 'relay.example.com', service: 'daintree-decisions' }],
    });
    const t = setup([acct], {
      answers: ['daintree-decisions', 'y'],
      faults: {
        fail: (m, p) =>
          m === 'DELETE' && p.endsWith('/r2/buckets/daintree-decisions')
            ? { status: 403, message: 'locked' }
            : null,
      },
    });
    await expect(t.run('https://relay.example.com')).rejects.toThrow(/only partly removed/);
    expect(text(t.out)).toContain(`decisions remove daintree-decisions --account-id ${A1}`);
    expect(t.probes.map((p) => p.url)).toEqual(['https://relay.example.com/api/v1/info']);
  });
});

const sha = (b: string) => createHash('sha256').update(b).digest('hex');

/** A relay bundle laid out like packages/relay/dist, enough to learn the pinned Wrangler version. */
function makeBundle() {
  const dir = mkdtempSync(join(root, 'bundle-'));
  const files: Record<string, string> = {
    'wrangler.json': JSON.stringify({
      name: 'daintree-decisions',
      r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'daintree-decisions' }],
    }),
    'worker/index.js': 'export default {};\n',
  };
  const manifestFiles: Record<string, { sha256: string; bytes: number }> = {};
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
    manifestFiles[rel] = { sha256: sha(content), bytes: Buffer.byteLength(content) };
  }
  const text = JSON.stringify({
    schema: 1,
    name: '@daintreehq/decisions-relay',
    version: '9.9.9',
    wrangler: WRANGLER,
    config: 'wrangler.json',
    files: manifestFiles,
  });
  writeFileSync(join(dir, 'manifest.json'), text);
  return { dir, digest: sha(text) };
}
