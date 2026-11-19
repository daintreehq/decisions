/**
 * The real phone app for compat-check's scenario 4: Chromium through the e2e package's playwright-core, the fixture
 * every document of the phone's browser gets, and the judgement of what that browser declared about agent-stopped
 * pushes. Nothing here starts anything on import.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const AGENT_STOPPED = 'agent-stopped-push-v1';

/**
 * The push service host the phone subscribes to: a reserved name (RFC 6761) that never resolves, which the relays of
 * scenario 4 accept through `PUSH_ENDPOINT_ALLOW`. A push the relay sends there fails as a network error, which
 * leaves the subscription enabled (worker/src/jobs/notify.ts), and reaches no real push service.
 */
export const PUSH_HOST = 'push.compat-check.invalid';

/**
 * Chromium and the playwright-core that drives it, from the e2e package (the workspace root does not depend on it):
 * `E2E_CHROMIUM` when set, as for the e2e suite, otherwise the build that playwright-core installs.
 */
export function loadChromium() {
  let pw;
  try {
    pw = createRequire(new URL('../../e2e/package.json', import.meta.url))('playwright-core');
  } catch (e) {
    throw new Error(
      `scenario 4 needs playwright-core from the e2e package; run \`pnpm install\` first (${e.message})`,
    );
  }
  const executablePath = process.env.E2E_CHROMIUM || pw.chromium.executablePath();
  if (!executablePath || !existsSync(executablePath))
    throw new Error(
      `scenario 4 needs Chromium, and there is none at ${executablePath}: install it with ` +
        '`pnpm --filter @daintreehq/decisions-e2e exec playwright-core install chromium`, ' +
        'or set E2E_CHROMIUM to a Chromium or Chrome executable',
    );
  return { chromium: pw.chromium, executablePath };
}

/** A push subscription for the phone: an endpoint on `PUSH_HOST`, a real P-256 public key and 16 auth bytes. */
export function pushSubscription() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(x, 'base64url'),
    Buffer.from(y, 'base64url'),
  ]);
  return {
    endpoint: `https://${PUSH_HOST}/compat/${randomBytes(12).toString('base64url')}`,
    p256dh: raw.toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

/** The module script a staged relay's app loads (`app/index.html`): which build a page is running. */
export function entryScript(relayDir) {
  const html = readFileSync(join(relayDir, 'app/index.html'), 'utf8');
  const m = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/);
  if (!m) throw new Error(`no module script in ${join(relayDir, 'app/index.html')}`);
  return m[1];
}

/**
 * Runs in every document of the phone's browser context before the app's own scripts (Playwright `addInitScript`),
 * so it must be self-contained. Headless Chromium has no push service, so `PushManager` hands out `sub` instead: none
 * until the app subscribes, then the same one in every document of the context. Everything else passes through,
 * reported to the `__compatTrace` binding: each subscription the app sends the relay, as it starts; each message it
 * posts a service worker; for a `FEATURES` question, the answer the worker gave the app and when the app stopped
 * waiting for one (it closes its end of the channel). Each entry carries the registration's workers as this document
 * saw them at that moment (`waiting` is null when the registration is not known yet), and a subscription also what
 * the active worker had answered the app (`activeAnswered`), so a later change cannot hide which worker the app acted
 * under.
 */
export function phoneFixture(sub) {
  const doc = Math.random().toString(36).slice(2, 10);
  Object.defineProperty(window, '__compatDoc', { value: doc });
  const report = (entry) => {
    try {
      const sent = window.__compatTrace?.({
        ...entry,
        doc,
        path: location.pathname,
        at: Date.now(),
      });
      sent?.catch?.(() => undefined);
    } catch {
      /* the page is going */
    }
  };
  report({ kind: 'doc' });

  let reg = null;
  const remember = (r) => {
    if (r) reg = r;
    return r;
  };
  if (typeof ServiceWorkerContainer !== 'undefined' && navigator.serviceWorker) {
    navigator.serviceWorker.getRegistration().then(remember, () => undefined);
    const register = ServiceWorkerContainer.prototype.register;
    ServiceWorkerContainer.prototype.register = function (...args) {
      return register.apply(this, args).then(remember);
    };
  }
  const workers = () => ({
    waiting: reg ? !!reg.waiting : null,
    installing: reg ? !!reg.installing : null,
    active: reg?.active?.state ?? null,
  });
  const role = (w) =>
    !reg
      ? 'unknown'
      : w === reg.active
        ? 'active'
        : w === reg.waiting
          ? 'waiting'
          : w === reg.installing
            ? 'installing'
            : 'other';
  // The answers each worker gave the app's `FEATURES` question, read from the app's own channel (the app keeps one
  // end and transfers the other), so nothing here asks a worker anything itself.
  const answered = new WeakMap();
  const ends = new WeakMap();
  const asking = new WeakMap();
  if (typeof MessageChannel !== 'undefined') {
    const Channel = window.MessageChannel;
    const Tracked = function MessageChannel() {
      const ch = new Channel();
      // Whichever end the app sends, it keeps the other.
      ends.set(ch.port2, ch.port1);
      ends.set(ch.port1, ch.port2);
      return ch;
    };
    Tracked.prototype = Channel.prototype;
    window.MessageChannel = Tracked;
    const close = MessagePort.prototype.close;
    MessagePort.prototype.close = function () {
      const q = asking.get(this);
      if (q && !q.settled) {
        q.settled = true;
        const state = workers();
        // The app closes its end from its own handler of the reply, before this fixture's listener for the same
        // message has run: report once that dispatch is over, so a reply is never taken for silence.
        setTimeout(() =>
          report({ kind: 'sw-settled', target: q.target, answered: q.answered, ...state }),
        );
      }
      return close.call(this);
    };
  }
  if (typeof ServiceWorker !== 'undefined') {
    const post = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (message, ...rest) {
      const type = typeof message?.type === 'string' ? message.type : null;
      const target = role(this);
      const state = workers();
      // Sent first: a message the browser refused is not one the app sent.
      const result = post.call(this, message, ...rest);
      report({ kind: 'sw-message', type, target, ...state });
      const list = rest[0]?.[Symbol.iterator] ? rest[0] : (rest[0]?.transfer ?? []);
      const mine = type === 'FEATURES' ? [...list].map((p) => ends.get(p)).find(Boolean) : null;
      if (mine) {
        const worker = this;
        const q = { worker, target, settled: false, answered: false };
        asking.set(mine, q);
        mine.addEventListener('message', (e) => {
          const features = Array.isArray(e.data?.features) ? e.data.features : [];
          q.answered = true;
          answered.set(worker, features);
          report({ kind: 'sw-answer', target, features, ...workers() });
        });
      }
      return result;
    };
  }

  const KEY = 'compat-check-push-subscription';
  const bytes = (s) =>
    Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
  const subscription = () => ({
    endpoint: sub.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null },
    getKey: (name) =>
      name === 'p256dh' ? bytes(sub.p256dh) : name === 'auth' ? bytes(sub.auth) : null,
    toJSON: () => ({
      endpoint: sub.endpoint,
      expirationTime: null,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    }),
    unsubscribe: async () => {
      localStorage.removeItem(KEY);
      report({ kind: 'unsubscribe' });
      return true;
    },
  });
  if (typeof PushManager !== 'undefined') {
    PushManager.prototype.subscribe = async function () {
      localStorage.setItem(KEY, '1');
      report({ kind: 'subscribe' });
      return subscription();
    };
    PushManager.prototype.getSubscription = async function () {
      return localStorage.getItem(KEY) ? subscription() : null;
    };
    PushManager.prototype.permissionState = async function () {
      return 'granted';
    };
  }

  const fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = String(
        init?.method ?? (input instanceof Request ? input.method : 'GET'),
      ).toUpperCase();
      if (method === 'POST' && url.pathname === '/api/v1/push/subscriptions') {
        let body = null;
        try {
          body = JSON.parse(String(init?.body));
        } catch {
          /* reported as a body with nothing in it */
        }
        if (!body || typeof body !== 'object') body = {};
        report({
          kind: 'push-post',
          endpoint: body.endpoint ?? null,
          p256dh: body.p256dh ?? null,
          auth: body.auth ?? null,
          features:
            'features' in body
              ? Array.isArray(body.features)
                ? body.features
                : 'not a list'
              : null,
          ...workers(),
          activeAnswered: reg?.active ? (answered.get(reg.active) ?? null) : null,
        });
      }
    } catch {
      /* never in the app's way */
    }
    // Always on the window: called as another object's method, the browser's fetch throws "Illegal invocation".
    return fetch.apply(window, arguments);
  };
}

/**
 * What the phone's trace says about its agent-stopped declaration (`phoneFixture` entries, plus the run's own
 * `{ kind: 'phase', name: 'restart', at }` from just before the person applied the update). `mixedDoc` is the document
 * the run saw load the new app while the old worker was still active and the new one waited; `requests` is how many
 * subscriptions the browser itself saw the phone send, so a trace that lost one is not taken as complete. Every
 * problem is listed:
 * - the phone subscribes once, keeps that subscription, and the released app sent it before the update;
 * - in `mixedDoc`, before the update was applied, the app asked the active (old) worker what it can show, and that
 *   question settled with no answer;
 * - no subscription declares the push before the update is applied, nor unless, when it was sent, nothing was
 *   waiting and the active worker had told the app it can show one;
 * - the updated phone declares, and nothing sent after the declaration withdraws it.
 */
export function judgeDeclarations(trace, sub, { mixedDoc, requests } = {}) {
  const problems = [];
  const restart = trace.find((e) => e.kind === 'phase' && e.name === 'restart');
  if (!restart) problems.push('the trace has no restart: the update was never applied');
  const restartAt = restart?.at ?? Infinity;

  const subscribes = trace.filter((e) => e.kind === 'subscribe');
  if (subscribes.length !== 1)
    problems.push(
      `the phone subscribed ${subscribes.length} times; it subscribes once and keeps that subscription`,
    );
  if (trace.some((e) => e.kind === 'unsubscribe'))
    problems.push('the phone dropped its push subscription');

  const posts = trace.filter((e) => e.kind === 'push-post');
  if (requests !== undefined && posts.length < requests)
    problems.push(
      `the browser saw ${requests} subscriptions sent, but the trace has ${posts.length}: it is incomplete`,
    );
  for (const p of posts)
    if (p.endpoint !== sub.endpoint || p.p256dh !== sub.p256dh || p.auth !== sub.auth)
      problems.push(`a subscription sent at ${p.at} names another endpoint or other keys`);
  const subscribedAt = subscribes[0]?.at ?? Infinity;
  if (!posts.some((p) => p.at >= subscribedAt && p.at < restartAt && p.features === null))
    problems.push('the released app never sent its subscription');

  const declares = (p) => Array.isArray(p.features) && p.features.includes(AGENT_STOPPED);
  const canShow = (p) =>
    Array.isArray(p.activeAnswered) && p.activeAnswered.includes(AGENT_STOPPED);
  for (const p of posts) {
    if (p.features !== null && !Array.isArray(p.features))
      problems.push(`a subscription sent at ${p.at} has features that are not a list`);
    if (!declares(p)) continue;
    const where = `a subscription sent at ${p.at} (${p.path}) declared ${AGENT_STOPPED}`;
    if (p.at < restartAt) problems.push(`${where} before the update was applied`);
    if (p.waiting !== false)
      problems.push(
        p.waiting
          ? `${where} while the new worker was still waiting`
          : `${where} with the worker state unknown`,
      );
    if (!canShow(p))
      problems.push(`${where} though the active worker had not told the app it can show one`);
  }

  const inMixed = (e) => e.doc === mixedDoc && e.at < restartAt && e.target === 'active';
  const asked = trace.find((e) => e.kind === 'sw-message' && e.type === 'FEATURES' && inMixed(e));
  if (!mixedDoc || !asked)
    problems.push(
      'the updated page under the old worker was not seen asking that worker what it can show before the update was applied',
    );
  const settled = trace.find((e) => e.kind === 'sw-settled' && inMixed(e));
  if (asked && !settled)
    problems.push(
      'the question to the old worker was not seen to settle before the update was applied',
    );
  if (trace.some((e) => e.kind === 'sw-answer' && inMixed(e) && declares(e)))
    problems.push(`the old worker answered that it can show ${AGENT_STOPPED}`);

  const declaration =
    posts.find((p) => declares(p) && p.at >= restartAt && p.waiting === false && canShow(p)) ??
    null;
  if (!declaration) problems.push(`the updated phone never declared ${AGENT_STOPPED}`);
  else {
    const i = posts.indexOf(declaration);
    const withdrawn = posts.find(
      (p, j) =>
        j !== i && !declares(p) && (p.at > declaration.at || (p.at === declaration.at && j > i)),
    );
    if (withdrawn)
      problems.push(
        `a subscription sent at ${withdrawn.at} (${withdrawn.path}) after the declaration withdraws it`,
      );
  }
  return { problems, declaration, asked: asked ?? null, settled: settled ?? null };
}
