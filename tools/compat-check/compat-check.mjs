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
 *    with `get` and `wait`. An advisory ask is refused as `not_supported: relay-unsupported` by the CLI and by the
 *    library, and asks nothing. An agent-stopped push request reports `unsupported`. The library's ordinary
 *    questions are answered and declined.
 * 3. An old host with open questions moves to the new version, then its relay does. The new host reads the old
 *    host's state directory: questions asked before the upgrade are answered, and a reopen made before it keeps its
 *    signed deadline. The relay is then replaced by the new one on the same storage: a question asked before both
 *    upgrades expires there, is reopened and is answered in its new round.
 *
 * Needs the network (npm and GitHub), Node 22.15 or later, and the workspace's dependencies (it runs the workspace's
 * Wrangler). It takes a few minutes: scenario 3 waits for a real deadline.
 *
 * Usage: node tools/compat-check/compat-check.mjs [--old <version>] [--new packed|<version>] [--no-build]
 *          [--only <1,2,3>] [--port <base>] [--keep]
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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPackages, installConsumer, packPackage } from '../pack-check/pack.mjs';
import { REPOSITORY, isValidVersion, listWorkspace } from '../release/workspace.mjs';

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
    else if (a === '--only') o.only = new Set(value().split(',').map(Number));
    else if (a === '--port') o.port = Number(value());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!isValidVersion(o.old)) throw new Error(`--old ${o.old} is not a version`);
  if (o.new !== 'packed' && !isValidVersion(o.new))
    throw new Error(`--new must be "packed" or a version, got ${o.new}`);
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 60_000)
    throw new Error('--port must be a port number from 1024 to 60000');
  return o;
}

const opts = parseArgs(process.argv.slice(2));
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
    bin: join(dir, 'node_modules/@daintreehq/decisions-cli/dist/bin.js'),
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

/** `wrangler dev` on a staged relay, with its own storage; `persist` may be reused to upgrade in place. */
async function startRelay(dir, port, persist, label) {
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
  const stop = () =>
    new Promise((done) => {
      running.delete(handle);
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once('exit', () => done());
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }, 5000).unref();
    });
  const handle = { stop };
  running.add(handle);
  const origin = `http://127.0.0.1:${port}`;
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error(`wrangler dev (${label}) exited early`);
      return fetch(`${origin}/health`)
        .then((r) => r.ok)
        .catch(() => false);
    },
    90_000,
    `relay ${label} to start (log: ${join(logs, `relay-${label}.log`)})`,
  );
  return { origin, label, stop };
}

async function info(origin) {
  return (await fetch(`${origin}/api/v1/info`)).json();
}

/** One side's actor.mjs as a child process, answering `call(op, args)`. */
function startActor(side, label) {
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
  child.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error(`${label} exited (${code})`));
    pending.clear();
  });
  const call = (op, args = {}, timeoutMs = 60_000) =>
    new Promise((resolve_, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${label}.${op} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve_(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.send({ id, op, args });
    });
  const stop = () =>
    new Promise((done) => {
      running.delete(handle);
      if (child.exitCode !== null) return done();
      child.once('exit', () => done());
      child.disconnect();
      setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
    });
  const handle = { stop };
  running.add(handle);
  return { call, stop, label };
}

/** Runs one side's `decisions` CLI on a state directory; `onLine` sees each line of stdout as it comes. */
function cli(side, home, argv, { env = {}, timeoutMs = 120_000, onLine } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [side.bin, '--home', home, ...argv], {
      cwd: side.dir,
      env: { ...process.env, DECISIONS_HOME: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
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
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
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
    });
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

const notices = (state, questionId) =>
  state.typed.filter((t) => t.text.includes(`question_id: ${questionId}`));

/** Audit events (packages/client/src/audit.ts callers) that say something went wrong. */
const PROBLEMS = new Set([
  'event.rejected',
  'event.error',
  'inject.threw',
  'inject.unavailable',
  'delivery.attention',
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
        const q = await neu.call('phoneQuestion', { name: 'phone', questionId: id });
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
    const typed1 = existsSync(sink) ? readFileSync(sink, 'utf8') : '';
    check(
      answered.code === 0 &&
        typed1.includes(`question_id: ${answered.questionId}`) &&
        typed1.includes('choice: mem') &&
        typed1.includes('Compat answer one') &&
        typed1.includes('source: human'),
      `old \`ask --wait\` receives the person's answer and writes it to its sink`,
      `${tail(answered)}; sink: ${typed1.slice(-400)}`,
    );

    const declined = await cliAsk(
      OLD,
      home,
      ['--json', 'ask', 'Compat 1: rename the flag?', '--wait', '--sink', `file:${sink}`],
      async (id) => {
        const q = await neu.call('phoneQuestion', { name: 'phone', questionId: id });
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
    const typed2 = readFileSync(sink, 'utf8').slice(typed1.length);
    check(
      declined.code === 0 &&
        typed2.includes(`question_id: ${declined.questionId}`) &&
        typed2.includes('status: declined'),
      `old \`ask --wait\` receives the person's decline and writes it to its sink`,
      `${tail(declined)}; sink: ${typed2.slice(-400)}`,
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
    const advOnPhone = await neu.call('phoneQuestion', { name: 'phone', questionId: advId });
    must(
      advOnPhone.reply_mode === 'advisory',
      'the relay commits it as advisory',
      show(advOnPhone),
    );
    const plain = await neu.call('bridgeAsk', {
      name: 'host',
      input: { question: 'Compat 1: a blocking question from the new host' },
    });
    must(
      plain.asked,
      `the ${NEW.label} Remote Host asks an ordinary question after it`,
      show(plain),
    );
    const plainId = plain.asked.questionId;
    await neu.call('phoneQuestion', { name: 'phone', questionId: plainId });

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
      const q = await neu.call('phoneQuestion', { name: 'phone', questionId: id });
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
    const state = await until(
      async () => {
        const s = await old.call('bridgeState', { name: 'owner' });
        return own.every((q) => notices(s, q.id).length > 0) ? s : null;
      },
      45_000,
      `the ${OLD.label} bridge to type both outcomes`,
    ).catch(async (e) => {
      fail(`${e.message}: ${show(await old.call('bridgeState', { name: 'owner' }))}`);
      return old.call('bridgeState', { name: 'owner' });
    });
    for (const q of own) {
      const typed = notices(state, q.id);
      const want = q.act === 'answer' ? 'Compat answer two' : 'status: declined';
      check(
        typed.length === 1 && typed[0].text.includes(want),
        `the ${OLD.label} bridge types the ${q.act} once, into its own pane`,
        show(typed),
      );
    }
    check(
      notices(state, advId).length === 0 && notices(state, plainId).length === 0,
      `the ${OLD.label} bridge types nothing for the Remote Host's questions`,
    );

    // The old protocol's own reader: refuses the advisory question, reads everything else.
    const ledger = await old.call('readLedger', {
      home,
      features: owner.features,
      questionIds: [advId, plainId, ...own.map((q) => q.id)],
    });
    const a = ledger.questions[advId];
    check(
      a.inLedger && !a.created && !a.detail,
      `${OLD.label}'s EventData.created and QuestionDetail refuse the advisory question (${a.createdIssue}; ${a.detailIssue})`,
      show(a),
    );
    for (const id of [plainId, ...own.map((q) => q.id)]) {
      const r = ledger.questions[id];
      check(r.inLedger && r.created && r.detail, `${OLD.label} reads question ${id}`, show(r));
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
    const features = (await info(relay.origin)).features ?? [];
    must(
      !features.includes(ADVISORY) && !features.includes(AGENT_STOPPED),
      `the ${OLD.label} relay advertises neither ${ADVISORY} nor ${AGENT_STOPPED}`,
      show(features),
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
        const q = await neu.call('phoneQuestion', { name: 'phone', questionId: id });
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
    const ar = answered.json.find((j) => j.record === 'result');
    check(
      answered.code === 0 &&
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
        const q = await neu.call('phoneQuestion', { name: 'phone', questionId: id });
        return neu.call('phoneDecline', {
          name: 'phone',
          questionId: id,
          revision: q.revision,
          publisher: q.originating_device_id,
        });
      },
      { timeoutMs: 150_000 },
    );
    const dr = declined.json.find((j) => j.record === 'result');
    check(
      declined.code === 10 && dr?.outcome === 'declined' && dr.closed_reason === 'declined',
      `${NEW.label} \`ask --wait\` reports the person's decline (exit 10)`,
      `${tail(declined)}; ${show(dr)}`,
    );
    for (const [id, outcome, code] of [
      [answered.questionId, 'answered', 0],
      [declined.questionId, 'declined', 10],
    ]) {
      const got = await cli(NEW, home, ['--json', 'get', id]);
      check(
        got.code === 0 && got.last?.outcome === outcome,
        `\`decisions get\` finds the ${outcome} question again`,
        `${tail(got)}; ${show(got.last)}`,
      );
      const waited = await cli(NEW, home, ['--json', 'wait', id], { timeoutMs: 60_000 });
      check(
        waited.code === code && waited.last?.outcome === outcome,
        `\`decisions wait\` reports the ${outcome} question (exit ${code})`,
        `${tail(waited)}; ${show(waited.last)}`,
      );
    }

    const before = await neu.call('ownerQuestions', { home });
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
        advisoryCli.stderr.includes('not_supported') &&
        advisoryCli.stderr.includes('relay-unsupported'),
      `${NEW.label} \`ask --planned-fallback\` is refused as not_supported: relay-unsupported (exit 1)`,
      tail(advisoryCli),
    );

    const auditDir = scratch('audit-2');
    await neu.call('bridgeStart', {
      name: 'owner',
      home,
      store: 'memory',
      pane: 'compat-2-owner',
      advisory: true,
      auditDir,
    });
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
    const after = await neu.call('ownerQuestions', { home });
    check(
      after.length === before.length,
      'neither refused advisory ask put a question on the relay',
      `${before.length} before, ${after.length} after`,
    );
    const push = await neu.call('bridgeAgentStopped', { name: 'owner' });
    check(
      push.outcome === 'unsupported',
      `an agent-stopped push request reports unsupported`,
      show(push),
    );

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
      const q = await neu.call('phoneQuestion', { name: 'phone', questionId: id });
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
    const state = await until(
      async () => {
        const s = await neu.call('bridgeState', { name: 'owner' });
        return own.every((q) => notices(s, q.id).length > 0) ? s : null;
      },
      45_000,
      `the ${NEW.label} bridge to type both outcomes`,
    ).catch(async (e) => {
      fail(e.message);
      return neu.call('bridgeState', { name: 'owner' });
    });
    for (const q of own) {
      const typed = notices(state, q.id);
      const want = q.act === 'answer' ? 'Compat answer four' : 'status: declined';
      check(
        typed.length === 1 && typed[0].text.includes(want),
        `the ${NEW.label} bridge types the ${q.act} once`,
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
    const A = await ask('Compat 3 A: keep the cache?');
    const shortDeadline = new Date(Date.now() + SHORT_DEADLINE_MS).toISOString();
    const B = await ask('Compat 3 B: rename the flag?', { expires_at: shortDeadline });
    const C = await ask('Compat 3 C: split the module?');
    const onPhone = {};
    for (const id of [A, B, C]) {
      onPhone[id] = await neu.call('phoneQuestion', { name: 'phone', questionId: id });
      must(onPhone[id].status === 'open', `question ${id} is open on the ${OLD.label} relay`);
    }
    check(
      onPhone[B].expires_at === shortDeadline,
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
    await neu.call('phoneQuestion', {
      name: 'phone',
      questionId: C,
      want: { status: 'cancelled' },
    });
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
    const answeredA = await until(
      async () => {
        const s = await neu.call('bridgeState', { name: 'post' });
        return notices(s, A).length ? s : null;
      },
      30_000,
      `the ${NEW.label} host to type A's answer`,
    );
    check(
      notices(answeredA, A)[0].text.includes('Compat answer A'),
      `the ${NEW.label} host types the answer to a question asked before the upgrade`,
      show(notices(answeredA, A)),
    );
    const viewA = await neu.call('bridgeView', { name: 'post', questionId: A });
    check(
      viewA.status === 'human-answered' && viewA.provenance === 'human' && viewA.revision === 1,
      'getDecision reports A answered by the person',
      show(viewA),
    );

    // The relay moves to the new version on the same storage, as `decisions update` does.
    const left = Date.parse(shortDeadline) - Date.now();
    must(
      left > 15_000,
      `B is still open when the relay is upgraded (${Math.round(left / 1000)} s left)`,
    );
    await relay.stop();
    relay = await startRelay(newRelay, port, persist, '3-new');
    const features = (await info(relay.origin)).features ?? [];
    must(features.includes(ADVISORY), `the relay now runs the ${NEW.label} bundle`, show(features));
    const stillB = await neu.call('phoneQuestion', { name: 'phone', questionId: B });
    must(
      stillB.status === 'open' && stillB.expires_at === shortDeadline,
      `the ${NEW.label} relay keeps B open from the ${OLD.label} relay's storage`,
      show(stillB),
    );

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
    const typedB = await until(
      async () => {
        const s = await neu.call('bridgeState', { name: 'post' });
        return notices(s, B).length ? notices(s, B) : null;
      },
      20_000,
      `the ${NEW.label} host to type B's expiry`,
    );
    check(
      typedB.length === 1 &&
        typedB[0].text.includes('status: expired') &&
        !typedB[0].text.includes('advisory'),
      `the ${NEW.label} host types B's expiry once, as an expiry`,
      show(typedB),
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
    const final = await neu.call('bridgeState', { name: 'post' });
    check(
      notices(final, C).some((t) => t.text.includes('Compat answer C')) &&
        notices(final, B).some((t) => t.text.includes('Compat answer B')),
      `the ${NEW.label} host types the answers to both reopened rounds`,
      show([...notices(final, B), ...notices(final, C)]),
    );
    checkBridgeHealth(final, `the ${NEW.label} host`);
  } finally {
    await old.stop();
    await neu.stop();
    await relay.stop();
  }
}

/* ---------------------------------------------------------------- run */

const SCENARIOS = [
  [1, 'the old desktop against the new relay', oldDesktopNewRelay],
  [2, 'the new desktop against the old relay', newDesktopOldRelay],
  [3, 'an old host with open questions moves to the new version, then its relay does', hostUpgrade],
];

const stopAll = async () => {
  for (const h of [...running]) await h.stop().catch(() => undefined);
};
process.on('SIGINT', () => void stopAll().then(() => process.exit(130)));
process.on('SIGTERM', () => void stopAll().then(() => process.exit(143)));

let OLD;
let NEW;
const started = Date.now();
try {
  OLD = prepareSide('old', opts.old);
  NEW = prepareSide('new', opts.new);
  const oldRelay = await stageReleasedRelay(opts.old, OLD);
  const newRelay = stageInstalledRelay(NEW);
  for (const [n, title, run] of SCENARIOS) {
    if (opts.only && !opts.only.has(n)) continue;
    current = `${n}`;
    step(`${n}. ${title} (${OLD.label} ${opts.old}, ${NEW.label} ${NEW.from})`);
    try {
      await run({ OLD, NEW, oldRelay, newRelay, port: opts.port + (n - 1) * 10 });
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      await stopAll();
    }
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await stopAll();
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  console.log(
    `\nold: ${OLD ? `${OLD.from} ${show(OLD.integrity)}` : 'not installed'}\nnew: ${NEW ? NEW.from : 'not installed'}\n${minutes} min, logs in ${logs}`,
  );
  if (opts.keep || failures.length) console.log(`Kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\ncompat-check failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\ncompat-check passed');
