import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../Icons.js';

/**
 * File layers are modes of the workspace, never modals that make the page inert: the answer dock stays usable
 * (and dictation keeps running) underneath. They portal into the workspace's `#workspace-overlay`, which covers
 * exactly the header and body rows above the dock; without it they fall back to a fixed full-viewport layer.
 */
function overlayHost(): { el: HTMLElement; inWorkspace: boolean } {
  const el = document.getElementById('workspace-overlay');
  return el ? { el, inWorkspace: true } : { el: document.body, inWorkspace: false };
}

export function Overlay({
  children,
  className = '',
  ...rest
}: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  const [host] = useState(overlayHost);
  return createPortal(
    <div
      className={`fx-overlay ${host.inWorkspace ? 'in-workspace' : 'is-fixed'} ${className}`}
      {...rest}
    >
      {children}
    </div>,
    host.el,
  );
}

/**
 * Focus moves into a layer when it opens and back to whatever opened it when it closes (or to `fallback` when the
 * opener has gone). Focus is only restored when the closing layer still held it, so a layer that replaces another
 * (a menu item opening a sheet) keeps the focus it took.
 */
export function useFocusInOut(
  target: () => HTMLElement | null | undefined,
  fallback?: () => HTMLElement | null | undefined,
  opener?: HTMLElement | null,
) {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useLayoutEffect(() => {
    const from = opener ?? (document.activeElement as HTMLElement | null);
    target()?.focus({ preventScroll: true });
    return () => {
      // After the layer's DOM is gone, so we can tell whether focus went down with it.
      queueMicrotask(() => {
        const now = document.activeElement;
        if (now && now !== document.body && now.isConnected) return;
        const back =
          from && from.isConnected && from !== document.body ? from : fallbackRef.current?.();
        back?.focus({ preventScroll: true });
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside `root` (sheets and menus are transient; the viewer itself does not trap, so the dock stays reachable). */
export function containTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (e.key !== 'Tab' || !root) return;
  const els = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
  if (!els.length) return;
  const first = els[0]!;
  const last = els[els.length - 1]!;
  const at = document.activeElement;
  if (e.shiftKey && (at === first || at === root || !root.contains(at))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** A bottom sheet (a centred panel on wide screens) over a scrim that covers only the workspace region. */
export function Sheet({
  title,
  onDismiss,
  children,
  footer,
  className = '',
  wide,
}: {
  title: ReactNode;
  /** Close through history (useLayer's dismiss). */
  onDismiss: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusInOut(() => panel.current);
  return (
    <Overlay className="fx-sheet-layer">
      <div className="fx-scrim" aria-hidden="true" onClick={onDismiss} />
      <div
        ref={panel}
        role="dialog"
        aria-labelledby={`${id}-t`}
        tabIndex={-1}
        className={`fx-sheet${wide ? ' wide' : ''} ${className}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            onDismiss();
          }
          containTab(e, panel.current);
        }}
      >
        <div className="fx-sheet-head">
          <h2 id={`${id}-t`}>{title}</h2>
          <button type="button" className="btn ghost icon" aria-label="Close" onClick={onDismiss}>
            <CloseIcon />
          </button>
        </div>
        <div className="fx-sheet-body">{children}</div>
        {footer && <div className="fx-sheet-foot">{footer}</div>}
      </div>
    </Overlay>
  );
}

export interface MenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

/** A small menu anchored under its trigger: arrow keys move, Escape closes, focus returns to the trigger. */
export function Menu({
  items,
  anchor,
  onDismiss,
  label,
  note,
}: {
  items: MenuItem[];
  anchor: HTMLElement | null;
  onDismiss: () => void;
  label: string;
  note?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const host = list.current?.offsetParent as HTMLElement | null;
    if (!anchor || !host) return;
    const a = anchor.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    setPos({ top: a.bottom - h.top + 4, right: h.right - a.right });
  }, [anchor]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
      ?.focus();
  }, []);
  useFocusInOut(
    () => null,
    () => anchor,
    anchor,
  );
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % els.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + els.length) % els.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = els.length - 1;
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
      return;
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onDismiss();
      return;
    } else return;
    e.preventDefault();
    els[next]?.focus();
  };
  return (
    <Overlay className="fx-menu-layer">
      <div className="fx-menu-catch" aria-hidden="true" onClick={onDismiss} />
      <div
        ref={list}
        role="menu"
        aria-label={label}
        className="fx-menu"
        style={pos ? { top: pos.top, right: pos.right } : { visibility: 'hidden' }}
        onKeyDown={move}
      >
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-disabled={it.disabled || undefined}
            onClick={() => {
              if (!it.disabled) it.onSelect();
            }}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        ))}
        {note && <p className="fx-menu-note">{note}</p>}
      </div>
    </Overlay>
  );
}
