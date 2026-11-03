import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../src/bin.js';
import { CliError, type Ctx } from '../src/runtime.js';
import {
  accountsFromWhoami,
  buildDeployPlan,
  deploy,
  nodeSpawner,
  wranglerCommands,
  type DeployDeps,
  type SpawnRequest,
  type SpawnResult,
} from '../src/commands/deploy.js';
import { stageRelayBundle, verifyRelayBundle } from '../src/relay-bundle.js';

const root = mkdtempSync(join(tmpdir(), 'decisions-deploy-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (p: string) => mkdtempSync(join(root, `${p}-`));

const VERSION = '9.9.9';
const WRANGLER = '4.156.0';
const SECRET = 'feedc0de'.repeat(8);
const TOKEN = 'cf-token-' + 'z'.repeat(32);
const ACCOUNT = 'a1b2c3d4'.repeat(4);
const URL_ = 'https://daintree-decisions.someone.workers.dev';

const WRANGLER_JSON = {
  name: 'daintree-decisions',
  main: './worker/index.js',
  no_bundle: true,
  assets: { directory: './app', binding: 'ASSETS' },
  r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'daintree-decisions' }],
  durable_objects: { bindings: [{ name: 'DECISION_ROOM', class_name: 'DecisionRoom' }] },
};

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Writes a relay bundle laid out like packages/relay/dist, and returns its pinned digest. */
function makeBundle(
  over: {
    version?: string;
    extraManifest?: Record<string, unknown>;
    files?: Record<string, string>;
  } = {},
) {
  const dir = fresh('bundle');
  const files: Record<string, string> = over.files ?? {
    'wrangler.json': JSON.stringify(WRANGLER_JSON, null, 2),
    'worker/index.js': 'export default { fetch() { return new Response("ok"); } };\n',
    'worker/index.js.map': '{"version":3,"sources":[],"mappings":""}',
    'app/index.html': '<!doctype html><title>Decisions</title>',
    'app/assets/index-abc.js': 'console.log(1)',
  };
  const manifestFiles: Record<string, { sha256: string; bytes: number }> = {};
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
    manifestFiles[rel] = { sha256: sha(content), bytes: Buffer.byteLength(content) };
  }
  const manifest = {
    schema: 1,
    name: '@daintreehq/decisions-relay',
    version: over.version ?? VERSION,
    wrangler: WRANGLER,
    config: 'wrangler.json',
    files: manifestFiles,
    ...over.extraManifest,
  };
  const text = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(join(dir, 'manifest.json'), text);
  return { dir, digest: sha(text) };
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

interface FakeWrangler {
  loggedIn?: boolean;
  /** The accounts `whoami --json` lists. */
  accounts?: { id: string; name: string }[];
  bucketExists?: boolean;
  deployOutput?: string;
  failOn?: string;
  /** Make the failing command repeat its stdin in the error, as a careless tool might. */
  echoInputOnFail?: boolean;
}

function fakeSpawner(f: FakeWrangler = {}) {
  const calls: (SpawnRequest & { configAtCall?: unknown })[] = [];
  let loggedIn = f.loggedIn ?? false;
  const spawn = async (req: SpawnRequest): Promise<SpawnResult> => {
    // Snapshot argv and env as they were at the time of the call.
    const call: SpawnRequest & { configAtCall?: unknown } = {
      ...req,
      args: [...req.args],
      env: { ...req.env },
    };
    calls.push(call);
    const ok = (stdout = ''): SpawnResult => ({ status: 0, stdout, stderr: '' });
    const no = (stderr: string): SpawnResult => ({ status: 1, stdout: '', stderr });
    const sub = req.args.slice(2).join(' ');
    if (f.failOn && sub.startsWith(f.failOn))
      return no(`${f.failOn} exploded${f.echoInputOnFail ? `: ${req.input ?? ''}` : ''}`);
    if (sub === '--version') return ok(`${WRANGLER}\n`);
    if (sub === 'whoami') {
      if (req.env.CLOUDFLARE_API_TOKEN) return ok('You are logged in with an API Token');
      return loggedIn
        ? ok('You are logged in with an OAuth Token')
        : no('You are not authenticated.');
    }
    if (sub === 'whoami --json') {
      if (!req.env.CLOUDFLARE_API_TOKEN && !loggedIn) return no('{"loggedIn":false}');
      const accounts = f.accounts ?? [{ id: ACCOUNT, name: 'Someone' }];
      return ok(JSON.stringify({ loggedIn: true, authType: 'OAuth Token', accounts }, null, 2));
    }
    if (sub === 'login') {
      loggedIn = true;
      return ok();
    }
    if (sub.startsWith('r2 bucket create'))
      return f.bucketExists ? no('The bucket you tried to create already exists') : ok('Created');
    if (sub.startsWith('deploy')) {
      call.configAtCall = JSON.parse(readFileSync(join(req.cwd, 'wrangler.json'), 'utf8'));
      return ok(f.deployOutput ?? `Uploaded daintree-decisions\nDeployed triggers\n  ${URL_}\n`);
    }
    if (sub.startsWith('secret put')) return ok(`Success! Uploaded secret ${req.args[4]}`);
    return no(`unexpected: ${sub}`);
  };
  return { spawn, calls };
}

const PROVIDER_MODELS: Record<string, string[]> = {
  'api.x.ai': ['grok-4'],
  'api.openai.com': ['gpt-6.1-terra', 'gpt-6-luna'],
  'api.anthropic.com': ['claude-haiku-5-5', 'claude-sonnet-5-5'],
};

interface FakeProviders {
  /** Keys every provider accepts; anything else gets a 401. */
  goodKeys?: string[];
  /** Every provider request fails at the network. */
  down?: boolean;
  calls?: { host: string; headers: Record<string, string>; redirect?: string }[];
}

function relayFetch(
  over: { claimed?: boolean; claimCalls?: unknown[]; providers?: FakeProviders } = {},
) {
  return (async (u: unknown, init?: RequestInit) => {
    const url = new URL(String(u));
    const models = PROVIDER_MODELS[url.host];
    if (models) {
      const p = over.providers ?? {};
      const headers = { ...(init?.headers as Record<string, string>) };
      p.calls?.push({ host: url.host, headers, ...(init?.redirect ? { redirect: init.redirect } : {}) });
      if (p.down) throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
      const key = headers['x-api-key'] ?? headers.authorization?.replace(/^Bearer /, '');
      if (!key || !(p.goodKeys ?? []).includes(key))
        return new Response(JSON.stringify({ error: `bad key ${key}` }), { status: 401 });
      return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }));
    }
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    if (key === 'GET /health') return new Response(JSON.stringify({ ok: true, version: VERSION }));
    if (key === 'GET /api/v1/info')
      return new Response(
        JSON.stringify({
          name: 'daintree-decisions',
          protocol_min: 1,
          protocol_max: 1,
          worker_version: VERSION,
          claimed: over.claimed ?? false,
          claim_configured: true,
          voice: { xai: false, anthropic: false, openai: false },
        }),
      );
    if (key === 'POST /api/v1/setup/claim') {
      const body = JSON.parse(String(init?.body)) as { installation_id: string };
      over.claimCalls?.push(body);
      return new Response(
        JSON.stringify({
          installation_id: body.installation_id,
          vapid_public_key: 'V'.repeat(87),
          server_time: new Date().toISOString(),
        }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify({ code: 'not_found', message: 'nope' }), { status: 404 });
  }) as typeof fetch;
}

function setupDeploy(
  over: {
    env?: Record<string, string>;
    answers?: string[];
    wrangler?: FakeWrangler;
    claimed?: boolean;
    bundle?: ReturnType<typeof makeBundle>;
    pinned?: string | undefined;
    nodeVersion?: string;
    interactive?: boolean;
    providers?: FakeProviders;
  } = {},
) {
  const out: string[] = [];
  const secretPrompts: string[] = [];
  const err: string[] = [];
  const claimCalls: unknown[] = [];
  const answers = [...(over.answers ?? [])];
  const prompts: string[] = [];
  const home = join(root, `home${n++}`);
  const ctx: Ctx = {
    home,
    json: false,
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    prompt: async (q, opts) => {
      prompts.push(q);
      if (opts?.secret) secretPrompts.push(q);
      return answers.shift() ?? '';
    },
    env: over.env ?? { PATH: '/usr/bin' },
    now: Date.now,
    readStdin: async () => '',
    fetch: relayFetch({
      claimed: over.claimed ?? false,
      claimCalls,
      ...(over.providers ? { providers: over.providers } : {}),
    }),
    ...(over.interactive !== undefined ? { interactive: over.interactive } : {}),
  };
  const bundle = over.bundle ?? makeBundle();
  const tmpRoot = fresh('tmp');
  const fake = fakeSpawner(over.wrangler);
  const deps: DeployDeps = {
    spawn: fake.spawn,
    bundleDir: bundle.dir,
    pinnedManifestSha256: 'pinned' in over ? over.pinned : bundle.digest,
    version: VERSION,
    tmpRoot,
    generateSecret: () => SECRET,
    sleep: async () => {},
    nodeVersion: over.nodeVersion ?? '22.12.0',
  };
  return {
    ctx,
    out,
    err,
    deps,
    calls: fake.calls,
    claimCalls,
    prompts,
    secretPrompts,
    home,
    tmpRoot,
    bundle,
  };
}

const text = (lines: string[]) => lines.join('\n');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('relay bundle verification', () => {
  it('accepts an untouched bundle and returns the verified bytes', async () => {
    const b = makeBundle();
    const v = await verifyRelayBundle(b.dir, { pinnedSha256: b.digest, version: VERSION });
    expect(v.manifest.wrangler).toBe(WRANGLER);
    expect(v.manifestSha256).toBe(b.digest);
    expect([...v.files.keys()].sort()).toEqual(
      [
        'app/assets/index-abc.js',
        'app/index.html',
        'wrangler.json',
        'worker/index.js',
        'worker/index.js.map',
      ].sort(),
    );
  });

  it('refuses a bundle with a tampered file', async () => {
    const b = makeBundle();
    writeFileSync(join(b.dir, 'worker/index.js'), 'export default { fetch() { steal(); } };\n');
    await expect(
      verifyRelayBundle(b.dir, { pinnedSha256: b.digest, version: VERSION }),
    ).rejects.toThrow(/worker\/index\.js.*SHA-256/);
  });

  it('refuses a bundle with a missing file', async () => {
    const b = makeBundle();
    rmSync(join(b.dir, 'app/index.html'));
    await expect(
      verifyRelayBundle(b.dir, { pinnedSha256: b.digest, version: VERSION }),
    ).rejects.toThrow(/app\/index\.html/);
  });

  it('refuses a manifest that differs from the digest the CLI was built with', async () => {
    const b = makeBundle();
    // A consistent rewrite: the file and its manifest entry both changed, so only the pin catches it.
    const evil = makeBundle({
      files: {
        'wrangler.json': JSON.stringify(WRANGLER_JSON),
        'worker/index.js': 'evil',
        'app/index.html': 'x',
      },
    });
    await expect(
      verifyRelayBundle(evil.dir, { pinnedSha256: b.digest, version: VERSION }),
    ).rejects.toThrow(/does not match the relay this CLI was built with/);
  });

  it('refuses when the CLI pins no bundle at all', async () => {
    const b = makeBundle();
    await expect(
      verifyRelayBundle(b.dir, { pinnedSha256: undefined, version: VERSION }),
    ).rejects.toThrow(/does not pin a relay bundle/);
  });

  it('refuses a bundle for a different version', async () => {
    const b = makeBundle({ version: '0.0.1' });
    await expect(
      verifyRelayBundle(b.dir, { pinnedSha256: b.digest, version: VERSION }),
    ).rejects.toThrow(/0\.0\.1.*9\.9\.9/);
  });

  it('refuses paths that escape the bundle', async () => {
    for (const bad of ['../outside.js', '/etc/passwd', 'app/../../x', 'app\\x.js', '']) {
      const b = makeBundle({
        extraManifest: {
          files: {
            [bad]: { sha256: sha('x'), bytes: 1 },
            'wrangler.json': { sha256: 'a', bytes: 1 },
          },
        },
      });
      await expect(
        verifyRelayBundle(b.dir, { pinnedSha256: b.digest, version: VERSION }),
      ).rejects.toThrow(CliError);
    }
  });

  it('refuses a malformed manifest or an unsafe Wrangler version', async () => {
    for (const extra of [{ schema: 2 }, { wrangler: 'latest; rm -rf /' }, { files: [] }]) {
      const b = makeBundle({ extraManifest: extra });
      await expect(
        verifyRelayBundle(b.dir, { pinnedSha256: b.digest, version: VERSION }),
      ).rejects.toThrow(CliError);
    }
  });

  it('stages only the verified bytes, with the chosen Worker and bucket names', async () => {
    const b = makeBundle();
    const v = await verifyRelayBundle(b.dir, { pinnedSha256: b.digest, version: VERSION });
    // Swapping a file after verification must not change what is staged.
    writeFileSync(join(b.dir, 'worker/index.js'), 'swapped');
    const dest = join(fresh('stage'), 'out');
    await stageRelayBundle(v, dest, { name: 'my-relay', bucket: 'my-bucket' });
    expect(readFileSync(join(dest, 'worker/index.js'), 'utf8')).toContain('Response("ok")');
    const cfg = JSON.parse(readFileSync(join(dest, 'wrangler.json'), 'utf8'));
    expect(cfg.name).toBe('my-relay');
    expect(cfg.r2_buckets[0].bucket_name).toBe('my-bucket');
    expect(cfg.durable_objects).toEqual(WRANGLER_JSON.durable_objects);
    expect(cfg.no_bundle).toBe(true);
    expect(walk(dest).length).toBe(5);
  });
});

describe('deploy plan', () => {
  it('lists every step with the exact pinned Wrangler commands and no secret', () => {
    const plan = buildDeployPlan({
      name: 'relay-x',
      bucket: 'bucket-y',
      wrangler: WRANGLER,
      auth: 'browser',
      claim: false,
    });
    const all = JSON.stringify(plan);
    expect(plan.map((s) => s.title)).toEqual([
      expect.stringMatching(/Node and Wrangler/),
      expect.stringMatching(/Cloudflare/),
      expect.stringMatching(/R2 bucket "bucket-y"/),
      expect.stringMatching(/Deploy/),
      expect.stringMatching(/claim secret/),
      expect.stringMatching(/Check/),
    ]);
    expect(all).toContain(`npx --yes wrangler@${WRANGLER} r2 bucket create bucket-y`);
    expect(all).toContain(`npx --yes wrangler@${WRANGLER} deploy --config wrangler.json`);
    expect(all).toContain(`npx --yes wrangler@${WRANGLER} secret put CLAIM_SECRET --name relay-x`);
    expect(all).toContain(`npx --yes wrangler@${WRANGLER} login`);
  });

  it('skips the browser login with an API token and adds the claim step when asked', () => {
    const plan = buildDeployPlan({
      name: 'a',
      bucket: 'bbb',
      wrangler: WRANGLER,
      auth: 'token-prompt',
      claim: true,
    });
    expect(JSON.stringify(plan)).not.toContain(' login');
    expect(plan.at(-1)!.title).toMatch(/Claim/);
  });

  it('uses the same argv for the plan and for execution', () => {
    expect(wranglerCommands.secret('relay')).toEqual([
      'secret',
      'put',
      'CLAIM_SECRET',
      '--name',
      'relay',
    ]);
  });
});

describe('decisions deploy', () => {
  it('is a command of the CLI with the documented options', () => {
    const cmd = buildProgram().commands.find((c) => c.name() === 'deploy');
    expect(cmd).toBeDefined();
    const flags = cmd!.options.map((o) => o.long);
    for (const f of [
      '--name',
      '--bucket',
      '--dry-run',
      '--api-token',
      '--account-id',
      '--claim',
      '--outdir',
    ])
      expect(flags).toContain(f);
    expect(flags).not.toContain('--claim-secret');
  });

  it('--dry-run verifies the bundle, prints the plan and touches nothing', async () => {
    const t = setupDeploy();
    await deploy(t.ctx, {}, { dryRun: true }, t.deps);
    const o = text(t.out);
    expect(t.calls).toEqual([]);
    expect(walk(t.tmpRoot)).toEqual([]);
    expect(existsSync(t.home)).toBe(false);
    expect(o).toMatch(/dry run/i);
    expect(o).toContain(`5 files verified`);
    expect(o).toContain(`npx --yes wrangler@${WRANGLER} deploy --config wrangler.json`);
    expect(o).not.toContain(SECRET);
  });

  it('--dry-run still refuses a tampered bundle', async () => {
    const b = makeBundle();
    writeFileSync(join(b.dir, 'app/index.html'), '<script>evil()</script>');
    const t = setupDeploy({ bundle: b });
    await expect(deploy(t.ctx, {}, { dryRun: true }, t.deps)).rejects.toThrow(/app\/index\.html/);
  });

  it('refuses a tampered bundle before running anything', async () => {
    const b = makeBundle();
    writeFileSync(join(b.dir, 'wrangler.json'), JSON.stringify({ ...WRANGLER_JSON, main: 'x' }));
    const t = setupDeploy({ bundle: b });
    await expect(deploy(t.ctx, {}, {}, t.deps)).rejects.toThrow(CliError);
    expect(t.calls).toEqual([]);
  });

  it('rejects names that are not valid Worker or bucket names', async () => {
    for (const o of [
      { name: 'Bad Name' },
      { name: '-x' },
      { bucket: 'a' },
      { bucket: 'x;rm' },
      { accountId: 'acc 1' },
    ]) {
      const t = setupDeploy();
      await expect(deploy(t.ctx, {}, o, t.deps)).rejects.toThrow(CliError);
      expect(t.calls).toEqual([]);
    }
  });

  it('requires Node 22', async () => {
    const t = setupDeploy({ nodeVersion: '20.11.0' });
    await expect(deploy(t.ctx, {}, {}, t.deps)).rejects.toThrow(/Node 22/);
    expect(t.calls).toEqual([]);
  });

  it('runs the steps in order through the pinned Wrangler, from a staged temp dir', async () => {
    const t = setupDeploy();
    await deploy(t.ctx, {}, {}, t.deps);
    const subs = t.calls.map((c) => c.args.join(' '));
    expect(subs).toEqual([
      `--yes wrangler@${WRANGLER} --version`,
      `--yes wrangler@${WRANGLER} whoami`,
      `--yes wrangler@${WRANGLER} login`,
      `--yes wrangler@${WRANGLER} r2 bucket create daintree-decisions`,
      `--yes wrangler@${WRANGLER} deploy --config wrangler.json`,
      `--yes wrangler@${WRANGLER} secret put CLAIM_SECRET --name daintree-decisions`,
    ]);
    for (const c of t.calls) {
      expect(c.cmd).toBe('npx');
      expect(c.cwd.startsWith(t.tmpRoot)).toBe(true);
    }
    expect(t.calls.find((c) => c.args.includes('login'))!.capture).toBe(false);
    const deployed = t.calls.find((c) => c.args.includes('deploy'))!;
    expect(deployed.configAtCall).toMatchObject({
      name: 'daintree-decisions',
      no_bundle: true,
      main: './worker/index.js',
      r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'daintree-decisions' }],
      durable_objects: WRANGLER_JSON.durable_objects,
    });
    // The staging directory is removed afterwards.
    expect(walk(t.tmpRoot)).toEqual([]);
  });

  it('never puts the claim secret in argv, env or any file, and shows it exactly once', async () => {
    const t = setupDeploy();
    await deploy(t.ctx, {}, {}, t.deps);
    for (const c of t.calls) {
      expect(c.args.join(' ')).not.toContain(SECRET);
      expect(c.cmd).not.toContain(SECRET);
      expect(JSON.stringify(c.env)).not.toContain(SECRET);
      if (c.args.includes('secret')) expect(c.input).toBe(SECRET + '\n');
      else expect(c.input ?? '').not.toContain(SECRET);
    }
    for (const f of [...walk(root), ...walk(t.home)]) {
      expect(readFileSync(f).includes(SECRET), f).toBe(false);
    }
    const o = text(t.out);
    expect(count(o, SECRET)).toBe(1);
    expect(text(t.err)).not.toContain(SECRET);
    expect(o).toContain(URL_);
    expect(o).toMatch(/Settings > Decisions/);
    expect(o).toMatch(/not saved anywhere/);
    // Nothing is left in the old places either.
    expect(existsSync(join(t.home, 'deploy.json'))).toBe(false);
    expect(existsSync(join(t.home, 'claim-secret'))).toBe(false);
  });

  it('reuses an existing login and an existing bucket', async () => {
    const t = setupDeploy({ wrangler: { loggedIn: true, bucketExists: true } });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(t.calls.map((c) => c.args[2])).not.toContain('login');
    expect(text(t.out)).toContain(SECRET);
  });

  it('holds a prompted API token in memory and passes it to Wrangler only through env', async () => {
    const t = setupDeploy({ answers: [TOKEN] });
    await deploy(t.ctx, {}, { apiToken: true, accountId: ACCOUNT }, t.deps);
    expect(t.prompts).toEqual([expect.stringMatching(/API token/)]);
    expect(t.calls.map((c) => c.args[2])).not.toContain('login');
    // The token is asked for after the Wrangler check, and reaches every later command.
    expect(t.calls[0]!.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(t.calls.slice(1).every((c) => c.env.CLOUDFLARE_API_TOKEN === TOKEN)).toBe(true);
    for (const c of t.calls) {
      expect(c.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
      expect(c.args.join(' ')).not.toContain(TOKEN);
      expect(c.input ?? '').not.toContain(TOKEN);
    }
    expect(t.ctx.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(text(t.out) + text(t.err)).not.toContain(TOKEN);
    for (const f of walk(root)) expect(readFileSync(f).includes(TOKEN), f).toBe(false);
  });

  it('does not leak an outer `npx -p` package list into the nested npx', async () => {
    const t = setupDeploy({
      env: {
        PATH: '/usr/bin',
        npm_config_package: '@daintreehq/decisions-cli',
        npm_config_call: 'x',
      },
    });
    await deploy(t.ctx, {}, {}, t.deps);
    for (const c of t.calls) {
      expect(c.env.npm_config_package).toBeUndefined();
      expect(c.env.npm_config_call).toBeUndefined();
      expect(c.env.PATH).toBe('/usr/bin');
    }
  });

  it('uses a token that is already in the environment without a browser login', async () => {
    const t = setupDeploy({ env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(t.prompts).toEqual([]);
    expect(t.calls.map((c) => c.args[2])).not.toContain('login');
  });

  it('fails clearly when Wrangler cannot run, and never generates a secret', async () => {
    let generated = false;
    const t = setupDeploy({ wrangler: { failOn: '--version' } });
    t.deps.generateSecret = () => ((generated = true), SECRET);
    await expect(deploy(t.ctx, {}, {}, t.deps)).rejects.toThrow(/Wrangler/);
    expect(generated).toBe(false);
  });

  it('fails when the bucket cannot be created', async () => {
    const t = setupDeploy({ wrangler: { failOn: 'r2 bucket create' } });
    await expect(deploy(t.ctx, {}, {}, t.deps)).rejects.toThrow(/R2/);
    expect(t.calls.map((c) => c.args[2])).not.toContain('deploy');
  });

  it('does not reset the claim secret of a relay that is already claimed', async () => {
    const t = setupDeploy({ claimed: true });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(t.calls.map((c) => c.args[2])).not.toContain('secret');
    expect(text(t.out)).not.toContain(SECRET);
    expect(text(t.out)).toMatch(/already claimed/);
  });

  it('still shows the secret when the health check fails after it was set', async () => {
    const t = setupDeploy();
    const base = t.ctx.fetch;
    t.ctx.fetch = (async (u: unknown, init?: RequestInit) =>
      new URL(String(u)).pathname === '/health'
        ? new Response('down', { status: 503 })
        : base(u as string, init)) as typeof fetch;
    await expect(deploy(t.ctx, {}, {}, t.deps)).rejects.toThrow(/health check/);
    expect(count(text(t.out), SECRET)).toBe(1);
    expect(text(t.out)).toMatch(/with problems/);
  });

  it('shows the secret when Wrangler errors while setting it, without echoing it in the error', async () => {
    const t = setupDeploy({ wrangler: { failOn: 'secret put', echoInputOnFail: true } });
    const e = (await deploy(t.ctx, {}, {}, t.deps).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(CliError);
    expect(e.message).toMatch(/may or may not have been set/);
    expect(e.message).toContain('[redacted]');
    expect(e.message).not.toContain(SECRET);
    expect(count(text(t.out), SECRET)).toBe(1);
    expect(text(t.err)).not.toContain(SECRET);
  });

  it('keeps Wrangler from logging request bodies, and writes no Wrangler log for the secret', async () => {
    const t = setupDeploy({ env: { PATH: '/usr/bin', WRANGLER_LOG_SANITIZE: 'false' } });
    await deploy(t.ctx, {}, {}, t.deps);
    for (const c of t.calls) expect(c.env.WRANGLER_LOG_SANITIZE).toBe('true');
    expect(t.calls.find((c) => c.args.includes('secret'))!.env.WRANGLER_WRITE_LOGS).toBe('false');
  });

  it('says so when it could not tell whether the relay was already claimed', async () => {
    const t = setupDeploy();
    const base = t.ctx.fetch;
    t.ctx.fetch = (async (u: unknown, init?: RequestInit) => {
      if (new URL(String(u)).pathname === '/api/v1/info') throw new TypeError('fetch failed');
      return base(u as string, init);
    }) as typeof fetch;
    await deploy(t.ctx, {}, {}, t.deps).catch(() => {});
    expect(count(text(t.out), SECRET)).toBe(1);
    expect(text(t.out)).toMatch(/could not be checked whether it was already claimed/);
  });

  it('still shows the secret when no workers.dev URL was printed', async () => {
    const t = setupDeploy({ wrangler: { deployOutput: 'Deployed with custom routes only' } });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(count(text(t.out), SECRET)).toBe(1);
    expect(text(t.out)).toMatch(/Worker URL/);
  });

  it('--claim claims the relay from this machine with the in-memory secret', async () => {
    const t = setupDeploy();
    await deploy(t.ctx, {}, { claim: true, label: 'Laptop' }, t.deps);
    expect(t.claimCalls).toHaveLength(1);
    expect((t.claimCalls[0] as { claim_secret: string }).claim_secret).toBe(SECRET);
    const o = text(t.out);
    expect(o).toContain(`Claimed ${URL_}`);
    expect(o).not.toContain(SECRET);
    for (const f of [...walk(root), ...walk(t.home)]) {
      expect(readFileSync(f).includes(SECRET), f).toBe(false);
    }
  });

  it('--claim exits non-zero, and still shows the secret, when the claim fails', async () => {
    const t = setupDeploy();
    const base = t.ctx.fetch;
    t.ctx.fetch = (async (u: unknown, init?: RequestInit) =>
      new URL(String(u)).pathname === '/api/v1/setup/claim'
        ? new Response(JSON.stringify({ code: 'already_claimed', message: 'no' }), { status: 409 })
        : base(u as string, init)) as typeof fetch;
    await expect(deploy(t.ctx, {}, { claim: true }, t.deps)).rejects.toThrow(/claiming/);
    expect(count(text(t.out), SECRET)).toBe(1);
  });

  it('--claim refuses up front when this machine already has a claimed identity', async () => {
    const t = setupDeploy();
    await deploy(t.ctx, {}, { claim: true }, t.deps); // claims and stores an identity in t.home
    const again = setupDeploy();
    again.ctx.home = t.home;
    await expect(deploy(again.ctx, {}, { claim: true }, again.deps)).rejects.toThrow(
      /already has a Decisions identity/,
    );
    expect(again.calls).toEqual([]);
  });

  it('--outdir writes the verified, deployable bundle and stops', async () => {
    const t = setupDeploy();
    const dest = join(fresh('outdir'), 'relay');
    await deploy(t.ctx, {}, { outdir: dest, name: 'mine', bucket: 'my-bucket' }, t.deps);
    expect(t.calls).toEqual([]);
    expect(JSON.parse(readFileSync(join(dest, 'wrangler.json'), 'utf8'))).toMatchObject({
      name: 'mine',
      r2_buckets: [{ bucket_name: 'my-bucket' }],
    });
    expect(text(t.out)).toContain(`wrangler@${WRANGLER} deploy --config wrangler.json`);
  });

  it('--outdir cannot be combined with --dry-run, which writes nothing', async () => {
    const t = setupDeploy();
    const dest = join(fresh('outdir'), 'relay');
    await expect(deploy(t.ctx, {}, { outdir: dest, dryRun: true }, t.deps)).rejects.toThrow(
      /cannot be combined/,
    );
    expect(existsSync(dest)).toBe(false);
  });

  it('--outdir refuses a non-empty directory', async () => {
    const t = setupDeploy();
    const dest = fresh('outdir');
    writeFileSync(join(dest, 'keep'), 'x');
    await expect(deploy(t.ctx, {}, { outdir: dest }, t.deps)).rejects.toThrow(/not empty/);
  });
});

describe('the real spawner', () => {
  it('delivers input on stdin, not argv, and captures the output', async () => {
    const r = await nodeSpawner({
      cmd: process.execPath,
      args: [
        '-e',
        'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(s.length)))',
      ],
      cwd: root,
      env: process.env,
      input: SECRET + '\n',
      capture: true,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(String(SECRET.length + 1));
  });

  it('survives a child that exits without reading its input', async () => {
    const r = await nodeSpawner({
      cmd: process.execPath,
      args: ['-e', 'process.exit(3)'],
      cwd: root,
      env: process.env,
      input: 'x'.repeat(1 << 20),
      capture: true,
    });
    expect(r.status).toBe(3);
  });

  it('refuses shell metacharacters when a shell has to be used (Windows npx)', async () => {
    await expect(
      nodeSpawner(
        { cmd: 'npx', args: ['wrangler', 'a&b'], cwd: root, env: {}, capture: true },
        'win32',
      ),
    ).rejects.toThrow(/unsafe/);
  });
});

describe('decisions deploy, guided at a terminal', () => {
  const XAI = 'xai-' + 'k'.repeat(40);
  const OPENAI = 'sk-' + 'o'.repeat(40);
  const ANTHROPIC = 'sk-ant-' + 'a'.repeat(40);
  const BAD = 'sk-wrong-' + 'w'.repeat(30);
  const KEYS = [XAI, OPENAI, ANTHROPIC];
  const MUTATING = /^(r2 |deploy|secret )/;
  const subs = (t: { calls: SpawnRequest[] }) => t.calls.map((c) => c.args.slice(2).join(' '));

  /** Every value in `values` stays out of argv, env, files, output and errors. */
  function expectNowhere(
    t: ReturnType<typeof setupDeploy>,
    values: string[],
    opts: { input?: boolean } = {},
  ) {
    for (const v of values) {
      for (const c of t.calls) {
        expect(c.args.join(' ')).not.toContain(v);
        expect(JSON.stringify(c.env)).not.toContain(v);
        if (!opts.input) expect(c.input ?? '').not.toContain(v);
      }
      for (const f of [...walk(root), ...walk(t.home)]) {
        expect(readFileSync(f).includes(v), f).toBe(false);
      }
      expect(text(t.out) + text(t.err)).not.toContain(v);
    }
  }

  it('asks everything first, then deploys with exactly the chosen keys and model', async () => {
    const providers: FakeProviders = { goodKeys: KEYS, calls: [] };
    const t = setupDeploy({
      interactive: true,
      providers,
      // name, bucket, dictation?, provider, key, cleanup?, provider, model, key, confirm
      answers: ['', '', 'y', '1', XAI, 'y', '1', '2', ANTHROPIC, 'y'],
    });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(subs(t)).toEqual([
      '--version',
      'whoami --json',
      'login',
      'whoami --json',
      'r2 bucket create daintree-decisions',
      'deploy --config wrangler.json',
      'secret put CLAIM_SECRET --name daintree-decisions',
      'secret put XAI_API_KEY --name daintree-decisions',
      'secret put ANTHROPIC_API_KEY --name daintree-decisions',
    ]);
    // Keys are asked for with hidden input and reach Wrangler only on stdin.
    expect(t.secretPrompts).toEqual([
      expect.stringMatching(/xAI .*API key/),
      expect.stringMatching(/Anthropic API key/),
    ]);
    const put = (s: string) => t.calls.find((c) => c.args.includes(s))!;
    expect(put('XAI_API_KEY').input).toBe(XAI + '\n');
    expect(put('ANTHROPIC_API_KEY').input).toBe(ANTHROPIC + '\n');
    for (const s of ['XAI_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(put(s).env.WRANGLER_WRITE_LOGS).toBe('false');
      expect(put(s).env.WRANGLER_LOG_SANITIZE).toBe('true');
    }
    expectNowhere(t, [XAI, ANTHROPIC], { input: true });
    for (const c of t.calls.filter((c) => !c.args.includes('secret')))
      for (const k of KEYS) expect(c.input ?? '').not.toContain(k);
    // The chosen model is deployed; the other provider's stays as the bundle has it.
    const deployed = t.calls.find((c) => c.args.includes('deploy'))!;
    expect(deployed.configAtCall).toMatchObject({
      vars: { ANTHROPIC_CORRECTION_MODEL: 'claude-sonnet-5-5' },
    });
    expect((deployed.configAtCall as { vars: object }).vars).not.toHaveProperty(
      'OPENAI_CORRECTION_MODEL',
    );
    // Each key was checked with its provider at its own step, never following a redirect.
    expect(providers.calls!.map((c) => c.host)).toEqual(['api.x.ai', 'api.anthropic.com']);
    expect(providers.calls!.every((c) => c.redirect === 'manual')).toBe(true);
    const o = text(t.out);
    expect(o).toMatch(/Cloudflare account: Someone \(a1b2c3d4/);
    expect(o).toMatch(/Cost:/);
    expect(count(o, "isn't end-to-end encrypted")).toBe(2);
    expect(o).toMatch(/Dictation +xAI \(Grok\)/);
    expect(o).toMatch(/Transcript cleanup +Anthropic, claude-sonnet-5-5/);
    expect(o).toMatch(/xAI key +present/);
    expect(o).toMatch(/OpenAI key +absent/);
    expect(count(o, SECRET)).toBe(1);
    expect(walk(t.tmpRoot)).toEqual([]);
  });

  it('changes nothing in the account when the summary is not confirmed', async () => {
    const t = setupDeploy({
      interactive: true,
      providers: { goodKeys: KEYS },
      answers: ['', '', 'y', '2', OPENAI, 'n', 'n'],
    });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(subs(t).filter((s) => MUTATING.test(s))).toEqual([]);
    expect(text(t.out)).toMatch(/Cancelled: nothing in your Cloudflare account was changed/);
    expect(text(t.out)).not.toContain(SECRET);
    expectNowhere(t, [OPENAI]);
    expect(walk(t.tmpRoot)).toEqual([]);
  });

  it('is cancelled by default: an empty answer to the summary deploys nothing', async () => {
    const t = setupDeploy({ interactive: true, answers: [] });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(subs(t).filter((s) => MUTATING.test(s))).toEqual([]);
    expect(text(t.out)).toMatch(/Dictation +off/);
    expect(text(t.out)).toMatch(/Cancelled/);
  });

  it('a Ctrl-C at any question leaves the account untouched and cleans up', async () => {
    const t = setupDeploy({ interactive: true, answers: ['', ''] });
    let asked = 0;
    const prompt = t.ctx.prompt;
    t.ctx.prompt = async (q, opts) => {
      if (++asked === 3) throw new CliError('cancelled', 130);
      return prompt(q, opts);
    };
    await expect(deploy(t.ctx, {}, {}, t.deps)).rejects.toMatchObject({ exitCode: 130 });
    expect(subs(t).filter((s) => MUTATING.test(s))).toEqual([]);
    expect(walk(t.tmpRoot)).toEqual([]);
  });

  it('reports a key the provider rejects at that step, and takes a corrected one', async () => {
    const t = setupDeploy({
      interactive: true,
      providers: { goodKeys: KEYS },
      answers: ['', '', 'y', 'xai', BAD, XAI, 'n', 'y'],
    });
    await deploy(t.ctx, {}, {}, t.deps);
    const o = text(t.out);
    const rejected = o.indexOf('rejected that key (HTTP 401)');
    expect(rejected).toBeGreaterThan(-1);
    expect(rejected).toBeLessThan(o.indexOf('Summary'));
    expect(t.calls.find((c) => c.args.includes('XAI_API_KEY'))!.input).toBe(XAI + '\n');
    expectNowhere(t, [BAD]);
  });

  it('leaves a feature off when no key is entered after a rejection', async () => {
    const t = setupDeploy({
      interactive: true,
      providers: { goodKeys: KEYS },
      answers: ['', '', 'y', '1', BAD, '', 'n', 'y'],
    });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(text(t.out)).toMatch(/Dictation +off/);
    expect(subs(t).filter((s) => s.startsWith('secret put'))).toEqual([
      'secret put CLAIM_SECRET --name daintree-decisions',
    ]);
  });

  it('keeps a key it could not check only when the user says so', async () => {
    const t = setupDeploy({
      interactive: true,
      providers: { down: true },
      answers: ['', '', 'y', '1', XAI, 'y', 'n', 'y'],
    });
    await deploy(t.ctx, {}, {}, t.deps);
    const o = text(t.out);
    expect(o).toMatch(/Could not check the key with xAI \(Grok\) \(network error\)/);
    expect(o).not.toMatch(/ENOTFOUND/);
    expect(o).toMatch(/xAI key +present \(not checked\)/);
    expect(subs(t)).toContain('secret put XAI_API_KEY --name daintree-decisions');
  });

  it('uses one OpenAI key for both features and sets the OpenAI cleanup model', async () => {
    const providers: FakeProviders = { goodKeys: KEYS, calls: [] };
    const t = setupDeploy({
      interactive: true,
      providers,
      // OpenAI is the default cleanup provider once dictation uses it; the key is not asked again.
      answers: ['', '', 'y', '2', OPENAI, 'y', '', '2', 'y'],
    });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(t.secretPrompts).toHaveLength(1);
    expect(providers.calls).toHaveLength(1);
    expect(subs(t).filter((s) => s.startsWith('secret put'))).toEqual([
      'secret put CLAIM_SECRET --name daintree-decisions',
      'secret put OPENAI_API_KEY --name daintree-decisions',
    ]);
    const deployed = t.calls.find((c) => c.args.includes('deploy'))!;
    expect(deployed.configAtCall).toMatchObject({
      vars: { OPENAI_CORRECTION_MODEL: 'gpt-6-luna' },
    });
    expect(text(t.out)).toMatch(/Using the OpenAI key entered for dictation/);
  });

  it('lets the user change the names, asking again for an invalid one', async () => {
    const t = setupDeploy({
      interactive: true,
      answers: ['Bad Name', 'my-relay', 'my-files', 'n', 'n', 'y'],
    });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(text(t.out)).toMatch(/"Bad Name" is not valid/);
    expect(subs(t)).toEqual(
      expect.arrayContaining([
        'r2 bucket create my-files',
        'secret put CLAIM_SECRET --name my-relay',
      ]),
    );
    expect(t.calls.find((c) => c.args.includes('deploy'))!.configAtCall).toMatchObject({
      name: 'my-relay',
      r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'my-files' }],
    });
  });

  it('asks which account to use when the login has several, and deploys there', async () => {
    const other = 'f0e1d2c3'.repeat(4);
    const t = setupDeploy({
      interactive: true,
      wrangler: {
        loggedIn: true,
        accounts: [
          { id: ACCOUNT, name: 'Personal' },
          { id: other, name: 'Work' },
        ],
      },
      answers: ['2', '', '', 'n', 'n', 'y'],
    });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(text(t.out)).toMatch(/Cloudflare account +Work \(f0e1d2c3/);
    const after = t.calls.filter((c) => MUTATING.test(c.args.slice(2).join(' ')));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c.env.CLOUDFLARE_ACCOUNT_ID === other)).toBe(true);
  });

  it('takes the account from --account-id without asking', async () => {
    const other = 'f0e1d2c3'.repeat(4);
    const t = setupDeploy({
      interactive: true,
      wrangler: {
        loggedIn: true,
        accounts: [
          { id: ACCOUNT, name: 'Personal' },
          { id: other, name: 'Work' },
        ],
      },
      answers: ['', '', 'n', 'n', 'y'],
    });
    await deploy(t.ctx, {}, { accountId: other }, t.deps);
    expect(t.prompts.some((q) => /Account/.test(q))).toBe(false);
    expect(text(t.out)).toMatch(/Cloudflare account: Work/);
  });

  it('sets the chosen keys on an already claimed relay without touching its claim secret', async () => {
    const t = setupDeploy({
      interactive: true,
      claimed: true,
      providers: { goodKeys: KEYS },
      answers: ['', '', 'y', '1', XAI, 'n', 'y'],
    });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(subs(t).filter((s) => s.startsWith('secret put'))).toEqual([
      'secret put XAI_API_KEY --name daintree-decisions',
    ]);
    expect(text(t.out)).not.toContain(SECRET);
  });

  it('still shows the claim secret when setting a key fails', async () => {
    const t = setupDeploy({
      interactive: true,
      providers: { goodKeys: KEYS },
      wrangler: { failOn: 'secret put XAI_API_KEY', echoInputOnFail: true },
      answers: ['', '', 'y', '1', XAI, 'n', 'y'],
    });
    await expect(deploy(t.ctx, {}, {}, t.deps)).rejects.toThrow(/XAI_API_KEY/);
    expect(count(text(t.out), SECRET)).toBe(1);
    expect(text(t.out)).toMatch(/with problems/);
    expectNowhere(t, [XAI], { input: true });
  });

  it('asks nothing for --dry-run, even at a terminal', async () => {
    const t = setupDeploy({ interactive: true });
    await deploy(t.ctx, {}, { dryRun: true }, t.deps);
    expect(t.prompts).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('asks nothing without a terminal, and runs the steps as before', async () => {
    const t = setupDeploy({ interactive: false });
    await deploy(t.ctx, {}, {}, t.deps);
    expect(t.prompts).toEqual([]);
    expect(subs(t)[1]).toBe('whoami');
  });

  it('reads accounts from `wrangler whoami --json`, ignoring anything malformed', () => {
    expect(
      accountsFromWhoami(
        'warning banner\n' +
          JSON.stringify({
            loggedIn: true,
            accounts: [{ id: ACCOUNT, name: 'A' }, { id: 'nope', name: 'B' }, null, { id: 7 }],
          }),
      ),
    ).toEqual([{ id: ACCOUNT, name: 'A' }]);
    expect(accountsFromWhoami('not json')).toEqual([]);
    expect(accountsFromWhoami('{"loggedIn":false}')).toEqual([]);
  });
});
