import { useEffect, useId, useRef } from 'react';
import { useLayer } from '../../app/layers.js';
import { useSwipeClose } from '../useSwipeClose.js';
import { useDialogMotion } from '../useDialogMotion.js';
import { setQuestions } from '../../app/listState.js';
import { CheckIcon, CloseIcon } from '../Icons.js';

export interface FacetValue {
  value: string;
  /** Questions with this value, under the other facet's filter. */
  count: number;
}

/**
 * Active filters as small removable chips, directly under the list's tools. Each one is a single tap to remove, and
 * says what it removes.
 */
export function FilterChips({
  project,
  computer,
}: {
  project: string | null;
  computer: string | null;
}) {
  if (!project && !computer) return null;
  const chip = (kind: 'Computer' | 'Project', value: string) => (
    <button
      key={kind}
      type="button"
      className="fchip on"
      aria-label={`Remove filter: ${kind} ${value}`}
      title={`${kind}: ${value}`}
      onClick={() => setQuestions(kind === 'Computer' ? { computer: null } : { project: null })}
    >
      <span className="fchip-label">{value}</span>
      <CloseIcon size={13} />
    </button>
  );
  return (
    <div className="filter-chips" role="group" aria-label="Active filters">
      {computer && chip('Computer', computer)}
      {project && chip('Project', project)}
    </div>
  );
}

function Facet({
  legend,
  name,
  any,
  values,
  selected,
  onPick,
}: {
  legend: string;
  name: string;
  any: string;
  values: FacetValue[];
  selected: string | null;
  onPick: (v: string | null) => void;
}) {
  const total = values.reduce((n, v) => n + v.count, 0);
  const options: { value: string | null; label: string; count: number }[] = [
    { value: null, label: any, count: total },
    ...values.map((v) => ({ value: v.value, label: v.value, count: v.count })),
  ];
  return (
    <fieldset className="facet">
      <legend className="facet-legend">{legend}</legend>
      {options.map((o) => {
        const on = o.value === selected;
        return (
          <label key={o.value ?? ''} className="facet-opt" data-on={on || undefined}>
            <input
              type="radio"
              name={name}
              checked={on}
              onChange={() => onPick(o.value)}
              className="sr-only"
            />
            <span className="facet-label">{o.label}</span>
            <span className="facet-count">
              <span className="sr-only">, </span>
              {o.count}
              <span className="sr-only">{o.count === 1 ? ' question' : ' questions'}</span>
            </span>
            <span className="facet-check" aria-hidden="true">
              {on && <CheckIcon size={18} />}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * Computer and project filters in one sheet: from the bottom on phones, centred from 720px. A modal dialog and a
 * workspace layer (Back and Escape close it, focus stays inside and returns to the filter button). A choice applies
 * at once and the sheet says, politely, how many questions now show (the page behind it is inert, so its own
 * announcement would not be heard); Done closes. Only the facets with more than one value are offered.
 */
export function FilterSheet({
  open,
  onClose,
  computers,
  projects,
  computer,
  project,
  resultCount,
}: {
  open: boolean;
  onClose: () => void;
  computers: FacetValue[];
  projects: FacetValue[];
  computer: string | null;
  project: string | null;
  /** How many questions the list shows under these filters (and any search). */
  resultCount: number;
}) {
  const dismiss = useLayer(open, onClose);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const uid = useId();
  const present = useDialogMotion(ref, open);
  const swipe = useSwipeClose(ref, 'down', dismiss);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open) {
      d.querySelector<HTMLElement>('.sheet-title')?.focus({ preventScroll: true });
    }
  }, [open]);

  const showComputers = computers.length > 1 || !!computer;
  const showProjects = projects.length > 1 || !!project;

  return (
    <dialog
      ref={ref}
      className="filter-sheet"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      {present && (
        <div className="filter-sheet-body">
          <header
            className="filter-sheet-head"
            {...swipe}
            style={{ touchAction: 'pan-x pinch-zoom' }}
          >
            <h2 className="sheet-title" id={titleId} tabIndex={-1}>
              Filter questions
            </h2>
            <button type="button" className="btn primary" onClick={dismiss}>
              Done
            </button>
          </header>
          <p className="sr-only" role="status">
            {resultCount === 1 ? '1 question shows' : `${resultCount} questions show`}
          </p>
          <div className="filter-sheet-scroll">
            {showComputers && (
              <Facet
                legend="Computer"
                name={`${uid}-computer`}
                any="Any computer"
                values={computers}
                selected={computer}
                onPick={(c) => setQuestions({ computer: c })}
              />
            )}
            {showProjects && (
              <Facet
                legend="Project"
                name={`${uid}-project`}
                any="Any project"
                values={projects}
                selected={project}
                onPick={(p) => setQuestions({ project: p })}
              />
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
