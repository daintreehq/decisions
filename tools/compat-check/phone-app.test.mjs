import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PUSH_HOST, entryScript, judgeDeclarations, pushSubscription } from './phone-app.mjs';

const sub = {
  endpoint: `https://${PUSH_HOST}/compat/abc`,
  p256dh: 'BKey',
  auth: 'auth',
};
const DECLARE = ['agent-stopped-push-v1'];
const post = (at, more = {}) => ({
  kind: 'push-post',
  doc: 'd',
  path: '/',
  at,
  endpoint: sub.endpoint,
  p256dh: sub.p256dh,
  auth: sub.auth,
  features: null,
  waiting: false,
  installing: false,
  active: 'activated',
  ...more,
});

/** The trace of a phone that did everything right: the shape scenario 4 expects. */
function good() {
  return [
    { kind: 'doc', doc: 'old', path: '/', at: 1 },
    { kind: 'subscribe', doc: 'old', path: '/settings/notifications', at: 10 },
    post(11, { doc: 'old' }),
    { kind: 'doc', doc: 'mixed', path: '/settings/about', at: 50 },
    {
      kind: 'sw-message',
      doc: 'mixed',
      path: '/settings/about',
      at: 55,
      type: 'FEATURES',
      target: 'active',
      waiting: true,
      installing: false,
      active: 'activated',
    },
    { kind: 'phase', name: 'restart', at: 100 },
    {
      kind: 'sw-message',
      doc: 'mixed',
      path: '/settings/about',
      at: 101,
      type: 'SKIP_WAITING',
      target: 'waiting',
      waiting: true,
      installing: false,
      active: 'activated',
    },
    { kind: 'doc', doc: 'new', path: '/settings/about', at: 120 },
    post(130, { doc: 'new', features: DECLARE }),
  ];
}

const problemsOf = (trace) => judgeDeclarations(trace, sub).problems;

describe('judgeDeclarations', () => {
  it('accepts a phone that declares only once the new worker is active', () => {
    const r = judgeDeclarations(good(), sub);
    assert.deepEqual(r.problems, []);
    assert.equal(r.declaration.at, 130);
    assert.equal(r.asked.at, 55);
  });

  it('refuses a declaration made before the update was applied, whatever the worker state says', () => {
    const t = good();
    t.splice(5, 0, post(60, { doc: 'mixed', features: DECLARE }));
    assert.match(problemsOf(t).join('\n'), /declared agent-stopped-push-v1 before the update/);
  });

  it('refuses a declaration made while the new worker was still waiting', () => {
    const t = good();
    t.splice(t.length - 1, 0, post(105, { doc: 'mixed', features: DECLARE, waiting: true }));
    assert.match(problemsOf(t).join('\n'), /while the new worker was still waiting/);
  });

  it('refuses a subscription that names another endpoint or other keys', () => {
    for (const changed of [
      { endpoint: `https://${PUSH_HOST}/compat/other` },
      { p256dh: 'BOther' },
      { auth: 'other' },
    ]) {
      const t = good();
      t[t.length - 1] = post(130, { doc: 'new', features: DECLARE, ...changed });
      assert.match(problemsOf(t).join('\n'), /names another endpoint or other keys/);
    }
  });

  it('refuses a trace with no sign of the new page asking the old, still-active worker', () => {
    const missing = good().filter((e) => !(e.kind === 'sw-message' && e.type === 'FEATURES'));
    assert.match(problemsOf(missing).join('\n'), /no updated page was seen asking/);
    // Asked, but of the waiting worker, or with nothing waiting, or after the restart: none of these is the case.
    for (const wrong of [{ target: 'waiting' }, { waiting: false }, { at: 102 }]) {
      const t = good().map((e) =>
        e.kind === 'sw-message' && e.type === 'FEATURES' ? { ...e, ...wrong } : e,
      );
      assert.match(problemsOf(t).join('\n'), /no updated page was seen asking/, show(wrong));
    }
  });

  it('refuses a phone that never declares, or declares and then withdraws it', () => {
    assert.match(problemsOf(good().slice(0, -1)).join('\n'), /never declared/);
    const t = [...good(), post(140, { doc: 'new' })];
    assert.match(problemsOf(t).join('\n'), /after the declaration withdraws it/);
  });

  it('refuses a phone that subscribes again or drops its subscription', () => {
    const again = [...good(), { kind: 'subscribe', doc: 'new', path: '/', at: 125 }];
    assert.match(problemsOf(again).join('\n'), /subscribed 2 times/);
    const dropped = [...good(), { kind: 'unsubscribe', doc: 'new', path: '/', at: 125 }];
    assert.match(problemsOf(dropped).join('\n'), /dropped its push subscription/);
  });

  it('refuses a trace without the restart, or without the released app subscribing', () => {
    const noRestart = good().filter((e) => e.kind !== 'phase');
    assert.match(problemsOf(noRestart).join('\n'), /no restart/);
    const neverSent = good().filter((e) => !(e.kind === 'push-post' && e.at === 11));
    assert.match(problemsOf(neverSent).join('\n'), /released app never sent its subscription/);
  });

  it('refuses features that are not a list', () => {
    const t = [...good(), post(140, { doc: 'new', features: 'not a list' })];
    assert.match(problemsOf(t).join('\n'), /features that are not a list/);
  });
});

const show = (v) => JSON.stringify(v);

describe('pushSubscription', () => {
  it('is an https endpoint on the unreachable host, with a P-256 point and 16 auth bytes', () => {
    const s = pushSubscription();
    const url = new URL(s.endpoint);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, PUSH_HOST);
    assert.ok(PUSH_HOST.endsWith('.invalid'));
    const point = Buffer.from(s.p256dh, 'base64url');
    assert.equal(point.length, 65);
    assert.equal(point[0], 4);
    assert.equal(Buffer.from(s.auth, 'base64url').length, 16);
    assert.notEqual(pushSubscription().endpoint, s.endpoint);
  });
});

describe('entryScript', () => {
  it("reads the module script a staged relay's app loads", () => {
    const dir = mkdtempSync(join(tmpdir(), 'compat-entry-'));
    try {
      mkdirSync(join(dir, 'app'));
      writeFileSync(
        join(dir, 'app/index.html'),
        '<head><link rel="modulepreload" href="/assets/vendor-1.js">' +
          '<script type="module" crossorigin src="/assets/index-AbC123.js"></script></head>',
      );
      assert.equal(entryScript(dir), '/assets/index-AbC123.js');
      writeFileSync(join(dir, 'app/index.html'), '<head></head>');
      assert.throws(() => entryScript(dir), /no module script/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
