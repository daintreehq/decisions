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
  /** Aborted when the cache is disposed (unpair, wipe, revocation) or no viewer wants the image any more. */
  signal: AbortSignal;
  /** Creates an object URL that the cache tracks and revokes. Throws if the cache was disposed meanwhile. */
  makeUrl(blob: Blob): string;
}

export interface ImageCacheDeps {
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
}

const DISPOSED: ImageResult = { ok: false, reason: 'error', message: 'Cancelled' };

/** Decrypted images kept after their last viewer goes, for quick back-and-forth between questions. */
export const IDLE_IMAGES = 12;

interface Entry {
  promise: Promise<ImageResult>;
  ctl: AbortController;
  urls: Set<string>;
  settled: boolean;
}

/**
 * Decrypted attachment images, held as object URLs, for as long as something shows them. Viewers `retain` the
 * images they show; when the last one lets go, an image still downloading is aborted and a loaded one joins a
 * small least-recently-used set (IDLE_IMAGES), beyond which the oldest is revoked. Disposal is immediate and
 * never waits on the network: in-flight downloads are aborted, results that arrive afterwards are thrown away (and
 * their URLs refused), and every URL already handed out is revoked, so erasing or locking a phone cannot be held
 * up or undone by a slow request.
 */
export class ImageCache {
  private entries = new Map<string, Entry>();
  /** How many viewers hold each image. */
  private refs = new Map<string, number>();
  /** Loaded images no viewer holds, least recently used first. */
  private idle = new Set<string>();
  private generation = 0;

  constructor(private readonly deps: ImageCacheDeps) {}

  load(key: string, produce: (ctx: ImageContext) => Promise<ImageResult>): Promise<ImageResult> {
    const hit = this.entries.get(key);
    if (hit) {
      if (this.idle.delete(key)) this.idle.add(key);
      return hit.promise;
    }
    const gen = this.generation;
    const entry: Entry = {
      promise: Promise.resolve(DISPOSED),
      ctl: new AbortController(),
      urls: new Set(),
      settled: false,
    };
    const makeUrl = (blob: Blob): string => {
      if (this.generation !== gen || entry.ctl.signal.aborted) throw new Error('Cancelled');
      const url = this.deps.createUrl(blob);
      entry.urls.add(url);
      return url;
    };
    this.entries.set(key, entry);
    entry.promise = produce({ signal: entry.ctl.signal, makeUrl })
      .catch((): ImageResult => ({
        ok: false,
        reason: 'error',
        message: 'Could not load the image',
      }))
      .then((r): ImageResult => {
        entry.settled = true;
        // Disposed or evicted meanwhile: its URLs were revoked then, and later ones were refused.
        if (this.generation !== gen || entry.ctl.signal.aborted) return DISPOSED;
        if (!r.ok) {
          this.revokeAll(entry);
          if (this.entries.get(key) === entry) this.entries.delete(key); // failures can be retried
        } else if (!this.refs.has(key)) this.park(key); // loaded with no viewer left
        return r;
      });
    return entry.promise;
  }

  /**
   * A viewer holds `key` until it calls the returned release. Releasing is idempotent; a viewer that re-acquires
   * the image in the same update (a re-render with the same files) keeps it without a reload.
   */
  retain(key: string): () => void {
    const gen = this.generation;
    this.refs.set(key, (this.refs.get(key) ?? 0) + 1);
    this.idle.delete(key);
    let held = true;
    return () => {
      if (!held || gen !== this.generation) return;
      held = false;
      const n = (this.refs.get(key) ?? 1) - 1;
      if (n > 0) {
        this.refs.set(key, n);
        return;
      }
      this.refs.delete(key);
      queueMicrotask(() => {
        if (gen !== this.generation || this.refs.has(key)) return;
        const e = this.entries.get(key);
        if (!e) return;
        if (e.settled) this.park(key);
        else this.evict(key); // still downloading for no one
      });
    };
  }

  /** Keep a loaded, unheld image among the recently used, revoking the oldest beyond the bound. */
  private park(key: string) {
    this.idle.delete(key);
    this.idle.add(key);
    while (this.idle.size > IDLE_IMAGES) this.evict(this.idle.values().next().value!);
  }

  private evict(key: string) {
    this.idle.delete(key);
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    e.ctl.abort();
    this.revokeAll(e);
  }

  private revokeAll(e: Entry) {
    for (const u of e.urls) this.deps.revokeUrl(u);
    e.urls.clear();
  }

  /** Synchronous and idempotent. */
  dispose(): void {
    this.generation++;
    for (const e of this.entries.values()) {
      e.ctl.abort();
      this.revokeAll(e);
    }
    this.entries.clear();
    this.refs.clear();
    this.idle.clear();
  }

  get liveUrls(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.urls.size;
    return n;
  }
}
