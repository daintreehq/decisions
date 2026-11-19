import type { LocalStore } from './store.js';

/**
 * The format of what this client stores, kept in the store's `meta` under `STORE_FORMAT_KEY`. It moves on only when a
 * client starts storing something an older client may misread: a new answer entry kind or source, or a new meaning for
 * a stored field. A client refuses a store whose format is newer than its own (`StoreFormatError`), so it never acts on
 * records it cannot understand, and stamps an older or unmarked store with its own format when it opens it. A store
 * without the key was last opened by a client from before formats were kept: format 0.
 */
export const STORE_FORMAT = 1;

/** The `meta` key holding the store's format (`STORE_FORMAT`). */
export const STORE_FORMAT_KEY = 'store_format';

/** A format as stored: a decimal integer with no sign, padding or leading zero. */
const FORMAT = /^(0|[1-9]\d{0,8})$/;

/**
 * A local store this client must not open: a newer client wrote it, so this one could misread what it holds. `marker`
 * says what is newer: the data format (`STORE_FORMAT`), or a SQLite store's schema. Upgrade the client to use it.
 */
export class StoreFormatError extends Error {
  constructor(
    readonly marker: 'format' | 'schema',
    /** What the store holds, as stored. */
    readonly found: string,
    /** The newest this client reads. */
    readonly supported: number,
  ) {
    super(
      marker === 'schema'
        ? `the local store's schema version is ${found}, and this client knows versions up to ${supported}: a newer Decisions client wrote it. Upgrade this client to use it.`
        : /^(0|[1-9]\d*)$/.test(found)
          ? `the local store holds data format ${found}, and this client reads formats up to ${supported}: a newer Decisions client wrote it, and this one could misread what it holds. Upgrade this client to use it.`
          : `the local store's data format ${JSON.stringify(found)} is not one this client reads (up to ${supported}): a newer Decisions client may have written it. Upgrade this client to use it.`,
    );
    this.name = 'StoreFormatError';
  }
}

/**
 * The format of a store whose `meta` holds `raw` under `STORE_FORMAT_KEY` (0 when it holds nothing), when this client
 * may read it. Anything newer, or not a format at all (a value that is not such a string, a BLOB included), throws
 * `StoreFormatError`.
 */
export function checkStoreFormat(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const found = typeof raw === 'string' ? raw : Object.prototype.toString.call(raw);
  const format = typeof raw === 'string' && FORMAT.test(raw) ? Number(raw) : NaN;
  if (!(format <= STORE_FORMAT)) throw new StoreFormatError('format', found, STORE_FORMAT);
  return format;
}

/**
 * Admit a store before anything reads or writes it: refuse one a newer client wrote (`StoreFormatError`), and stamp an
 * older or unmarked one with this client's format. `DecisionsBridge.start()` runs it first. It goes through `getMeta`
 * and `setMeta`, two separate calls, so a store that can check and stamp in one transaction does that when it opens
 * (`SqliteLocalStore` does), and this finds it already stamped.
 */
export async function admitStoreFormat(store: LocalStore): Promise<void> {
  if (checkStoreFormat(await store.getMeta(STORE_FORMAT_KEY)) < STORE_FORMAT)
    await store.setMeta(STORE_FORMAT_KEY, String(STORE_FORMAT));
}
