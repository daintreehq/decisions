import { useId } from 'react';
import type { ImageResult } from '../../data/images.js';
import type { QuestionView } from '../../domain/model.js';
import { originParts } from '../../domain/selectors.js';
import { CheckIcon, ChevronRight } from '../Icons.js';
import { SafeText } from '../SafeText.js';
import { STATUS_SHORT, StatusGlyph, statusOf } from './FileState.js';
import { Sheet } from './Layer.js';
import { questionExcerpt } from './Viewer.js';
import type { FileItem } from './sequence.js';

/** Every file at a glance, with its state and whether it has been viewed. Picking one makes it active. */
export function AllFilesSheet({
  view,
  items,
  results,
  active,
  presented,
  onPick,
  onDismiss,
  onQuestion,
}: {
  view: QuestionView;
  items: readonly FileItem[];
  results: Readonly<Record<string, ImageResult | undefined>>;
  active: number;
  presented: ReadonlySet<string>;
  onPick: (index: number) => void;
  onDismiss: () => void;
  /** Opens the full question over this sheet. */
  onQuestion: () => void;
}) {
  const id = useId();
  const n = items.length;
  const statuses = items.map((i) => statusOf(results[i.d.attachment_id]));
  const viewed = items.filter((i, k) => statuses[k] === 'ready' && presented.has(i.key)).length;
  // Not loaded can still be retried; expired and unverified files are gone for good.
  const notLoaded = statuses.filter((st) => st === 'error').length;
  const unavailable = statuses.filter((st) => st === 'expired' || st === 'unverified').length;
  const { project } = originParts(view);
  const summary = [
    viewed === n ? `All ${n} viewed` : `${viewed} of ${n} viewed`,
    notLoaded > 0 ? `${notLoaded} not loaded` : null,
    unavailable > 0 ? `${unavailable} unavailable` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Sheet
      title={
        <>
          All files <span className="fx-sheet-count">· {n}</span>
        </>
      }
      wide
      onDismiss={onDismiss}
      lead={
        <>
          {/* The sheet covers the question, so it says which question these files belong to, and stays put while
              the grid scrolls. The line opens the full question. */}
          <button
            type="button"
            className="fx-sheet-id"
            aria-describedby={`${id}-qa`}
            onClick={onQuestion}
          >
            <span className="fx-sheet-id-text">
              <span className="fx-id-project">{project}</span>
              <span aria-hidden="true"> · </span>
              {questionExcerpt(view.content?.question)}
            </span>
            <ChevronRight size={16} />
          </button>
          <span hidden id={`${id}-qa`}>
            Shows the full question
          </span>
          <p className="fx-sheet-sub">{summary}</p>
        </>
      }
    >
      <ul className="fx-grid">
        {items.map((item) => {
          const r = results[item.d.attachment_id];
          const status = statusOf(r);
          const seen = presented.has(item.key) && status === 'ready';
          const stateText =
            status === 'ready' ? (seen ? 'Viewed' : 'Not viewed yet') : STATUS_SHORT[status];
          return (
            <li key={item.key}>
              <button
                type="button"
                className={`fx-tile${item.index === active ? ' is-current' : ''}`}
                aria-current={item.index === active ? 'true' : undefined}
                aria-label={`${item.label}, file ${item.index + 1} of ${n}. ${stateText}`}
                onClick={() => onPick(item.index)}
              >
                <span className="fx-tile-well">
                  {r?.ok ? (
                    <img src={r.image.url} alt="" draggable={false} />
                  ) : (
                    <StatusGlyph status={status} />
                  )}
                </span>
                <span className="fx-tile-label">{item.label}</span>
                <span className="fx-tile-meta">
                  <span className={`fx-tile-state is-${seen ? 'seen' : status}`}>
                    {seen && <CheckIcon size={14} />}
                    {status !== 'ready' && status !== 'preparing' && (
                      <StatusGlyph status={status} />
                    )}
                    {stateText}
                  </span>
                  <span className="fx-tile-index tabular">
                    {item.index + 1} of {n}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

/** The full question text, from inside the viewer, so the evidence and the question can be checked together. */
export function QuestionSheet({ view, onDismiss }: { view: QuestionView; onDismiss: () => void }) {
  const { project, machine } = originParts(view);
  return (
    <Sheet title="Question" onDismiss={onDismiss}>
      <p className="fx-sheet-sub">{machine ? `${project} · ${machine}` : project}</p>
      {view.content && <SafeText text={view.content.question} className="fx-question" />}
      {view.content?.context && (
        <section className="fx-question-context" aria-label="Context from the agent">
          <h3 className="eyebrow">Context from the agent</h3>
          <SafeText text={view.content.context} className="fx-question-context-text" />
        </section>
      )}
    </Sheet>
  );
}
