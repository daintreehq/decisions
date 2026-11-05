import { useState, type ReactNode } from 'react';
import { backLabel, backTarget, goBack } from '../../app/listState.js';
import { ChevronLeft, MoreIcon } from '../Icons.js';
import { Menu } from './Sheet.js';

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

/** The answer in force, as Home's rows say it: who decided ("You", "Model") and what. */
export interface HeaderAnswer {
  author: 'You' | 'Model';
  text: string;
}

/**
 * The chat's header, three columns of which the outer two are always the same width so the title stays centred:
 * - leading: the menu button's slot (below 1100px the floating button sits over it) and Back, only when the
 *   question was reached from inside the app;
 * - centre: the project over the computer, or, once the question has scrolled away, a one-line excerpt over
 *   the answer in force ("You: Yes, rename", "Model: Changed") or, before there is one, "project · computer".
 *   The excerpt is a button that scrolls back to the question. Both titles stay mounted in one cell and roll
 *   together in the scroll's direction, each line in its own clipped lane (the excerpt up into place as the
 *   question scrolls away, the origin back down as it returns), so it reads as one header changing rather than two
 *   swapping, and a first line never passes through the second's place;
 * - trailing: the terminal button (its slot stays reserved when the relay serves no snapshots), then the overflow
 *   menu.
 */
export function WorkspaceHeader({
  project,
  machine,
  excerpt,
  answer,
  showExcerpt,
  onExcerpt,
  back,
  terminal,
  menu,
}: {
  project: string;
  machine: string;
  excerpt?: string;
  /** The answer in force, kept in view under the excerpt while follow-ups scroll by. */
  answer?: HeaderAnswer | null;
  showExcerpt?: boolean;
  onExcerpt?: () => void;
  /** Offer Back: navigation reached this question from a page inside the app. */
  back: boolean;
  /** The terminal button; without one the slot stays empty so the title keeps its place. */
  terminal?: ReactNode;
  menu?: MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const label = backLabel();
  const excerptOn = !!(showExcerpt && excerpt);
  const origin = machine ? `${project} · ${machine}` : project;
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
        {/* Only the title on screen can be reached: the other is inert. The caller moves focus to the question when
            the excerpt had it and the question scrolls back into view. */}
        <p
          className="ws-origin"
          title={origin}
          aria-hidden={excerptOn || undefined}
          inert={excerptOn}
        >
          <span className="ws-title-main">
            <span className="ws-line">{project}</span>
          </span>
          {machine && (
            <span className="ws-title-sub">
              <span className="ws-line">
                <span className="sr-only"> on </span>
                {machine}
              </span>
            </span>
          )}
        </p>
        {excerpt && (
          <button
            type="button"
            className="ws-excerpt"
            title={`${excerpt}\n${answer ? `${answer.author}: ${answer.text}` : origin}`}
            onClick={onExcerpt}
            aria-hidden={!excerptOn || undefined}
            inert={!excerptOn}
          >
            <span className="ws-title-main">
              <span className="ws-line">{excerpt}</span>
            </span>
            <span className="ws-title-sub">
              <span className="ws-line">
                {answer ? (
                  <>
                    <span className="sr-only">. </span>
                    <span className="ws-sub-answer" data-author={answer.author}>
                      {answer.author === 'Model' && (
                        <svg
                          className="ws-model-mark"
                          viewBox="0 0 16 16"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" />
                        </svg>
                      )}
                      <span className="ws-sub-who">{answer.author}:</span>{' '}
                      <span className="ws-sub-text">{answer.text}</span>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="sr-only">
                      , from {project}
                      {machine && `, on ${machine}`}
                    </span>
                    {/* Drawn for the eye only: the computer is left out when too little of it would fit. */}
                    <span className="ws-sub-project" aria-hidden="true">
                      {project}
                    </span>
                    {machine && (
                      <span className="ws-sub-on" aria-hidden="true">
                        <span className="ws-sub-sep">{' · '}</span>
                        <span className="ws-sub-machine">{machine}</span>
                      </span>
                    )}
                  </>
                )}
                <span className="sr-only">. Scroll to the question.</span>
              </span>
            </span>
          </button>
        )}
      </div>
      <div className="ws-tools">
        {terminal ?? <span className="ws-terminal-slot" data-slot="terminal" aria-hidden="true" />}
        {menu && menu.length > 0 && (
          <span className="menu-anchor">
            <button
              type="button"
              className="btn ghost icon ws-more"
              aria-label="More"
              title="More"
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
