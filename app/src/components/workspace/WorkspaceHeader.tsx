import { useState } from 'react';
import { backLabel, backTarget, goBack } from '../../app/listState.js';
import { ChevronLeft, MoreIcon } from '../Icons.js';
import { Menu } from './Sheet.js';

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

/**
 * The chat's header, three columns of which the outer two are always the same width so the title stays centred:
 * - leading: the menu button's slot (below 1100px the floating button sits over it) and Back, only when the
 *   question was reached from inside the app;
 * - centre: the project over the computer, or, once the question has scrolled away, a one-line excerpt over
 *   "project · computer" that scrolls back to the question;
 * - trailing: a slot reserved for the terminal button, then the overflow menu.
 */
export function WorkspaceHeader({
  project,
  machine,
  excerpt,
  showExcerpt,
  onExcerpt,
  back,
  menu,
}: {
  project: string;
  machine: string;
  excerpt?: string;
  showExcerpt?: boolean;
  onExcerpt?: () => void;
  /** Offer Back: navigation reached this question from a page inside the app. */
  back: boolean;
  menu?: MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const label = backLabel();
  const excerptOn = !!(showExcerpt && excerpt);
  return (
    <header className="ws-head">
      <div className="ws-lead">
        <span className="ws-menu-slot" aria-hidden="true" />
        {back && (
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
        )}
      </div>
      <div className="ws-title" data-excerpt={excerptOn || undefined}>
        {excerptOn ? (
          <button type="button" className="ws-excerpt" onClick={onExcerpt}>
            <span className="ws-title-main">{excerpt}</span>
            <span className="ws-title-sub">
              <span className="sr-only">, from </span>
              {project}
              {machine && ` · ${machine}`}
              <span className="sr-only">. Scroll to the question.</span>
            </span>
          </button>
        ) : (
          <p className="ws-origin">
            <span className="ws-title-main">{project}</span>
            {machine && (
              <span className="ws-title-sub">
                <span className="sr-only"> on </span>
                {machine}
              </span>
            )}
          </p>
        )}
      </div>
      <div className="ws-tools">
        {/* Reserved for the terminal button (a separate issue under #30). */}
        <span className="ws-terminal-slot" data-slot="terminal" aria-hidden="true" />
        {menu && menu.length > 0 && (
          <span className="menu-anchor">
            <button
              type="button"
              className="btn ghost icon ws-more"
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
      </div>
    </header>
  );
}
