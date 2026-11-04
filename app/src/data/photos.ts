import { LIMITS } from '@daintreehq/decisions-protocol';
import { sha256Hex, sniffImageMime } from '@daintreehq/decisions-crypto';

/*
 * A photo the person chose, made ready to send (docs/protocol.md section 17). It is decoded (honouring the camera's
 * orientation), scaled down, and drawn into a fresh canvas that is encoded again. A canvas encoder writes pixels and
 * nothing else, so location, camera details and every other piece of EXIF or XMP metadata stay behind: the bytes
 * that are encrypted and uploaded are only the picture.
 */

/** Longest edge after scaling: plenty for an agent to read a screen or a label, a fraction of a camera's 12–48 MP. */
export const PHOTO_MAX_EDGE = 2048;
/** JPEG quality for photographs. */
export const PHOTO_QUALITY = 0.85;
/** A screenshot or graphic is kept lossless (PNG) while it stays under this; past it, it becomes a JPEG too. */
export const PNG_KEEP_BYTES = 4 * 1024 * 1024;
/** Photos one answer or follow-up can carry (the protocol's limit). */
export const PHOTOS_PER_MESSAGE = LIMITS.phoneImagesPerContent;
/** Photos one question can ever take, from every answer and follow-up together. */
export const PHOTOS_PER_QUESTION = LIMITS.phoneImagesPerQuestion;

export type PhotoMime = 'image/jpeg' | 'image/png';

export interface PreparedPhoto {
  bytes: Uint8Array;
  mime: PhotoMime;
  width: number;
  height: number;
  /** SHA-256 (hex) of `bytes`: the digest the signed answer or message carries. */
  sha256: string;
}

export type PrepareResult =
  { ok: true; photo: PreparedPhoto } | { ok: false; reason: 'unsupported' | 'failed' };

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/** Decode with the camera's orientation applied: createImageBitmap where it can, an <img> (which also honours it) otherwise. */
async function decode(file: Blob): Promise<Decoded | null> {
  if (typeof createImageBitmap === 'function') {
    for (const opts of [{ imageOrientation: 'from-image' as const }, undefined]) {
      try {
        const b = opts ? await createImageBitmap(file, opts) : await createImageBitmap(file);
        return { source: b, width: b.width, height: b.height, close: () => b.close() };
      } catch {
        /* an option this engine refuses, or bytes it cannot read: try the next way */
      }
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => undefined,
    };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function encode(
  d: Decoded,
  edge: number,
  mime: PhotoMime,
  quality: number,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const scale = Math.min(1, edge / Math.max(d.width, d.height));
  const width = Math.max(1, Math.round(d.width * scale));
  const height = Math.max(1, Math.round(d.height * scale));
  let blob: Blob | null = null;
  const draw = (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => {
    // JPEG has no transparency: a transparent screenshot reads on white rather than black.
    if (mime === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(d.source, 0, 0, width, height);
  };
  if (typeof OffscreenCanvas === 'function') {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    draw(ctx);
    blob = await c.convertToBlob({ type: mime, quality });
  } else if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    draw(ctx);
    blob = await new Promise<Blob | null>((r) => c.toBlob(r, mime, quality));
    c.width = c.height = 0;
  }
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // An engine that cannot encode the asked type quietly gives PNG: only the type asked for is accepted.
  if (sniffImageMime(bytes) !== mime) return null;
  return { bytes, width, height };
}

async function head(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, 16).arrayBuffer());
}

/**
 * Decode, scale and re-encode one chosen photo. Never throws. A PNG (a screenshot) stays PNG while it is small enough;
 * everything else, and a PNG that would be too big, becomes a JPEG. A result over the protocol's limit is tried again
 * smaller before giving up.
 */
export async function preparePhoto(file: Blob): Promise<PrepareResult> {
  let d: Decoded | null = null;
  try {
    d = await decode(file);
    if (!d || d.width < 1 || d.height < 1) return { ok: false, reason: 'unsupported' };
    const lossless = sniffImageMime(await head(file)) === 'image/png';
    const attempts: [PhotoMime, number, number][] = [
      ...(lossless ? ([['image/png', PHOTO_MAX_EDGE, 1]] as [PhotoMime, number, number][]) : []),
      ['image/jpeg', PHOTO_MAX_EDGE, PHOTO_QUALITY],
      ['image/jpeg', 1600, 0.75],
      ['image/jpeg', 1200, 0.7],
    ];
    for (const [mime, edge, quality] of attempts) {
      const out = await encode(d, edge, mime, quality);
      if (!out) continue;
      const cap = mime === 'image/png' ? PNG_KEEP_BYTES : LIMITS.phoneImageBytes;
      if (out.bytes.length > cap) continue;
      return {
        ok: true,
        photo: { ...out, mime, sha256: await sha256Hex(out.bytes) },
      };
    }
    return { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  } finally {
    d?.close();
  }
}

/** "1 photo", "3 photos". */
export const photoCount = (n: number): string => `${n} ${n === 1 ? 'photo' : 'photos'}`;
