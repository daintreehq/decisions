import { useState, type ReactNode } from 'react';
import { backLabel, backTarget, goBack } from '../../app/listState.js';
import { ConnectionPill } from '../Shell.js';
import { ChevronLeft, MoreIcon } from '../Icons.js';
import { Menu } from './Sheet.js';

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

/**
 * Back, the question's identity (project first, computer beside it), a compact status glyph, the more menu and the
 * connection dot. Once the heading scrolls away the identity becomes a one-line excerpt of the question that scrolls
 * back to it when tapped.
 */
export function WorkspaceHeader({
  project,
  machine,
  glyph,
  statusText,
  excerpt,
  showExcerpt,
  onExcerpt,
  menu,
}: {
  project: string;
  machine: string;
  glyph?: ReactNode;
  statusText?: string;
  excerpt?: string;
  showExcerpt?: boolean;
  onExcerpt?: () => void;
  menu?: MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  // Back returns to where the question was opened from (Questions, History…), restoring that list.
  const label = backLabel();
  return (
    <header className="ws-head">
      <a
        href={backTarget()}
        className="ws-back"
        aria-label={`Back to ${label}`}
        title={`Back to ${label}`}
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          goBack();
        }}
      >
        <ChevronLeft size={22} />
      </a>
      <div className="ws-id">
        {showExcerpt && excerpt ? (
          <button type="button" className="ws-excerpt" onClick={onExcerpt}>
            <span className="ws-excerpt-text">{excerpt}</span>
            <span className="ws-id-sub">
              {project}
              {machine && ` · ${machine}`}
            </span>
          </button>
        ) : (
          <p className="ws-origin">
            {glyph && (
              <span className="ws-glyph" title={statusText}>
                {glyph}
                {statusText && <span className="sr-only">{statusText}, </span>}
              </span>
            )}
            <span className="ws-project">{project}</span>
            {machine && (
              <span className="ws-machine">
                <span className="sr-only"> on </span>
                {machine}
              </span>
            )}
          </p>
        )}
      </div>
      <ConnectionPill />
      {menu && menu.length > 0 && (
        <span className="menu-anchor">
          <button
            type="button"
            className="btn ghost icon"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <MoreIcon />
          </button>
          <Menu open={open} onClose={() => setOpen(false)} label="Question">
            {menu.map((m) => (
              <button
                key={m.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  // Closed by state (not Back) so an item that opens its own layer is not undone by the pop.
                  setOpen(false);
                  m.onSelect();
                }}
              >
                {m.label}
              </button>
            ))}
          </Menu>
        </span>
      )}
    </header>
  );
}
