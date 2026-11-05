import { useEffect, useId, useRef } from 'react';
import { useLayer } from '../../app/layers.js';
import { closeNavigator, openNavigator, useNavigatorOpen } from '../../app/navigator.js';
import { Link } from '../../app/router.js';
import { CloseIcon } from '../Icons.js';
import { HistoryGlyph, SettingsGlyph } from '../NavGlyphs.js';
import { NavigatorPanel } from './Navigator.js';
import { useDialogMotion } from '../useDialogMotion.js';

let wantSearch = false;

/** Open the navigator with its search focused (Ctrl/⌘+K, when Home's own search is not on screen). */
export function openNavigatorWithSearch(): void {
  const open = document.querySelector<HTMLInputElement>(
    'dialog.nav-sheet[open] input[type="search"]',
  );
  if (open) {
    open.focus();
    open.select();
    return;
  }
  wantSearch = true;
  openNavigator();
}

/**
 * The navigator as a sheet: full height from the bottom on phones, from the left from 720px. It is
 * a workspace layer (Back and Escape close it) and a modal dialog (focus stays inside, and returns to whatever
 * opened it). Choosing a question replaces the sheet's history entry, so Back never reopens it.
 */
export function NavigatorSheet({ currentId }: { currentId?: string }) {
  const open = useNavigatorOpen();
  const dismiss = useLayer(open, closeNavigator);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const present = useDialogMotion(ref, open);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open) {
      const target =
        (wantSearch && d.querySelector<HTMLElement>('input[type="search"]')) ||
        d.querySelector<HTMLElement>('.qrow[aria-current="page"]') ||
        d.querySelector<HTMLElement>('.sheet-title');
      target?.focus({ preventScroll: !wantSearch });
      wantSearch = false;
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="nav-sheet"
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
        <div className="nav-sheet-body">
          <header className="nav-sheet-head">
            <h2 className="sheet-title" id={titleId} tabIndex={-1}>
              Questions &amp; answers
            </h2>
            <Link to="/history" className="btn ghost icon" aria-label="History" title="History">
              <HistoryGlyph />
            </Link>
            <Link to="/settings" className="btn ghost icon" aria-label="Settings" title="Settings">
              <SettingsGlyph />
            </Link>
            <button
              type="button"
              className="btn ghost icon"
              aria-label="Close"
              title="Close (Esc)"
              onClick={dismiss}
            >
              <CloseIcon size={20} />
            </button>
          </header>
          <NavigatorPanel presentation="sheet" currentId={currentId} />
        </div>
      )}
    </dialog>
  );
}
