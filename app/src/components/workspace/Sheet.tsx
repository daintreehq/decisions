import { useEffect, useRef, type ReactNode } from 'react';
import { useLayer } from '../../app/layers.js';
import { Modal } from '../Modal.js';

/**
 * A bottom sheet on phones and a centred panel on wide screens (the shared Modal). It is a workspace layer: Back,
 * Escape, a tap on the dimmed page and a downward swipe on its head close it, one layer at a time. A sheet with a
 * footer is a confirmation, answered by its actions; one without has a Close button.
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
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={footer}
      className={className ? `sheet ${className}` : 'sheet'}
      describedBy={describedBy}
      animateExit={animateExit}
    >
      {children}
    </Modal>
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
