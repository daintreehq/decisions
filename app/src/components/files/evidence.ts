import type { ImageResult } from '../../data/images.js';
import type { FileItem } from './sequence.js';

/**
 * Evidence review (guide 5.3). Verified is "the exact bytes decrypted, validated and decoded". Presented is "the
 * file was actually displayed as the active inline preview, in the viewer, or in a usable comparison pane". A
 * prefetch or a thumbnail never counts. Send acknowledges the digests of presented files only.
 */
export interface ReviewState {
  /** sha256 of every file that was both verified and presented: what Send acknowledges. */
  digests: string[];
  total: number;
  /** Verified (decrypted, digest-checked, decoded). */
  loaded: number;
  /** Verified and actually displayed: the active inline preview, the viewer, or a usable comparison pane. */
  presented: number;
  expired: number;
  /** Could not load, or could not be verified. */
  failed: number;
}

export const NO_REVIEW: ReviewState = {
  digests: [],
  total: 0,
  loaded: 0,
  presented: 0,
  expired: 0,
  failed: 0,
};

/** Presentation belongs to one question revision; a new revision starts again. */
export const scopeKey = (v: { id: string; revision: number }): string => `${v.id}@${v.revision}`;

const verified = (item: FileItem, r: ImageResult | undefined): boolean =>
  !!r && r.ok && r.image.sha256 === item.d.sha256;

export function computeReview(
  items: readonly FileItem[],
  results: Readonly<Record<string, ImageResult | undefined>>,
  presented: ReadonlySet<string>,
): ReviewState {
  const digests: string[] = [];
  let loaded = 0;
  let expired = 0;
  let failed = 0;
  for (const item of items) {
    const r = results[item.d.attachment_id];
    if (verified(item, r)) {
      loaded++;
      // Keyed by digest, so a changed file is never covered by having seen the old one.
      if (presented.has(item.key)) digests.push(item.d.sha256);
    } else if (r && !r.ok) {
      if (r.reason === 'expired') expired++;
      else failed++;
    }
  }
  return { digests, total: items.length, loaded, presented: digests.length, expired, failed };
}

export const sameReview = (a: ReviewState, b: ReviewState): boolean =>
  a.total === b.total &&
  a.loaded === b.loaded &&
  a.presented === b.presented &&
  a.expired === b.expired &&
  a.failed === b.failed &&
  a.digests.length === b.digests.length &&
  a.digests.every((d, i) => d === b.digests[i]);

/** Index of the first file not yet both verified and presented, or -1 when every file has been. */
export function firstUnreviewed(
  items: readonly FileItem[],
  results: Readonly<Record<string, ImageResult | undefined>>,
  presented: ReadonlySet<string>,
): number {
  return items.findIndex(
    (item) => !(verified(item, results[item.d.attachment_id]) && presented.has(item.key)),
  );
}

/**
 * What has been presented this session, per question revision. Kept for the session so leaving a question and
 * coming back does not demand the same files again; it never outlives the page and never survives a new revision
 * or a changed digest (both change the keys).
 */
export class PresentationLog {
  private scopes = new Map<string, Set<string>>();

  /** Returns true when this is news. */
  mark(scope: string, key: string): boolean {
    let set = this.scopes.get(scope);
    if (!set) this.scopes.set(scope, (set = new Set()));
    if (set.has(key)) return false;
    set.add(key);
    return true;
  }

  get(scope: string): ReadonlySet<string> {
    return new Set(this.scopes.get(scope) ?? []);
  }

  clear(): void {
    this.scopes.clear();
  }
}

export const presentationLog = new PresentationLog();
