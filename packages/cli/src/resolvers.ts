import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { LIMITS } from '@daintreehq/decisions-protocol';
import type { AttachmentResolver, QuestionOrigin } from '@daintreehq/decisions-client';

const MAX = LIMITS.attachmentBytes;

/**
 * Read a regular file with a hard size cap. Special files (FIFOs, devices, directories) are rejected BEFORE
 * opening, and the read never goes past the cap, so a hostile path cannot hang or exhaust memory.
 */
export async function readBounded(path: string, max: number = MAX): Promise<Uint8Array | null> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size === 0 || st.size > max) return null;
  const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size > max) return null;
    const buf = Buffer.alloc(stat.size);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return new Uint8Array(buf.subarray(0, off));
  } finally {
    await fh.close();
  }
}

/** Unrestricted resolver for `decisions ask --attach`: the HUMAN at the terminal named the path, not an agent. */
export const humanFileResolver: AttachmentResolver = {
  async resolve(_o, id) {
    const bytes = await readBounded(id);
    return bytes ? { bytes } : null;
  },
};

/** MCP/agent callers can never name a path; they can only name a file the human put in THEIR pane's folder. */
export const noAttachmentsResolver: AttachmentResolver = {
  async resolve() {
    return null;
  },
};

/**
 * Resources registered for a pane: files inside `<root>/<pane id>/`. The id is a plain relative file name; it
 * is confined to that folder after resolving symlinks, must be a regular file, and is read with a size cap.
 */
export class PaneDirectoryResolver implements AttachmentResolver {
  constructor(private readonly root: string) {}
  async resolve(origin: QuestionOrigin, id: string): Promise<{ bytes: Uint8Array } | null> {
    if (
      !id ||
      id.includes('\0') ||
      isAbsolute(id) ||
      id.split(/[\\/]/).some((p) => p === '..' || p === '')
    )
      return null;
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(origin.pane_id)) return null;
    let base: string;
    let real: string;
    try {
      base = await realpath(join(this.root, origin.pane_id));
      real = await realpath(join(base, id));
    } catch {
      return null;
    }
    if (real !== base && !real.startsWith(base + sep)) return null; // symlink escape
    const bytes = await readBounded(real);
    return bytes ? { bytes } : null;
  }
}
