import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  downloadRelease,
  extractTarball,
  isVersion,
  listRelayReleases,
  parseProtocolRange,
  type RelayRelease,
} from '../src/relay-release.js';
import { paxRecord, tarball } from './tar.js';

const integrity = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`;

describe('versions', () => {
  it('orders by semver precedence, prereleases before their release', () => {
    const sorted = ['0.10.0', '0.2.0', '1.0.0-rc.1', '1.0.0', '1.0.0-beta', '0.2.1'].sort(
      compareVersions,
    );
    expect(sorted).toEqual(['0.2.0', '0.2.1', '0.10.0', '1.0.0-beta', '1.0.0-rc.1', '1.0.0']);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    // Numeric identifiers beyond 2^53 still compare exactly.
    expect(compareVersions('0.3.0-9007199254740993.1', '0.3.0-9007199254740992.2')).toBeGreaterThan(
      0,
    );
  });

  it('parses protocol ranges', () => {
    expect(parseProtocolRange('1')).toEqual({ min: 1, max: 1 });
    expect(parseProtocolRange('1-3')).toEqual({ min: 1, max: 3 });
    expect(parseProtocolRange('2..2')).toEqual({ min: 2, max: 2 });
    expect(() => parseProtocolRange('3-1')).toThrow(/not a valid range/);
    expect(() => parseProtocolRange('0')).toThrow(/not a valid range/);
    expect(() => parseProtocolRange('^1')).toThrow(/must be/);
    expect(() => parseProtocolRange('1-' + '9'.repeat(400))).toThrow(/not a valid range/);
  });

  it('accepts only valid semver', () => {
    expect(isVersion('1.2.3')).toBe(true);
    expect(isVersion('1.2.3-rc.1+build.5')).toBe(true);
    for (const v of ['01.2.3', '1.2', '1.2.3-', '1.2.3-01', 'v1.2.3'])
      expect(isVersion(v)).toBe(false);
  });
});

describe('listRelayReleases', () => {
  it('lists versions with their declared protocol range, skipping unusable entries', async () => {
    const urls: string[] = [];
    const fetchFn = (async (u: unknown) => {
      urls.push(String(u));
      return new Response(
        JSON.stringify({
          versions: {
            '0.3.0': {
              decisions: { protocol: { min: 1, max: 1 } },
              repository: { url: 'git+https://github.com/daintreehq/decisions.git' },
              dist: { tarball: 'https://r/0.3.0.tgz', integrity: 'sha512-BBBB' },
            },
            '0.4.0': { dist: { tarball: 'https://r/0.4.0.tgz', integrity: 'sha1-CCCC' } },
            junk: { dist: { tarball: 'x', integrity: 'sha512-DDDD' } },
            '0.2.0': { dist: { tarball: 'https://r/0.2.0.tgz', integrity: 'sha512-AAAA' } },
          },
        }),
      );
    }) as typeof fetch;
    const r = await listRelayReleases(fetchFn, 'https://registry.example');
    expect(urls).toEqual(['https://registry.example/@daintreehq%2fdecisions-relay']);
    expect(r.map((x) => [x.version, x.protocol])).toEqual([
      ['0.2.0', null],
      ['0.3.0', { min: 1, max: 1 }],
    ]);
    expect(r[1]!.repository).toBe('git+https://github.com/daintreehq/decisions.git');
  });

  it('fails clearly when the registry is unreachable or answers an error', async () => {
    const down = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    await expect(listRelayReleases(down, 'https://r')).rejects.toThrow(/could not reach/);
    const missing = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    await expect(listRelayReleases(missing, 'https://r')).rejects.toThrow(/HTTP 404/);
  });
});

describe('downloadRelease', () => {
  const release = (b: Buffer, i = integrity(b)): RelayRelease => ({
    version: '0.3.0',
    protocol: { min: 1, max: 1 },
    tarball: 'https://r/0.3.0.tgz',
    integrity: i,
    repository: null,
  });
  const serve = (b: Buffer) => (async () => new Response(new Uint8Array(b))) as typeof fetch;

  it('returns the tarball when it matches the published sha512', async () => {
    const b = tarball([{ path: 'package/a.txt', data: 'a' }]);
    expect((await downloadRelease(serve(b), release(b))).equals(b)).toBe(true);
  });

  it('stops reading at the size cap whatever the server claims', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const endless = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            sent++;
            c.enqueue(chunk);
          },
        }),
      )) as typeof fetch;
    const b = tarball([{ path: 'package/a.txt', data: 'a' }]);
    await expect(downloadRelease(endless, release(b))).rejects.toThrow(/too large/);
    expect(sent).toBeLessThan(40);
  });

  it('refuses a tarball that does not match', async () => {
    const b = tarball([{ path: 'package/a.txt', data: 'a' }]);
    const other = tarball([{ path: 'package/a.txt', data: 'b' }]);
    await expect(downloadRelease(serve(other), release(b))).rejects.toThrow(/integrity/);
  });
});

describe('extractTarball', () => {
  it('reads files under package/, including long pax paths', () => {
    const long = `package/dist/app/${'x'.repeat(120)}.js`;
    const files = extractTarball(
      tarball([
        { path: 'package/', type: '5' },
        { path: 'package/package.json', data: '{}' },
        { path: 'package/dist/manifest.json', data: '{"schema":1}' },
        { path: 'ignored', data: 'long', pax: long },
        { path: 'package/after.txt', data: 'after' },
        // Consecutive pax headers apply together; a later one without a path keeps the path.
        { path: 'PaxHeader', type: 'x', data: paxRecord('path', 'package/dist/two.js') },
        { path: 'PaxHeader', type: 'x', data: paxRecord('mtime', '1') },
        { path: 'fallback', data: 'two' },
      ]),
    );
    expect([...files.keys()].sort()).toEqual([
      'after.txt',
      `dist/app/${'x'.repeat(120)}.js`,
      'dist/manifest.json',
      'dist/two.js',
      'package.json',
    ]);
    expect(files.get('dist/manifest.json')!.toString()).toBe('{"schema":1}');
    expect(files.get(`dist/app/${'x'.repeat(120)}.js`)!.toString()).toBe('long');
    expect(files.get('after.txt')!.toString()).toBe('after');
    expect(files.get('dist/two.js')!.toString()).toBe('two');
  });

  it('refuses links, path traversal and corrupt archives', () => {
    expect(() => extractTarball(tarball([{ path: 'package/l', type: '2' }]))).toThrow(
      /non-file entry/,
    );
    expect(() => extractTarball(tarball([{ path: 'package/../../etc/x', data: 'x' }]))).toThrow(
      /unsafe path/,
    );
    expect(() => extractTarball(Buffer.from('not gzip'))).toThrow(/gzip/);
    const ok = [{ path: 'package/a', data: 'x' }];
    expect(extractTarball(tarball(ok)).size).toBe(1);
    expect(() => extractTarball(tarball([{ ...ok[0]!, badChecksum: true }]))).toThrow(/checksum/);
    expect(() => extractTarball(tarball(ok, { eofBlocks: 1 }))).toThrow(/truncated/);
    expect(() => extractTarball(tarball(ok, { eofBlocks: 0 }))).toThrow(/truncated/);
    expect(() =>
      extractTarball(
        tarball([...ok, { path: 'PaxHeader', type: 'x', data: paxRecord('path', 'package/b') }]),
      ),
    ).toThrow(/truncated/);
    expect(() =>
      extractTarball(
        tarball([{ path: 'PaxHeader', type: 'x', data: '18 path=package/aX' }, ...ok]),
      ),
    ).toThrow(/pax/);
    expect(() =>
      extractTarball(tarball([{ path: 'PaxHeader', type: 'x', data: '99 path=x\n' }, ...ok])),
    ).toThrow(/pax/);
    expect(() => extractTarball(tarball([{ path: 'other/a.txt', data: 'x' }]))).toThrow(
      /unsafe path/,
    );
    expect(() =>
      extractTarball(
        tarball([
          { path: 'package/a', data: 'x' },
          { path: 'package/a', data: 'y' },
        ]),
      ),
    ).toThrow(/twice/);
  });
});
