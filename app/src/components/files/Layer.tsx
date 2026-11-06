import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
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
        // The opener, unless it has gone or can no longer take focus (a button disabled meanwhile).
        const usable =
          from &&
          from.isConnected &&
          from !== document.body &&
          !(from as HTMLButtonElement).disabled;
        const back = usable ? from : fallbackRef.current?.();
        back?.focus({ preventScroll: true });
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * A control that disables or removes itself when used (Fit at Fit, Next on the last file, Retry once it loads) would
 * drop focus on the page body, where the layer's keys no longer reach. Inside `root`, focus goes to `fallback`
 * instead. Focus that moves anywhere else (the dock, another control) is left alone.
 */
export function useFocusKeeper(
  root: RefObject<HTMLElement | null>,
  fallback: (from: HTMLElement) => HTMLElement | null | undefined,
) {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const lost = (e: FocusEvent) => {
      if (e.relatedTarget) return;
      const from = e.target as HTMLElement;
      setTimeout(() => {
        const now = document.activeElement;
        if (now && now !== document.body) return;
        const gone = !from.isConnected || (from as HTMLButtonElement).disabled === true;
        if (gone && node.isConnected) fallbackRef.current(from)?.focus({ preventScroll: true });
      }, 0);
    };
    node.addEventListener('focusout', lost);
    return () => node.removeEventListener('focusout', lost);
  }, [root]);
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
  lead,
  className = '',
  wide,
}: {
  title: ReactNode;
  /** Close through history (useLayer's dismiss). */
  onDismiss: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Stays put above the scrolling body (what the sheet is about). */
  lead?: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  // A menu item that opens a sheet unmounts with its menu, so focus comes back to the menu's trigger instead.
  const [opener] = useState(openerForLayer);
  useFocusInOut(() => panel.current, undefined, opener);
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
          <button
            type="button"
            className="btn ghost icon"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onDismiss}
          >
            <CloseIcon />
          </button>
        </div>
        {lead && <div className="fx-sheet-lead">{lead}</div>}
        <div className="fx-sheet-body">{children}</div>
        {footer && <div className="fx-sheet-foot">{footer}</div>}
      </div>
    </Overlay>
  );
}

/** The trigger of the open menu, while one is open: what a layer opened from a menu item gives focus back to. */
let menuAnchor: HTMLElement | null = null;

function openerForLayer(): HTMLElement | null {
  const at = document.activeElement as HTMLElement | null;
  if (at?.closest('[role="menu"]') && menuAnchor?.isConnected) return menuAnchor;
  return at;
}

export interface MenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  /** Starts a new group: a hairline above it. */
  group?: boolean;
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
    menuAnchor = anchor;
    return () => {
      if (menuAnchor === anchor) menuAnchor = null;
    };
  }, [anchor]);
  // Focus moves in once the menu is placed (it is hidden until then, and a hidden element cannot take focus), so
  // Escape and the arrow keys reach the menu rather than the layer under it. With every item unavailable the menu
  // itself holds focus.
  // The answer dock and the sidebar sit outside the menu's catch layer: a tap or focus there closes it too.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const outside = (e: Event) => {
      const t = e.target as Node | null;
      if (t && !list.current?.contains(t) && !anchor?.contains(t)) dismissRef.current();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
    };
  }, [anchor]);
  const noteId = useId();
  const placed = pos !== null;
  useEffect(() => {
    if (!placed) return;
    const first = list.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    );
    (first ?? list.current)?.focus();
  }, [placed]);
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
        tabIndex={-1}
        aria-label={label}
        aria-describedby={note ? noteId : undefined}
        className="fx-menu"
        style={pos ? { top: pos.top, right: pos.right } : { visibility: 'hidden' }}
        onKeyDown={move}
      >
        {items.map((it) => [
          it.group && <hr key={`${it.key}-sep`} className="fx-menu-sep" aria-hidden="true" />,
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
          </button>,
        ])}
        {note && (
          <p className="fx-menu-note" id={noteId}>
            {note}
          </p>
        )}
      </div>
    </Overlay>
  );
}
