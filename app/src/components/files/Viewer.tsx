import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { announce } from '../../lib/announce.js';
import { originParts } from '../../domain/selectors.js';
import { ChevronDown, CloseIcon, CompareIcon } from '../Icons.js';
import { FileMenu } from './FileMenu.js';
import { FileStage, type FileStageHandle, type StageSlide } from './FileStage.js';
import { FilePlaceholder, statusOf } from './FileState.js';
import { Overlay, useFocusInOut, useFocusKeeper } from './Layer.js';
import type { FilesModel } from './model.js';
import { altFor } from './sequence.js';
import { ViewerStop } from './ViewerStop.js';
import {
  isModified,
  toolFallback,
  useMoveFocus,
  PanPad,
  StepButtons,
  ZoomButtons,
  zoomCommands,
} from './Tools.js';
import { FIT, fromNormal, isZoomed, toNormal, type Size, type View } from './zoom.js';

/** One line of the question for the viewer's identity, without markup characters. */
export function questionExcerpt(text: string | undefined): string {
  return (text ?? '')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slidesFor(model: FilesModel, onRetry: (id: string) => void): StageSlide[] {
  return model.items.map((item) => {
    const r = model.results[item.d.attachment_id];
    const status = statusOf(r);
    return {
      key: item.key,
      id: item.d.attachment_id,
      src: r?.ok ? r.image.url : undefined,
      alt: altFor(item),
      natural: model.naturals[item.d.attachment_id],
      placeholder: (
        <FilePlaceholder status={status} onRetry={() => onRetry(item.d.attachment_id)} />
      ),
    };
  });
}

/**
 * Which question this is, in every file mode (guide 1.4 rule 2): what is shown on the first line, the project and as
 * much of the question as fits on the second. The whole block opens the full question, so the excerpt gets the
 * bar's width instead of sharing it with a separate button.
 */
export function QuestionIdentity({
  id,
  title,
  project,
  excerpt,
  onQuestion,
}: {
  id: string;
  title: ReactNode;
  project: string;
  excerpt: string;
  onQuestion: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="fx-id fx-id-btn"
        aria-describedby={`${id}-qa`}
        onClick={onQuestion}
      >
        <span className="fx-id-file" id={`${id}-t`}>
          {title}
        </span>
        <span className="fx-id-q" id={`${id}-q`}>
          <span className="fx-id-q-text">
            <span className="fx-id-project">{project}</span>
            <span aria-hidden="true"> · </span>
            {excerpt}
          </span>
          <ChevronDown size={14} />
        </span>
      </button>
      <span hidden id={`${id}-qa`}>
        Shows the full question
      </span>
    </>
  );
}

const px = (n: number) => `${n}px`;

interface Bare {
  frame: Record<string, string> | null;
  /** The image area does not span the viewport's width (a sidebar was beside it). */
  inset: boolean;
}

/**
 * Where the image area and the bars sit with the chrome shown, as the custom properties the hidden layout pins them
 * with: the image keeps its size and position, and the bars leave from where they were.
 */
function frameOf(
  track: HTMLElement | null | undefined,
  bar: HTMLElement | null,
  tools: HTMLElement | null,
): Bare {
  if (!track || !bar || !tools) return { frame: null, inset: false };
  const t = track.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  const o = tools.getBoundingClientRect();
  const inset = t.left > 0.5 || t.right < window.innerWidth - 0.5;
  const frame = {
    '--fx-bare-t': px(t.top),
    '--fx-bare-l': px(t.left),
    '--fx-bare-w': px(t.width),
    '--fx-bare-h': px(t.height),
    '--fx-bare-bar-t': px(b.top),
    '--fx-bare-bar-l': px(b.left),
    '--fx-bare-bar-w': px(b.width),
    '--fx-bare-tools-t': px(o.top),
    '--fx-bare-tools-b': 'auto',
    '--fx-bare-tools-l': px(o.left),
    '--fx-bare-tools-w': px(o.width),
  };
  return { frame, inset };
}

/**
 * The file viewer: a mode of the workspace, not a modal. Close, the question's identity (with the full text one
 * tap away), the file's label and position, the file menu; the darkest stage at the largest practical size; then
 * Previous/Next, zoom and Move. Recording and the answer dock carry on underneath.
 *
 * A single tap on the image (or Space on the stage) hides all of that, the dock included, and the stage fills the
 * viewport; another brings it back. The image area stays exactly where it was, so the image neither moves nor
 * resizes: a zoomed image simply has the whole screen to run into. Stop stays on screen while recording.
 */
export function Viewer({
  model,
  active,
  onActive,
  onClose,
  onAllFiles,
  onQuestion,
  onCompare,
  focusFallback,
  covered,
}: {
  model: FilesModel;
  active: number;
  onActive: (index: number) => void;
  onClose: () => void;
  onAllFiles?: () => void;
  onQuestion: () => void;
  onCompare?: () => void;
  focusFallback: () => HTMLElement | null | undefined;
  /** A sheet (All files, the question) is over the viewer, so what it shows is not being looked at. */
  covered: boolean;
}) {
  const { items, results, naturals } = model;
  const item = items[active]!;
  const total = items.length;
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<FileStageHandle>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [moving, setMoving] = useState(false);
  const tools = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  // Chrome hidden: where the image area and the bars sat with it shown (viewport px), so nothing jumps. Null while
  // shown; its frame is dropped after a resize while hidden, when the image area takes the whole viewport.
  const [bare, setBare] = useState<Bare | null>(null);
  // The frame the hidden layout first applies in: slides move to it without animating (no neighbour sweeps past).
  const [settling, setSettling] = useState(false);
  useMoveFocus(moving, tools, () => stage.current?.el);
  useFocusInOut(() => stage.current?.el, focusFallback);
  useFocusKeeper(root, (from) => toolFallback(from, () => stage.current?.el));

  const r = results[item.d.attachment_id];
  const natural = naturals[item.d.attachment_id];
  const ready = !!r?.ok && !!natural && size.w > 0;
  const view: View = ready ? fromNormal(model.zoomOf(item.key), natural, size) : FIT;
  const setView = (v: View) => {
    if (natural && size.w > 0) model.setZoom(item.key, toNormal(v, natural, size));
  };
  const zoomed = ready && isZoomed(view);
  const cmd = zoomCommands([{ view, natural: ready ? natural : undefined, size, set: setView }]);

  // Displayed in the viewer, with nothing over it: that counts as presented.
  useEffect(() => {
    if (!covered && r?.ok && natural && size.w > 0 && size.h > 0) model.present(item);
  }, [covered, r, natural, size, item, model]);

  useEffect(() => {
    if (!zoomed) setMoving(false);
  }, [zoomed]);

  const hidden = bare !== null;
  const toggleChrome = () => {
    if (hidden) {
      setBare(null);
      announce('Controls shown.');
      return;
    }
    // Focus never stays on a control that is about to be hidden (the bars, the dock, anything else on screen).
    const el = stage.current?.el;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    setMoving(false);
    setBare(frameOf(stage.current?.track, bar.current, tools.current));
    setSettling(true);
    announce('Controls hidden. Tap the image or press Space to show them.');
  };

  useEffect(() => {
    if (!settling) return;
    // Two frames: the first paints the hidden layout with slide transitions off, the second turns them back on.
    let id = requestAnimationFrame(() => {
      id = requestAnimationFrame(() => setSettling(false));
    });
    return () => cancelAnimationFrame(id);
  }, [settling]);

  // A new viewport (rotation, a resized window) has no "where it was": the image area takes the whole screen.
  useEffect(() => {
    if (!hidden) return;
    const drop = () => setBare((b) => (b?.frame ? { frame: null, inset: false } : b));
    window.addEventListener('resize', drop);
    return () => window.removeEventListener('resize', drop);
  }, [hidden]);
  const bareStyle = (bare?.frame ?? undefined) as CSSProperties | undefined;

  const step = (dir: -1 | 1) => {
    const next = active + dir;
    if (next >= 0 && next < total) onActive(next);
  };

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!root.current?.contains(e.target as Node)) return; // a sheet or menu above us
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (isModified(e)) return;
    // Arrow keys act on the image from the stage and from the toolbar (not from inside the zoom popover).
    const onStage =
      t === stage.current?.el ||
      t === root.current ||
      (!!tools.current?.contains(t) && !t.closest('.fx-zoom-popover'));
    switch (e.key) {
      case ' ':
        // Space on the stage itself shows or hides the chrome (a button keeps Space for itself).
        if (t !== stage.current?.el) return;
        if (!e.repeat) toggleChrome();
        break;
      case 'Escape':
        // Move is a mode of the toolbar: Escape leaves it before it leaves the viewer.
        if (moving) setMoving(false);
        else onClose();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (!onStage) return;
        if (zoomed) cmd.pan(e.key === 'ArrowLeft' ? -1 : 1, 0);
        else step(e.key === 'ArrowLeft' ? -1 : 1);
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
      case 'Home':
        onActive(0);
        break;
      case 'End':
        onActive(total - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const { project } = originParts(model.view);
  const excerpt = questionExcerpt(model.view.content?.question);

  return (
    <Overlay className="fx-viewer-layer">
      <div
        ref={root}
        className={`fx-viewer${hidden ? ' is-bare' : ''}${bare?.inset ? ' is-inset' : ''}${
          settling ? ' is-settling' : ''
        }`}
        style={bareStyle}
        role="dialog"
        aria-labelledby={`${id}-t`}
        aria-describedby={`${id}-q`}
        onKeyDown={key}
      >
        <header ref={bar} className="fx-bar" inert={hidden}>
          <button
            type="button"
            className="btn ghost icon"
            aria-label="Close viewer"
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
            title={
              <>
                <span className="fx-id-label">{item.label}</span>
                {total > 1 && (
                  <span className="fx-id-count tabular">
                    {active + 1} of {total}
                  </span>
                )}
              </>
            }
          />
          <FileMenu item={item} result={r} total={total} onAllFiles={onAllFiles} />
        </header>

        <FileStage
          ref={stage}
          className="fx-viewer-stage"
          touch="zoom"
          slides={slidesFor(model, model.retry)}
          active={active}
          view={ready ? view : undefined}
          onView={setView}
          onStep={total > 1 ? step : undefined}
          onTap={toggleChrome}
          canStep={(d) => active + d >= 0 && active + d < total}
          onNatural={model.onNatural}
          onSize={setSize}
          tabIndex={0}
          role="group"
          aria-roledescription="image stage"
          aria-label={`${item.label}, file ${active + 1} of ${total}. ${
            zoomed
              ? 'Drag or use the arrow keys to move around; double-tap or press 0 for Fit.'
              : 'Swipe or use the arrow keys for other files; pinch, double-tap or press + to zoom.'
          } ${
            hidden
              ? 'Controls hidden: tap or press Space to show them.'
              : 'Tap or press Space to hide the controls.'
          }`}
        />

        <div
          ref={tools}
          className="fx-tools"
          role="group"
          aria-label="Viewer controls"
          inert={hidden}
        >
          {moving && zoomed ? (
            <PanPad cmd={cmd} onDone={() => setMoving(false)} />
          ) : (
            <>
              {total > 1 && <StepButtons index={active} total={total} onStep={step} />}
              <ZoomButtons cmd={cmd} onMove={() => setMoving(true)} />
              {onCompare && (
                <button
                  type="button"
                  className="btn ghost icon fx-tool fx-tool-labelled"
                  aria-label="Compare before and after"
                  title="Compare before and after"
                  onClick={onCompare}
                >
                  <CompareIcon size={20} />
                  <span className="fx-tool-text">Compare</span>
                </button>
              )}
            </>
          )}
        </div>
        {hidden && <ViewerStop fallback={() => stage.current?.el} />}
      </div>
    </Overlay>
  );
}
