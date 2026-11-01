import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Native <dialog> modal: focus trap and Escape handling come from the platform. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Several dialogs can be mounted at once, so each needs its own ids for its name and description.
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog wide' : 'dialog'}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      onClose={onClose}
      onCancel={onClose}
    >
      <h2 id={`${id}-title`}>{title}</h2>
      <div className="dialog-body" id={`${id}-body`}>
        {children}
      </div>
      <div className="dialog-actions">{actions}</div>
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  danger,
  confirmDisabled,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'btn danger' : 'btn primary'}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
