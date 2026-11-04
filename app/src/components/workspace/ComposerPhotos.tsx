import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { AttachmentDescriptor } from '@daintreehq/decisions-protocol';
import { useLayer } from '../../app/layers.js';
import type { ImageResult } from '../../data/images.js';
import type { QuestionView } from '../../domain/model.js';
import type { DraftPhoto } from '../../features/compose/draftStore.js';
import { CameraIcon, CloseIcon, ImageIcon, PlusIcon } from '../Icons.js';
import type { FilesModel } from '../files/model.js';
import { fileKey, type FileItem } from '../files/sequence.js';
import { QuestionSheet } from '../files/Sheets.js';
import { Viewer } from '../files/Viewer.js';
import { FIT_NORMAL, type NormalView, type Size } from '../files/zoom.js';
import { Sheet } from './Sheet.js';

/** What the composer needs to offer photos: the draft's photos, the room left, and what to do with a choice. */
export interface ComposerPhotosProps {
  /** The question, for the viewer's identity when a chosen photo is opened before sending. */
  view: QuestionView;
  list: readonly DraftPhoto[];
  /** How many more photos can go with this answer or follow-up (0 when full). */
  room: number;
  /** The most one answer or follow-up can carry here (4, or fewer near the question's own limit). */
  limit: number;
  /** "answer" or "follow-up": what the photos go with, for the words. */
  noun: string;
  /** The device can take a photo (a phone or tablet with a camera), so `+` offers it beside the library. */
  camera: boolean;
  /** Send is sealing the draft: nothing may be added or removed until it has. */
  locked: boolean;
  onAdd: (files: Blob[]) => void;
  onRemove: (id: string) => void;
  /** `+` was tapped with no room left: say why in the lane. */
  onFull: () => void;
}

const imageFiles = (list: FileList | null | undefined): File[] =>
  [...(list ?? [])].filter((f) => !f.type || f.type.startsWith('image/'));

/**
 * `+` at the composer's leading edge. On a phone or tablet with a camera it opens a small sheet, Take photo and
 * Choose photos; anywhere else there is only the library, so it opens the picker directly rather than a sheet with
 * one choice in it. With no room left it stays where it is and says why, rather than greying out silently.
 */
export function AttachButton({ photos }: { photos: ComposerPhotosProps }) {
  const [open, setOpen] = useState(false);
  const cam = useRef<HTMLInputElement>(null);
  const lib = useRef<HTMLInputElement>(null);
  const full = photos.room <= 0;
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = imageFiles(e.currentTarget.files);
    // Cleared at once, so choosing the same photo again still reports a change.
    e.currentTarget.value = '';
    if (files.length && !photos.locked) photos.onAdd(files);
  };
  const library = () => {
    setOpen(false);
    lib.current?.click();
  };
  const shoot = () => {
    setOpen(false);
    cam.current?.click();
  };
  const sub =
    photos.room >= photos.limit
      ? `Up to ${photos.limit} with each ${photos.noun}`
      : `${photos.room} more can go with this ${photos.noun}`;
  const offersSheet = photos.camera && !full;
  return (
    <>
      <button
        type="button"
        className="composer-add"
        aria-label="Add photos"
        aria-haspopup={offersSheet ? 'dialog' : undefined}
        aria-expanded={offersSheet ? open : undefined}
        aria-disabled={full || photos.locked || undefined}
        title="Add photos"
        onClick={() => {
          if (photos.locked) return;
          if (full) photos.onFull();
          else if (photos.camera) setOpen(true);
          else lib.current?.click();
        }}
      >
        <PlusIcon size={22} />
      </button>
      <input
        ref={cam}
        className="file-input"
        type="file"
        accept="image/*"
        capture="environment"
        tabIndex={-1}
        aria-hidden="true"
        onChange={pick}
      />
      <input
        ref={lib}
        className="file-input"
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={pick}
      />
      {photos.camera && (
        <Sheet
          open={open}
          title="Add photos"
          onClose={() => setOpen(false)}
          className="attach-sheet"
        >
          <div className="attach-options">
            <button type="button" className="attach-option" onClick={shoot}>
              <span className="attach-glyph" aria-hidden="true">
                <CameraIcon size={22} />
              </span>
              <span className="attach-text">
                <span className="attach-label">Take photo</span>
                <span className="attach-sub">With the camera</span>
              </span>
            </button>
            <button type="button" className="attach-option" onClick={library}>
              <span className="attach-glyph" aria-hidden="true">
                <ImageIcon size={22} />
              </span>
              <span className="attach-text">
                <span className="attach-label">Choose photos</span>
                <span className="attach-sub">{sub}</span>
              </span>
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

type Ready = Extract<DraftPhoto, { status: 'ready' }>;

/** The draft's ready photos as the file viewer's sequence, shown from their own bytes (nothing is fetched). */
function useDraftViewer(view: QuestionView, list: readonly DraftPhoto[]) {
  const ready = list.filter((p): p is Ready => p.status === 'ready');
  const sig = ready.map((p) => p.id).join(',');
  const items: FileItem[] = useMemo(
    () =>
      ready.map((p, index) => {
        const d: AttachmentDescriptor = {
          attachment_id: p.id,
          role: 'other',
          mime: p.mime,
          size: p.bytes.length,
          sha256: p.sha256,
          nonce: 'AAAAAAAAAAAAAAAA',
          key_epoch: 1,
        };
        const at = list.indexOf(p);
        return { d, index, label: `Photo ${at + 1}`, spoken: 'Your photo', key: fileKey(d) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig],
  );
  const results = useMemo(() => {
    const out: Record<string, ImageResult> = {};
    for (const p of ready)
      out[p.id] = { ok: true, image: { url: p.url, sha256: p.sha256, mime: p.mime } };
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const [naturals, setNaturals] = useState<Record<string, Size>>({});
  const [zooms, setZooms] = useState<Record<string, NormalView>>({});
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
      retry: () => undefined,
      zoomOf: (k) => zooms[k] ?? FIT_NORMAL,
      setZoom: (k, v) => setZooms((z) => ({ ...z, [k]: v })),
      present: () => undefined,
    }),
    [view, items, results, naturals, onNatural, zooms],
  );
  return { model, items };
}

/**
 * The chosen photos, above the field inside the pill: square thumbnails showing the whole photo, each opening it full
 * size before Send, each with its own remove button. A photo still being prepared holds its place, so nothing shifts
 * when it is ready. Removing one moves focus to the next remove button (or `+`), never to the page.
 */
export function PhotoTray({ photos }: { photos: ComposerPhotosProps }) {
  const n = photos.list.length;
  const ul = useRef<HTMLUListElement>(null);
  const refocus = useRef<number | null>(null);
  const { model, items } = useDraftViewer(photos.view, photos.list);
  const [viewing, setViewing] = useState<number | null>(null);
  const [question, setQuestion] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  useLayer(viewing !== null, () => setViewing(null));
  useLayer(question, () => setQuestion(false));
  useLayoutEffect(() => {
    const at = refocus.current;
    if (at === null) return;
    refocus.current = null;
    const buttons = ul.current?.querySelectorAll<HTMLButtonElement>('.tray-remove');
    const next = buttons?.[Math.min(at, (buttons?.length ?? 1) - 1)];
    if (next) next.focus();
    else (document.querySelector('.dock .composer-add') as HTMLButtonElement | null)?.focus();
  }, [n]);
  if (!n) return null;
  const active = viewing !== null ? Math.min(viewing, items.length - 1) : null;
  return (
    <>
      <ul
        ref={ul}
        className="composer-tray"
        aria-label={n === 1 ? '1 photo attached' : `${n} photos attached`}
      >
        {photos.list.map((p, i) => (
          <li key={p.id} className={`tray-photo is-${p.status}`}>
            {p.status === 'ready' ? (
              <button
                type="button"
                className="tray-open"
                aria-label={`Photo ${i + 1} of ${n}, view`}
                title="View photo"
                onClick={(e) => {
                  opener.current = e.currentTarget;
                  setViewing(items.findIndex((it) => it.d.attachment_id === p.id));
                }}
              >
                <img src={p.url} alt="" draggable={false} />
              </button>
            ) : (
              <span
                className="tray-wait"
                role="img"
                aria-label={`Photo ${i + 1} of ${n}, preparing`}
              >
                <span className="spinner small" aria-hidden="true" />
              </span>
            )}
            <button
              type="button"
              className="tray-remove"
              aria-label={`Remove photo ${i + 1} of ${n}`}
              aria-disabled={photos.locked || undefined}
              title="Remove photo"
              onClick={(e) => {
                if (photos.locked) return;
                // Only a keyboard or a focused press moves focus on; a tap leaves it where the finger is.
                const focused = document.activeElement === e.currentTarget;
                if (focused) refocus.current = i;
                photos.onRemove(p.id);
                // The last one takes the tray with it: `+`, which stays, takes the focus.
                if (focused && n === 1)
                  requestAnimationFrame(() =>
                    (document.querySelector('.dock .composer-add') as HTMLElement | null)?.focus(),
                  );
              }}
            >
              <CloseIcon size={14} />
            </button>
          </li>
        ))}
      </ul>
      {active !== null && active >= 0 && (
        <Viewer
          model={model}
          active={active}
          onActive={setViewing}
          onClose={() => setViewing(null)}
          onQuestion={() => setQuestion(true)}
          focusFallback={() => opener.current}
          covered={question}
        />
      )}
      {question && <QuestionSheet view={photos.view} onDismiss={() => setQuestion(false)} />}
    </>
  );
}

export { imageFiles };
