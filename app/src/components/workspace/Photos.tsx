import { useCallback, useMemo, useRef, useState } from 'react';
import type { AttachmentDescriptor, PhoneImageReference } from '@daintreehq/decisions-protocol';
import { useLayer } from '../../app/layers.js';
import { photoCount } from '../../data/photos.js';
import type { PhotoState } from '../../data/outbox.js';
import type { QuestionView } from '../../domain/model.js';
import type { DraftPhoto } from '../../features/compose/draftStore.js';
import { ClockIcon, RefreshIcon, WarningIcon } from '../Icons.js';
import { StatusGlyph, statusOf } from '../files/FileState.js';
import type { FilesModel } from '../files/model.js';
import { zoomMemory } from '../files/model.js';
import { fileKey, type FileItem } from '../files/sequence.js';
import { QuestionSheet } from '../files/Sheets.js';
import { useFileLoader } from '../files/useFileLoader.js';
import { Viewer } from '../files/Viewer.js';
import { FIT_NORMAL, type NormalView, type Size } from '../files/zoom.js';

/** Where each queued photo has got to on its way to the relay. */
export interface PhotoUpload {
  state: (attachmentId: string) => PhotoState;
}

/** The person's photos as the file viewer's sequence: "Photo 1", "Photo 2". Never evidence for an approval. */
function photoSequence(images: readonly PhoneImageReference[]): FileItem[] {
  return images.map((ref, index) => {
    const d: AttachmentDescriptor = { ...ref, role: 'other' };
    const label = `Photo ${index + 1}`;
    return { d, index, label, spoken: 'Your photo', key: fileKey(d) };
  });
}

/** A progress ring: the share uploaded, drawn on the scrim over the thumbnail; full and turning while it finishes. */
function Ring({ value, finishing }: { value: number; finishing?: boolean }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className={`photo-ring${finishing ? ' finishing' : ''}`}
      viewBox="0 0 36 36"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="photo-ring-track" cx="18" cy="18" r={r} />
      <circle
        className="photo-ring-fill"
        cx="18"
        cy="18"
        r={r}
        strokeDasharray={finishing ? `${c * 0.25} ${c}` : c}
        strokeDashoffset={finishing ? 0 : c * (1 - value)}
      />
    </svg>
  );
}

/** What a queued photo's frame says, in words for assistive tech. */
function stateWords(s: PhotoState): string {
  switch (s.kind) {
    case 'waiting':
      return 'waiting to upload';
    case 'uploading':
      return `uploading, ${Math.round(s.fraction * 100)}%`;
    case 'finishing':
      return 'uploaded, confirming';
    case 'interrupted':
      return 'upload stopped';
    case 'done':
      return '';
  }
}

/**
 * The person's photos inside their bubble: one at a 4:3 frame, two side by side, three as one large and two small,
 * four as a grid. Every frame is fixed before the photo loads, so nothing in the thread moves. A tap opens the same
 * viewer as the agent's screenshots. While queued, each photo carries its upload progress; a photo that couldn't be
 * fetched or verified says so in its frame.
 */
export function PhotoGrid({
  view,
  images,
  upload,
  unverified,
}: {
  view: QuestionView;
  images: readonly PhoneImageReference[];
  upload?: PhotoUpload;
  /** The content's photos don't match its signed record: none of them is fetched or shown. */
  unverified?: boolean;
}) {
  const itemKey = images.map((i) => `${i.attachment_id}:${i.sha256}`).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => (unverified ? [] : photoSequence(images)), [itemKey, unverified]);
  const n = images.length;
  const [active, setActive] = useState(0);
  const [viewer, setViewer] = useState(false);
  const [question, setQuestion] = useState(false);
  useLayer(viewer, () => setViewer(false));
  useLayer(question, () => setQuestion(false));
  const { results, retry } = useFileLoader(view, items, active);
  const [naturals, setNaturals] = useState<Record<string, Size>>({});
  const [zooms, setZooms] = useState<Record<string, NormalView>>({});
  const opener = useRef<HTMLElement | null>(null);
  const zoomOf = useCallback((k: string) => zooms[k] ?? zoomMemory.get(k) ?? FIT_NORMAL, [zooms]);
  const setZoom = useCallback((k: string, v: NormalView) => {
    zoomMemory.set(k, v);
    setZooms((z) => ({ ...z, [k]: v }));
  }, []);
  const onNatural = useCallback((id: string, size: Size) => {
    setNaturals((m) => (m[id]?.w === size.w && m[id]?.h === size.h ? m : { ...m, [id]: size }));
  }, []);
  const model: FilesModel = useMemo(
    () => ({
      view,
      items,
      results,
      naturals,
      onNatural,
      retry,
      zoomOf,
      setZoom,
      present: () => undefined,
    }),
    [view, items, results, naturals, onNatural, retry, zoomOf, setZoom],
  );

  if (!n) return null;
  if (unverified)
    return (
      <p className="photo-note warn">
        <WarningIcon size={14} />
        {n === 1 ? 'Its photo' : `Its ${photoCount(n)}`} couldn’t be verified, so{' '}
        {n === 1 ? 'it isn’t' : 'they aren’t'} shown.
      </p>
    );

  const open = (i: number, el: HTMLElement) => {
    const r = results[items[i]!.d.attachment_id];
    // A photo that couldn't be fetched is asked for again from its frame; expired or unverified ones stay shut.
    if (r && !r.ok && r.reason === 'error') return retry(items[i]!.d.attachment_id);
    if (!r?.ok) return;
    opener.current = el;
    setActive(i);
    setViewer(true);
  };
  return (
    <>
      <ul className="photo-grid" data-n={Math.min(n, 4)} aria-label={photoCount(n)}>
        {items.map((it, i) => {
          const r = results[it.d.attachment_id];
          const st = statusOf(r);
          const up = upload?.state(it.d.attachment_id) ?? ({ kind: 'done' } as PhotoState);
          const going = up.kind !== 'done';
          const words = going
            ? `, ${stateWords(up)}`
            : st === 'ready'
              ? ', open'
              : st === 'preparing'
                ? ', loading'
                : st === 'error'
                  ? ', couldn’t load, tap to try again'
                  : ', not available';
          return (
            <li
              key={it.key}
              className={`photo-cell is-${st}${going ? ` is-going is-${up.kind}` : ''}`}
            >
              <button
                type="button"
                className="photo-tile"
                aria-label={`${it.label} of ${n}${words}`}
                aria-disabled={(st !== 'ready' && st !== 'error') || undefined}
                onClick={(e) => open(i, e.currentTarget)}
              >
                {r?.ok ? (
                  <img src={r.image.url} alt="" draggable={false} />
                ) : st === 'error' ? (
                  <span className="photo-retry" aria-hidden="true">
                    <RefreshIcon size={18} />
                  </span>
                ) : (
                  <StatusGlyph status={st} />
                )}
              </button>
              {going && (
                <span
                  className={`photo-progress is-${up.kind}`}
                  role="progressbar"
                  aria-label={`Uploading ${it.label.toLowerCase()}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  {...(up.kind === 'uploading'
                    ? { 'aria-valuenow': Math.round(up.fraction * 100) }
                    : up.kind === 'finishing'
                      ? { 'aria-valuenow': 100 }
                      : {})}
                  aria-valuetext={stateWords(up)}
                >
                  {up.kind === 'interrupted' ? (
                    <span className="photo-badge warn" aria-hidden="true">
                      <WarningIcon size={16} />
                    </span>
                  ) : up.kind === 'waiting' ? (
                    <span className="photo-badge" aria-hidden="true">
                      <ClockIcon size={16} />
                    </span>
                  ) : (
                    <Ring
                      value={up.kind === 'uploading' ? up.fraction : 1}
                      finishing={up.kind === 'finishing'}
                    />
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {viewer && (
        <Viewer
          model={model}
          active={active}
          onActive={setActive}
          onClose={() => setViewer(false)}
          onQuestion={() => setQuestion(true)}
          focusFallback={() => opener.current}
          covered={question}
        />
      )}
      {question && <QuestionSheet view={view} onDismiss={() => setQuestion(false)} />}
    </>
  );
}

/** A draft's photos where the draft can no longer be sent (the question closed): small, so the words still lead. */
export function DraftPhotoStrip({ photos }: { photos: readonly DraftPhoto[] }) {
  const ready = photos.filter(
    (p): p is Extract<DraftPhoto, { status: 'ready' }> => p.status === 'ready',
  );
  if (!ready.length) return null;
  return (
    <ul className="draft-photos" aria-label={`${photoCount(ready.length)} not sent`}>
      {ready.map((p, i) => (
        <li key={p.id}>
          <img src={p.url} alt={`Photo ${i + 1}`} draggable={false} />
        </li>
      ))}
    </ul>
  );
}
