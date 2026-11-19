#!/usr/bin/env node
/**
 * Checks a released version of the packages and its relay against the current ones, in both directions, with real
 * relays (`wrangler dev`), real CLIs and the libraries as a host app uses them.
 *
 * The old side is a release from npm (`--old`, default 0.8.0) and the relay bundle attached to its GitHub release,
 * checked against the release's SHA256SUMS and against the manifest of the npm relay package of the same version.
 * The new side is a packed build of this tree (`--new packed`, the default, before a release) or a published version
 * (`--new 0.9.0`, the smoke check after it). Each side is installed with npm into its own scratch project outside the
 * workspace, and its code only ever runs from there: through its installed `decisions` CLI, or as a child process
 * (actor.mjs) whose imports resolve to that project's node_modules.
 *
 * 1. The old desktop against the new relay. The old CLI claims the relay as the owner desktop, asks, and gets the
 *    answer and the decline a simulated phone gives. A new Remote Host enrolled by the old CLI asks an advisory
 *    question and then an ordinary one, while the old library bridge is connected: the old protocol's own reader
 *    refuses the advisory question and reads the ordinary one, and the bridge goes on asking and receiving answers
 *    and declines, with no error and no request the relay refuses.
 * 2. The new desktop against the old relay. The new CLI asks, gets an answer and a decline, and finds both again
 *    with `get` and `wait`. Where the old relay lacks advice, an advisory ask is refused as
 *    `not_supported: relay-unsupported` by the CLI and by the library, and asks nothing; where it lacks agent-stopped
 *    pushes, a request reports `unsupported`. The library's ordinary questions are answered and declined.
 * 3. An old host with open questions moves to the new version, then its relay does. The new host reads the old
 *    host's state directory: questions asked before the upgrade are answered, and a reopen made before it keeps its
 *    signed deadline. The relay is then replaced by the new one on the same storage: a question asked before both
 *    upgrades expires there, is reopened and is answered in its new round.
 * 4. A phone with the old app still loaded, in Chromium, while its relay moves to the new version. The released app
 *    pairs with the new desktop and subscribes to pushes on the old relay; the relay is then replaced on the same
 *    storage while the page stays open. The cached app answers and declines ordinary questions, an advisory ask is
 *    refused because no paired device can show it, and an agent-stopped push finds nothing it may go to. The phone
 *    then updates in place: while the new page still runs under the old service worker nothing declares the push, and
 *    once the new worker takes over the same subscription declares it and the push goes to it. The questions from
 *    before the update show as they ended, and one is reopened and answered in the new app. This is the upgrade from a
 *    release that has neither advice nor agent-stopped pushes (0.8.0), and it is skipped for an older side that has
 *    either.
 *
 * Needs the network (npm and GitHub), Node 22.15 or later, and the workspace's dependencies (it runs the workspace's
 * Wrangler, and scenario 4 the e2e package's playwright-core with its Chromium, or `E2E_CHROMIUM`). It takes a few
 * minutes: scenario 3 waits for a real deadline.
 *
 * Usage: node tools/compat-check/compat-check.mjs [--old <version>] [--new packed|<version>] [--no-build]
 *          [--only <1,2,3,4>] [--port <base>] [--keep]
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPackages, installConsumer, packPackage } from '../pack-check/pack.mjs';
import { REPOSITORY, isValidVersion, listWorkspace } from '../release/workspace.mjs';
import {
  PUSH_HOST,
  entryScript,
  judgeDeclarations,
  loadChromium,
  phoneFixture,
  pushSubscription,
} from './phone-app.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');
const CLAIM_SECRET = 'compat-check-claim-secret-0123456789abcdef';
const ADVISORY = 'advisory-deadlines-v1';
const AGENT_STOPPED = 'agent-stopped-push-v1';
/** How far ahead scenario 3's short question is due: past the old client's one-minute floor, and past both upgrades. */
const SHORT_DEADLINE_MS = 150_000;

function parseArgs(argv) {
  const o = { old: '0.8.0', new: 'packed', build: true, keep: false, only: null, port: 8870 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--old') o.old = value();
    else if (a === '--new') o.new = value();
    else if (a === '--no-build') o.build = false;
    else if (a === '--keep') o.keep = true;
    else if (a === '--only') {
      const picked = value()
        .split(',')
        .map((s) => s.trim());
      if (picked.some((s) => !/^[1-4]$/.test(s)))
        throw new Error('--only takes scenario numbers from 1 to 4, such as 1,3');
      o.only = new Set(picked.map(Number));
    } else if (a === '--port') o.port = Number(value());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!isValidVersion(o.old)) throw new Error(`--old ${o.old} is not a version`);
  if (o.new !== 'packed' && !isValidVersion(o.new))
    throw new Error(`--new must be "packed" or a version, got ${o.new}`);
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 60_000)
    throw new Error('--port must be a port number from 1024 to 60000');
  return o;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`compat-check: ${e.message}`);
  process.exit(2);
}
const failures = [];
let current = 'setup';
const step = (msg) => console.log(`\n> ${msg}`);
const ok = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => {
  failures.push(`[${current}] ${msg}`);
  console.log(`  FAIL ${msg}`);
};
/** Records a failed expectation and goes on. */
const check = (cond, msg, detail) => (cond ? ok(msg) : fail(detail ? `${msg}: ${detail}` : msg));
/** Stops the scenario: what follows depends on it. */
function must(cond, msg, detail) {
  if (cond) return ok(msg);
  throw new Error(detail ? `${msg}: ${detail}` : msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(300);
  }
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const show = (v) => JSON.stringify(v)?.slice(0, 600);

const work = mkdtempSync(join(tmpdir(), 'decisions-compat-check-'));
const logs = join(work, 'logs');
mkdirSync(logs);
const scratch = (name) => {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/* ---------------------------------------------------------------- artifacts */

/** Installs one side into its own scratch project; `spec` is `packed` or a published version. */
function prepareSide(label, spec) {
  const dir = join(work, label);
  const published = listWorkspace(ROOT).filter((p) => !p.private);
  let deps;
  let from;
  if (spec === 'packed') {
    if (opts.build) {
      step('Building the packages of this tree');
      buildPackages(ROOT);
    }
    const tarballs = scratch('tarballs');
    deps = Object.fromEntries(
      published.map((p) => [p.name, `file:${packPackage(p.dir, tarballs, ROOT)}`]),
    );
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean).length;
    from = `packed from ${head}${dirty ? ` with ${dirty} uncommitted changes` : ''}`;
  } else {
    deps = Object.fromEntries(published.map((p) => [p.name, spec]));
    from = `npm ${spec}`;
  }
  step(`Installing the ${label} side (${from}) into ${dir}`);
  installConsumer(dir, deps, { name: `decisions-compat-${label}` });
  copyFileSync(join(import.meta.dirname, 'actor.mjs'), join(dir, 'actor.mjs'));
  const versions = Object.fromEntries(
    published.map((p) => [
      p.name,
      JSON.parse(readFileSync(join(dir, 'node_modules', p.name, 'package.json'), 'utf8')).version,
    ]),
  );
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const integrity = Object.fromEntries(
    published.map((p) => [p.name, lock.packages?.[`node_modules/${p.name}`]?.integrity ?? null]),
  );
  console.log(`  ${label}: ${Object.values(versions).join(', ')} (${from})`);
  return {
    label,
    from,
    dir,
    versions,
    integrity,
    // Through the `bin` link npm made, so a package whose `bin` points nowhere fails here.
    bin: realpathSync(join(dir, 'node_modules/.bin/decisions')),
  };
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, bytes);
  return bytes;
}

/**
 * The relay bundle attached to the GitHub release of `version`: both archives checked against the release's
 * SHA256SUMS, unpacked, and every file checked against the manifest of the npm relay package of the same version,
 * whose Wrangler config it runs with (the release ships none).
 */
async function stageReleasedRelay(version, side) {
  const dir = scratch(`relay-${side.label}`);
  const downloads = scratch(`release-v${version}`);
  const base = `https://github.com/${REPOSITORY}/releases/download/v${version}`;
  step(`Downloading the relay bundle of the v${version} GitHub release`);
  const sums = new Map(
    (await download(`${base}/SHA256SUMS`, join(downloads, 'SHA256SUMS')))
      .toString('utf8')
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length === 2)
      .map(([hash, name]) => [name.replace(/^\*/, ''), hash]),
  );
  for (const [archive, into] of [
    [`decisions-worker-v${version}.tar.gz`, dir],
    [`decisions-app-v${version}.tar.gz`, join(dir, 'app')],
  ]) {
    const bytes = await download(`${base}/${archive}`, join(downloads, archive));
    must(sums.get(archive) === sha256(bytes), `${archive} matches SHA256SUMS`);
    mkdirSync(into, { recursive: true });
    execFileSync('tar', ['-xzf', join(downloads, archive), '-C', into]);
  }
  const npmRelay = join(side.dir, 'node_modules/@daintreehq/decisions-relay/dist');
  copyFileSync(join(npmRelay, 'wrangler.json'), join(dir, 'wrangler.json'));
  const manifest = JSON.parse(readFileSync(join(npmRelay, 'manifest.json'), 'utf8'));
  // The release job bundles the Worker from another directory, so its source map names the sources by other relative
  // paths; everything that runs must be byte for byte the same.
  const compared = Object.entries(manifest.files).filter(([rel]) => !rel.endsWith('.map'));
  const differ = compared.filter(
    ([rel, want]) =>
      !existsSync(join(dir, rel)) || sha256(readFileSync(join(dir, rel))) !== want.sha256,
  );
  must(
    differ.length === 0,
    `the release's Worker and app are the ones @daintreehq/decisions-relay@${version} deploys (${compared.length} files)`,
    differ.map(([rel]) => rel).join(', '),
  );
  // And nothing more: Wrangler's README beside the bundled Worker is the only file the npm package does not ship.
  const maps = Object.keys(manifest.files).filter((rel) => rel.endsWith('.map'));
  must(
    maps.every((rel) => existsSync(join(dir, rel))),
    `the release has the source maps the npm relay package has`,
    maps.filter((rel) => !existsSync(join(dir, rel))).join(', '),
  );
  const listed = new Set([...Object.keys(manifest.files), 'wrangler.json', 'worker/README.md']);
  const extra = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .filter((rel) => !listed.has(rel));
  must(
    extra.length === 0,
    `the release ships no file the npm relay package lacks`,
    extra.join(', '),
  );
  return dir;
}

/** The relay the installed CLI deploys, staged by `decisions deploy --outdir` (verified against its pinned digest). */
function stageInstalledRelay(side) {
  const dir = join(work, `relay-${side.label}`);
  execFileSync(process.execPath, [side.bin, 'deploy', '--outdir', dir], {
    cwd: side.dir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return dir;
}

/* ---------------------------------------------------------------- processes */

const running = new Set();
/** Set once SIGINT or SIGTERM arrives: nothing is started after it, so the shutdown sees every process. */
let shuttingDown = false;
const mayStart = (what) => {
  if (shuttingDown) throw new Error(`stopping: ${what} not started`);
};

/** Whether anything accepts a connection on the loopback port. */
const answers = (port) =>
  new Promise((done) => {
    const s = connect({ port, host: '127.0.0.1' });
    s.setTimeout(2000);
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('timeout', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
  });

/**
 * `wrangler dev` on a staged relay, with its own storage; `persist` may be reused to upgrade in place. Its ports must
 * be free first (a relay just stopped may hold them for a moment), so whatever answers `/health` afterwards is this one.
 * `vars` are further Worker variables, beside the claim secret.
 */
async function startRelay(dir, port, persist, label, vars = {}) {
  await until(
    async () => !(await answers(port)) && !(await answers(port + 1000)),
    20_000,
    `ports ${port} and ${port + 1000} to be free for relay ${label} (try another --port)`,
  );
  mayStart(`relay ${label}`);
  const log = createWriteStream(join(logs, `relay-${label}.log`));
  const child = spawn(
    WRANGLER,
    [
      'dev',
      '--config',
      'wrangler.json',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--inspector-port',
      String(port + 1000),
      '--var',
      `CLAIM_SECRET:${CLAIM_SECRET}`,
      ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
      '--persist-to',
      persist,
    ],
    {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exited = false;
  // Settles when Wrangler exits, or when it never started (a spawn error with no process).
  const gone = new Promise((done) => {
    child.once('exit', done);
    child.on('error', (e) => {
      log.write(`\nspawn error: ${e.message}\n`);
      if (child.pid === undefined) done();
    });
  }).then(() => (exited = true));
  let stopping = null;
  // The whole process group: Wrangler and the workerd it started.
  const group = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* gone */
    }
  };
  const stop = () =>
    (stopping ??= (async () => {
      running.delete(handle);
      if (!exited) {
        group('SIGTERM');
        setTimeout(() => group('SIGKILL'), 5000).unref();
        await gone;
      }
      group('SIGKILL');
    })());
  const handle = { stop };
  running.add(handle);
  const origin = `http://127.0.0.1:${port}`;
  await until(
    async () => {
      if (exited) throw new Error(`wrangler dev (${label}) exited early`);
      return fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) })
        .then((r) => r.ok)
        .catch(() => false);
    },
    90_000,
    `relay ${label} to start (log: ${join(logs, `relay-${label}.log`)})`,
  );
  return { origin, label, stop };
}

async function info(origin) {
  return (await fetch(`${origin}/api/v1/info`, { signal: AbortSignal.timeout(10_000) })).json();
}

/** One side's actor.mjs as a child process, answering `call(op, args)`. */
function startActor(side, label) {
  mayStart(`actor ${label}`);
  const log = createWriteStream(join(logs, `actor-${label}.log`));
  const child = spawn(process.execPath, ['actor.mjs'], {
    cwd: side.dir,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const pending = new Map();
  let next = 1;
  child.on('message', ({ id, ok: good, value, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (good) p.resolve(value);
    else p.reject(new Error(`${label}: ${error.code ? `${error.code}: ` : ''}${error.message}`));
  });
  let exited = false;
  let markGone;
  const gone = new Promise((r) => (markGone = r));
  const ended = (why) => {
    if (exited) return;
    exited = true;
    for (const p of pending.values()) p.reject(new Error(`${label} ${why}`));
    pending.clear();
    markGone();
  };
  child.on('exit', (code, signal) => ended(`exited (${code ?? signal})`));
  // A send on a channel that just closed is reported here (and rejected by `exit`); a spawn that failed never exits.
  child.on('error', (e) => {
    log.write(`\nactor error: ${e.message}\n`);
    if (child.pid === undefined) ended(`did not start: ${e.message}`);
  });
  const call = (op, args = {}, timeoutMs = 60_000) =>
    new Promise((resolve_, reject) => {
      if (exited || !child.connected) return reject(new Error(`${label} is not running (${op})`));
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${label}.${op} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve_(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.send({ id, op, args }, (e) => {
        if (!e) return;
        pending.get(id)?.reject(e);
        pending.delete(id);
      });
    });
  let stopping = null;
  // Disconnecting lets the actor stop its bridges and close its stores before it exits.
  const stop = () =>
    (stopping ??= (async () => {
      running.delete(handle);
      if (exited) return;
      if (child.connected) child.disconnect();
      else child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
      await gone;
    })());
  const handle = { stop };
  running.add(handle);
  return { call, stop, label };
}

/**
 * Chromium for the phone app, owned like every other process: the handle is in `running` before the launch is awaited,
 * so a stop that comes while it starts still closes it.
 */
function startBrowser(label) {
  mayStart(`browser ${label}`);
  const { chromium, executablePath } = loadChromium();
  // The runner owns the signals: it stops every relay, actor and browser itself (`onSignal`).
  const launched = chromium.launch({
    executablePath,
    headless: true,
    timeout: 90_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  launched.catch(() => undefined);
  let stopping = null;
  const stop = () =>
    (stopping ??= (async () => {
      running.delete(handle);
      const browser = await launched.catch(() => null);
      await browser?.close().catch(() => undefined);
    })());
  const handle = { stop };
  running.add(handle);
  return { launched, stop };
}

let cliRuns = 0;

/**
 * Runs one side's `decisions` CLI on a state directory; `onLine` sees each line of stdout as it comes. The run is
 * stopped with its scenario if it is still going, and its output is kept in the logs.
 */
function cli(side, home, argv, { env = {}, timeoutMs = 120_000, onLine } = {}) {
  if (shuttingDown)
    return Promise.reject(new Error(`stopping: decisions ${argv.join(' ')} not run`));
  const n = ++cliRuns;
  return new Promise((done) => {
    const child = spawn(process.execPath, [side.bin, '--home', home, ...argv], {
      cwd: side.dir,
      env: { ...process.env, DECISIONS_HOME: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let closed = false;
    const kill = () => {
      if (closed) return;
      child.kill('SIGTERM');
      setTimeout(() => !closed && child.kill('SIGKILL'), 5000).unref();
    };
    const waiting = [];
    const handle = {
      stop: () => (kill(), new Promise((r) => (closed ? r() : waiting.push(r)))),
    };
    running.add(handle);
    // A CLI that could not be started never closes: finish it here.
    child.on('error', (e) => {
      if (child.pid !== undefined) return;
      stderr += `\nspawn error: ${e.message}`;
      finish(null, null);
    });
    let stdout = '';
    let stderr = '';
    let partial = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      partial += d;
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const l of lines) if (l.trim()) onLine?.(l);
    });
    child.stderr.on('data', (d) => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on('close', (code, signal) => finish(code, signal));
    function finish(code, signal) {
      if (closed) return;
      clearTimeout(timer);
      closed = true;
      running.delete(handle);
      for (const r of waiting.splice(0)) r();
      try {
        writeFileSync(
          join(
            logs,
            `cli-${String(n).padStart(2, '0')}-${side.label}-${argv.find((a) => !a.startsWith('-'))}.log`,
          ),
          `$ decisions --home ${home} ${argv.join(' ')}\nexit ${code ?? signal}${timedOut ? ' (timed out)' : ''}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`,
        );
      } catch (e) {
        console.log(`  (could not keep the log of CLI run ${n}: ${e.message})`);
      }
      // One pretty-printed object (`setup`, `host`, `devices`, `get`), or one object per line (`ask`, `wait`).
      let json;
      try {
        json = [JSON.parse(stdout)];
      } catch {
        json = stdout
          .split('\n')
          .filter((l) => l.trim().startsWith('{'))
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }
      done({ code, signal, timedOut, stdout, stderr, json, last: json.at(-1) ?? null });
    }
  });
}
const tail = (r) =>
  `exit ${r.code}${r.timedOut ? ' (timed out)' : ''}; stderr: ${r.stderr.slice(-600)}`;

/**
 * `decisions ask` that runs until its question has an outcome: once it prints the question id, `act(id)` plays the
 * phone's part, and the command's own result comes back with it.
 */
async function cliAsk(side, home, argv, act, o = {}) {
  let seen = false;
  let gotId;
  const id = new Promise((r) => (gotId = r));
  const run = cli(side, home, argv, {
    ...o,
    onLine: (l) => {
      try {
        const j = JSON.parse(l);
        if (!seen && typeof j.question_id === 'string') {
          seen = true;
          gotId(j.question_id);
        }
      } catch {
        /* not a JSON line */
      }
    },
  });
  const early = run.then((r) => {
    if (!seen) throw new Error(`ask ended before it printed a question id: ${tail(r)}`);
  });
  early.catch(() => undefined);
  const questionId = await Promise.race([id, early]);
  const acted = await act(questionId);
  return { questionId, acted, ...(await run) };
}

async function setupOwner(side, home, origin, label) {
  const r = await cli(side, home, ['--json', 'setup', '--url', origin, '--label', label], {
    env: { DECISIONS_CLAIM_SECRET: CLAIM_SECRET },
  });
  must(r.code === 0, `${side.label} CLI claims the relay as "${label}"`, tail(r));
}

/** Pairs the simulated phone through the owner's library: invite, candidate, approval, the epoch key. */
async function pairPhone(owner, phoneActor, home, name) {
  const invite = await owner.call('ownerInvite', { home });
  await phoneActor.call('phoneCandidate', { name, ...invite });
  await owner.call('ownerApprove', { home, pairingId: invite.pairingId });
  const r = await phoneActor.call('phoneFinish', { name, ownerSigningPub: invite.ownerSigningPub });
  ok(`a phone pairs (declares ${r.features.join(', ') || 'nothing'})`);
  return r;
}

/** The phone reads `questionId` (once `want` holds) and must find the question that was asked, decrypted. */
async function phoneReads(phoneActor, questionId, question, want = {}) {
  const q = await phoneActor.call('phoneQuestion', { name: 'phone', questionId, want });
  if (q.content?.question !== question)
    throw new Error(`the phone read "${q.content?.question}" for ${questionId}, not "${question}"`);
  return q;
}

/** The single record of a kind a `--json` CLI run printed for `questionId`, or null when there is not exactly one. */
function onlyRecord(run, record, questionId) {
  const all = run.json.filter((j) => j.record === record);
  return all.length === 1 && all[0].question_id === questionId ? all[0] : null;
}

/**
 * The answer notice blocks in `text` (packages/client/src/notice.ts) for one question, each with its first value of
 * every field. A write may hold several blocks, so each is matched by its own `question_id` line.
 */
function blocksIn(text, questionId) {
  const out = [];
  const re = /\[DAINTREE DECISION ANSWER\]\n([\s\S]*?)\n\[END DAINTREE DECISION ANSWER\]/g;
  for (const m of text.matchAll(re)) {
    const fields = {};
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(': ');
      if (i > 0 && !line.startsWith(' ')) fields[line.slice(0, i)] ??= line.slice(i + 2);
    }
    if (fields.question_id?.split(' ')[0] === questionId) out.push({ fields, text: m[0] });
  }
  return out;
}

/** The notice blocks a bridge typed for one question, with the pane each went to. */
const notices = (state, questionId) =>
  state.typed.flatMap((t) => blocksIn(t.text, questionId).map((b) => ({ ...b, pane: t.pane })));

/** A notice says the person answered with `choice` and `text`, or declined; into `pane` when given. */
function noticeSays(n, want, pane) {
  if (pane && n.pane !== pane) return false;
  const f = n.fields;
  if (want.declined) return f.status === 'declined' && f.authorised === 'no';
  // An expiry that waited for a decision: nothing in it may say a plan can go ahead.
  if (want.expired)
    return (
      f.status === 'expired' &&
      f.authorised === 'no' &&
      !f.disposition &&
      !/advisory|plan|fallback/i.test(n.text)
    );
  return f.source === 'human' && f.choice === want.choice && n.text.includes(want.text);
}

/** Reads a bridge's state once its notices have had a moment to settle, so a late duplicate is counted too. */
async function settled(actor, name) {
  await sleep(1500);
  return actor.call('bridgeState', { name });
}

/** Audit events (packages/client/src/audit.ts callers) that say something went wrong. */
const PROBLEMS = new Set([
  'event.rejected',
  'event.error',
  'inject.threw',
  'inject.unavailable',
  'delivery.attention',
  // A decline notice dropped because its agent has gone: never so here, where every pane is alive.
  'delivery.skipped',
  'question.unpublished',
  'round.ambiguous',
  'round.unreconciled',
  'rounds.unreconciled',
]);

/**
 * A bridge's own health: no error event, no request the relay refused, and nothing in its audit that says something
 * went wrong, but for a refusal of a question in `refusable` (one it is meant to refuse rather than misread).
 */
function checkBridgeHealth(state, who, refusable = []) {
  check(state.errors.length === 0, `${who} reported no error`, show(state.errors));
  check(
    state.refused.length === 0,
    `the relay refused none of ${who}'s requests`,
    show(state.refused),
  );
  const counts = {};
  for (const a of state.audit) counts[a.event] = (counts[a.event] ?? 0) + 1;
  check(state.audit.length > 0, `${who} kept an audit`, 'its audit file is empty');
  console.log(`  ${who}'s audit: ${show(counts)}`);
  const problems = state.audit.filter(
    (a) =>
      PROBLEMS.has(a.event) && !(a.event === 'event.rejected' && refusable.includes(a.question_id)),
  );
  check(problems.length === 0, `${who}'s audit records no problem`, show(problems));
}

/* ---------------------------------------------------------------- scenarios */

/** 1. The old desktop (CLI and library) against the new relay. */
async function oldDesktopNewRelay({ OLD, NEW, newRelay, port }) {
  const relay = await startRelay(newRelay, port, scratch('persist-1'), '1-new');
  const old = startActor(OLD, '1-old');
  const neu = startActor(NEW, '1-new');
  try {
    const features = (await info(relay.origin)).features ?? [];
    must(
      features.includes(ADVISORY) && features.includes(AGENT_STOPPED),
      `the ${NEW.label} relay advertises ${ADVISORY} and ${AGENT_STOPPED}`,
      show(features),
    );
    const home = scratch('home-1-owner');
    await setupOwner(OLD, home, relay.origin, `Compat ${OLD.label} owner`);
    await pairPhone(old, neu, home, 'phone');

    const sink = join(work, 'sink-1.log');
    const answered = await cliAsk(
      OLD,
      home,
      [
        '--json',
        'ask',
        'Compat 1: which fixture should the tests use?',
        '--option',
        'mem=In memory',
        '--option',
        'disk=On disk',
        '--wait',
        '--sink',
        `file:${sink}`,
      ],
      async (id) => {
        const q = await phoneReads(neu, id, 'Compat 1: which fixture should the tests use?');
        return neu.call('phoneAnswer', {
          name: 'phone',
          questionId: id,
          revision: q.revision,
          option: 'mem',
          text: 'Compat answer one',
        });
      },
    );
    check(
      answered.acted.status === 201,
      'the phone answers the old CLI question',
      show(answered.acted),
    );
    const sinkText = () => (existsSync(sink) ? readFileSync(sink, 'utf8') : '');
    const typed1 = blocksIn(sinkText(), answered.questionId);
    check(
      answered.code === 0 &&
        typed1.length === 1 &&
        noticeSays(typed1[0], { choice: 'mem', text: 'Compat answer one' }),
      `${OLD.label} \`ask --wait\` writes the person's answer to its sink once, and exits 0`,
      `${tail(answered)}; sink: ${sinkText().slice(-400)}`,
    );

    const declined = await cliAsk(
      OLD,
      home,
      ['--json', 'ask', 'Compat 1: rename the flag?', '--wait', '--sink', `file:${sink}`],
      async (id) => {
        const q = await phoneReads(neu, id, 'Compat 1: rename the flag?');
        return neu.call('phoneDecline', {
          name: 'phone',
          questionId: id,
          revision: q.revision,
          publisher: q.originating_device_id,
        });
      },
      { timeoutMs: 90_000 },
    );
    check(
      declined.acted.status === 200 || declined.acted.status === 201,
      'the phone declines the old CLI question',
      show(declined.acted),
    );
    const typed2 = blocksIn(sinkText(), declined.questionId);
    check(
      declined.code === 0 && typed2.length === 1 && noticeSays(typed2[0], { declined: true }),
      `${OLD.label} \`ask --wait\` writes the person's decline to its sink once, and exits 0`,
      `${tail(declined)}; sink: ${sinkText().slice(-400)}`,
    );
    check(
      blocksIn(sinkText(), answered.questionId).length === 1,
      'the earlier answer is not written again',
    );

    // A Remote Host on the new version, enrolled by the old owner: it can ask what the old desktop cannot read.
    const hostHome = scratch('home-1-host');
    const req = await cli(NEW, hostHome, [
      '--json',
      'host',
      'request',
      '--label',
      'Compat new host',
    ]);
    must(
      req.code === 0 && req.last?.request,
      `${NEW.label} CLI requests a Remote Host enrollment`,
      tail(req),
    );
    const enr = await cli(OLD, home, ['--json', 'host', 'enroll', '--yes', req.last.request]);
    must(
      enr.code === 0 && enr.last?.response,
      `${OLD.label} owner enrolls the ${NEW.label} Remote Host`,
      tail(enr),
    );
    const acc = await cli(NEW, hostHome, ['--json', 'host', 'accept', enr.last.response]);
    must(acc.code === 0, `${NEW.label} Remote Host accepts the enrollment`, tail(acc));
    const devices = await cli(OLD, home, ['--json', 'devices']);
    check(
      devices.code === 0 && devices.last?.devices?.length === 3,
      `old \`decisions devices\` lists the owner, the phone and the new Remote Host`,
      `${tail(devices)}; ${show(devices.last)}`,
    );

    const auditDir = scratch('audit-1');
    const owner = await old.call('bridgeStart', {
      name: 'owner',
      home,
      store: 'memory',
      pane: 'compat-1-owner',
      auditDir,
    });
    await neu.call('bridgeStart', {
      name: 'host',
      home: hostHome,
      store: 'memory',
      pane: 'compat-1-host',
      advisory: true,
      auditDir,
    });

    const adv = await neu.call('bridgeAsk', {
      name: 'host',
      input: {
        question: 'Compat 1: which fixture should I use?',
        options: [
          { id: 'mem', label: 'In memory' },
          { id: 'disk', label: 'On disk' },
        ],
        expires_in: '10m',
        planned_fallback: 'I will use the in-memory fixture.',
      },
      awaitAdvisorySupport: true,
    });
    must(
      adv.asked?.replyMode === 'advisory',
      `the ${NEW.label} Remote Host asks an advisory question on the ${NEW.label} relay`,
      show(adv),
    );
    const advId = adv.asked.questionId;
    const advOnPhone = await phoneReads(neu, advId, 'Compat 1: which fixture should I use?');
    must(
      advOnPhone.reply_mode === 'advisory' &&
        advOnPhone.content.planned_fallback === 'I will use the in-memory fixture.' &&
        advOnPhone.signed_expires_at === adv.asked.expiresAt &&
        advOnPhone.expires_at === adv.asked.expiresAt,
      'the relay commits it as advisory, with its plan and signed deadline',
      show(advOnPhone),
    );
    const plain = await neu.call('bridgeAsk', {
      name: 'host',
      input: { question: 'Compat 1: a blocking question from the new host' },
    });
    must(
      plain.asked?.replyMode === 'blocking',
      `the ${NEW.label} Remote Host asks an ordinary question after it`,
      show(plain),
    );
    const plainId = plain.asked.questionId;
    await phoneReads(neu, plainId, 'Compat 1: a blocking question from the new host');

    // The old library bridge, connected throughout, asks after both: an answer and a decline.
    const own = [];
    for (const [question, act] of [
      ['Compat 1: the old bridge asks, the person answers', 'answer'],
      ['Compat 1: the old bridge asks, the person declines', 'decline'],
    ]) {
      const r = await old.call('bridgeAsk', {
        name: 'owner',
        input: {
          question,
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
      });
      must(r.asked, `the ${OLD.label} bridge asks "${question}"`, show(r));
      const id = r.asked.questionId;
      const q = await phoneReads(neu, id, question);
      const res =
        act === 'answer'
          ? await neu.call('phoneAnswer', {
              name: 'phone',
              questionId: id,
              revision: q.revision,
              option: 'yes',
              text: 'Compat answer two',
            })
          : await neu.call('phoneDecline', {
              name: 'phone',
              questionId: id,
              revision: q.revision,
              publisher: owner.deviceId,
            });
      must(res.status === 200 || res.status === 201, `the phone's ${act} is committed`, show(res));
      own.push({ id, act });
    }
    await until(
      async () => {
        const s = await old.call('bridgeState', { name: 'owner' });
        return own.every((q) => notices(s, q.id).length > 0);
      },
      45_000,
      `the ${OLD.label} bridge to type both outcomes`,
    ).catch(async (e) => {
      fail(`${e.message}: ${show(await old.call('bridgeState', { name: 'owner' }))}`);
    });
    const state = await settled(old, 'owner');
    for (const q of own) {
      const typed = notices(state, q.id);
      const want =
        q.act === 'answer' ? { choice: 'yes', text: 'Compat answer two' } : { declined: true };
      check(
        typed.length === 1 && noticeSays(typed[0], want, 'compat-1-owner'),
        `the ${OLD.label} bridge types the ${q.act} once, into its own pane`,
        show(typed),
      );
    }
    check(
      notices(state, advId).length === 0 && notices(state, plainId).length === 0,
      `the ${OLD.label} bridge types nothing for the Remote Host's questions`,
    );
    for (const id of [advId, plainId])
      check(
        !(await old.call('bridgeKnows', { name: 'owner', questionId: id })),
        `the ${OLD.label} bridge does not take the Remote Host's question ${id} as its own`,
      );

    // The old protocol's own reader: refuses the advisory question if it predates advice, reads everything else.
    const { knowsAdvisory } = await old.call('versions');
    const ledger = await old.call('readLedger', {
      home,
      features: owner.features,
      questionIds: [advId, plainId, ...own.map((q) => q.id)],
    });
    const a = ledger.questions[advId];
    const refusesForTheMode = (issue) =>
      issue?.code === 'unrecognized_keys' && issue.keys.includes('reply_mode');
    if (knowsAdvisory)
      check(
        a.inLedger && a.creates === 1 && a.created && a.detail,
        `${OLD.label} has advisory questions, and reads this one`,
        show(a),
      );
    else
      check(
        a.inLedger &&
          a.creates === 1 &&
          !a.created &&
          !a.detail &&
          refusesForTheMode(a.createdIssue) &&
          refusesForTheMode(a.detailIssue),
        `${OLD.label}'s EventData.created and QuestionDetail refuse the advisory question for its reply_mode`,
        show(a),
      );
    for (const id of [plainId, ...own.map((q) => q.id)]) {
      const r = ledger.questions[id];
      check(
        r.inLedger && r.creates === 1 && r.created && r.detail,
        `${OLD.label} reads question ${id}`,
        show(r),
      );
    }
    const caught = await until(
      async () => {
        const s = await old.call('bridgeState', { name: 'owner' });
        return s.cursor >= ledger.highWater ? s : null;
      },
      20_000,
      `the ${OLD.label} bridge's cursor to reach ${ledger.highWater}`,
    ).catch((e) => (fail(e.message), null));
    if (caught)
      ok(`the ${OLD.label} bridge's cursor passed the advisory question (${caught.cursor})`);
    checkBridgeHealth(await old.call('bridgeState', { name: 'owner' }), `the ${OLD.label} bridge`, [
      advId,
    ]);
  } finally {
    await old.stop();
    await neu.stop();
    await relay.stop();
  }
}

/** 2. The new desktop (CLI and library) against the old relay bundle. */
async function newDesktopOldRelay({ OLD, NEW, oldRelay, port }) {
  const relay = await startRelay(oldRelay, port, scratch('persist-2'), '2-old');
  const neu = startActor(NEW, '2-new');
  try {
    // What the new desktop must refuse depends on what the old relay lacks (0.8.0 lacks both).
    const features = (await info(relay.origin)).features ?? [];
    const lacksAdvice = !features.includes(ADVISORY);
    const lacksPush = !features.includes(AGENT_STOPPED);
    console.log(
      `  the ${OLD.label} relay ${lacksAdvice ? 'lacks' : 'has'} ${ADVISORY} and ${lacksPush ? 'lacks' : 'has'} ${AGENT_STOPPED}`,
    );
    const home = scratch('home-2-owner');
    await setupOwner(NEW, home, relay.origin, `Compat ${NEW.label} owner`);
    await pairPhone(neu, neu, home, 'phone');

    const answered = await cliAsk(
      NEW,
      home,
      [
        '--json',
        'ask',
        'Compat 2: ship the change?',
        '--option',
        'yes=Yes',
        '--option',
        'no=No',
        '--wait',
        '--wait-timeout',
        '2m',
      ],
      async (id) => {
        const q = await phoneReads(neu, id, 'Compat 2: ship the change?');
        return neu.call('phoneAnswer', {
          name: 'phone',
          questionId: id,
          revision: q.revision,
          option: 'yes',
          text: 'Compat answer three',
        });
      },
      { timeoutMs: 150_000 },
    );
    const ar = onlyRecord(answered, 'result', answered.questionId);
    check(
      answered.code === 0 &&
        onlyRecord(answered, 'asked', answered.questionId) &&
        ar?.outcome === 'answered' &&
        ar.provenance === 'human' &&
        ar.choice === 'yes' &&
        ar.text === 'Compat answer three',
      `${NEW.label} \`ask --wait\` reports the person's answer (exit 0)`,
      `${tail(answered)}; ${show(ar)}`,
    );

    const declined = await cliAsk(
      NEW,
      home,
      ['--json', 'ask', 'Compat 2: drop the old flag?', '--wait', '--wait-timeout', '2m'],
      async (id) => {
        const q = await phoneReads(neu, id, 'Compat 2: drop the old flag?');
        return neu.call('phoneDecline', {
          name: 'phone',
          questionId: id,
          revision: q.revision,
          publisher: q.originating_device_id,
        });
      },
      { timeoutMs: 150_000 },
    );
    const dr = onlyRecord(declined, 'result', declined.questionId);
    check(
      declined.code === 10 &&
        onlyRecord(declined, 'asked', declined.questionId) &&
        dr?.outcome === 'declined' &&
        dr.closed_reason === 'declined',
      `${NEW.label} \`ask --wait\` reports the person's decline (exit 10)`,
      `${tail(declined)}; ${show(dr)}`,
    );
    for (const [id, outcome, code] of [
      [answered.questionId, 'answered', 0],
      [declined.questionId, 'declined', 10],
    ]) {
      const got = await cli(NEW, home, ['--json', 'get', id]);
      check(
        got.code === 0 && got.last?.question_id === id && got.last.outcome === outcome,
        `\`decisions get\` finds the ${outcome} question again`,
        `${tail(got)}; ${show(got.last)}`,
      );
      const waited = await cli(NEW, home, ['--json', 'wait', id], { timeoutMs: 60_000 });
      check(
        waited.code === code && onlyRecord(waited, 'result', id)?.outcome === outcome,
        `\`decisions wait\` reports the ${outcome} question (exit ${code})`,
        `${tail(waited)}; ${show(waited.last)}`,
      );
    }

    const before = (await neu.call('ownerQuestions', { home })).sort();
    if (lacksAdvice) {
      const advisoryCli = await cli(NEW, home, [
        '--json',
        'ask',
        'Compat 2: which fixture should I use?',
        '--planned-fallback',
        'I will use the in-memory fixture.',
        '--expires-in',
        '5m',
      ]);
      check(
        advisoryCli.code === 1 &&
          advisoryCli.json.length === 0 &&
          /not_supported: relay-unsupported/.test(advisoryCli.stderr),
        `${NEW.label} \`ask --planned-fallback\` is refused as not_supported: relay-unsupported (exit 1), with no receipt`,
        tail(advisoryCli),
      );
    }

    const auditDir = scratch('audit-2');
    await neu.call('bridgeStart', {
      name: 'owner',
      home,
      store: 'memory',
      pane: 'compat-2-owner',
      advisory: true,
      auditDir,
    });
    if (lacksAdvice) {
      const advisoryLib = await neu.call('bridgeAsk', {
        name: 'owner',
        input: {
          question: 'Compat 2: which fixture should I use?',
          expires_in: '5m',
          planned_fallback: 'I will use the in-memory fixture.',
        },
        awaitAdvisorySupport: true,
      });
      check(
        advisoryLib.refused?.code === 'not_supported' &&
          advisoryLib.refused.message.startsWith('relay-unsupported'),
        `the ${NEW.label} library refuses the advisory ask as not_supported: relay-unsupported`,
        show(advisoryLib),
      );
      // Anything queued would go out with the next pump: run one before looking.
      await neu.call('bridgePump', { name: 'owner' });
      const after = (await neu.call('ownerQuestions', { home })).sort();
      check(
        after.join(',') === before.join(','),
        'neither refused advisory ask put a question on the relay',
        `${show(before)} before, ${show(after)} after`,
      );
    } else console.log(`  skip the advisory refusal: the ${OLD.label} relay supports advice`);
    if (lacksPush) {
      // The relay's refusal of a push it does not know would show as a refused request (checked below).
      const push = await neu.call('bridgeAgentStopped', { name: 'owner' });
      check(
        push.outcome === 'unsupported',
        `an agent-stopped push request reports unsupported`,
        show(push),
      );
    } else
      console.log(`  skip the push refusal: the ${OLD.label} relay supports agent-stopped pushes`);

    const own = [];
    for (const [question, act] of [
      ['Compat 2: the new bridge asks, the person answers', 'answer'],
      ['Compat 2: the new bridge asks, the person declines', 'decline'],
    ]) {
      const r = await neu.call('bridgeAsk', {
        name: 'owner',
        input: {
          question,
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
      });
      must(
        r.asked?.replyMode === 'blocking',
        `the ${NEW.label} bridge asks "${question}"`,
        show(r),
      );
      const id = r.asked.questionId;
      const q = await phoneReads(neu, id, question);
      const res =
        act === 'answer'
          ? await neu.call('phoneAnswer', {
              name: 'phone',
              questionId: id,
              revision: q.revision,
              option: 'no',
              text: 'Compat answer four',
            })
          : await neu.call('phoneDecline', {
              name: 'phone',
              questionId: id,
              revision: q.revision,
              publisher: q.originating_device_id,
            });
      must(res.status === 200 || res.status === 201, `the phone's ${act} is committed`, show(res));
      own.push({ id, act });
    }
    await until(
      async () => {
        const s = await neu.call('bridgeState', { name: 'owner' });
        return own.every((q) => notices(s, q.id).length > 0);
      },
      45_000,
      `the ${NEW.label} bridge to type both outcomes`,
    ).catch((e) => fail(e.message));
    const state = await settled(neu, 'owner');
    for (const q of own) {
      const typed = notices(state, q.id);
      const want =
        q.act === 'answer' ? { choice: 'no', text: 'Compat answer four' } : { declined: true };
      check(
        typed.length === 1 && noticeSays(typed[0], want, 'compat-2-owner'),
        `the ${NEW.label} bridge types the ${q.act} once, into its own pane`,
        show(typed),
      );
      const view = await neu.call('bridgeView', { name: 'owner', questionId: q.id });
      check(
        q.act === 'answer'
          ? view.status === 'human-answered' && view.provenance === 'human'
          : view.status === 'cancelled' && view.closedReason === 'declined',
        `getDecision reports the ${q.act}`,
        show(view),
      );
    }
    checkBridgeHealth(await neu.call('bridgeState', { name: 'owner' }), `the ${NEW.label} bridge`);
  } finally {
    await neu.stop();
    await relay.stop();
  }
}

/** 3. An old host with open questions moves to the new version, then its relay does. */
async function hostUpgrade({ OLD, NEW, oldRelay, newRelay, port }) {
  const persist = scratch('persist-3');
  let relay = await startRelay(oldRelay, port, persist, '3-old');
  const old = startActor(OLD, '3-old');
  const neu = startActor(NEW, '3-new');
  try {
    const home = scratch('home-3-owner');
    await setupOwner(OLD, home, relay.origin, `Compat ${OLD.label} owner`);
    await pairPhone(old, neu, home, 'phone');
    const auditDir = scratch('audit-3');
    const pre = await old.call('bridgeStart', {
      name: 'pre',
      home,
      store: 'sqlite',
      pane: 'compat-3',
      auditDir,
    });
    const ask = async (question, extra = {}) => {
      const r = await old.call('bridgeAsk', {
        name: 'pre',
        input: {
          question,
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
          ...extra,
        },
      });
      must(r.asked, `the ${OLD.label} host asks "${question}"`, show(r));
      return r.asked.questionId;
    };
    const asked = {
      A: 'Compat 3 A: keep the cache?',
      B: 'Compat 3 B: rename the flag?',
      C: 'Compat 3 C: split the module?',
    };
    const A = await ask(asked.A);
    const C = await ask(asked.C);
    // B last, so its short deadline is spent on the upgrades and nothing before them.
    const shortDeadline = new Date(Date.now() + SHORT_DEADLINE_MS).toISOString();
    const B = await ask(asked.B, { expires_at: shortDeadline });
    const onPhone = {};
    for (const [id, name] of [
      [A, 'A'],
      [B, 'B'],
      [C, 'C'],
    ]) {
      onPhone[id] = await phoneReads(neu, id, asked[name]);
      must(onPhone[id].status === 'open', `${name} is open on the ${OLD.label} relay`);
    }
    check(
      onPhone[B].expires_at === shortDeadline && onPhone[B].signed_expires_at === shortDeadline,
      `B carries its signed deadline`,
      show(onPhone[B]),
    );

    // A reopen made before the upgrade: the person declines C, and the old owner reopens it with a new deadline.
    const dc = await neu.call('phoneDecline', {
      name: 'phone',
      questionId: C,
      revision: 0,
      publisher: pre.deviceId,
    });
    must(dc.status === 200 || dc.status === 201, 'the phone declines C', show(dc));
    await phoneReads(neu, C, asked.C, { status: 'cancelled' });
    await until(
      async () => notices(await old.call('bridgeState', { name: 'pre' }), C).length > 0,
      30_000,
      `the ${OLD.label} host to type C's decline`,
    );
    const declinedC = notices(await settled(old, 'pre'), C);
    check(
      declinedC.length === 1 && noticeSays(declinedC[0], { declined: true }, 'compat-3'),
      `the ${OLD.label} host types C's decline once`,
      show(declinedC),
    );
    const reopenedC = new Date(Date.now() + 3 * 86_400_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, '.000Z');
    const rc = await old.call('ownerReopen', {
      home,
      questionId: C,
      expectedRevision: 0,
      expiresAt: reopenedC,
    });
    must(rc.status === 'open' && rc.revision === 1, `the ${OLD.label} owner reopens C`, show(rc));
    const preC = await until(
      async () => {
        const v = await old.call('bridgeView', { name: 'pre', questionId: C });
        return v.status === 'open' && v.revision === 1 ? v : null;
      },
      20_000,
      `the ${OLD.label} host to read C's reopen`,
    );
    console.log(`  the ${OLD.label} host keeps C due ${preC.expiresAt} (reopened to ${reopenedC})`);
    const preState = await old.call('bridgeState', { name: 'pre' });
    checkBridgeHealth(preState, `the ${OLD.label} host`);
    await old.call('bridgeStop', { name: 'pre' });

    // The host moves to the new version on the same state directory (identity.json and decisions.db).
    await neu.call('bridgeStart', {
      name: 'post',
      home,
      store: 'sqlite',
      pane: 'compat-3',
      auditDir,
    });
    for (const [id, deadline] of [
      [A, onPhone[A].expires_at],
      [B, shortDeadline],
    ]) {
      const v = await neu.call('bridgeView', { name: 'post', questionId: id });
      check(
        v.status === 'open' &&
          v.revision === 0 &&
          v.expiresAt === deadline &&
          v.replyMode === 'blocking',
        `the ${NEW.label} host reads ${id === A ? 'A' : 'B'} as the open question it was`,
        show(v),
      );
    }
    const postC = await until(
      async () => {
        const v = await neu.call('bridgeView', { name: 'post', questionId: C });
        return v.status === 'open' && v.revision === 1 && v.expiresAt === reopenedC ? v : null;
      },
      20_000,
      `the ${NEW.label} host to read C as reopened, due ${reopenedC}`,
    ).catch(async (e) => {
      fail(`${e.message}: ${show(await neu.call('bridgeView', { name: 'post', questionId: C }))}`);
      return null;
    });
    if (postC) ok(`the ${NEW.label} host reads C reopened, with the reopen's signed deadline`);

    const aa = await neu.call('phoneAnswer', {
      name: 'phone',
      questionId: A,
      revision: 0,
      option: 'yes',
      text: 'Compat answer A',
    });
    must(aa.status === 201, 'the phone answers A', show(aa));
    await until(
      async () => notices(await neu.call('bridgeState', { name: 'post' }), A).length > 0,
      30_000,
      `the ${NEW.label} host to type A's answer`,
    );
    const typedA = notices(await settled(neu, 'post'), A);
    check(
      typedA.length === 1 &&
        noticeSays(typedA[0], { choice: 'yes', text: 'Compat answer A' }, 'compat-3'),
      `the ${NEW.label} host types the answer to a question asked before the upgrade, once`,
      show(typedA),
    );
    const viewA = await neu.call('bridgeView', { name: 'post', questionId: A });
    check(
      viewA.status === 'human-answered' && viewA.provenance === 'human' && viewA.revision === 1,
      'getDecision reports A answered by the person',
      show(viewA),
    );

    // The relay moves to the new version on the same storage, as `decisions update` does.
    // B must outlive the swap by more than a relay restart takes, or its expiry would happen on the old relay.
    const left = Date.parse(shortDeadline) - Date.now();
    must(
      left > 60_000,
      `B is still open, with time to spare, when the relay is upgraded (${Math.round(left / 1000)} s left)`,
    );
    const oldFeatures = (await info(relay.origin)).features ?? [];
    await relay.stop();
    relay = await startRelay(newRelay, port, persist, '3-new');
    const features = (await info(relay.origin)).features ?? [];
    if (!oldFeatures.includes(ADVISORY))
      must(
        features.includes(ADVISORY),
        `the relay now runs the ${NEW.label} bundle`,
        show(features),
      );
    const stillB = await phoneReads(neu, B, asked.B);
    must(
      stillB.status === 'open' && stillB.revision === 0 && stillB.expires_at === shortDeadline,
      `the ${NEW.label} relay keeps B open from the ${OLD.label} relay's storage`,
      show(stillB),
    );
    if (!oldFeatures.includes(AGENT_STOPPED)) {
      // The positive control for scenario 2's `unsupported`: the same request, now that the relay has the route.
      const push = await neu.call('bridgeAgentStopped', { name: 'post' });
      check(
        push.outcome === 'no-subscription',
        `once the relay is upgraded, an agent-stopped push request reaches it (no-subscription: no phone subscribed)`,
        show(push),
      );
    }

    // B expires on the new relay, is reopened and answered in its new round.
    const expiredB = await until(
      async () => {
        const v = await neu.call('bridgeView', { name: 'post', questionId: B });
        return v.status === 'expired' ? v : null;
      },
      SHORT_DEADLINE_MS + 60_000,
      'B to expire',
    );
    check(
      expiredB.closedReason === 'expired' &&
        expiredB.fallbackDue === false &&
        expiredB.replyMode === 'blocking',
      'B expires as a question that waited for a decision: nothing is due',
      show(expiredB),
    );
    await until(
      async () => notices(await neu.call('bridgeState', { name: 'post' }), B).length > 0,
      20_000,
      `the ${NEW.label} host to type B's expiry`,
    );
    const typedB = notices(await settled(neu, 'post'), B);
    check(
      typedB.length === 1 && noticeSays(typedB[0], { expired: true }, 'compat-3'),
      `the ${NEW.label} host types B's expiry once, as an expiry that authorises nothing`,
      show(typedB),
    );
    check(
      Date.parse(expiredB.expiresAt) === Date.parse(shortDeadline),
      'B expired at its own deadline',
      show(expiredB),
    );
    const reopenedB = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
    const rb = await neu.call('ownerReopen', {
      home,
      questionId: B,
      expectedRevision: 0,
      expiresAt: reopenedB,
    });
    must(rb.status === 'open' && rb.revision === 1, `the ${NEW.label} owner reopens B`, show(rb));
    await until(
      async () => {
        const v = await neu.call('bridgeView', { name: 'post', questionId: B });
        return v.status === 'open' && v.revision === 1 && v.expiresAt === reopenedB;
      },
      20_000,
      `the ${NEW.label} host to read B reopened`,
    );
    ok(`the ${NEW.label} host reads B reopened, due ${reopenedB}`);
    for (const [id, name] of [
      [B, 'B'],
      [C, 'C'],
    ]) {
      const res = await neu.call('phoneAnswer', {
        name: 'phone',
        questionId: id,
        revision: 1,
        option: 'no',
        text: `Compat answer ${name}`,
      });
      must(res.status === 201, `the phone answers ${name}'s reopened round`, show(res));
      const v = await until(
        async () => {
          const view = await neu.call('bridgeView', { name: 'post', questionId: id });
          return view.status === 'human-answered' && view.revision === 2 ? view : null;
        },
        30_000,
        `the ${NEW.label} host to read ${name}'s answer`,
      );
      check(
        v.provenance === 'human' && v.text === `Compat answer ${name}`,
        `getDecision reports ${name}'s answer`,
        show(v),
      );
    }
    // getDecision can report an answer a moment before the sink has it typed.
    const answeredIn = (s, id, name) =>
      notices(s, id).filter((n) =>
        noticeSays(n, { choice: 'no', text: `Compat answer ${name}` }, 'compat-3'),
      );
    await until(
      async () => {
        const s = await neu.call('bridgeState', { name: 'post' });
        return answeredIn(s, B, 'B').length > 0 && answeredIn(s, C, 'C').length > 0;
      },
      30_000,
      `the ${NEW.label} host to type the answers to both reopened rounds`,
    ).catch((e) => fail(e.message));
    const final = await settled(neu, 'post');
    // Exactly one notice of each reopened round's answer (revision 2) in any pane, and that one is the answer, here.
    const roundTwo = (id, name) => {
      const typed = notices(final, id).filter((n) => n.fields.revision === '2');
      return (
        typed.length === 1 &&
        noticeSays(typed[0], { choice: 'no', text: `Compat answer ${name}` }, 'compat-3')
      );
    };
    check(
      roundTwo(B, 'B') && roundTwo(C, 'C'),
      `the ${NEW.label} host types the answers to both reopened rounds, once each`,
      show([...notices(final, B), ...notices(final, C)]),
    );
    checkBridgeHealth(final, `the ${NEW.label} host`);
  } finally {
    await old.stop();
    await neu.stop();
    await relay.stop();
  }
}

/**
 * 4. A phone with the old app still loaded while its relay moves to the new version, until the app updates in place.
 * The phone is the released app in Chromium; only its push subscription is a fixture (phone-app.mjs). Returns
 * 'skipped' when the old side already has advice or agent-stopped pushes: this is the upgrade from neither.
 */
async function cachedPhone({ OLD, NEW, oldRelay, newRelay, port }) {
  const vars = { PUSH_ENDPOINT_ALLOW: PUSH_HOST };
  const persist = scratch('persist-4');
  let relay = await startRelay(oldRelay, port, persist, '4-old', vars);
  const neu = startActor(NEW, '4-new');
  let browser = null;
  const phoneLog = createWriteStream(join(logs, 'phone-4.jsonl'));
  const keep = (entry) => phoneLog.write(`${JSON.stringify(entry)}\n`);
  const reading = new Set();
  // The response bodies still being read, for at most ten seconds: one that stalls never holds the run.
  const drained = () =>
    Promise.race([
      Promise.allSettled([...reading]),
      new Promise((r) => setTimeout(r, 10_000).unref()),
    ]);
  const pathOf = (url) => {
    try {
      return new URL(url).pathname;
    } catch {
      return null;
    }
  };
  try {
    const oldFeatures = (await info(relay.origin)).features ?? [];
    if (oldFeatures.includes(ADVISORY) || oldFeatures.includes(AGENT_STOPPED)) {
      console.log(
        `  skip: the ${OLD.label} relay already has ${ADVISORY} or ${AGENT_STOPPED}; this scenario is the upgrade from a phone app that has neither`,
      );
      return 'skipped';
    }
    const oldEntry = entryScript(oldRelay);
    const newEntry = entryScript(newRelay);
    must(
      oldEntry !== newEntry,
      `the ${OLD.label} and ${NEW.label} phone apps are different builds`,
      oldEntry,
    );
    browser = startBrowser('4');
    const home = scratch('home-4-owner');
    await setupOwner(NEW, home, relay.origin, `Compat ${NEW.label} owner`);

    // Everything the phone's browser does is kept: its own trace (phone-app.mjs) and the relay requests it makes.
    const sub = pushSubscription();
    const trace = [];
    const net = [];
    const pageErrors = [];
    const pages = new WeakMap();
    // The subscriptions the pages themselves sent or removed, as the browser saw them.
    let subscriptionPosts = 0;
    let subscriptionDeletes = 0;
    const context = await (
      await browser.launched
    ).newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
    await context.grantPermissions(['notifications'], { origin: relay.origin });
    await context.exposeBinding('__compatTrace', (source, entry) => {
      const traced = { ...entry, page: pages.get(source.page) ?? null };
      trace.push(traced);
      keep({ src: 'page', ...traced });
    });
    await context.addInitScript(phoneFixture, sub);
    context.on('page', (page) => {
      page.on('pageerror', (e) => {
        const entry = {
          src: 'pageerror',
          at: Date.now(),
          page: pages.get(page) ?? null,
          path: pathOf(page.url()),
          message: e.message.slice(0, 500),
        };
        pageErrors.push(entry);
        keep(entry);
      });
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning')
          keep({ src: 'console', at: Date.now(), type: m.type(), text: m.text().slice(0, 500) });
      });
    });
    // Each request is timed when it starts and named by the page that made it, so a response that arrives late is
    // never taken for one sent after it. Bodies only where a check reads them; never a header, query or fragment.
    const started = new WeakMap();
    const API = '/api/v1/';
    context.on('request', (req) => {
      const path = pathOf(req.url());
      if (!path?.startsWith(API)) return;
      let page = null;
      let framed = false;
      try {
        page = pages.get(req.frame().page()) ?? null;
        framed = true;
      } catch {
        /* a service worker's request has no frame */
      }
      started.set(req, { at: Date.now(), page });
      if (!framed) return;
      if (req.method() === 'POST' && path === '/api/v1/push/subscriptions') subscriptionPosts++;
      if (req.method() === 'DELETE' && path.startsWith('/api/v1/push/subscriptions/'))
        subscriptionDeletes++;
    });
    const READ = new Set([
      '/api/v1/push/subscriptions',
      '/api/v1/socket-ticket',
      '/api/v1/devices',
    ]);
    context.on('response', (res) => {
      const path = pathOf(res.url());
      if (!path?.startsWith(API)) return;
      const req = res.request();
      const from = started.get(req) ?? { at: Date.now(), page: null };
      const entry = { src: 'net', ...from, method: req.method(), path, status: res.status() };
      if (!READ.has(path)) {
        net.push(entry);
        keep(entry);
        return;
      }
      let sent = null;
      try {
        sent = JSON.parse(req.postData() ?? 'null');
      } catch {
        /* no JSON body */
      }
      if (path === '/api/v1/socket-ticket') entry.features = sent?.features ?? null;
      if (path === '/api/v1/push/subscriptions' && sent && typeof sent === 'object')
        entry.sent = {
          endpoint: sent.endpoint ?? null,
          features: 'features' in sent ? sent.features : null,
        };
      const read =
        path === '/api/v1/socket-ticket' || res.status() >= 300
          ? Promise.resolve()
          : res.json().then(
              (j) =>
                (entry.body =
                  path === '/api/v1/devices'
                    ? (j?.devices ?? []).map((d) => ({
                        device_id: d.device_id,
                        role: d.role,
                        features: d.features ?? [],
                      }))
                    : j),
              () => undefined,
            );
      const done = read.finally(() => {
        reading.delete(done);
        net.push(entry);
        keep(entry);
      });
      reading.add(done);
    });
    const seen = (pred, ms, what) => until(() => net.find(pred), ms, what);
    const docOf = (page) => page.evaluate(() => window.__compatDoc);
    const entryOf = (page) =>
      page.evaluate(() =>
        document.querySelector('script[type="module"][src]')?.getAttribute('src'),
      );
    // A navigation would load whatever shell the relay serves now, so the cached app only ever moves within itself.
    const goInApp = (page, to) =>
      page.evaluate((path) => {
        history.pushState(null, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, to);
    // A phone brought back to the foreground: the app reads its devices again and reconnects at once.
    let nudged = 0;
    const nudge = async (page) => {
      if (Date.now() - nudged < 4000) return;
      nudged = Date.now();
      await page
        .evaluate(() => {
          if (document.visibilityState === 'visible')
            document.dispatchEvent(new Event('visibilitychange'));
        })
        .catch(() => undefined);
    };
    // Home lists `qs` (after any new items are let in), and `q` is opened from it.
    const listed = async (page, qs) => {
      const rows = qs.map((q) => page.locator('main').getByText(q.question).first());
      await until(
        async () => {
          const pill = page.locator('main .nav-new');
          if (await pill.isVisible().catch(() => false)) await pill.click().catch(() => undefined);
          for (const row of rows) if (!(await row.isVisible().catch(() => false))) return false;
          return true;
        },
        30_000,
        `${qs.map((q) => `"${q.question}"`).join(' and ')} listed on the phone`,
      );
      return rows;
    };
    const openOnPhone = async (page, q) => {
      await goInApp(page, '/');
      const [row] = await listed(page, [q]);
      await row.click();
      await page.waitForURL((u) => u.pathname === `/q/${q.id}`, { timeout: 20_000 });
    };
    const answerOnPhone = async (page, option) => {
      await page.getByRole('radio', { name: option }).first().check();
      await page.getByRole('button', { name: /^Send (decision|answer)$/ }).click();
    };
    const typedFor = async (id, what) => {
      await until(
        async () => notices(await neu.call('bridgeState', { name: 'owner' }), id).length > 0,
        45_000,
        what,
      );
      return notices(await settled(neu, 'owner'), id);
    };
    const readers = (list) =>
      list.filter((d) => (d.role === 'phone' || d.role === 'tablet') && !d.revoked_at);

    // The released app pairs with the new desktop, and subscribes to pushes, on the old relay.
    const tab = await context.newPage();
    pages.set(tab, 'cached');
    const invite = await neu.call('ownerInvite', { home });
    await tab.goto(invite.url);
    await tab.getByRole('button', { name: 'Pair this device' }).click();
    await tab.getByText('Check that this matches your computer').waitFor({ timeout: 20_000 });
    const shown = (await tab.locator('.pair-digits').innerText()).replace(/\s/g, '');
    await neu.call('ownerApprove', { home, pairingId: invite.pairingId, shortCode: shown });
    await tab.waitForURL((u) => u.pathname === '/' && !u.hash, { timeout: 30_000 });
    await tab.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: 30_000,
    });
    must(
      (await entryOf(tab)) === oldEntry,
      `the ${OLD.label} phone app pairs through its own screens, with the code the desktop computes, under its own service worker`,
      await entryOf(tab),
    );
    const paired = readers(await neu.call('ownerDevices', { home }));
    must(
      paired.length === 1 && paired[0].role === 'phone',
      'one phone is paired, and no other phone or tablet',
      show(paired),
    );
    const phoneId = paired[0].device_id;

    await tab.goto(`${relay.origin}/settings/notifications`);
    const subscribeAt = Date.now();
    await tab.getByRole('button', { name: /^(Set up notifications|Turn on)$/ }).click();
    const subscribed = await seen(
      (e) =>
        e.page === 'cached' &&
        e.at >= subscribeAt &&
        e.method === 'POST' &&
        e.path === '/api/v1/push/subscriptions',
      30_000,
      'the phone to send its push subscription',
    );
    must(
      subscribed.status === 201 &&
        subscribed.sent?.endpoint === sub.endpoint &&
        subscribed.sent.features === null &&
        subscribed.body?.enabled === true &&
        typeof subscribed.body.subscription_id === 'string' &&
        subscribed.body.subscription_id.length > 0,
      `the ${OLD.label} app subscribes to pushes, declaring nothing`,
      show(subscribed),
    );
    const subscriptionId = subscribed.body.subscription_id;

    // The page the phone keeps: loaded from the old relay, and never loaded again until the phone updates.
    await tab.goto(`${relay.origin}/`);
    await tab.getByRole('main').waitFor({ timeout: 20_000 });
    const cachedDoc = await docOf(tab);
    must(typeof cachedDoc === 'string' && cachedDoc.length > 0, 'the cached page is traced');
    // Everything the old app does below is attributed to this page, so it must still be the same document.
    const stillCached = async (when) => {
      const now = await tab.evaluate(() => ({
        doc: window.__compatDoc,
        entry: document.querySelector('script[type="module"][src]')?.getAttribute('src'),
      }));
      must(
        now.doc === cachedDoc && now.entry === oldEntry,
        `the phone still runs the ${OLD.label} app it loaded before the relay was upgraded (${when})`,
        `${show(now)}; kept ${cachedDoc}`,
      );
    };

    // The relay moves to the new version on the same storage, as `decisions update` does; the page stays open.
    await relay.stop();
    const swappedAt = Date.now();
    relay = await startRelay(newRelay, port, persist, '4-new', vars);
    const features = (await info(relay.origin)).features ?? [];
    must(
      features.includes(ADVISORY) && features.includes(AGENT_STOPPED),
      `the relay now runs the ${NEW.label} bundle, with ${ADVISORY} and ${AGENT_STOPPED}`,
      show(features),
    );
    // The cached page asks the new relay for a socket ticket, declaring only what the released app knows.
    const cachedTickets = (e) =>
      e.page === 'cached' && e.at >= swappedAt && e.path === '/api/v1/socket-ticket';
    await until(
      async () => {
        await nudge(tab);
        return net.find((e) => cachedTickets(e) && e.status === 200);
      },
      90_000,
      'the cached page to get a socket ticket from the new relay',
    );
    await stillCached('after the relay was upgraded');
    const listedNow = await neu.call('ownerDevices', { home });
    const phone = listedNow.find((d) => d.device_id === phoneId);
    check(
      readers(listedNow).length === 1 &&
        phone &&
        !phone.revoked_at &&
        phone.push_enabled === true &&
        !phone.features.includes(ADVISORY) &&
        !phone.features.includes(AGENT_STOPPED),
      `the new relay lists the cached phone as the only phone or tablet, with push on, declaring neither ${ADVISORY} nor ${AGENT_STOPPED}`,
      show(listedNow),
    );

    // An advisory ask from the CLI, before anything else runs on this home: the only phone cannot show one.
    const advisory = 'Compat 4: which fixture should I use, if nobody answers in time?';
    const fallback = 'I will use the in-memory fixture.';
    const before = (await neu.call('ownerQuestions', { home })).sort();
    const advisoryCli = await cli(NEW, home, [
      '--json',
      'ask',
      advisory,
      '--planned-fallback',
      fallback,
      '--expires-in',
      '5m',
    ]);
    check(
      advisoryCli.code === 1 &&
        advisoryCli.stdout.trim() === '' &&
        /not_supported: no-capable-reader/.test(advisoryCli.stderr),
      `${NEW.label} \`ask --planned-fallback\` is refused as not_supported: no-capable-reader (exit 1), with no receipt`,
      tail(advisoryCli),
    );

    const auditDir = scratch('audit-4');
    const owner = await neu.call('bridgeStart', {
      name: 'owner',
      home,
      store: 'memory',
      pane: 'compat-4',
      advisory: true,
      auditDir,
    });
    const bridgeAt = Date.now();
    // The phone reads the desktop's declarations from the new relay (Dismiss needs person-declines-v1).
    await until(
      async () => {
        await nudge(tab);
        return net.find(
          (e) =>
            e.page === 'cached' &&
            e.at >= bridgeAt &&
            e.path === '/api/v1/devices' &&
            e.body?.some?.(
              (d) => d.device_id === owner.deviceId && d.features.includes('person-declines-v1'),
            ),
        );
      },
      60_000,
      "the phone to read the desktop's declarations from the new relay",
    );

    // Push: the subscription the old relay stored is kept, declares nothing, and is sent no agent-stopped push.
    // The released Notifications section reads the relay's rows each time it mounts, so leave it first.
    const NOTIFICATIONS_LEAD = 'Applies to this device straight away';
    const readSubscriptions = async (when) => {
      await goInApp(tab, '/');
      await tab
        .getByText(NOTIFICATIONS_LEAD)
        .first()
        .waitFor({ state: 'detached', timeout: 20_000 });
      const at = Date.now();
      await goInApp(tab, '/settings/notifications');
      const r = await seen(
        (e) =>
          e.page === 'cached' &&
          e.at >= at &&
          e.method === 'GET' &&
          e.path === '/api/v1/push/subscriptions' &&
          e.status === 200,
        30_000,
        `the phone to read its push subscriptions (${when})`,
      );
      return r.body?.subscriptions ?? [];
    };
    const untouched = (rows) =>
      rows.length === 1 &&
      rows[0].subscription_id === subscriptionId &&
      rows[0].enabled === true &&
      Array.isArray(rows[0].features) &&
      rows[0].features.length === 0 &&
      rows[0].last_success_at === null &&
      rows[0].last_error_code === null;
    const rows = await readSubscriptions('before an agent-stopped request');
    must(
      untouched(rows),
      `the new relay keeps the ${OLD.label} app's subscription, enabled and declaring nothing`,
      show(rows),
    );
    const refusedPush = await neu.call('bridgeAgentStopped', { name: 'owner' });
    check(
      refusedPush.outcome === 'no-subscription',
      'an agent-stopped push request finds nothing it may go to (no-subscription)',
      show(refusedPush),
    );
    const after = await readSubscriptions('after it');
    check(
      untouched(after),
      `the relay recorded no send to the ${OLD.label} app's subscription`,
      show(after),
    );

    // Advice from the library: refused for the same reason, and nothing reaches the relay.
    const advisoryLib = await neu.call('bridgeAsk', {
      name: 'owner',
      input: {
        question: advisory,
        options: [
          { id: 'mem', label: 'In memory' },
          { id: 'disk', label: 'On disk' },
        ],
        expires_in: '5m',
        planned_fallback: fallback,
      },
      awaitAdvisorySupport: true,
    });
    check(
      advisoryLib.refused?.code === 'not_supported' &&
        advisoryLib.refused.message.startsWith('no-capable-reader:'),
      `the ${NEW.label} library refuses the advisory ask as not_supported: no-capable-reader`,
      show(advisoryLib),
    );
    await neu.call('bridgePump', { name: 'owner' });
    const afterAdvice = (await neu.call('ownerQuestions', { home })).sort();
    check(
      afterAdvice.join(',') === before.join(','),
      'neither refused advisory ask put a question on the relay',
      `${show(before)} before, ${show(afterAdvice)} after`,
    );

    // Two ordinary questions, answered and declined in the cached app.
    const asked = {};
    for (const [key, question, options] of [
      [
        'A',
        'Compat 4 A: which fixture should the tests use?',
        [
          { id: 'mem', label: 'In memory' },
          { id: 'disk', label: 'On disk' },
        ],
      ],
      [
        'B',
        'Compat 4 B: rename the flag?',
        [
          { id: 'yes', label: 'Rename it' },
          { id: 'no', label: 'Keep the name' },
        ],
      ],
    ]) {
      const r = await neu.call('bridgeAsk', { name: 'owner', input: { question, options } });
      must(
        r.asked?.replyMode === 'blocking',
        `the ${NEW.label} bridge asks "${question}"`,
        show(r),
      );
      asked[key] = { id: r.asked.questionId, question };
    }
    await openOnPhone(tab, asked.A);
    await answerOnPhone(tab, /In memory/);
    const typedA = await typedFor(asked.A.id, `the ${NEW.label} bridge to type A's answer`);
    check(
      typedA.length === 1 &&
        noticeSays(typedA[0], { choice: 'mem', text: '' }, 'compat-4') &&
        typedA[0].fields.revision === '1',
      `the ${OLD.label} app answers an ordinary question, and the ${NEW.label} desktop types the answer once`,
      show(typedA),
    );
    await openOnPhone(tab, asked.B);
    await tab.locator('.ws-head').getByRole('button', { name: 'More' }).click();
    await tab.getByRole('menuitem', { name: 'Dismiss question…' }).click();
    await tab.getByRole('button', { name: 'Dismiss question' }).click();
    await tab
      .getByRole('dialog', { name: 'Dismiss this question?' })
      .waitFor({ state: 'hidden', timeout: 30_000 });
    await tab.getByText('Declined by you', { exact: true }).first().waitFor({ timeout: 30_000 });
    const typedB = await typedFor(asked.B.id, `the ${NEW.label} bridge to type B's decline`);
    check(
      typedB.length === 1 && noticeSays(typedB[0], { declined: true }, 'compat-4'),
      `the ${OLD.label} app declines an ordinary question, and the ${NEW.label} desktop types the decline once`,
      show(typedB),
    );
    // Home has synced past both, which were asked after the advisory refusals: nothing else came with them.
    await goInApp(tab, '/');
    await listed(tab, [asked.A, asked.B]);
    check(
      (await tab.locator('main').getByText(advisory).count()) === 0,
      "the refused advisory question is not on the phone's Home",
    );
    const onRelay = (await neu.call('ownerQuestions', { home })).sort();
    check(
      onRelay.join(',') === [...before, asked.A.id, asked.B.id].sort().join(','),
      'the relay holds only the two ordinary questions beside what it had',
      show(onRelay),
    );
    await stillCached('after answering and declining');
    // Every ticket the cached page got from the new relay, reconnects included (one that declares nothing is fine).
    const tickets = net.filter((e) => cachedTickets(e) && e.status === 200);
    check(
      tickets.every(
        (t) =>
          t.features === null ||
          (Array.isArray(t.features) &&
            !t.features.includes(ADVISORY) &&
            !t.features.includes(AGENT_STOPPED)),
      ),
      `the ${OLD.label} app's ${tickets.length} socket tickets on the new relay declare neither ${ADVISORY} nor ${AGENT_STOPPED}`,
      show(tickets.map((t) => t.features)),
    );

    // The phone updates in place. The browser finds the new worker while the cached page is open, so it waits; a
    // second page of the same phone then loads the new app under the old worker, and the cached page closes.
    // Not awaited in the page: an update check that stalls must not hold the wait below past its deadline.
    await tab.evaluate(() => {
      navigator.serviceWorker
        .getRegistration()
        .then((r) => r?.update())
        .catch(() => undefined);
    });
    // Polled from here: Playwright's waitForFunction takes an async predicate's promise itself as the answer.
    await until(
      () =>
        Promise.race([
          tab.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting),
          sleep(5000).then(() => false),
        ]),
      60_000,
      'the browser to install the new worker, which waits while the cached page is open',
    );
    await stillCached('once the new worker waits');
    const updated = await context.newPage();
    pages.set(updated, 'updated');
    await updated.goto(`${relay.origin}/settings/about`);
    const mixed = await updated.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        doc: window.__compatDoc,
        entry: document.querySelector('script[type="module"][src]')?.getAttribute('src'),
        waiting: !!reg?.waiting,
        oldControls: !!reg?.active && navigator.serviceWorker.controller === reg.active,
      };
    });
    must(
      mixed.entry === newEntry && mixed.waiting && mixed.oldControls && mixed.doc,
      `the phone loads the ${NEW.label} app while the ${OLD.label} service worker controls it and the new one waits`,
      show(mixed),
    );
    const mixedDoc = mixed.doc;
    await tab.close();
    // The new app asks the active worker whether it can show an agent-stopped push; the old one never answers, and
    // the app gives up after two seconds (app/src/features/push.ts WORKER_ASK_MS) and closes its end.
    await until(
      () =>
        trace.find(
          (e) =>
            e.doc === mixedDoc &&
            e.kind === 'sw-settled' &&
            e.target === 'active' &&
            !e.answered &&
            e.waiting === true,
        ),
      30_000,
      'the new app to ask the old, still-active worker what it can show, and give up waiting',
    ).catch((e) => fail(e.message));
    must(
      await updated.evaluate(
        async () => !!(await navigator.serviceWorker.getRegistration())?.waiting,
      ),
      'the new worker is still waiting',
    );
    const heldPush = await neu.call('bridgeAgentStopped', { name: 'owner' });
    check(
      heldPush.outcome === 'no-subscription',
      'while the new app runs under the old worker, an agent-stopped push still finds nothing it may go to',
      show(heldPush),
    );

    // The person applies the update: the new worker takes over, the page reloads, and the subscription declares it.
    const restartAt = Date.now();
    trace.push({ kind: 'phase', name: 'restart', at: restartAt });
    keep({ src: 'run', kind: 'phase', name: 'restart', at: restartAt });
    await updated.getByRole('button', { name: 'Restart to update' }).click();
    // The phone's own record of sending the declaration, from the page that is updating or the one it reloads into.
    const declares = (features) => Array.isArray(features) && features.includes(AGENT_STOPPED);
    const sent = await until(
      () =>
        trace.find(
          (e) =>
            e.kind === 'push-post' &&
            e.page === 'updated' &&
            e.at >= restartAt &&
            declares(e.features),
        ),
      60_000,
      'the updated phone to declare agent-stopped pushes',
    ).catch((e) => (fail(e.message), null));
    await until(
      async () => {
        const d = await docOf(updated).catch(() => null);
        return d && d !== mixedDoc;
      },
      30_000,
      'the phone to reload into the update',
    );
    await updated.waitForLoadState('load');
    // The relay's answer to it. The reload can cut off the answer to one sent just before it; one the reloaded page
    // sends is waited for, so nothing below navigates away from a declaration still on its way.
    const declared = sent
      ? await until(
          () =>
            net.find(
              (e) =>
                e.page === 'updated' &&
                e.at >= restartAt &&
                e.method === 'POST' &&
                e.path === '/api/v1/push/subscriptions' &&
                declares(e.sent?.features),
            ),
          15_000,
          "the relay's answer to the declaration",
        ).catch(() => null)
      : null;
    if (declared)
      check(
        declared.status === 201 && declared.sent.endpoint === sub.endpoint,
        `once the new worker is active, the phone declares ${AGENT_STOPPED} on its subscription`,
        show(declared),
      );
    else if (sent)
      check(
        sent.doc === mixedDoc,
        `once the new worker is active, the phone sends ${AGENT_STOPPED} on its subscription (the reload cut off the relay's answer)`,
        `sent from ${sent.doc}, the page it reloaded into, and never answered`,
      );
    const now = await updated.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return {
        entry: document.querySelector('script[type="module"][src]')?.getAttribute('src'),
        waiting: !!r?.waiting,
        controlled: !!r?.active && navigator.serviceWorker.controller === r.active,
      };
    });
    check(
      !now.waiting && now.controlled && now.entry === newEntry,
      `the phone now runs the ${NEW.label} app under the ${NEW.label} worker`,
      show(now),
    );
    // Each later page must be the new app too, or what it shows says nothing about the update.
    const onNewApp = async (what) =>
      must((await entryOf(updated)) === newEntry, `the ${NEW.label} app shows ${what}`);

    const rowsAt = Date.now();
    await updated.goto(`${relay.origin}/settings/notifications`);
    await onNewApp('its notification settings');
    const read = await seen(
      (e) =>
        e.page === 'updated' &&
        e.at >= rowsAt &&
        e.method === 'GET' &&
        e.path === '/api/v1/push/subscriptions' &&
        e.status === 200,
      30_000,
      'the updated phone to read its push subscriptions',
    );
    const declaredRows = read.body?.subscriptions ?? [];
    check(
      declaredRows.length === 1 &&
        declaredRows[0].subscription_id === subscriptionId &&
        declaredRows[0].enabled === true &&
        Array.isArray(declaredRows[0].features) &&
        declaredRows[0].features.includes(AGENT_STOPPED),
      `the relay keeps the phone's one subscription, the same one, now declaring ${AGENT_STOPPED}`,
      show(declaredRows),
    );
    if (sent) {
      // `failed` is a send the relay attempted for an eligible subscription: the phone's is the only one there is.
      const sentPush = await neu.call('bridgeAgentStopped', { name: 'owner' });
      check(
        sentPush.outcome === 'failed',
        `the relay now picks the updated phone's subscription for an agent-stopped push and tries to send it (failed: ${PUSH_HOST} never answers)`,
        show(sentPush),
      );
    }

    // The questions from before the update show as they ended, and the declined one is reopened and answered.
    const unreadable = /Not readable here|Could not verify/;
    const title = updated.locator('#q-title');
    await updated.goto(`${relay.origin}/q/${asked.A.id}`);
    await onNewApp('question A');
    await title.getByText(asked.A.question, { exact: true }).waitFor({ timeout: 30_000 });
    const answerA = updated.locator('#ws-answer');
    await answerA
      .locator('.bubble-label')
      .getByText('Your answer', { exact: true })
      .waitFor({ timeout: 30_000 });
    await answerA
      .locator('.answer-choice')
      .getByText('In memory', { exact: true })
      .waitFor({ timeout: 30_000 });
    await answerA.getByText('Typed into the terminal').first().waitFor({ timeout: 30_000 });
    check(
      !unreadable.test(await updated.locator('main').innerText()),
      `the ${NEW.label} app shows A as the person answered it in the ${OLD.label} app, typed into the terminal`,
    );
    await updated.goto(`${relay.origin}/q/${asked.B.id}`);
    await onNewApp('question B');
    await title.getByText(asked.B.question, { exact: true }).waitFor({ timeout: 30_000 });
    await updated
      .locator('main')
      .getByText('Declined by you', { exact: true })
      .first()
      .waitFor({ timeout: 30_000 });
    check(
      !unreadable.test(await updated.locator('main').innerText()),
      `the ${NEW.label} app shows B, declined in the ${OLD.label} app, as declined by the person`,
    );
    const reopenedB = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
    const rb = await neu.call('ownerReopen', {
      home,
      questionId: asked.B.id,
      expectedRevision: 0,
      expiresAt: reopenedB,
    });
    must(rb.status === 'open' && rb.revision === 1, `the ${NEW.label} owner reopens B`, show(rb));
    await updated.getByText('Reopened by your agent').first().waitFor({ timeout: 30_000 });
    await answerOnPhone(updated, /Keep the name/);
    const answeredB = await until(
      async () => {
        const v = await neu.call('bridgeView', { name: 'owner', questionId: asked.B.id });
        return v.status === 'human-answered' && v.revision === 2 ? v : null;
      },
      30_000,
      `the ${NEW.label} bridge to read B's answer`,
    );
    check(
      answeredB.provenance === 'human' && answeredB.choice === 'no',
      "getDecision reports the answer to B's reopened round",
      show(answeredB),
    );
    await until(
      async () =>
        notices(await neu.call('bridgeState', { name: 'owner' }), asked.B.id).some(
          (n) => n.fields.revision === '2',
        ),
      30_000,
      `the ${NEW.label} bridge to type the answer to B's reopened round`,
    ).catch((e) => fail(e.message));
    // The relay's row once more, at the end: nothing since disabled, removed or withdrew it.
    const endAt = Date.now();
    await updated.goto(`${relay.origin}/settings/notifications`);
    await onNewApp('its notification settings again');
    const last = await seen(
      (e) =>
        e.page === 'updated' &&
        e.at >= endAt &&
        e.method === 'GET' &&
        e.path === '/api/v1/push/subscriptions' &&
        e.status === 200,
      30_000,
      'the updated phone to read its push subscriptions at the end',
    );
    const lastRows = last.body?.subscriptions ?? [];
    check(
      lastRows.length === 1 &&
        lastRows[0].subscription_id === subscriptionId &&
        lastRows[0].enabled === true &&
        Array.isArray(lastRows[0].features) &&
        lastRows[0].features.includes(AGENT_STOPPED),
      `at the end the relay still holds the phone's one subscription, enabled and declaring ${AGENT_STOPPED}`,
      show(lastRows),
    );
    const final = await settled(neu, 'owner');
    const all = { A: notices(final, asked.A.id), B: notices(final, asked.B.id) };
    const roundTwo = all.B.filter((n) => n.fields.revision === '2');
    check(
      all.A.length === 1 &&
        all.B.length === 2 &&
        all.B.filter((n) => noticeSays(n, { declined: true }, 'compat-4')).length === 1 &&
        roundTwo.length === 1 &&
        noticeSays(roundTwo[0], { choice: 'no', text: '' }, 'compat-4'),
      `through the whole run the ${NEW.label} desktop typed A's answer once, B's decline once, and the answer to B's reopened round once`,
      show(all),
    );

    // The whole trace, now that nothing more is asked of the phone.
    await drained();
    const judged = judgeDeclarations(trace, sub, { mixedDoc, requests: subscriptionPosts });
    for (const problem of judged.problems) fail(problem);
    check(
      subscriptionDeletes === 0,
      "neither app removed the phone's subscription from the relay",
      `${subscriptionDeletes} removed`,
    );
    if (!judged.problems.length)
      ok(
        `the trace agrees: one subscription, declared only by the updated app once the new worker said it can show the push (${trace.length} entries, ${subscriptionPosts} sent)`,
      );
    check(
      pageErrors.length === 0,
      'neither app had an uncaught error',
      show(pageErrors.map((e) => e.message)),
    );
    checkBridgeHealth(final, `the ${NEW.label} bridge`);
  } catch (e) {
    // What each page showed when the scenario stopped, beside phone-4.jsonl.
    const browserNow = await browser?.launched.catch(() => null);
    let n = 0;
    for (const context of browserNow?.contexts() ?? [])
      for (const page of context.pages()) {
        n++;
        await page
          .screenshot({
            path: join(logs, `phone-4-page-${n}.png`),
            fullPage: true,
            timeout: 10_000,
          })
          .catch(() => undefined);
        const text = await page
          .locator('body')
          .innerText({ timeout: 2000 })
          .catch(() => '');
        keep({ src: 'stopped', page: n, path: pathOf(page.url()), text: text.slice(0, 3000) });
      }
    throw e;
  } finally {
    await neu.stop();
    await browser?.stop();
    await relay.stop();
    await drained();
    await new Promise((r) => phoneLog.end(r));
  }
}

/* ---------------------------------------------------------------- run */

const SCENARIOS = [
  [1, 'the old desktop against the new relay', oldDesktopNewRelay],
  [2, 'the new desktop against the old relay', newDesktopOldRelay],
  [3, 'an old host with open questions moves to the new version, then its relay does', hostUpgrade],
  [4, 'a phone with the old app cached, while its relay and then the app update', cachedPhone],
];

const stopAll = async () => {
  for (const h of [...running]) await h.stop().catch(() => undefined);
};
const onSignal = (code) => () => {
  shuttingDown = true;
  void stopAll().then(() => process.exit(code));
};
process.on('SIGINT', onSignal(130));
process.on('SIGTERM', onSignal(143));
process.on('SIGHUP', onSignal(129));

let OLD;
let NEW;
/** Scenarios that did not apply to these versions (a scenario's `run` returned 'skipped'): never counted as run. */
const skipped = [];
const started = Date.now();
try {
  // A missing browser is said now, not after the installs; scenario 4 fails on it only once it applies.
  if (!opts.only || opts.only.has(4))
    try {
      loadChromium();
    } catch (e) {
      console.log(`\n  warning: ${e.message}`);
    }
  OLD = prepareSide('old', opts.old);
  NEW = prepareSide('new', opts.new);
  const oldRelay = await stageReleasedRelay(opts.old, OLD);
  const newRelay = stageInstalledRelay(NEW);
  let ran = 0;
  for (const [n, title, run] of SCENARIOS) {
    if (opts.only && !opts.only.has(n)) continue;
    ran++;
    current = `${n}`;
    step(`${n}. ${title} (${OLD.label} ${opts.old}, ${NEW.label} ${NEW.from})`);
    try {
      const result = await run({ OLD, NEW, oldRelay, newRelay, port: opts.port + (n - 1) * 10 });
      if (result === 'skipped') {
        ran--;
        skipped.push(n);
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      await stopAll();
    }
  }
  current = 'run';
  if (ran === 0)
    fail(`no scenario ran${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await stopAll();
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  const record = (side, label) =>
    side
      ? `${label}: ${side.from}\n${Object.entries(side.integrity)
          .map(
            ([name, sum]) => `  ${name}@${side.versions[name]} ${sum ?? '(no integrity recorded)'}`,
          )
          .join('\n')}`
      : `${label}: not installed`;
  console.log(`\n${record(OLD, 'old')}\n${record(NEW, 'new')}\n${minutes} min, logs in ${logs}`);
  if (skipped.length)
    console.log(`Skipped scenario ${skipped.join(', ')}: it does not apply to these versions`);
  if (opts.keep || failures.length) console.log(`Kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\ncompat-check failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\ncompat-check passed');
