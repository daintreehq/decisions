export interface LoadedImage {
  url: string;
  sha256: string;
  mime: string;
}

/**
 * `expired`: the relay no longer has it. `unverified`: the bytes arrived but did not decrypt, match their signed
 * digest, match their declared type or decode, so nothing of them is shown or exported. `error`: anything else
 * (network, missing key); retryable.
 */
export type ImageResult =
  | { ok: true; image: LoadedImage }
  | { ok: false; reason: 'expired' | 'unverified' | 'error'; message: string };

export interface ImageContext {
  /** Aborted when the cache is disposed (unpair / wipe). Pass it to the network request. */
  signal: AbortSignal;
  /** Creates an object URL that the cache tracks and revokes. Throws if the cache was disposed meanwhile. */
  makeUrl(blob: Blob): string;
}

export interface ImageCacheDeps {
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
}

const DISPOSED: ImageResult = { ok: false, reason: 'error', message: 'Cancelled' };

/**
 * Decrypted attachment images, held as object URLs. Disposal is immediate and never waits on the network:
 * in-flight downloads are aborted, results that arrive afterwards are thrown away (and their URLs revoked),
 * and every URL already handed out is revoked, so erasing a phone cannot be held up or undone by a slow request.
 */
export class ImageCache {
  private entries = new Map<string, Promise<ImageResult>>();
  private controllers = new Set<AbortController>();
  private urls = new Set<string>();
  private generation = 0;

  constructor(private readonly deps: ImageCacheDeps) {}

  load(key: string, produce: (ctx: ImageContext) => Promise<ImageResult>): Promise<ImageResult> {
    const hit = this.entries.get(key);
    if (hit) return hit;
    const gen = this.generation;
    const ctl = new AbortController();
    this.controllers.add(ctl);
    const makeUrl = (blob: Blob): string => {
      if (this.generation !== gen || ctl.signal.aborted) throw new Error('Cancelled');
      const url = this.deps.createUrl(blob);
      this.urls.add(url);
      return url;
    };
    const p = produce({ signal: ctl.signal, makeUrl })
      .catch((): ImageResult => ({
        ok: false,
        reason: 'error',
        message: 'Could not load the image',
      }))
      .then((r): ImageResult => {
        this.controllers.delete(ctl);
        if (this.generation !== gen) {
          // Any URL created before disposal was revoked by dispose(); later ones are refused by makeUrl().
          return DISPOSED;
        }
        if (!r.ok && this.entries.get(key) === p) this.entries.delete(key); // failures can be retried
        return r;
      });
    this.entries.set(key, p);
    return p;
  }

  private revoke(url: string) {
    if (this.urls.delete(url)) this.deps.revokeUrl(url);
  }

  /** Synchronous and idempotent. */
  dispose(): void {
    this.generation++;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    for (const u of [...this.urls]) this.revoke(u);
    this.entries.clear();
  }

  get liveUrls(): number {
    return this.urls.size;
  }
}
