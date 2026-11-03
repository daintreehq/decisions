import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import { buildProgram } from '../src/bin.js';
import type { WorkerSnapshot } from '../src/cloudflare.js';
import type { SpawnRequest, SpawnResult } from '../src/commands/deploy.js';
import {
  chooseRelease,
  planConfig,
  relayOrigin,
  update,
  type UpdateOptions,
} from '../src/commands/update.js';
import type { RelayRelease } from '../src/relay-release.js';
import type { Ctx } from '../src/runtime.js';
import { tarball } from './tar.js';

const root = mkdtempSync(join(tmpdir(), 'decisions-update-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const WRANGLER = '4.160.0';
const ACCOUNT = 'a1b2c3d4'.repeat(4);
const OTHER = 'f0e1d2c3'.repeat(4);
const OAUTH = 'oauth-token-' + 'q'.repeat(30);
const ORIGIN = 'https://relay-one.someone.workers.dev';
const REGISTRY = 'https://registry.test';

const RELEASE_CONFIG = {
  name: 'daintree-decisions',
  main: './worker/index.js',
  no_bundle: true,
  compatibility_date: '2026-11-30',
  observability: { enabled: false },
  assets: { directory: './app', binding: 'ASSETS', run_worker_first: true },
  r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'daintree-decisions' }],
  durable_objects: { bindings: [{ name: 'DECISION_ROOM', class_name: 'DecisionRoom' }] },
  exports: { DecisionRoom: { type: 'durable-object', storage: 'sqlite' } },
  vars: {
    ANTHROPIC_CORRECTION_MODEL: 'claude-haiku-5-5',
    OPENAI_CORRECTION_MODEL: 'gpt-6.1-terra',
    PUSH_SUBJECT: '',
    NEW_SETTING: 'default',
  },
};

const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const sri = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`;

/** A published relay package, as npm serves it. */
function relayTarball(version: string, over: { protocol?: unknown; tamper?: boolean } = {}) {
  const files: Record<string, string> = {
    'wrangler.json': JSON.stringify(RELEASE_CONFIG, null, 2),
    'worker/index.js': `export default {}; // ${version}\n`,
    'app/index.html': '<!doctype html><title>Decisions</title>',
  };
  const manifest = {
    schema: 1,
    name: '@daintreehq/decisions-relay',
    version,
    protocol: 'protocol' in over ? over.protocol : { min: 1, max: 1 },
    wrangler: WRANGLER,
    config: 'wrangler.json',
    files: Object.fromEntries(
      Object.entries(files).map(([k, v]) => [
        k,
        { sha256: sha256(v), bytes: Buffer.byteLength(v) },
      ]),
    ),
  };
  if (over.tamper) files['worker/index.js'] = 'export default { evil: true };\n';
  return tarball([
    { path: 'package/package.json', data: JSON.stringify({ name: manifest.name, version }) },
    { path: 'package/dist/manifest.json', data: JSON.stringify(manifest, null, 2) + '\n' },
    ...Object.entries(files).map(([k, v]) => ({ path: `package/dist/${k}`, data: v })),
  ]);
}

const LIVE_BINDINGS = [
  { type: 'assets', name: 'ASSETS' },
  { type: 'r2_bucket', name: 'ATTACHMENTS', bucket_name: 'my-bucket' },
  {
    type: 'durable_object_namespace',
    name: 'DECISION_ROOM',
    class_name: 'DecisionRoom',
    namespace_id: 'ns1',
  },
  { type: 'plain_text', name: 'ANTHROPIC_CORRECTION_MODEL', text: 'claude-sonnet-5-5' },
  { type: 'plain_text', name: 'OPENAI_CORRECTION_MODEL', text: 'gpt-6.1-terra' },
  { type: 'plain_text', name: 'PUSH_SUBJECT', text: 'mailto:me@example.com' },
  { type: 'plain_text', name: 'VOICE_MONTHLY_MINUTES', text: '900' },
  { type: 'secret_text', name: 'CLAIM_SECRET' },
  { type: 'secret_text', name: 'XAI_API_KEY' },
];

interface World {
  live: string;
  room: string;
  published: Record<string, { protocol?: unknown; tamper?: boolean }>;
  bindings: Record<string, unknown>[];
  workerName: string;
  subdomain: string;
  accounts: { id: string; name: string }[];
  customDomains: Record<string, string>;
  workersDev: boolean;
  /** Advance the room's version only after this many /api/v1/info reads past the deploy. */
  roomLag: number;
  /** Change the bindings on the n-th settings read (to simulate a concurrent edit). */
  driftOnRead?: number;
  deployFails?: boolean;
  infoClaimed: boolean;
  githubDown?: boolean;
}

function setup(
  over: Partial<World> & {
    answers?: string[];
    interactive?: boolean;
    env?: Record<string, string>;
  } = {},
) {
  const w: World = {
    live: '0.2.0',
    room: '0.2.0',
    published: { '0.2.0': { protocol: undefined }, '0.3.0': {}, '0.4.0': {} },
    bindings: LIVE_BINDINGS.map((b) => ({ ...b })),
    workerName: 'relay-one',
    subdomain: 'someone',
    accounts: [{ id: ACCOUNT, name: 'Mine' }],
    customDomains: {},
    workersDev: true,
    roomLag: 0,
    infoClaimed: true,
    ...over,
  };
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const answers = [...(over.answers ?? [])];
  const calls: (SpawnRequest & { config?: Record<string, unknown> })[] = [];
  const requests: { url: string; auth: string | null }[] = [];
  const tarballs = new Map<string, Buffer>();
  for (const [v, o] of Object.entries(w.published)) tarballs.set(v, relayTarball(v, o));
  let deployed = false;
  let settingsReads = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const cf = (result: unknown, status = 200) =>
    json(
      { success: status < 300, result, errors: status < 300 ? [] : [{ message: 'nope' }] },
      status,
    );

  const fetchFn = (async (u: unknown, init?: RequestInit) => {
    const url = new URL(String(u));
    const auth = new Headers(init?.headers).get('authorization');
    requests.push({ url: url.toString(), auth });
    if (url.origin === ORIGIN || Object.keys(w.customDomains).some((h) => url.hostname === h)) {
      if (url.pathname === '/health') return json({ ok: true, version: w.live });
      if (url.pathname === '/api/v1/info') {
        if (deployed && w.room !== w.live) {
          if (w.roomLag-- <= 0) w.room = w.live;
        }
        return json({
          name: 'daintree-decisions',
          protocol_min: 1,
          protocol_max: 1,
          worker_version: w.room,
          claimed: w.infoClaimed,
          claim_configured: true,
          voice: { xai: true, anthropic: false, openai: false },
        });
      }
      return json({ code: 'not_found' }, 404);
    }
    if (url.origin === REGISTRY) {
      if (url.pathname === '/@daintreehq%2fdecisions-relay') {
        return json({
          versions: Object.fromEntries(
            Object.entries(w.published).map(([v, o]) => [
              v,
              {
                version: v,
                ...(o.protocol === undefined && v === '0.2.0'
                  ? {}
                  : { decisions: { protocol: o.protocol ?? { min: 1, max: 1 } } }),
                dist: { tarball: `${REGISTRY}/t/${v}.tgz`, integrity: sri(tarballs.get(v)!) },
              },
            ]),
          ),
        });
      }
      const m = /^\/t\/(.+)\.tgz$/.exec(url.pathname);
      if (m && tarballs.has(m[1]!)) return new Response(new Uint8Array(tarballs.get(m[1]!)!));
      return json({}, 404);
    }
    if (url.hostname === 'api.github.com') {
      if (w.githubDown) throw new Error('offline');
      const m = /\/releases\/tags\/v(.+)$/.exec(url.pathname);
      return m ? json({ body: `## ${m[1]}\n- fixed things in ${m[1]}` }) : json({}, 404);
    }
    if (url.hostname === 'api.cloudflare.com') {
      if (auth !== `Bearer ${OAUTH}`) return cf(null, 403);
      const p = url.pathname.replace('/client/v4', '');
      if (p === '/accounts')
        return json({
          success: true,
          result: w.accounts,
          result_info: { page: 1, total_pages: 1 },
        });
      let m = /^\/accounts\/([^/]+)\/workers\/subdomain$/.exec(p);
      if (m)
        return m[1] === ACCOUNT ? cf({ subdomain: w.subdomain }) : cf({ subdomain: 'elsewhere' });
      m = /^\/accounts\/([^/]+)\/workers\/domains$/.exec(p);
      if (m) {
        const host = url.searchParams.get('hostname')!;
        const svc = m[1] === ACCOUNT ? w.customDomains[host] : undefined;
        return json({
          success: true,
          result: svc ? [{ hostname: host, service: svc, environment: 'production' }] : [],
          result_info: { total_pages: 1 },
        });
      }
      m = /^\/accounts\/([^/]+)\/workers\/scripts$/.exec(p);
      if (m)
        return json({
          success: true,
          result: m[1] === ACCOUNT ? [{ id: w.workerName }, { id: 'something-else' }] : [],
          result_info: { total_pages: 1 },
        });
      m = /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/(settings|subdomain)$/.exec(p);
      if (m) {
        if (m[1] !== ACCOUNT || m[2] !== w.workerName) return cf(null, 404);
        if (m[3] === 'subdomain') return cf({ enabled: w.workersDev, previews_enabled: false });
        settingsReads++;
        if (w.driftOnRead === settingsReads)
          w.bindings.push({ type: 'plain_text', name: 'SNEAKY', text: 'x' });
        return cf({ bindings: w.bindings, placement: { mode: 'smart' }, observability: null });
      }
      return cf(null, 404);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const spawn = async (req: SpawnRequest): Promise<SpawnResult> => {
    const call: SpawnRequest & { config?: Record<string, unknown> } = {
      ...req,
      env: { ...req.env },
    };
    calls.push(call);
    const ok = (stdout = ''): SpawnResult => ({ status: 0, stdout, stderr: '' });
    const sub = req.args.slice(2).join(' ');
    if (sub === '--version') return ok(`${WRANGLER}\n`);
    if (sub === 'whoami') return ok('You are logged in with an OAuth Token');
    if (sub === 'auth token --json') return ok(JSON.stringify({ type: 'oauth', token: OAUTH }));
    if (sub.startsWith('deploy')) {
      call.config = JSON.parse(readFileSync(join(req.cwd, 'wrangler.json'), 'utf8'));
      if (w.deployFails) return { status: 1, stdout: '', stderr: `upload failed ${OAUTH}` };
      deployed = true;
      w.live = /\/\/ (\S+)/.exec(readFileSync(join(req.cwd, 'worker/index.js'), 'utf8'))![1]!;
      return ok(`Uploaded ${w.workerName}\n  ${ORIGIN}\n`);
    }
    return { status: 1, stdout: '', stderr: `unexpected: ${sub}` };
  };
  const ctx: Ctx = {
    home: join(root, `home${n++}`),
    json: false,
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    prompt: async (q) => {
      prompts.push(q);
      return answers.shift() ?? '';
    },
    env: over.env ?? { PATH: '/usr/bin' },
    now: Date.now,
    readStdin: async () => '',
    fetch: fetchFn,
    ...(over.interactive !== undefined ? { interactive: over.interactive } : {}),
  };
  const tmpRoot = mkdtempSync(join(root, 'tmp-'));
  const run = (o: Partial<UpdateOptions> = {}) => {
    return update(
      ctx,
      {},
      { url: ORIGIN, ...o },
      {
        spawn,
        tmpRoot,
        sleep: async () => {},
        registry: REGISTRY,
      },
    );
  };
  const text = () => out.join('\n');
  const deploys = () => calls.filter((c) => c.args[2] === 'deploy');
  return { w, ctx, out, err, prompts, calls, requests, run, text, deploys, tmpRoot };
}

describe('decisions update', () => {
  it('is registered with its options', () => {
    const cmd = buildProgram().commands.find((c) => c.name() === 'update')!;
    expect(cmd).toBeDefined();
    const flags = cmd.options.map((o) => o.long);
    for (const f of [
      '--url',
      '--name',
      '--account-id',
      '--protocol',
      '--to',
      '--yes',
      '--dry-run',
      '--api-token',
    ])
      expect(flags).toContain(f);
  });

  it('finds the Worker from a workers.dev URL and deploys exactly the newest compatible release', async () => {
    const t = setup({ answers: ['y'] });
    await t.run();
    const deploys = t.deploys();
    expect(deploys).toHaveLength(1);
    const d = deploys[0]!;
    expect(d.args).toEqual([
      '--yes',
      `wrangler@${WRANGLER}`,
      'deploy',
      '--config',
      'wrangler.json',
    ]);
    expect(d.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
    expect(d.config!.name).toBe('relay-one');
    expect(t.text()).toMatch(/0\.2\.0 -> 0\.4\.0/);
    expect(t.text()).toMatch(/Updated https:\/\/relay-one\.someone\.workers\.dev to relay 0\.4\.0/);
    expect(t.prompts.some((p) => /Update now\? \[y\/N\]/.test(p))).toBe(true);
    // Release notes for every version passed over.
    expect(t.text()).toMatch(/fixed things in 0\.3\.0/);
    expect(t.text()).toMatch(/fixed things in 0\.4\.0/);
  });

  it('keeps the bucket, variables, secrets and settings the Worker already has', async () => {
    const t = setup({ answers: ['y'], workersDev: false });
    await t.run();
    const c = t.deploys()[0]!.config!;
    expect(c.r2_buckets).toEqual([{ binding: 'ATTACHMENTS', bucket_name: 'my-bucket' }]);
    expect(c.keep_vars).toBe(true);
    // Only the variable the Worker does not have yet is sent; changed models and push subject stay.
    expect(c.vars).toEqual({ NEW_SETTING: 'default' });
    expect(c.workers_dev).toBe(false);
    expect(c.preview_urls).toBe(false);
    expect(c.placement).toEqual({ mode: 'smart' });
    expect(c.observability).toEqual({ enabled: false });
    expect(c.durable_objects).toEqual(RELEASE_CONFIG.durable_objects);
    // No secret, bucket or claim commands at all.
    for (const call of t.calls) expect(call.args.join(' ')).not.toMatch(/secret|r2 bucket|login/);
    expect(t.text()).toMatch(
      /keeps\s+variables .*ANTHROPIC_CORRECTION_MODEL.*VOICE_MONTHLY_MINUTES/,
    );
    expect(t.text()).toMatch(/keeps\s+secrets CLAIM_SECRET, XAI_API_KEY/);
    expect(t.text()).toMatch(/adds\s+variables NEW_SETTING/);
  });

  it('says so and changes nothing when the relay is already current', async () => {
    const t = setup({ live: '0.4.0', room: '0.4.0' });
    await t.run();
    expect(t.text()).toMatch(/already at 0\.4\.0.*Nothing was changed/);
    expect(t.calls).toHaveLength(0);
    expect(t.requests.some((r) => r.url.includes('cloudflare'))).toBe(false);
  });

  it('says so and changes nothing when no release speaks the caller protocol', async () => {
    const t = setup();
    await t.run({ protocol: '2-3' });
    expect(t.text()).toMatch(
      /No published release declares support for protocol 2–3.*Nothing was changed/,
    );
    expect(t.calls).toHaveLength(0);
  });

  it('picks the newest release that overlaps the protocol range the caller passes', async () => {
    const t = setup({
      answers: ['y'],
      published: {
        '0.2.0': {},
        '0.3.0': { protocol: { min: 1, max: 2 } },
        '0.4.0': { protocol: { min: 2, max: 2 } },
      },
    });
    await t.run({ protocol: '1' });
    expect(t.text()).toMatch(/0\.2\.0 -> 0\.3\.0/);
  });

  it('changes nothing when the user does not confirm', async () => {
    const t = setup({ answers: [''] });
    await t.run();
    expect(t.deploys()).toHaveLength(0);
    expect(t.text()).toMatch(/Cancelled\. Nothing was changed; the relay is still 0\.2\.0/);
    expect(readdirSync(t.tmpRoot)).toEqual([]);
  });

  it('shows the plan on a dry run without deploying or asking', async () => {
    const t = setup();
    await t.run({ dryRun: true });
    expect(t.deploys()).toHaveLength(0);
    expect(t.prompts).toHaveLength(0);
    expect(t.text()).toMatch(/Dry run: nothing was changed/);
    expect(t.text()).toMatch(/Update the Worker "relay-one" in Mine from 0\.2\.0 to 0\.4\.0/);
  });

  it('refuses a release whose tarball does not match its manifest', async () => {
    const t = setup({ published: { '0.2.0': {}, '0.3.0': { tamper: true } } });
    await expect(t.run({ yes: true })).rejects.toThrow(/modified or is incomplete/);
    expect(t.calls).toHaveLength(0);
  });

  it('refuses a release whose manifest disagrees with the protocol it was chosen by', async () => {
    const t = setup({ published: { '0.2.0': {}, '0.3.0': { protocol: undefined } } });
    // The registry lists 0.3.0 for protocol 1, but the manifest inside the tarball declares none.
    await expect(t.run({ yes: true })).rejects.toThrow(/different protocol range/);
    expect(t.calls).toHaveLength(0);
  });

  it('honours --to, and refuses downgrades and unpublished versions', async () => {
    const t = setup({ answers: ['y'] });
    await t.run({ to: '0.3.0' });
    expect(t.text()).toMatch(/0\.2\.0 -> 0\.3\.0/);
    const t2 = setup({ live: '0.4.0', room: '0.4.0' });
    await expect(t2.run({ to: '0.3.0' })).rejects.toThrow(/downgrades are refused/);
    await expect(t2.run({ to: '9.9.9' })).rejects.toThrow(/not published/);
  });

  it('asks which Worker to update when the URL is a domain it cannot match', async () => {
    // Served at a domain Cloudflare does not list as a custom domain of any Worker (a route, say).
    const t2 = setup({ answers: ['1', 'y'], customDomains: { 'decisions.example.com': '' } });
    const res = await t2.run({ url: 'https://decisions.example.com' });
    expect(res).toBeUndefined();
    expect(t2.text()).toMatch(/Could not tell which Worker serves/);
    expect(t2.text()).toMatch(/\[1\] relay-one/);
    expect(t2.text()).toMatch(/chosen by name/);
    expect(t2.deploys()[0]!.config!.name).toBe('relay-one');
  });

  it('resolves a custom domain through Cloudflare without asking', async () => {
    const t = setup({ answers: ['y'], customDomains: { 'decisions.example.com': 'relay-one' } });
    await t.run({ url: 'https://decisions.example.com' });
    expect(t.text()).not.toMatch(/Could not tell/);
    expect(t.deploys()).toHaveLength(1);
  });

  it('needs --name when it cannot tell the Worker and nobody is at the terminal', async () => {
    const t = setup({ interactive: false, subdomain: 'not-this-one' });
    await expect(t.run({ yes: true })).rejects.toThrow(/Pass --name/);
    expect(t.deploys()).toHaveLength(0);
  });

  it('refuses a --name that contradicts the URL', async () => {
    const t = setup();
    await expect(t.run({ name: 'another', yes: true })).rejects.toThrow(
      /served by the Worker "relay-one"/,
    );
  });

  it('refuses to drop a binding this release does not declare', async () => {
    const t = setup();
    t.w.bindings.push({ type: 'kv_namespace', name: 'CACHE', namespace_id: 'x' });
    await expect(t.run({ yes: true })).rejects.toThrow(/kv_namespace binding CACHE/);
    expect(t.deploys()).toHaveLength(0);
  });

  it('refuses to go ahead when the Worker changed while waiting for confirmation', async () => {
    const t = setup({ answers: ['y'], driftOnRead: 2 });
    await expect(t.run()).rejects.toThrow(/changed in Cloudflare while waiting/);
    expect(t.deploys()).toHaveLength(0);
  });

  it('says what state the relay was left in when the deploy fails, without leaking the token', async () => {
    const t = setup({ answers: ['y'], deployFails: true });
    const e = (await t.run().catch((x: Error) => x)) as Error;
    expect(e.message).toMatch(/still reports 0\.2\.0/);
    expect(e.message).not.toContain(OAUTH);
    expect(e.message).toContain('[redacted]');
    expect(readdirSync(t.tmpRoot)).toEqual([]);
  });

  it('waits for the relay storage to pick up the new version', async () => {
    const t = setup({ answers: ['y'], roomLag: 3 });
    await t.run();
    expect(t.text()).toMatch(/Updated/);
  });

  it('reports a relay whose storage never switched', async () => {
    const t = setup({ answers: ['y'], roomLag: 1000 });
    await expect(t.run()).rejects.toThrow(/storage still answers as 0\.2\.0/);
  });

  it('sends the Cloudflare token only to the Cloudflare API, and never prints it', async () => {
    const t = setup({ answers: ['y'] });
    await t.run();
    for (const r of t.requests) {
      if (r.auth) expect(new URL(r.url).hostname).toBe('api.cloudflare.com');
    }
    expect(t.text()).not.toContain(OAUTH);
    const tok = t.calls.find((c) => c.args.includes('token'))!;
    expect(tok.env.WRANGLER_WRITE_LOGS).toBe('false');
  });

  it('refuses anything that is not a Decisions relay', async () => {
    const t = setup();
    await expect(
      t.run({ url: 'https://example.org' }).catch((e: Error) => e),
    ).resolves.toBeInstanceOf(Error);
    expect(t.calls).toHaveLength(0);
  });

  it('still works without release notes', async () => {
    const t = setup({ answers: ['y'], githubDown: true });
    await t.run();
    expect(t.text()).toMatch(
      /0\.4\.0\s+https:\/\/github\.com\/daintreehq\/decisions\/releases\/tag\/v0\.4\.0/,
    );
    expect(t.text()).toMatch(/Updated/);
  });
});

describe('chooseRelease', () => {
  const rel = (version: string, protocol: { min: number; max: number } | null): RelayRelease => ({
    version,
    protocol,
    tarball: '',
    integrity: '',
    repository: null,
  });
  const one = { min: 1, max: 1 };

  it('skips prereleases and releases without a declared range', () => {
    const r = chooseRelease(
      [rel('0.3.0', one), rel('0.4.0', null), rel('0.5.0-rc.1', one)],
      '0.2.0',
      one,
    );
    expect('release' in r && r.release.version).toBe('0.3.0');
  });

  it('explains a relay newer than every compatible release', () => {
    const r = chooseRelease([rel('0.3.0', one)], '0.5.0', one);
    expect('none' in r && r.none).toMatch(/newer than 0\.3\.0/);
  });
});

describe('planConfig', () => {
  const snap = (bindings: Record<string, unknown>[]): WorkerSnapshot => ({
    account: { id: OTHER, name: 'x' },
    name: 'w',
    bindings: bindings as WorkerSnapshot['bindings'],
    workersDev: true,
    previewUrls: true,
    carried: {},
  });

  it('keeps a bucket jurisdiction and does not send a default over a secret of the same name', () => {
    const p = planConfig(
      snap([
        ...LIVE_BINDINGS.filter((b) => b.type !== 'r2_bucket'),
        { type: 'r2_bucket', name: 'ATTACHMENTS', bucket_name: 'eu-bucket', jurisdiction: 'eu' },
        { type: 'secret_text', name: 'NEW_SETTING' },
      ]),
      structuredClone(RELEASE_CONFIG),
    );
    expect(p.blockers).toEqual([]);
    const c = structuredClone(RELEASE_CONFIG) as Record<string, unknown>;
    p.edit(c);
    expect(c.r2_buckets).toEqual([
      { binding: 'ATTACHMENTS', bucket_name: 'daintree-decisions', jurisdiction: 'eu' },
    ]);
    expect(c.vars).toEqual({});
    expect(p.bucket).toBe('eu-bucket');
  });

  it('refuses a Worker without the relay Durable Object or bucket', () => {
    const p = planConfig(
      snap([{ type: 'assets', name: 'ASSETS' }]),
      structuredClone(RELEASE_CONFIG),
    );
    expect(p.blockers.join('\n')).toMatch(/no Durable Object DECISION_ROOM/);
    expect(p.blockers.join('\n')).toMatch(/no ATTACHMENTS bucket/);
  });

  it('refuses a Durable Object class change', () => {
    const p = planConfig(
      snap(
        LIVE_BINDINGS.map((b) =>
          b.name === 'DECISION_ROOM' ? { ...b, class_name: 'OldRoom' } : b,
        ),
      ),
      structuredClone(RELEASE_CONFIG),
    );
    expect(p.blockers.join('\n')).toMatch(/needs a migration/);
  });
});

describe('relayOrigin', () => {
  it('accepts an origin and refuses anything else', () => {
    expect(relayOrigin('https://a.b.workers.dev/')).toBe('https://a.b.workers.dev');
    expect(relayOrigin('http://localhost:8787')).toBe('http://localhost:8787');
    for (const bad of [
      'http://a.example',
      'https://u:p@a.example',
      'https://a.example/x',
      'https://a.example/?q',
      'nope',
    ])
      expect(() => relayOrigin(bad)).toThrow();
  });
});

describe('the relay package', () => {
  it('declares the protocol range this repository speaks', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../relay/package.json', import.meta.url), 'utf8'),
    ) as { decisions: { protocol: { min: number; max: number } } };
    expect(pkg.decisions.protocol).toEqual({ min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION });
    expect(existsSync(new URL('../../relay/scripts/build.mjs', import.meta.url))).toBe(true);
  });
});
