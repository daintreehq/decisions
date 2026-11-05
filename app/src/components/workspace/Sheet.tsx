import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useLayer } from '../../app/layers.js';
import { CloseIcon } from '../Icons.js';
import { useDialogMotion } from '../useDialogMotion.js';

/**
 * A bottom sheet on phones and a centred panel on wide screens, built on the native modal <dialog> (focus is
 * contained and returned by the platform). It is a workspace layer: Back and Escape close it, one layer at a time.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
  className,
  describedBy,
  animateExit = true,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  describedBy?: string;
  /** Native camera/library handoffs release the modal immediately. */
  animateExit?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const dismiss = useLayer(open, onClose);
  const present = useDialogMotion(ref, open, animateExit);
  return (
    <dialog
      ref={ref}
      className={`sheet${className ? ` ${className}` : ''}`}
      aria-labelledby={`${id}-t`}
      aria-describedby={describedBy}
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      onClick={(e) => {
        // A tap on the scrim (the dialog box itself, outside its content) closes it.
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      {present && (
        <div className="sheet-body">
          <header className="sheet-head">
            <h2 id={`${id}-t`}>{title}</h2>
            <button type="button" className="btn ghost icon" aria-label="Close" onClick={dismiss}>
              <CloseIcon />
            </button>
          </header>
          <div className="sheet-content">{children}</div>
          {footer && <div className="sheet-foot">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/** A small anchored menu (the workspace's more menu). Escape, Back and a tap outside close it. */
export function Menu({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useLayer(open, onClose);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    el?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...(el?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      next?.focus();
      e.preventDefault();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, dismiss]);
  if (!open) return null;
  return (
    <div ref={ref} className="menu" role="menu" aria-label={label}>
      {children}
    </div>
  );
}
