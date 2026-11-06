import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { originParts } from '../../domain/selectors.js';
import { CheckIcon, CloseIcon } from '../Icons.js';
import { FileStage, type FileStageHandle } from './FileStage.js';
import { Overlay, useFocusInOut, useFocusKeeper } from './Layer.js';
import { zoomMemory, type FilesModel } from './model.js';
import {
  formatScale,
  isModified,
  toolFallback,
  useMoveFocus,
  PanPad,
  ZoomButtons,
  zoomCommands,
  type ZoomTarget,
} from './Tools.js';
import { QuestionIdentity, questionExcerpt, slidesFor } from './Viewer.js';
import {
  FIT,
  FIT_NORMAL,
  fromNormal,
  isZoomed,
  toNormal,
  type NormalView,
  type Size,
} from './zoom.js';

export type Side = 'before' | 'after';
const SIDES: Side[] = ['before', 'after'];
const LABEL: Record<Side, string> = { before: 'Before', after: 'After' };
/**
 * Below this width comparison is one stage with a Before | After switch; from it, side-by-side panes. Two panes of
 * at least 320 px each (the inline stage's own cap), so a laptop's workspace beside the sidebar and list qualifies.
 */
export const COMPARE_SIDE_BY_SIDE = 640;

/** The width comparison will have: the workspace region it covers, or the window without one. */
function hostWidth(): number {
  return document.getElementById('workspace-overlay')?.clientWidth || window.innerWidth;
}

/**
 * Before and after (guide 5.5). On a phone: one large stage and a full-width Before | After switch that keeps the
 * zoom and position, so flipping shows exactly what changed. On wide screens: labelled side-by-side panes, with
 * Link zoom (on by default when both images share an aspect ratio). Images are never stretched to line up.
 */
export function Compare({
  model,
  pair,
  side,
  onSide,
  onClose,
  onQuestion,
  focusFallback,
  covered,
}: {
  model: FilesModel;
  pair: { before: number; after: number };
  side: Side;
  onSide: (s: Side) => void;
  onClose: () => void;
  onQuestion: () => void;
  focusFallback: () => HTMLElement | null | undefined;
  /** A sheet is over the comparison. */
  covered: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const stageA = useRef<FileStageHandle>(null);
  const stageB = useRef<FileStageHandle>(null);
  // Measured from the host before the first render, so the panes never mount and unmount again (taking focus).
  const [wide, setWide] = useState(() => hostWidth() >= COMPARE_SIDE_BY_SIDE);
  const [sizes, setSizes] = useState<Record<Side, Size>>({
    before: { w: 0, h: 0 },
    after: { w: 0, h: 0 },
  });
  // Comparison zoom is remembered for the session per pair of files, like the viewer's per file.
  const memKey = `compare:${model.items[pair.before]!.key}|${model.items[pair.after]!.key}`;
  const [shared, setShared] = useState<NormalView>(() => zoomMemory.get(memKey) ?? FIT_NORMAL);
  const [own, setOwn] = useState<Record<Side, NormalView>>(() => ({
    before: zoomMemory.get(`${memKey}:before`) ?? FIT_NORMAL,
    after: zoomMemory.get(`${memKey}:after`) ?? FIT_NORMAL,
  }));
  useEffect(() => {
    zoomMemory.set(memKey, shared);
    zoomMemory.set(`${memKey}:before`, own.before);
    zoomMemory.set(`${memKey}:after`, own.after);
  }, [memKey, shared, own]);
  const [linkChoice, setLinkChoice] = useState<boolean | null>(null);
  /** With Link zoom off, the pane the toolbar and keys work on: the one last touched or focused. */
  const [current, setCurrent] = useState<Side>('after');
  const [moving, setMoving] = useState(false);
  const tools = useRef<HTMLDivElement>(null);
  const currentStage = () =>
    (wide ? (current === 'before' ? stageA : stageB) : stageB).current?.el ?? root.current;
  useMoveFocus(moving, tools, currentStage);

  useEffect(() => {
    const node = root.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWide(node.clientWidth >= COMPARE_SIDE_BY_SIDE));
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const items = { before: model.items[pair.before]!, after: model.items[pair.after]! };
  const nat = (s: Side) => model.naturals[items[s].d.attachment_id];
  const res = (s: Side) => model.results[items[s].d.attachment_id];
  const nb = nat('before');
  const na = nat('after');
  const sameShape = !!nb && !!na && Math.abs(nb.w / nb.h - na.w / na.h) < 0.01;
  const linked = !wide || (linkChoice ?? sameShape);

  useFocusInOut(
    () => (wide ? stageA.current?.el : stageB.current?.el) ?? root.current,
    focusFallback,
  );
  useFocusKeeper(root, (from) => toolFallback(from, currentStage));

  const target = (s: Side): ZoomTarget => {
    const natural = nat(s);
    const size = wide ? sizes[s] : sizes.before;
    const ready = !!res(s)?.ok && !!natural && size.w > 0;
    const n = linked ? shared : own[s];
    return {
      view: ready ? fromNormal(n, natural!, size) : FIT,
      natural: ready ? natural : undefined,
      size,
      set: (v) => {
        if (!natural || size.w <= 0) return;
        const next = toNormal(v, natural, size);
        if (linked) setShared(next);
        else setOwn((o) => ({ ...o, [s]: next }));
      },
    };
  };

  const shown: Side[] = wide ? SIDES : [side];
  // A pane counts as presented once its verified image is actually on screen.
  useEffect(() => {
    if (covered) return;
    for (const s of shown) {
      const size = wide ? sizes[s] : sizes.before;
      if (res(s)?.ok && nat(s) && size.w > 0 && size.h > 0) model.present(items[s]);
    }
  });

  const targets = wide ? SIDES.map(target) : [target(side)];
  // Linked panes share one view, so commands go through whichever pane is ready; unlinked, through the current one.
  const cmd = zoomCommands(
    !wide ? targets : linked ? [targets.find((t) => t.natural) ?? targets[0]!] : [target(current)],
  );
  // Unlinked, Move and the keys work on the current pane, so its zoom is the one that counts.
  const zoomed = wide && !linked ? cmd.zoomed : targets.some((t) => isZoomed(t.view));
  useEffect(() => {
    if (!zoomed) setMoving(false);
  }, [zoomed]);

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!root.current?.contains(e.target as Node)) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select')) return;
    if (isModified(e)) return;
    const onStage =
      !!t.closest('.fs-stage') ||
      t === root.current ||
      !!t.closest('.fx-compare-switch') ||
      (!!tools.current?.contains(t) && !t.closest('.fx-zoom-popover'));
    switch (e.key) {
      case 'Escape':
        if (moving) setMoving(false);
        else onClose();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (!onStage) return;
        if (zoomed) cmd.pan(e.key === 'ArrowLeft' ? -1 : 1, 0);
        else if (!wide) onSide(e.key === 'ArrowLeft' ? 'before' : 'after');
        else return;
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        if (!onStage || !zoomed) return;
        cmd.pan(0, e.key === 'ArrowUp' ? -1 : 1);
        break;
      case '+':
      case '=':
        cmd.zoomIn();
        break;
      case '-':
      case '_':
        cmd.zoomOut();
        break;
      case '0':
        cmd.fit();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const { project } = originParts(model.view);
  const excerpt = questionExcerpt(model.view.content?.question);
  const allSlides = slidesFor(model, model.retry);
  const slideOf = (s: Side) => allSlides[s === 'before' ? pair.before : pair.after]!;
  const dims = (s: Side) => {
    const n = nat(s);
    return n ? `${n.w} × ${n.h}` : '';
  };

  return (
    <Overlay className="fx-viewer-layer">
      <div
        ref={root}
        className={`fx-viewer fx-compare${wide ? ' is-wide' : ''}`}
        role="dialog"
        aria-labelledby={`${id}-t`}
        aria-describedby={`${id}-q`}
        onKeyDown={key}
      >
        <header className="fx-bar">
          <button
            type="button"
            className="btn ghost icon"
            aria-label="Close comparison"
            title="Close (Esc)"
            onClick={onClose}
          >
            <CloseIcon size={20} />
          </button>
          <QuestionIdentity
            id={id}
            project={project}
            excerpt={excerpt}
            onQuestion={onQuestion}
            title={<span className="fx-id-label">Before and after</span>}
          />
        </header>

        {wide ? (
          <div className="fx-panes">
            {SIDES.map((s) => {
              const t = target(s);
              return (
                <section
                  key={s}
                  className={`fx-pane${!linked && current === s ? ' is-current' : ''}`}
                  aria-label={LABEL[s]}
                  onPointerDown={() => setCurrent(s)}
                  onFocus={() => setCurrent(s)}
                >
                  <div className="fx-pane-head">
                    <span className="fx-pane-label">{LABEL[s]}</span>
                    <span className="fx-pane-dims tabular">
                      {isZoomed(t.view) && `${formatScale(t.view.scale)} · `}
                      {dims(s)}
                    </span>
                  </div>
                  <FileStage
                    ref={s === 'before' ? stageA : stageB}
                    className="fx-viewer-stage"
                    touch="zoom"
                    slides={[slideOf(s)]}
                    active={0}
                    view={t.natural ? t.view : undefined}
                    onView={t.set}
                    onNatural={model.onNatural}
                    onSize={(size: Size) =>
                      setSizes((o) =>
                        o[s].w === size.w && o[s].h === size.h ? o : { ...o, [s]: size },
                      )
                    }
                    tabIndex={0}
                    role="group"
                    aria-roledescription="image stage"
                    aria-label={`${LABEL[s]} screenshot`}
                  />
                </section>
              );
            })}
          </div>
        ) : (
          <FileStage
            ref={stageB}
            className="fx-viewer-stage fx-flip-stage"
            touch="zoom"
            slides={[slideOf('before'), slideOf('after')]}
            active={side === 'before' ? 0 : 1}
            view={targets[0]!.natural ? targets[0]!.view : undefined}
            onView={targets[0]!.set}
            onStep={(d) => onSide(d > 0 ? 'after' : 'before')}
            canStep={(d) => (d > 0 ? side === 'before' : side === 'after')}
            onNatural={model.onNatural}
            onSize={(size: Size) =>
              setSizes((o) =>
                o.before.w === size.w && o.before.h === size.h ? o : { ...o, before: size },
              )
            }
            tabIndex={0}
            role="group"
            aria-roledescription="image stage"
            aria-label={`${LABEL[side]} screenshot. Zoom and position stay the same when you switch.`}
          />
        )}

        {/* One stage: the full-width Before | After switch (guide 5.5), above the tools and kept while moving, so
            flipping never means leaving Move. */}
        {!wide && (
          <div className="fx-compare-switch">
            <div className="seg fx-compare-seg" role="group" aria-label="Show">
              {SIDES.map((s) => (
                <button key={s} type="button" aria-pressed={side === s} onClick={() => onSide(s)}>
                  {LABEL[s]}
                </button>
              ))}
            </div>
          </div>
        )}
        <div ref={tools} className="fx-tools" role="group" aria-label="Comparison controls">
          {moving && zoomed ? (
            <PanPad cmd={cmd} onDone={() => setMoving(false)} />
          ) : (
            <>
              <ZoomButtons cmd={cmd} onMove={() => setMoving(true)} />
              {wide && (
                <button
                  type="button"
                  className="btn small fx-link"
                  aria-pressed={linked}
                  onClick={() => {
                    const next = !linked;
                    // Linking keeps what the current pane shows, so the inspection in progress is not lost.
                    if (next) setShared(own[current]);
                    else setOwn({ before: shared, after: shared });
                    setLinkChoice(next);
                  }}
                >
                  {linked && <CheckIcon size={16} />}
                  Link zoom
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}
