import { gzipSync } from 'node:zlib';

/** A minimal ustar writer, enough to build npm-style tarballs for the reader. */
export function tarball(
  entries: {
    path: string;
    data?: string | Buffer;
    type?: string;
    pax?: string;
    badChecksum?: boolean;
  }[],
  o: { eofBlocks?: number } = {},
): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string, badChecksum = false) => {
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
    if (badChecksum) sum += 1;
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
    blocks.push(header(e.path, data.length, e.type ?? '0', e.badChecksum), pad(data));
  }
  blocks.push(Buffer.alloc(512 * (o.eofBlocks ?? 2)));
  return gzipSync(Buffer.concat(blocks));
}

/** One pax extended-header record, `<len> <key>=<value>\n`, with its length computed. */
export function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let len = rest.length + 1;
  while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
  return `${len}${rest}`;
}
