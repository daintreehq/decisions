import type { ImageResult } from '../../data/images.js';
import type { QuestionView } from '../../domain/model.js';
import { originParts } from '../../domain/selectors.js';
import { CheckIcon } from '../Icons.js';
import { SafeText } from '../SafeText.js';
import { STATUS_SHORT, StatusGlyph, statusOf } from './FileState.js';
import { Sheet } from './Layer.js';
import type { FileItem } from './sequence.js';

/** Every file at a glance, with its state and whether it has been viewed. Picking one makes it active. */
export function AllFilesSheet({
  items,
  results,
  active,
  presented,
  onPick,
  onDismiss,
}: {
  items: readonly FileItem[];
  results: Readonly<Record<string, ImageResult | undefined>>;
  active: number;
  presented: ReadonlySet<string>;
  onPick: (index: number) => void;
  onDismiss: () => void;
}) {
  const n = items.length;
  const viewed = items.filter((i) => presented.has(i.key)).length;
  return (
    <Sheet
      title={
        <>
          All files <span className="fx-sheet-count">· {n}</span>
        </>
      }
      wide
      onDismiss={onDismiss}
    >
      <p className="fx-sheet-sub">
        {viewed === n ? 'You have viewed every file.' : `Viewed ${viewed} of ${n}.`}
      </p>
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
    </Sheet>
  );
}
