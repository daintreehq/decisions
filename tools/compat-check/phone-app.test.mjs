import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
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
const FEATURE = 'agent-stopped-push-v1';
const DECLARE = [FEATURE];
const post = (at, more = {}) => ({
  kind: 'push-post',
  doc: 'new',
  path: '/',
  at,
  endpoint: sub.endpoint,
  p256dh: sub.p256dh,
  auth: sub.auth,
  features: null,
  waiting: false,
  installing: false,
  active: 'activated',
  activeAnswered: null,
  ...more,
});
const declaration = (at, more = {}) =>
  post(at, { features: DECLARE, activeAnswered: DECLARE, ...more });
const inMixed = (kind, at, more = {}) => ({
  kind,
  doc: 'mixed',
  path: '/settings/about',
  at,
  target: 'active',
  waiting: true,
  installing: false,
  active: 'activated',
  ...more,
});

/** The trace of a phone that did everything right: the shape scenario 4 expects. */
function good() {
  return [
    { kind: 'doc', doc: 'old', path: '/', at: 1 },
    { kind: 'subscribe', doc: 'old', path: '/settings/notifications', at: 10 },
    post(11, { doc: 'old', waiting: false }),
    { kind: 'doc', doc: 'mixed', path: '/settings/about', at: 50 },
    inMixed('sw-message', 55, { type: 'FEATURES' }),
    inMixed('sw-settled', 57, { answered: false }),
    { kind: 'phase', name: 'restart', at: 100 },
    inMixed('sw-message', 101, { type: 'SKIP_WAITING', target: 'waiting' }),
    inMixed('sw-message', 102, { type: 'FEATURES', waiting: false, active: 'activating' }),
    inMixed('sw-answer', 103, { features: DECLARE, waiting: false, active: 'activating' }),
    declaration(110, { doc: 'mixed', active: 'activating' }),
    { kind: 'doc', doc: 'new', path: '/settings/about', at: 120 },
  ];
}

const OPTS = { mixedDoc: 'mixed', requests: 2 };
const judge = (trace, opts = OPTS) => judgeDeclarations(trace, sub, opts);
const problemsOf = (trace, opts) => judge(trace, opts).problems.join('\n');
const replace = (trace, pred, change) =>
  trace.map((e) => (pred(e) ? (change ? { ...e, ...change } : null) : e)).filter(Boolean);
const isDeclaration = (e) => e.kind === 'push-post' && e.at === 110;
const isBaseline = (e) => e.kind === 'push-post' && e.at === 11;
const isProbe = (e) => e.kind === 'sw-message' && e.type === 'FEATURES' && e.at === 55;
const show = (v) => JSON.stringify(v);

describe('judgeDeclarations', () => {
  it('accepts a phone that declares only once the new worker is active and said it can show the push', () => {
    const r = judge(good());
    assert.deepEqual(r.problems, []);
    assert.equal(r.declaration.at, 110);
    assert.equal(r.asked.at, 55);
    assert.equal(r.settled.at, 57);
  });

  it('refuses a declaration made before the update was applied, whatever the worker state says', () => {
    const t = [...good(), declaration(60, { doc: 'mixed' })];
    assert.match(
      problemsOf(t, { ...OPTS, requests: 3 }),
      /declared .* before the update was applied/,
    );
  });

  it('refuses a declaration made while the new worker waits, or with the worker state unknown', () => {
    const waiting = replace(good(), isDeclaration, { waiting: true });
    assert.match(problemsOf(waiting), /while the new worker was still waiting/);
    assert.equal(judge(waiting).declaration, null);
    const unknown = replace(good(), isDeclaration, { waiting: null });
    assert.match(problemsOf(unknown), /with the worker state unknown/);
    assert.equal(judge(unknown).declaration, null);
  });

  it('refuses a declaration unless the active worker had told the app it can show the push', () => {
    for (const activeAnswered of [null, [], ['pane-snapshots-v1']]) {
      const t = replace(good(), isDeclaration, { activeAnswered });
      const r = judge(t);
      assert.match(
        r.problems.join('\n'),
        /had not told the app it can show one/,
        show(activeAnswered),
      );
      assert.equal(r.declaration, null);
    }
  });

  it('refuses any subscription that names another endpoint or other keys, the released one included', () => {
    for (const changed of [
      { endpoint: `https://${PUSH_HOST}/compat/other` },
      { p256dh: 'BOther' },
      { auth: 'other' },
    ]) {
      for (const which of [isBaseline, isDeclaration]) {
        const t = replace(good(), which, changed);
        assert.match(problemsOf(t), /names another endpoint or other keys/, show(changed));
      }
    }
  });

  it('refuses a trace with no question from the mixed page to the old, still-active worker', () => {
    assert.match(problemsOf(replace(good(), isProbe)), /was not seen asking that worker/);
    assert.match(problemsOf(good(), { requests: 2 }), /was not seen asking that worker/);
    for (const wrong of [
      { doc: 'old' },
      { target: 'waiting' },
      { at: 100 },
      { kind: 'sw-answer' },
      { type: 'SKIP_WAITING' },
    ]) {
      const t = replace(good(), isProbe, wrong);
      assert.match(problemsOf(t), /was not seen asking that worker/, show(wrong));
    }
  });

  it('refuses a question to the old worker that never settled, or that it answered with the push', () => {
    const unsettled = replace(good(), (e) => e.kind === 'sw-settled');
    assert.match(problemsOf(unsettled), /not seen to settle/);
    const answered = [...good(), inMixed('sw-answer', 56, { features: DECLARE })];
    assert.match(problemsOf(answered), /old worker answered that it can show/);
  });

  it('refuses a phone that never declares the push itself', () => {
    assert.match(
      problemsOf(replace(good(), isDeclaration), { ...OPTS, requests: 1 }),
      /never declared/,
    );
    for (const features of [[], ['pane-snapshots-v1']]) {
      const t = replace(good(), isDeclaration, { features });
      assert.match(problemsOf(t), /never declared/, show(features));
    }
  });

  it('refuses a declaration that a later subscription withdraws, even in the same millisecond', () => {
    for (const later of [
      [post(130)],
      [post(130, { features: [] })],
      [post(110)],
      [declaration(125), post(130)],
    ]) {
      const t = [...good(), ...later];
      assert.match(
        problemsOf(t, { ...OPTS, requests: 2 + later.length }),
        /after the declaration withdraws it/,
        show(later),
      );
    }
    assert.deepEqual(judge([...good(), declaration(130)], { ...OPTS, requests: 3 }).problems, []);
  });

  it('refuses a phone that never subscribes, subscribes again or drops its subscription', () => {
    const none = replace(good(), (e) => e.kind === 'subscribe');
    assert.match(problemsOf(none), /subscribed 0 times/);
    const again = [...good(), { kind: 'subscribe', doc: 'new', path: '/', at: 125 }];
    assert.match(problemsOf(again), /subscribed 2 times/);
    const dropped = [...good(), { kind: 'unsubscribe', doc: 'new', path: '/', at: 125 }];
    assert.match(problemsOf(dropped), /dropped its push subscription/);
  });

  it('refuses a trace without the restart', () => {
    assert.match(problemsOf(replace(good(), (e) => e.kind === 'phase')), /no restart/);
    const renamed = replace(good(), (e) => e.kind === 'phase', { name: 'reload' });
    assert.match(problemsOf(renamed), /no restart/);
  });

  it('requires the released app to have sent its own subscription, after subscribing and before the update', () => {
    const missing = replace(good(), isBaseline);
    assert.match(problemsOf(missing, { ...OPTS, requests: 1 }), /never sent its subscription/);
    for (const wrong of [{ features: [] }, { at: 100 }, { at: 5 }]) {
      const t = replace(good(), isBaseline, wrong);
      assert.match(problemsOf(t), /never sent its subscription/, show(wrong));
    }
  });

  it('refuses features that are not a list', () => {
    const t = [...good(), post(140, { features: 'not a list' })];
    assert.match(problemsOf(t, { ...OPTS, requests: 3 }), /features that are not a list/);
  });

  it('refuses a trace that has fewer subscriptions than the browser saw sent', () => {
    assert.match(problemsOf(good(), { ...OPTS, requests: 3 }), /trace has 2: it is incomplete/);
    assert.deepEqual(judge(good(), { mixedDoc: 'mixed' }).problems, []);
  });
});

describe('judgeDeclarations, at the edges', () => {
  it('accepts a declaration made only by the reloaded page', () => {
    const t = [
      ...replace(good(), isDeclaration),
      declaration(130, { doc: 'new', path: '/settings/about' }),
    ];
    const r = judge(t);
    assert.deepEqual(r.problems, []);
    assert.equal(r.declaration.doc, 'new');
  });

  it('says an early declaration came before the update, whatever the worker state', () => {
    const t = [...good(), declaration(60, { doc: 'mixed', waiting: true })];
    assert.match(
      problemsOf(t, { ...OPTS, requests: 3 }),
      /declared agent-stopped-push-v1 before the update was applied/,
    );
  });

  it('takes a missing worker state as unknown, and a bare answer as no answer', () => {
    const t = good().map((e) => {
      if (!isDeclaration(e)) return e;
      const { waiting: _, ...rest } = e;
      return rest;
    });
    assert.match(problemsOf(t), /with the worker state unknown/);
    const scalar = replace(good(), isDeclaration, { activeAnswered: FEATURE });
    assert.match(problemsOf(scalar), /had not told the app it can show one/);
  });

  it('checks the endpoint and keys of every subscription, however many', () => {
    const t = [...good(), declaration(130), declaration(140, { auth: 'other' })];
    assert.match(problemsOf(t, { ...OPTS, requests: 4 }), /sent at 140 names another endpoint/);
  });

  it('accepts a question to the old worker sent while the new one was still installing', () => {
    const t = replace(good(), isProbe, { waiting: false, installing: true });
    assert.deepEqual(judge(t).problems, []);
  });

  it('counts only a settlement in the mixed page, before the update', () => {
    for (const wrong of [{ doc: 'new' }, { at: 105 }]) {
      const t = replace(good(), (e) => e.kind === 'sw-settled', wrong);
      assert.match(problemsOf(t), /not seen to settle/, show(wrong));
    }
  });

  it('takes only the exact feature as the declaration', () => {
    const t = replace(good(), isDeclaration, {
      features: ['agent-stopped-push-v2'],
      activeAnswered: ['agent-stopped-push-v2'],
    });
    assert.match(problemsOf(t), /never declared/);
  });

  it('refuses a withdrawal even when the phone declares again after it', () => {
    const t = [...good(), post(130), declaration(140)];
    assert.match(problemsOf(t, { ...OPTS, requests: 4 }), /sent at 130 .* withdraws it/);
  });

  it('refuses an unsubscribe at any point', () => {
    const t = [{ kind: 'unsubscribe', doc: 'old', path: '/', at: 5 }, ...good()];
    assert.match(problemsOf(t), /dropped its push subscription/);
  });

  it('takes only a phase entry as the restart', () => {
    const t = replace(good(), (e) => e.kind === 'phase', { kind: 'doc' });
    assert.match(problemsOf(t), /no restart/);
  });

  it('accepts the released subscription sent in the same millisecond as subscribing', () => {
    assert.deepEqual(judge(replace(good(), isBaseline, { at: 10 })).problems, []);
  });

  it('refuses features that are not a list before the update too', () => {
    const t = [...good(), post(70, { doc: 'old', features: 'not a list' })];
    assert.match(
      problemsOf(t, { ...OPTS, requests: 3 }),
      /sent at 70 has features that are not a list/,
    );
  });

  it('refuses an incomplete trace even when it never declared', () => {
    const t = replace(good(), isDeclaration);
    assert.match(problemsOf(t, { ...OPTS, requests: 2 }), /trace has 1: it is incomplete/);
  });
});

describe('pushSubscription', () => {
  it('is an https endpoint on the unreachable host, with a P-256 public key and 16 auth bytes', () => {
    const s = pushSubscription();
    const url = new URL(s.endpoint);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, PUSH_HOST);
    assert.ok(PUSH_HOST.endsWith('.invalid'));
    const point = Buffer.from(s.p256dh, 'base64url');
    assert.equal(point.length, 65);
    assert.equal(point[0], 4);
    // A point that is not on the curve is refused here, as a push service's encryption would refuse it.
    const secret = createECDH('prime256v1');
    secret.generateKeys();
    assert.equal(secret.computeSecret(point).length, 32);
    assert.throws(() => secret.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)])));
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
        '<head><script src="/legacy.js"></script><link rel="modulepreload" href="/assets/vendor-1.js">' +
          '<script type="module" crossorigin src="/assets/index-AbC123.js"></script></head>',
      );
      assert.equal(entryScript(dir), '/assets/index-AbC123.js');
      writeFileSync(
        join(dir, 'app/index.html'),
        '<head><script type="module" src="/assets/index-Plain1.js"></script></head>',
      );
      assert.equal(entryScript(dir), '/assets/index-Plain1.js');
      writeFileSync(join(dir, 'app/index.html'), '<head><script src="/legacy.js"></script></head>');
      assert.throws(() => entryScript(dir), /no module script/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
