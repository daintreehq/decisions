import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { useLayer } from '../app/layers.js';
import type { QuestionView } from '../domain/model.js';
import { Compare, type Side } from './files/Compare.js';
import {
  computeReview,
  firstUnreviewed,
  presentationLog,
  sameReview,
  scopeKey,
  type ReviewState,
} from './files/evidence.js';
import { FileStage, type FileStageHandle } from './files/FileStage.js';
import { STATUS_SHORT, StatusGlyph, statusOf } from './files/FileState.js';
import { zoomMemory, type FilesModel } from './files/model.js';
import {
  announceFor,
  autoPair,
  buildSequence,
  stepIndex,
  type FileItem,
} from './files/sequence.js';
import { AllFilesSheet, QuestionSheet } from './files/Sheets.js';
import { useFileLoader } from './files/useFileLoader.js';
import { slidesFor, Viewer } from './files/Viewer.js';
import { FIT_NORMAL, type NormalView, type Size } from './files/zoom.js';
import { CompareIcon, ExpandIcon, GridIcon } from './Icons.js';

export type { ReviewState } from './files/evidence.js';
export { NO_REVIEW } from './files/evidence.js';
export { registerHandoffGuard, type HandoffGuard } from './files/handoff.js';

export interface GalleryHandle {
  /** Select (and scroll into view) the first file that has not been presented yet. */
  showFirstUnreviewed(): void;
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A question's files (guide 5): the inline gallery, the viewer, comparison, All files, Open/Download, and the
 * presentation-based evidence review that approvals depend on. Renders nothing when there are no files.
 */
export function AttachmentGallery({
  view,
  onReview,
  handleRef,
}: {
  view: QuestionView;
  onReview: (s: ReviewState) => void;
  handleRef?: Ref<GalleryHandle>;
}) {
  const uid = useId();
  const attachments = view.content?.attachments;
  const itemKey = (attachments ?? []).map((a) => `${a.attachment_id}:${a.sha256}`).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => buildSequence(attachments ?? []), [itemKey]);
  const n = items.length;
  const [activeRaw, setActive] = useState(0);
  const active = Math.min(activeRaw, Math.max(0, n - 1));
  const item: FileItem | undefined = items[active];
  const { results, retry } = useFileLoader(view, items, active);
  const [naturals, setNaturals] = useState<Record<string, Size>>({});
  const [announce, setAnnounce] = useState('');
  const pair = useMemo(() => autoPair(items), [items]);

  /* ---------- evidence ---------- */
  const scope = scopeKey(view);
  const [presented, setPresented] = useState(() => presentationLog.get(scope));
  useEffect(() => setPresented(presentationLog.get(scope)), [scope]);
  const present = useCallback(
    (it: FileItem) => {
      const r = results[it.d.attachment_id];
      if (!r?.ok || r.image.sha256 !== it.d.sha256) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (presentationLog.mark(scope, it.key)) setPresented(presentationLog.get(scope));
    },
    [results, scope],
  );
  const review = useMemo(
    () => computeReview(items, results, presented),
    [items, results, presented],
  );
  const reported = useRef<ReviewState | null>(null);
  useEffect(() => {
    if (reported.current && sameReview(reported.current, review)) return;
    reported.current = review;
    onReview(review);
  }, [review, onReview]);

  /* ---------- layers ---------- */
  const [viewer, setViewer] = useState(false);
  const [compare, setCompare] = useState<Side | null>(null);
  const [allFiles, setAllFiles] = useState(false);
  const [question, setQuestion] = useState(false);
  // Each is a history layer: Back closes the topmost. Closing by state unwinds its entry silently, and moving
  // from file to file never adds one.
  useLayer(viewer, () => setViewer(false));
  useLayer(compare !== null, () => setCompare(null));
  useLayer(allFiles, () => setAllFiles(false));
  useLayer(question, () => setQuestion(false));

  // Another question (or a new revision with other files) starts from the first file with nothing open.
  useEffect(() => {
    setActive(0);
    setViewer(false);
    setCompare(null);
    setAllFiles(false);
    setQuestion(false);
    setAnnounce('');
  }, [view.id, itemKey]);

  /* ---------- zoom memory ---------- */
  const [zooms, setZooms] = useState<Record<string, NormalView>>({});
  const zoomOf = useCallback((k: string) => zooms[k] ?? zoomMemory.get(k) ?? FIT_NORMAL, [zooms]);
  const setZoom = useCallback((k: string, v: NormalView) => {
    zoomMemory.set(k, v);
    setZooms((z) => ({ ...z, [k]: v }));
  }, []);
  const onNatural = useCallback((id: string, size: Size) => {
    setNaturals((m) => (m[id]?.w === size.w && m[id]?.h === size.h ? m : { ...m, [id]: size }));
  }, []);

  const model: FilesModel = useMemo(
    () => ({ view, items, results, naturals, onNatural, retry, zoomOf, setZoom, present }),
    [view, items, results, naturals, onNatural, retry, zoomOf, setZoom, present],
  );

  /* ---------- selection ---------- */
  const select = useCallback(
    (i: number) => {
      const it = items[i];
      if (!it) return;
      setActive(i);
      setAnnounce(announceFor(it, items.length));
    },
    [items],
  );

  const stage = useRef<FileStageHandle>(null);
  const opener = useRef<HTMLElement | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [focusTab, setFocusTab] = useState(0);
  useEffect(() => setFocusTab(active), [active]);

  // Keep the active thumbnail in view inside the strip without scrolling the page.
  useEffect(() => {
    const s = strip.current;
    const tab = s?.children[active] as HTMLElement | undefined;
    if (!s || !tab) return;
    const left = tab.offsetLeft - s.offsetLeft;
    if (left < s.scrollLeft) s.scrollLeft = left - 8;
    else if (left + tab.offsetWidth > s.scrollLeft + s.clientWidth)
      s.scrollLeft = left + tab.offsetWidth - s.clientWidth + 8;
  }, [active]);

  /* ---------- inline presentation ---------- */
  const [inlineVisible, setInlineVisible] = useState(
    () => typeof IntersectionObserver === 'undefined',
  );
  useEffect(() => {
    const el = stage.current?.el;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([e]) => setInlineVisible(!!e && e.isIntersecting && e.intersectionRatio >= 0.5),
      { threshold: [0, 0.5, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [n > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const overlayOpen = viewer || compare !== null || allFiles || question;
  const activeNatural = item ? naturals[item.d.attachment_id] : undefined;
  useEffect(() => {
    // The active inline preview, at least half on screen with nothing over it, is presented.
    if (item && inlineVisible && !overlayOpen && activeNatural) present(item);
  }, [item, inlineVisible, overlayOpen, activeNatural, present]);

  useImperativeHandle(
    handleRef,
    () => ({
      showFirstUnreviewed() {
        const i = firstUnreviewed(items, results, presented);
        if (i < 0) return;
        select(i);
        if (viewer || compare !== null) {
          setCompare(null);
          setViewer(true);
          return;
        }
        stage.current?.el?.scrollIntoView({
          block: 'center',
          behavior: reducedMotion() ? 'auto' : 'smooth',
        });
      },
    }),
    [items, results, presented, select, viewer, compare],
  );

  if (!item) return null;

  const r = results[item.d.attachment_id];
  const ready = !!r?.ok;
  // Whatever opened the viewer gets focus back, even after a trip through comparison remounts it.
  const rememberOpener = () => {
    if (!viewer && compare === null) opener.current = document.activeElement as HTMLElement | null;
  };
  const focusBack = () =>
    opener.current?.isConnected && opener.current !== document.body
      ? opener.current
      : stage.current?.el;
  const openViewer = () => {
    if (!ready) return;
    rememberOpener();
    setViewer(true);
  };
  const sideOf = (i: number): Side => (pair && i === pair.after ? 'after' : 'before');
  const openCompare = () => {
    if (!pair) return;
    const s = sideOf(active);
    rememberOpener();
    select(s === 'after' ? pair.after : pair.before);
    setCompare(s);
  };
  const stageKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      select(stepIndex(active, e.key === 'ArrowLeft' ? -1 : 1, n));
    else if (e.key === 'Home') select(0);
    else if (e.key === 'End') select(n - 1);
    else if (e.key === 'Enter' || e.key === ' ') openViewer();
    else return;
    e.preventDefault();
  };
  const tabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next = focusTab;
    if (e.key === 'ArrowRight') next = Math.min(n - 1, focusTab + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, focusTab - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    setFocusTab(next);
    (strip.current?.children[next] as HTMLElement | undefined)?.focus();
  };
  const panelId = `${uid}-panel`;
  const tabId = (i: number) => `${uid}-tab-${i}`;

  return (
    <section className="fx-files" aria-labelledby={`${uid}-h`}>
      <div className="fx-files-head">
        <h2 className="fx-files-title" id={`${uid}-h`}>
          Files <span className="fx-files-n tabular">· {n}</span>
        </h2>
        {n > 1 && (
          <button
            type="button"
            className="btn ghost small fx-allfiles"
            onClick={() => setAllFiles(true)}
          >
            <GridIcon size={16} />
            All files
          </button>
        )}
      </div>

      <FileStage
        ref={stage}
        className={`fx-inline-stage${ready ? ' is-ready' : ''}`}
        touch="inline"
        slides={slidesFor(model, retry)}
        active={active}
        onStep={n > 1 ? (d) => select(stepIndex(active, d, n)) : undefined}
        canStep={(d) => active + d >= 0 && active + d < n}
        onActivate={openViewer}
        onNatural={onNatural}
        onKeyDown={stageKey}
        tabIndex={0}
        id={panelId}
        role={n > 1 ? 'tabpanel' : 'group'}
        aria-labelledby={n > 1 ? tabId(active) : undefined}
        aria-label={n > 1 ? undefined : item.label}
        aria-describedby={`${uid}-how`}
      />
      <span id={`${uid}-how`} className="sr-only">
        {ready ? 'Press Enter to enlarge.' : ''}
        {n > 1 ? ' Arrow keys show other files.' : ''}
      </span>

      <div className="fx-files-meta">
        <span className="fx-files-label" title={item.label}>
          {item.label}
        </span>
        {n > 1 && (
          <span className="fx-files-count tabular">
            {active + 1} of {n}
          </span>
        )}
        <span className="fx-spacer" />
        {pair && (
          <button type="button" className="btn ghost small fx-meta-btn" onClick={openCompare}>
            <CompareIcon size={16} />
            Compare
          </button>
        )}
        <button
          type="button"
          className="btn ghost small fx-meta-btn"
          aria-label={`Enlarge ${item.label}`}
          disabled={!ready}
          onClick={openViewer}
        >
          <ExpandIcon size={16} />
          Enlarge
        </button>
      </div>

      {n > 1 && (
        <div ref={strip} className="fx-strip" role="tablist" aria-label="Files" onKeyDown={tabKey}>
          {items.map((it) => {
            const ri = results[it.d.attachment_id];
            const st = statusOf(ri);
            const on = it.index === active;
            return (
              <button
                key={it.key}
                type="button"
                role="tab"
                id={tabId(it.index)}
                aria-selected={on}
                aria-controls={panelId}
                tabIndex={it.index === focusTab ? 0 : -1}
                className={`fx-thumb${on ? ' is-active' : ''} is-${st}`}
                aria-label={`${it.label}, file ${it.index + 1} of ${n}${st === 'ready' ? '' : `, ${STATUS_SHORT[st]}`}`}
                onClick={() => select(it.index)}
              >
                {ri?.ok ? (
                  <img src={ri.image.url} alt="" draggable={false} />
                ) : (
                  <StatusGlyph status={st} />
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {viewer && compare === null && (
        <Viewer
          model={model}
          active={active}
          onActive={select}
          onClose={() => setViewer(false)}
          onAllFiles={() => setAllFiles(true)}
          onQuestion={() => setQuestion(true)}
          onCompare={pair ? openCompare : undefined}
          focusFallback={focusBack}
          covered={allFiles || question}
        />
      )}
      {compare !== null && pair && (
        <Compare
          model={model}
          pair={pair}
          side={compare}
          onSide={(s) => {
            setCompare(s);
            select(s === 'after' ? pair.after : pair.before);
          }}
          onClose={() => setCompare(null)}
          onQuestion={() => setQuestion(true)}
          focusFallback={focusBack}
          covered={allFiles || question}
        />
      )}
      {allFiles && (
        <AllFilesSheet
          items={items}
          results={results}
          active={active}
          presented={presented}
          onPick={(i) => {
            select(i);
            setAllFiles(false);
          }}
          onDismiss={() => setAllFiles(false)}
        />
      )}
      {question && <QuestionSheet view={view} onDismiss={() => setQuestion(false)} />}
    </section>
  );
}
