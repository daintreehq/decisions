import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareVersions,
  distTagFor,
  isValidVersion,
  listWorkspace,
  parseNpmView,
  publishInOrder,
  publishOrder,
  readVersionConstants,
  releaseProblems,
} from './workspace.mjs';

const repo = (dir) => ({
  type: 'git',
  url: 'https://github.com/daintreehq/decisions.git',
  directory: dir,
});

function pkg(name, { deps = {}, peer, dev, isPrivate = false, version = '1.2.3', dir } = {}) {
  dir ??= `packages/${name.split('/').pop()}`;
  return {
    name,
    version,
    private: isPrivate,
    dir,
    manifest: {
      name,
      version,
      ...(isPrivate ? { private: true } : {}),
      dependencies: deps,
      ...(peer ? { peerDependencies: peer } : {}),
      ...(dev ? { devDependencies: dev } : {}),
      repository: repo(dir),
    },
  };
}

const names = (list) => list.map((p) => p.name);

describe('publishOrder', () => {
  it('puts every dependency before its dependents and leaves out private packages', () => {
    const order = publishOrder([
      pkg('@daintreehq/cli', {
        deps: { '@daintreehq/client': 'workspace:*', '@daintreehq/protocol': 'workspace:*' },
      }),
      pkg('@daintreehq/app', { deps: { '@daintreehq/crypto': 'workspace:*' }, isPrivate: true }),
      pkg('@daintreehq/client', {
        deps: { '@daintreehq/crypto': 'workspace:*', zod: '^4' },
      }),
      pkg('@daintreehq/crypto', { deps: { '@daintreehq/protocol': 'workspace:*' } }),
      pkg('@daintreehq/protocol', { deps: { zod: '^4' } }),
    ]);
    assert.deepEqual(names(order), [
      '@daintreehq/protocol',
      '@daintreehq/crypto',
      '@daintreehq/client',
      '@daintreehq/cli',
    ]);
  });

  it('orders through peer dependencies and picks up a newly added package with no list to edit', () => {
    const order = publishOrder([
      pkg('@daintreehq/cli', { deps: { '@daintreehq/relay-bundle': 'workspace:*' } }),
      pkg('@daintreehq/relay-bundle', { peer: { '@daintreehq/protocol': 'workspace:*' } }),
      pkg('@daintreehq/protocol'),
    ]);
    assert.deepEqual(names(order), [
      '@daintreehq/protocol',
      '@daintreehq/relay-bundle',
      '@daintreehq/cli',
    ]);
  });

  it('ignores devDependencies, so a dev-only edge cannot form a cycle', () => {
    const order = publishOrder([
      pkg('@daintreehq/a', { deps: { '@daintreehq/b': 'workspace:*' } }),
      pkg('@daintreehq/b', { dev: { '@daintreehq/a': 'workspace:*' } }),
    ]);
    assert.deepEqual(names(order), ['@daintreehq/b', '@daintreehq/a']);
  });

  it('is stable: independent packages come out in name order', () => {
    const order = publishOrder([pkg('@daintreehq/z'), pkg('@daintreehq/m'), pkg('@daintreehq/a')]);
    assert.deepEqual(names(order), ['@daintreehq/a', '@daintreehq/m', '@daintreehq/z']);
  });

  it('refuses a published package that depends on a private workspace package', () => {
    assert.throws(
      () =>
        publishOrder([
          pkg('@daintreehq/cli', { deps: { '@daintreehq/app': 'workspace:*' } }),
          pkg('@daintreehq/app', { isPrivate: true }),
        ]),
      /@daintreehq\/cli depends on the private package @daintreehq\/app/,
    );
  });

  it('refuses a dependency cycle', () => {
    assert.throws(
      () =>
        publishOrder([
          pkg('@daintreehq/a', { deps: { '@daintreehq/b': 'workspace:*' } }),
          pkg('@daintreehq/b', { deps: { '@daintreehq/a': 'workspace:*' } }),
        ]),
      /cycle: @daintreehq\/a -> @daintreehq\/b -> @daintreehq\/a/,
    );
  });
});

describe('releaseProblems', () => {
  const ok = [pkg('@daintreehq/a'), pkg('@daintreehq/b')];

  it('accepts one shared version that matches the tag and the constants', () => {
    assert.deepEqual(
      releaseProblems(ok, { tag: 'v1.2.3', constants: [{ file: 'x.ts', version: '1.2.3' }] }),
      [],
    );
  });

  it('accepts no tag (the pull-request dry run)', () => {
    assert.deepEqual(releaseProblems(ok), []);
  });

  it('fails fast when the tag does not match the version', () => {
    assert.match(releaseProblems(ok, { tag: 'v1.2.4' }).join('\n'), /tag v1.2.4 does not match/);
    assert.match(releaseProblems(ok, { tag: '1.2.3' }).join('\n'), /expected v1.2.3/);
  });

  it('fails when packages are not in lockstep', () => {
    const problems = releaseProblems([
      pkg('@daintreehq/a'),
      pkg('@daintreehq/b', { version: '1.2.4' }),
    ]);
    assert.match(problems.join('\n'), /not at one shared version/);
  });

  it('fails when a version constant lags', () => {
    const problems = releaseProblems(ok, { constants: [{ file: 'bin.ts', version: '1.2.2' }] });
    assert.match(problems.join('\n'), /bin.ts reports version 1.2.2, expected 1.2.3/);
  });

  it('fails on a package outside the scope or without provenance-ready repository metadata', () => {
    const stray = pkg('decisions-thing');
    const noRepo = pkg('@daintreehq/c');
    delete noRepo.manifest.repository;
    const wrongDir = pkg('@daintreehq/d', { dir: 'packages/d' });
    wrongDir.manifest.repository.directory = 'packages/elsewhere';
    const problems = releaseProblems([stray, noRepo, wrongDir]).join('\n');
    assert.match(problems, /decisions-thing: not under the @daintreehq\/ scope/);
    assert.match(problems, /@daintreehq\/c: repository.url must point at/);
    assert.match(problems, /@daintreehq\/d: repository.directory is packages\/elsewhere/);
  });

  it('accepts the usual spellings of the repository URL', () => {
    for (const url of [
      'git+https://github.com/daintreehq/decisions.git',
      'https://github.com/daintreehq/decisions',
      'git@github.com:daintreehq/decisions.git',
    ]) {
      const p = pkg('@daintreehq/a');
      p.manifest.repository.url = url;
      assert.deepEqual(releaseProblems([p]), [], url);
    }
  });
});

describe('versions', () => {
  it('validates release versions', () => {
    for (const v of ['0.1.0', '1.0.0', '10.20.30', '1.0.0-rc.1', '0.2.0-beta']) {
      assert.ok(isValidVersion(v), v);
    }
    for (const v of ['v1.0.0', '1.0', '01.0.0', '1.0.0+build', '1.0.0-', '', undefined]) {
      assert.ok(!isValidVersion(v), String(v));
    }
  });

  it('never publishes a prerelease as latest', () => {
    assert.equal(distTagFor('1.0.0'), 'latest');
    assert.equal(distTagFor('1.0.0-rc.1'), 'next');
  });

  it('compares npm versions numerically', () => {
    assert.equal(compareVersions('11.5.1', '11.5.1'), 0);
    assert.equal(compareVersions('11.10.0', '11.5.1'), 1);
    assert.equal(compareVersions('10.9.2', '11.5.1'), -1);
    assert.equal(compareVersions('11.5.1-pre', '11.5.1'), -1);
  });
});

describe('parseNpmView', () => {
  it('reads a published version', () => {
    assert.equal(parseNpmView('"1.2.3"\n', '1.2.3'), true);
    assert.equal(parseNpmView('["1.2.3"]', '1.2.3'), true);
  });

  it('treats a missing package or version as unpublished', () => {
    const e404 = JSON.stringify({ error: { code: 'E404', summary: 'Not Found' } });
    assert.equal(parseNpmView(e404, '1.2.3'), false);
    assert.equal(parseNpmView('', '1.2.3'), false);
  });

  it('throws on any other registry error instead of guessing', () => {
    const e500 = JSON.stringify({ error: { code: 'E500', summary: 'Internal' } });
    assert.throws(() => parseNpmView(e500, '1.2.3'), /E500/);
    assert.throws(() => parseNpmView('<html>', '1.2.3'), /unexpected npm view output/);
    assert.throws(() => parseNpmView('"1.2.4"', '1.2.3'), /returned "1.2.4"/);
  });
});

describe('publishInOrder', () => {
  const packed = ['a', 'b', 'c'].map((n) => ({
    pkg: { name: `@daintreehq/${n}` },
    tarball: `${n}.tgz`,
  }));

  /** A fake registry: `published` is mutated by successful publishes. */
  function registry({ published = [], fail = [], landThenFail = [], viewError = [] } = {}) {
    const state = new Set(published);
    const calls = [];
    return {
      state,
      calls,
      io: {
        version: '1.0.0',
        dryRun: false,
        log: () => {},
        isPublished: (name) => {
          if (viewError.includes(name)) throw new Error('E500');
          return state.has(name);
        },
        publish: (tarball) => {
          calls.push(tarball);
          const name = `@daintreehq/${tarball.replace('.tgz', '')}`;
          if (fail.includes(name)) throw new Error('E403');
          state.add(name);
          if (landThenFail.includes(name)) throw new Error('ETIMEDOUT');
        },
        dryRunPublish: (tarball) => calls.push(`dry:${tarball}`),
      },
    };
  }

  it('publishes in the given order and skips what is already on npm', () => {
    const r = registry({ published: ['@daintreehq/a'] });
    const summary = publishInOrder(packed, r.io);
    assert.deepEqual(r.calls, ['b.tgz', 'c.tgz']);
    assert.deepEqual(summary, [
      '@daintreehq/a@1.0.0 skipped (already published)',
      '@daintreehq/b@1.0.0 published',
      '@daintreehq/c@1.0.0 published',
    ]);
  });

  it('stops at the first failure, and a re-run finishes without re-attempting what landed', () => {
    const first = registry({ fail: ['@daintreehq/b'] });
    assert.throws(
      () => publishInOrder(packed, first.io),
      /@daintreehq\/b@1.0.0: npm publish failed/,
    );
    assert.deepEqual(first.calls, ['a.tgz', 'b.tgz']);

    const rerun = registry({ published: [...first.state] });
    publishInOrder(packed, rerun.io);
    assert.deepEqual(rerun.calls, ['b.tgz', 'c.tgz']);
  });

  it('counts a publish that errored after landing as published', () => {
    const r = registry({ landThenFail: ['@daintreehq/a'] });
    assert.equal(publishInOrder(packed, r.io)[0], '@daintreehq/a@1.0.0 published');
    assert.deepEqual(r.calls, ['a.tgz', 'b.tgz', 'c.tgz']);
  });

  it('never publishes when the registry cannot be read', () => {
    const r = registry({ viewError: ['@daintreehq/a'] });
    assert.throws(() => publishInOrder(packed, r.io), /cannot read the registry/);
    assert.deepEqual(r.calls, []);
  });

  it('uploads nothing in a dry run, and tolerates a registry error there', () => {
    const r = registry({ published: ['@daintreehq/a'], viewError: ['@daintreehq/b'] });
    const summary = publishInOrder(packed, { ...r.io, dryRun: true });
    assert.deepEqual(r.calls, ['dry:b.tgz', 'dry:c.tgz']);
    assert.equal(summary[1], '@daintreehq/b@1.0.0 would be published');
  });
});

describe('this workspace', () => {
  it('is releasable as it stands: lockstep versions, provenance metadata, a valid order', () => {
    const order = publishOrder(listWorkspace());
    assert.ok(order.length > 0);
    assert.deepEqual(releaseProblems(order, { constants: readVersionConstants() }), []);
    const index = new Map(order.map((p, i) => [p.name, i]));
    assert.ok(index.get('@daintreehq/decisions-protocol') < index.get('@daintreehq/decisions-cli'));
  });
});
