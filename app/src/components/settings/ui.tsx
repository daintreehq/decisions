import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useLayer } from '../../app/layers.js';
import { CloseIcon, ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from '../Icons.js';

/**
 * Settings grammar, after Daintree's: section → group → rows. A group is one surface holding related rows split by
 * hairlines; a row has a label, an optional description and a control on the right (or full width under it).
 */
export function SettingsGroup({
  label,
  children,
  id,
  footer,
}: {
  label?: string;
  children: ReactNode;
  id?: string;
  /** A short note under the group, for what applies to the whole group rather than one row. */
  footer?: ReactNode;
}) {
  const hid = useId();
  return (
    <section className="s-group-wrap" aria-labelledby={label ? hid : undefined} id={id}>
      {label && (
        <h2 className="s-group-label" id={hid}>
          {label}
        </h2>
      )}
      <div className="s-group">{children}</div>
      {footer && <p className="s-group-foot">{footer}</p>}
    </section>
  );
}

export function Row({
  label,
  description,
  control,
  stacked,
  htmlFor,
  labelId,
  descriptionId,
  icon,
  className,
  actions,
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  stacked?: boolean;
  htmlFor?: string;
  labelId?: string;
  descriptionId?: string;
  icon?: ReactNode;
  className?: string;
  /** Buttons that act on this row, under its description. */
  actions?: ReactNode;
}) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div className={`s-row${stacked ? ' stacked' : ''}${className ? ' ' + className : ''}`}>
      {icon && <span className="s-row-icon">{icon}</span>}
      <div className="s-row-text">
        <Label className="s-row-label" htmlFor={htmlFor} id={labelId}>
          {label}
        </Label>
        {description && (
          <span className="s-row-desc" id={descriptionId}>
            {description}
          </span>
        )}
        {actions && <div className="s-actions s-row-actions">{actions}</div>}
      </div>
      {control && <div className="s-row-control">{control}</div>}
    </div>
  );
}

/** Instant on/off. A real checkbox with switch semantics, so it is one tab stop and Space toggles it. */
export function Switch({
  checked,
  onChange,
  labelledBy,
  describedBy,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  labelledBy?: string;
  describedBy?: string;
  disabled?: boolean;
  label?: string;
}) {
  // The label wrapper only widens the tap target to 44 px; the name comes from the row through aria-labelledby.
  return (
    <label className="s-switch-hit">
      <input
        type="checkbox"
        role="switch"
        className="s-switch"
        checked={checked}
        disabled={disabled}
        aria-checked={checked}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** A switch row: the whole row's text names the switch. */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Row
      label={label}
      labelId={`${id}-l`}
      description={description}
      descriptionId={description ? `${id}-d` : undefined}
      control={
        <Switch
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          labelledBy={`${id}-l`}
          describedBy={description ? `${id}-d` : undefined}
        />
      }
    />
  );
}

/** Daintree's callout: a faint tint of the hue, the hue on the glyph, neutral words. */
export function Callout({
  tone = 'info',
  title,
  children,
  action,
  role,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success' | 'neutral';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'alert' | 'status';
}) {
  const Glyph =
    tone === 'error'
      ? ErrorIcon
      : tone === 'warn'
        ? WarningIcon
        : tone === 'success'
          ? SuccessIcon
          : InfoIcon;
  return (
    <div className={`callout s-callout ${tone}`} role={role}>
      <Glyph size={18} />
      <div className="s-callout-body">
        {title && <p className="s-callout-title">{title}</p>}
        {children}
        {action && <div className="s-callout-actions">{action}</div>}
      </div>
    </div>
  );
}

/**
 * A sheet: a bottom sheet on phones, a centred panel on wide screens. It owns a history entry (useLayer), so Back
 * and Escape close it before leaving the page, and focus returns to whatever opened it.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  describedBy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  describedBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const dismiss = useLayer(open, onClose);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
    }
    if (!open && d.open) {
      d.close();
      (opener.current as HTMLElement | null)?.focus?.();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="s-sheet"
      aria-labelledby={`${id}-t`}
      aria-describedby={describedBy}
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      onClick={(e) => {
        // A tap on the scrim (the dialog element itself, outside its panel) closes it.
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="s-sheet-panel">
        <header className="s-sheet-head">
          <h2 id={`${id}-t`}>{title}</h2>
          <button type="button" className="btn ghost icon" aria-label="Close" onClick={dismiss}>
            <CloseIcon />
          </button>
        </header>
        <div className="s-sheet-body">{children}</div>
        {footer && <div className="s-sheet-foot">{footer}</div>}
      </div>
    </dialog>
  );
}
