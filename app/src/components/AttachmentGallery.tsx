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
import { stageCovered, useLayer, useStageCovered } from '../app/layers.js';
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
import { useFocusKeeper } from './files/Layer.js';
import { CheckIcon, CompareIcon, ExpandIcon, GridIcon } from './Icons.js';

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
  onFocusChange,
}: {
  view: QuestionView;
  onReview: (s: ReviewState) => void;
  handleRef?: Ref<GalleryHandle>;
  onFocusChange?: (open: boolean) => void;
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
  const switcher = !!pair && n === 2;

  /* ---------- evidence ---------- */
  const scope = scopeKey(view);
  const [presented, setPresented] = useState(() => presentationLog.get(scope));
  useEffect(() => setPresented(presentationLog.get(scope)), [scope]);
  // A hidden page, or anything covering the workspace (the navigator sheet, a sheet or dialog, the full-height
  // editor), means nothing on the stage is being seen. When it uncovers, `present` changes and every surface that
  // presents (inline, viewer, comparison) re-checks what is now in front of the person.
  const covered = useStageCovered();
  const present = useCallback(
    (it: FileItem) => {
      const r = results[it.d.attachment_id];
      if (!r?.ok || r.image.sha256 !== it.d.sha256) return;
      if (covered || stageCovered()) return;
      if (presentationLog.mark(scope, it.key)) setPresented(presentationLog.get(scope));
    },
    [results, scope, covered],
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
  useEffect(() => onFocusChange?.(viewer || compare !== null), [viewer, compare, onFocusChange]);
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
  const section = useRef<HTMLElement>(null);
  // Arrow keys move focus along the strip without selecting (manual activation); the selected tab stays the strip's
  // one Tab stop, so leaving and coming back lands on the file that is shown.
  const [focusTab, setFocusTab] = useState(0);
  useEffect(() => setFocusTab(active), [active]);
  // Retry, once its file loads, goes away under the finger: focus moves to the stage rather than the page.
  useFocusKeeper(section, () => stage.current?.el);

  // Whether thumbnails lie past either edge of the strip, so that edge fades instead of cutting one in half.
  const [more, setMore] = useState<'left' | 'right' | 'both' | null>(null);
  useEffect(() => {
    const s = strip.current;
    if (!s) return;
    const check = () => {
      const left = s.scrollLeft > 1;
      const right = s.scrollLeft + s.clientWidth < s.scrollWidth - 1;
      setMore(left && right ? 'both' : left ? 'left' : right ? 'right' : null);
    };
    check();
    s.addEventListener('scroll', check, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    ro?.observe(s);
    return () => {
      s.removeEventListener('scroll', check);
      ro?.disconnect();
    };
  }, [n > 1, itemKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a thumbnail in view inside the strip without scrolling the page, clear of the 32 px edge fades (8 px at the
  // first and last, where there is no fade on that side).
  const reveal = useCallback((i: number) => {
    const s = strip.current;
    const tab = s?.children[i] as HTMLElement | undefined;
    if (!s || !tab) return;
    const left = tab.offsetLeft - s.offsetLeft;
    const lead = i > 0 ? 40 : 8;
    const trail = i < s.children.length - 1 ? 40 : 8;
    if (left - lead < s.scrollLeft) s.scrollLeft = left - lead;
    else if (left + tab.offsetWidth + trail > s.scrollLeft + s.clientWidth)
      s.scrollLeft = left + tab.offsetWidth - s.clientWidth + trail;
  }, []);
  useEffect(() => reveal(active), [active, reveal]);

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
  // The opener, unless it has gone or can no longer take focus (Enlarge on a file that is not ready).
  const focusBack = () => {
    const o = opener.current;
    const usable = o?.isConnected && o !== document.body && !(o as HTMLButtonElement).disabled;
    return usable ? o : stage.current?.el;
  };
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
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // One file: Enter and Space enlarge; the arrows, Home and End stay the page's.
    if (n < 2 && e.key !== 'Enter' && e.key !== ' ') return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      select(stepIndex(active, e.key === 'ArrowLeft' ? -1 : 1, n));
    else if (e.key === 'Home') select(0);
    else if (e.key === 'End') select(n - 1);
    else if (e.key === 'Enter' || e.key === ' ') openViewer();
    else return;
    e.preventDefault();
  };
  const tabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    let next = focusTab;
    // Arrows wrap at the ends, as in the APG tabs pattern.
    if (e.key === 'ArrowRight') next = (focusTab + 1) % n;
    else if (e.key === 'ArrowLeft') next = (focusTab - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    setFocusTab(next);
    (strip.current?.children[next] as HTMLElement | undefined)?.focus({ preventScroll: true });
    reveal(next);
  };
  const panelId = `${uid}-panel`;
  const tabId = (i: number) => `${uid}-tab-${i}`;

  const metaRow = (
    <div className="fx-files-meta">
      {/* With the Before | After switch, the selected half is the label and the count. */}
      {!switcher && (
        <>
          <span className="fx-files-label" title={item.label}>
            {item.label}
          </span>
          {n > 1 && (
            <span className="fx-files-count tabular">
              {active + 1} of {n}
            </span>
          )}
        </>
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
  );
  const stripRow = n > 1 && (
    <div className="fx-strip-row">
      {/* Exactly one Before and one After: a labelled Before | After switch (guide 5.5), since two thumbnails of
              near-identical screenshots don't say which is which. Any other set keeps its thumbnails. */}
      <div
        ref={strip}
        className={switcher ? 'fx-strip seg fx-pair-switch' : 'fx-strip'}
        data-more={(!switcher && more) || undefined}
        role="tablist"
        aria-label="Files"
        onKeyDown={tabKey}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusTab(active);
        }}
      >
        {items.map((it) => {
          const ri = results[it.d.attachment_id];
          const st = statusOf(ri);
          const on = it.index === active;
          const seen = st === 'ready' && presented.has(it.key);
          return (
            <button
              key={it.key}
              type="button"
              role="tab"
              id={tabId(it.index)}
              aria-selected={on}
              aria-controls={panelId}
              tabIndex={on ? 0 : -1}
              className={switcher ? undefined : `fx-thumb${on ? ' is-active' : ''} is-${st}`}
              aria-label={`${it.label}, file ${it.index + 1} of ${n}${st === 'ready' ? (seen ? ', viewed' : '') : `, ${STATUS_SHORT[st]}`}`}
              onClick={() => {
                setFocusTab(it.index);
                select(it.index);
              }}
            >
              {switcher ? (
                <span className="fx-pair-label" aria-hidden="true">
                  {st !== 'ready' && <StatusGlyph status={st} />}
                  {it.label}
                  {seen && <CheckIcon size={14} />}
                </span>
              ) : ri?.ok ? (
                <>
                  <img src={ri.image.url} alt="" draggable={false} />
                  {seen && (
                    <span className="fx-thumb-seen" aria-hidden="true">
                      <CheckIcon size={12} />
                    </span>
                  )}
                </>
              ) : (
                <StatusGlyph status={st} />
              )}
            </button>
          );
        })}
      </div>
      {/* Two files are both in the switch already; All files is for a set worth seeing at once. */}
      {!switcher && (
        <button type="button" className="fx-strip-all" onClick={() => setAllFiles(true)}>
          <GridIcon size={18} />
          <span>All files</span>
        </button>
      )}
    </div>
  );

  return (
    <section
      ref={section}
      className="fx-files"
      data-pair={switcher || undefined}
      aria-labelledby={`${uid}-h`}
    >
      {/* The count is in the meta row ("1 of 2"), and All files ends the strip, so the heading is for assistive
          tech only: the stage starts right under the question. */}
      <h2 className="sr-only" id={`${uid}-h`}>
        Files, {n}
      </h2>

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

      {/* With the Before | After switch the row reads switch, then Compare and Enlarge: the DOM keeps that order. */}
      {switcher ? (
        <>
          {stripRow}
          {metaRow}
        </>
      ) : (
        <>
          {metaRow}
          {stripRow}
        </>
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
          view={view}
          items={items}
          results={results}
          active={active}
          presented={presented}
          onPick={(i) => {
            select(i);
            setAllFiles(false);
          }}
          onDismiss={() => setAllFiles(false)}
          onQuestion={() => setQuestion(true)}
        />
      )}
      {question && <QuestionSheet view={view} onDismiss={() => setQuestion(false)} />}
    </section>
  );
}
