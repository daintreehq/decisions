import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
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

/** A minimal ustar writer, enough to build npm-style tarballs for the reader. */
export function tarball(
  entries: { path: string; data?: string | Buffer; type?: string; pax?: string }[],
): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, 'utf8');
    h.write('0000644\0', 100, 'ascii');
    h.write('0000000\0', 108, 'ascii');
    h.write('0000000\0', 116, 'ascii');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    h.write('00000000000\0', 136, 'ascii');
    h.write('        ', 148, 'ascii');
    h.write(type, 156, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return h;
  };
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const e of entries) {
    if (e.pax !== undefined) {
      const rec = ` path=${e.pax}\n`;
      let len = rec.length;
      len += String(len + String(len).length).length;
      const body = Buffer.from(`${len}${rec}`);
      blocks.push(header('PaxHeader', body.length, 'x'), pad(body));
    }
    const data = Buffer.from(e.data ?? '');
    blocks.push(header(e.path, data.length, e.type ?? '0'), pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const integrity = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`;

describe('versions', () => {
  it('orders by semver precedence, prereleases before their release', () => {
    const sorted = ['0.10.0', '0.2.0', '1.0.0-rc.1', '1.0.0', '1.0.0-beta', '0.2.1'].sort(
      compareVersions,
    );
    expect(sorted).toEqual(['0.2.0', '0.2.1', '0.10.0', '1.0.0-beta', '1.0.0-rc.1', '1.0.0']);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
  });

  it('parses protocol ranges', () => {
    expect(parseProtocolRange('1')).toEqual({ min: 1, max: 1 });
    expect(parseProtocolRange('1-3')).toEqual({ min: 1, max: 3 });
    expect(parseProtocolRange('2..2')).toEqual({ min: 2, max: 2 });
    expect(() => parseProtocolRange('3-1')).toThrow(/not a valid range/);
    expect(() => parseProtocolRange('0')).toThrow(/not a valid range/);
    expect(() => parseProtocolRange('^1')).toThrow(/must be/);
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
            '0.2.0': { dist: { tarball: 'https://r/0.2.0.tgz', integrity: 'sha512-AAAA' } },
            '0.3.0': {
              decisions: { protocol: { min: 1, max: 1 } },
              repository: { url: 'git+https://github.com/daintreehq/decisions.git' },
              dist: { tarball: 'https://r/0.3.0.tgz', integrity: 'sha512-BBBB' },
            },
            '0.4.0': { dist: { tarball: 'https://r/0.4.0.tgz', integrity: 'sha1-CCCC' } },
            junk: { dist: { tarball: 'x', integrity: 'sha512-DDDD' } },
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
      ]),
    );
    expect([...files.keys()].sort()).toEqual([
      `dist/app/${'x'.repeat(120)}.js`,
      'dist/manifest.json',
      'package.json',
    ]);
    expect(files.get('dist/manifest.json')!.toString()).toBe('{"schema":1}');
  });

  it('refuses links, path traversal and corrupt archives', () => {
    expect(() => extractTarball(tarball([{ path: 'package/l', type: '2' }]))).toThrow(
      /non-file entry/,
    );
    expect(() => extractTarball(tarball([{ path: 'package/../../etc/x', data: 'x' }]))).toThrow(
      /unsafe path/,
    );
    expect(() => extractTarball(Buffer.from('not gzip'))).toThrow(/gzip/);
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
