import { useEffect, useMemo, useState } from 'react';
import type { AttachmentDescriptor } from '@daintree/decisions-protocol';
import { app, type ImageResult } from '../app/controller.js';
import type { QuestionView } from '../domain/model.js';
import { Dialog } from './Dialog.js';
import { ZoomableImage } from './ZoomableImage.js';

export interface ReviewState {
  /** sha256 of every plaintext image that was fetched, authenticated and decoded successfully. */
  digests: string[];
  total: number;
  loaded: number;
  expired: number;
  failed: number;
}

function Thumb({
  d,
  r,
  onOpen,
  label,
}: {
  d: AttachmentDescriptor;
  r: ImageResult | undefined;
  onOpen: () => void;
  label: string;
}) {
  if (!r) return <div className="thumb skeleton" role="img" aria-label={`Loading ${label}`} />;
  if (!r.ok) {
    return (
      <div className="thumb error" role="img" aria-label={`${label}: ${r.message}`}>
        <span>{r.reason === 'expired' ? 'Expired' : 'Could not load'}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="thumb"
      onClick={onOpen}
      aria-label={`Open ${label} full screen`}
    >
      <img src={r.image.url} alt={d.alt ?? label} />
    </button>
  );
}

const ROLE_LABEL: Record<string, string> = {
  before: 'Before',
  after: 'After',
  reference: 'Reference',
  other: 'Image',
};

export function AttachmentGallery({
  view,
  onReview,
}: {
  view: QuestionView;
  onReview: (s: ReviewState) => void;
}) {
  const items = view.content?.attachments ?? [];
  const [results, setResults] = useState<Record<string, ImageResult>>({});
  const [open, setOpen] = useState<string | null>(null);
  const itemKey = items.map((i) => i.attachment_id).join(',');

  useEffect(() => {
    let live = true;
    for (const d of items) {
      void app
        .loadImage(view, d)
        .then((r) => live && setResults((p) => ({ ...p, [d.attachment_id]: r })));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id, itemKey]);

  const state = useMemo<ReviewState>(() => {
    const rs = items.map((d) => results[d.attachment_id]);
    return {
      digests: rs.flatMap((r) => (r?.ok ? [r.image.sha256] : [])),
      total: items.length,
      loaded: rs.filter((r) => r?.ok).length,
      expired: rs.filter((r) => r && !r.ok && r.reason === 'expired').length,
      failed: rs.filter((r) => r && !r.ok && r.reason === 'error').length,
    };
  }, [items, results]);

  useEffect(() => onReview(state), [state, onReview]);

  if (!items.length) return null;
  const before = items.find((i) => i.role === 'before');
  const after = items.find((i) => i.role === 'after');
  const compare = before && after;
  const rest = compare ? items.filter((i) => i !== before && i !== after) : items;
  const current = items.find((i) => i.attachment_id === open);
  const currentResult = current ? results[current.attachment_id] : undefined;

  return (
    <section className="attachments" aria-label="Attachments">
      {compare && (
        <div className="compare" role="group" aria-label="Before and after">
          {[before, after].map((d) => (
            <figure key={d.attachment_id}>
              <Thumb
                d={d}
                r={results[d.attachment_id]}
                label={ROLE_LABEL[d.role]!}
                onOpen={() => setOpen(d.attachment_id)}
              />
              <figcaption>{ROLE_LABEL[d.role]}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div className="gallery" role="list">
          {rest.map((d) => (
            <figure key={d.attachment_id} role="listitem">
              <Thumb
                d={d}
                r={results[d.attachment_id]}
                label={d.alt ?? ROLE_LABEL[d.role]!}
                onOpen={() => setOpen(d.attachment_id)}
              />
              <figcaption>{d.alt ?? ROLE_LABEL[d.role]}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {state.expired > 0 && (
        <p className="note warn">Some attachments expired and were deleted from your relay.</p>
      )}
      {state.failed > 0 && (
        <p className="note warn">Some attachments could not be verified or loaded.</p>
      )}
      <Dialog
        open={!!current && !!currentResult?.ok}
        title={current ? (current.alt ?? ROLE_LABEL[current.role]!) : ''}
        onClose={() => setOpen(null)}
        actions={
          <button type="button" className="btn primary" onClick={() => setOpen(null)}>
            Close
          </button>
        }
      >
        {current && currentResult?.ok && (
          <ZoomableImage
            src={currentResult.image.url}
            alt={current.alt ?? ROLE_LABEL[current.role]!}
          />
        )}
      </Dialog>
    </section>
  );
}
