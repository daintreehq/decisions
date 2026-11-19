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
 * reported to the `__compatTrace` binding as it starts: each subscription the app sends the relay, each message it
 * posts a service worker, and the registration's workers at that moment, read synchronously so a later change cannot
 * hide which worker was active when the app acted.
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
    waiting: !!reg?.waiting,
    installing: !!reg?.installing,
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
  if (typeof ServiceWorker !== 'undefined') {
    const post = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (message, ...rest) {
      report({
        kind: 'sw-message',
        type: typeof message?.type === 'string' ? message.type : null,
        target: role(this),
        ...workers(),
      });
      return post.call(this, message, ...rest);
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
        report({
          kind: 'push-post',
          endpoint: body?.endpoint ?? null,
          p256dh: body?.p256dh ?? null,
          auth: body?.auth ?? null,
          features:
            body && 'features' in body
              ? Array.isArray(body.features)
                ? body.features
                : 'not a list'
              : null,
          ...workers(),
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
 * `{ kind: 'phase', name: 'restart', at }` from just before the person applied the update). Every problem is listed:
 * the phone subscribes once and keeps that subscription; no subscription it sends declares the push before the
 * update is applied, or while the new worker still waits; the updated page under the old worker was seen asking that
 * worker what it can show; the updated phone declares; and nothing sent after the declaration withdraws it.
 */
export function judgeDeclarations(trace, sub) {
  const problems = [];
  const restart = trace.find((e) => e.kind === 'phase' && e.name === 'restart');
  if (!restart) problems.push('the trace has no restart: the update was never applied');
  const restartAt = restart?.at ?? Infinity;

  const subscribes = trace.filter((e) => e.kind === 'subscribe').length;
  if (subscribes !== 1)
    problems.push(
      `the phone subscribed ${subscribes} times; it subscribes once and keeps that subscription`,
    );
  if (trace.some((e) => e.kind === 'unsubscribe'))
    problems.push('the phone dropped its push subscription');

  const posts = trace.filter((e) => e.kind === 'push-post');
  for (const p of posts)
    if (p.endpoint !== sub.endpoint || p.p256dh !== sub.p256dh || p.auth !== sub.auth)
      problems.push(`a subscription sent at ${p.at} names another endpoint or other keys`);
  if (!posts.some((p) => p.at < restartAt && p.features === null))
    problems.push('the released app never sent its subscription');

  const declares = (p) => Array.isArray(p.features) && p.features.includes(AGENT_STOPPED);
  for (const p of posts) {
    if (p.features !== null && !Array.isArray(p.features))
      problems.push(`a subscription sent at ${p.at} has features that are not a list`);
    if (!declares(p)) continue;
    if (p.at < restartAt)
      problems.push(
        `a subscription sent at ${p.at} (${p.path}) declared ${AGENT_STOPPED} before the update was applied`,
      );
    if (p.waiting)
      problems.push(
        `a subscription sent at ${p.at} (${p.path}) declared ${AGENT_STOPPED} while the new worker was still waiting`,
      );
  }

  const asked = trace.find(
    (e) =>
      e.kind === 'sw-message' &&
      e.type === 'FEATURES' &&
      e.target === 'active' &&
      e.waiting &&
      e.at < restartAt,
  );
  if (!asked)
    problems.push(
      'no updated page was seen asking the still-active old worker what it can show before the update was applied',
    );

  const declaration = posts.find((p) => declares(p) && p.at >= restartAt && !p.waiting) ?? null;
  if (!declaration) problems.push(`the updated phone never declared ${AGENT_STOPPED}`);
  else {
    const withdrawn = posts.find((p) => p.at > declaration.at && !declares(p));
    if (withdrawn)
      problems.push(
        `a subscription sent at ${withdrawn.at} (${withdrawn.path}) after the declaration withdraws it`,
      );
  }
  return { problems, declaration, asked: asked ?? null };
}
