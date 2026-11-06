import { useEffect, useState } from 'react';
import type { ImageResult } from '../../data/images.js';
import { ClockIcon, ErrorIcon, RefreshIcon, WarningIcon } from '../Icons.js';

export type FileStatus = 'preparing' | 'ready' | 'error' | 'expired' | 'unverified';

export function statusOf(r: ImageResult | undefined): FileStatus {
  if (!r) return 'preparing';
  if (r.ok) return 'ready';
  return r.reason;
}

export const STATUS_TEXT: Record<FileStatus, string> = {
  preparing: 'Preparing preview…',
  ready: 'Ready',
  error: 'Could not load this file',
  expired: 'This file is no longer available',
  unverified: 'File could not be verified',
};

/** Short form for the thumbnail and grid captions. */
export const STATUS_SHORT: Record<FileStatus, string> = {
  preparing: 'Preparing…',
  ready: 'Ready',
  error: 'Not loaded',
  expired: 'Expired',
  unverified: 'Not verified',
};

/**
 * What a stage shows while it has no verified image. Same box as the image it stands in for, so nothing moves when
 * the state changes. Preparing waits out the 400 ms Doherty gate before it says anything.
 */
export function FilePlaceholder({
  status,
  onRetry,
  compact,
}: {
  status: FileStatus;
  onRetry?: () => void;
  compact?: boolean;
}) {
  if (status === 'ready') return null;
  if (status === 'preparing') return <Preparing />;
  const Icon = status === 'expired' ? ClockIcon : status === 'unverified' ? WarningIcon : ErrorIcon;
  return (
    <div className={`fx-state is-${status}`} role="status">
      <span className={`fx-state-glyph is-${status}`} aria-hidden="true">
        <Icon size={compact ? 18 : 22} />
      </span>
      <span className="fx-state-text">{STATUS_TEXT[status]}</span>
      {status === 'unverified' && !compact && (
        <span className="fx-state-sub">It is not shown and cannot be opened.</span>
      )}
      {status === 'expired' && !compact && (
        <span className="fx-state-sub">Your relay deleted it after its retention period.</span>
      )}
      {status === 'error' && onRetry && (
        <button
          type="button"
          className="btn small fx-retry"
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
        >
          <RefreshIcon size={16} />
          Retry
        </button>
      )}
    </div>
  );
}

/** Preparing preview…, then "Still loading…" once it has taken more than 5 s (guide 2.6). */
function Preparing() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="fx-state is-preparing" role="status">
      <span className="fx-state-pulse" aria-hidden="true" />
      <span className="fx-state-text">{slow ? 'Still loading…' : STATUS_TEXT.preparing}</span>
    </div>
  );
}

/** The small glyph a thumbnail shows in place of an image. */
export function StatusGlyph({ status }: { status: FileStatus }) {
  if (status === 'ready') return null;
  if (status === 'preparing') return <span className="fx-thumb-pulse" aria-hidden="true" />;
  const Icon = status === 'expired' ? ClockIcon : status === 'unverified' ? WarningIcon : ErrorIcon;
  return (
    <span className={`fx-state-glyph is-${status}`} aria-hidden="true">
      <Icon size={16} />
    </span>
  );
}
