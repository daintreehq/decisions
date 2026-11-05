import type { ReactNode } from 'react';
import { Modal } from './Modal.js';

/**
 * A confirmation or disclosure: the shared Modal, so it is a bottom sheet on phones and a centred panel from 720px,
 * exactly like a workspace sheet. Focus containment and return come from the native <dialog>; Back, Escape and a
 * tap on the dimmed page close it as one layer.
 */
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
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={actions}
      className={wide ? 'sheet dialog wide' : 'sheet dialog'}
      bodyClassName="dialog-body"
      footClassName="dialog-actions"
    >
      {children}
    </Modal>
  );
}

export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger,
  confirmDisabled,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  /** The safe action, named for what it keeps where a plain "Cancel" would be ambiguous. */
  cancelLabel?: string;
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
            {cancelLabel}
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
