import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useLayer } from '../app/layers.js';
import { CloseIcon } from './Icons.js';
import { useDialogMotion } from './useDialogMotion.js';
import { useSwipeClose } from './useSwipeClose.js';

/** Below 720px a modal is a bottom sheet, and a downward swipe on its head closes it. */
const docked = () =>
  typeof matchMedia === 'function' && matchMedia('(max-width: 719.98px)').matches;

/**
 * The one modal layer behind Sheet and Dialog: a bottom sheet on phones and a centred panel from 720px, built on the
 * native modal <dialog> (focus is contained and returned by the platform). It is a layer: Back, Escape, a tap on the
 * dimmed page and, on a phone, a downward swipe on its head close it, one layer at a time.
 *
 * A modal with actions is a confirmation: it is answered by them, so it has no Close button, and it is an alert
 * dialog. One without actions shows information and has Close in its head. When it opens, focus goes to the first safe
 * (neither `danger` nor `primary`, enabled) action of a destructive or short confirmation, which is always the one that keeps things
 * as they are, so Enter never commits; a read (long, or structured like a list or a before-and-after) and an
 * information sheet focus the title instead, so they are read from the top. A confirmation is described by its lead
 * paragraph, never its whole body. An element with `autofocus` inside takes precedence. Content stays
 * through the exit, even when the caller drops it as it closes. The actions sit side by side, equal in width, while
 * every label fits half the row on a phone, and stack full width (in reading order) when one does not.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  className,
  bodyClassName,
  footClassName,
  describedBy,
  animateExit = true,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className: string;
  bodyClassName?: string;
  footClassName?: string;
  describedBy?: string;
  animateExit?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const dismiss = useLayer(open, onClose);
  const present = useDialogMotion(ref, open, animateExit);
  // A swipe carries the sheet off the bottom; every other close mirrors the entry (motion.css).
  const swipe = useSwipeClose(ref, 'down', () => {
    ref.current?.setAttribute('data-swiped', '');
    dismiss();
  });
  // What was on screen while open, kept for the exit.
  const shown = useRef({ title, children, footer });
  if (open) shown.current = { title, children, footer };
  const view = open ? { title, children, footer } : shown.current;
  const actions = view.footer != null && view.footer !== false;
  const contentId = `${id}-d`;

  useLayoutEffect(() => {
    const d = ref.current;
    if (!open || !d) return;
    d.removeAttribute('data-swiped');
    const content = d.querySelector<HTMLElement>('.sheet-content');
    // A read rather than a question: long, or structured (a list, a before-and-after), so it is read from the top.
    const reading =
      !!content &&
      (content.scrollHeight > content.clientHeight + 1 ||
        (content.textContent ?? '').length > 480 ||
        [...content.children].some((c) => c.tagName !== 'P'));
    const destructive = !!d.querySelector('.sheet-foot .btn.danger');
    if (actions) d.setAttribute('role', 'alertdialog');
    else d.removeAttribute('role');
    if (!describedBy) {
      // A confirmation is described by its lead paragraph, never by its whole body.
      const lead = actions ? content?.querySelector<HTMLElement>(':scope > p') : null;
      if (lead) {
        if (!lead.id) lead.id = `${contentId}-lead`;
        d.setAttribute('aria-describedby', lead.id);
      } else d.removeAttribute('aria-describedby');
    }
    if (d.querySelector('[autofocus]')) return;
    // Destructive: always the safe action. Otherwise the safe action of a short question, or the title of a read.
    const safe =
      actions && (destructive || !reading)
        ? [...d.querySelectorAll<HTMLButtonElement>('.sheet-foot button')].find(
            (b) =>
              !b.classList.contains('danger') && !b.classList.contains('primary') && !b.disabled,
          )
        : undefined;
    (safe ?? d.querySelector<HTMLElement>('.sheet-head h2'))?.focus();
  }, [open]);

  // Equal halves while every label fits; a full-width stack otherwise. Measured at each label's own width, before
  // the first paint.
  useLayoutEffect(() => {
    const foot = ref.current?.querySelector<HTMLElement>('.sheet-foot');
    if (!open || !foot || typeof ResizeObserver === 'undefined') return;
    const fit = () => {
      const buttons = [...foot.children].filter(
        (c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('btn'),
      );
      foot.classList.remove('stacked');
      if (buttons.length < 2 || !docked()) return;
      foot.classList.add('measuring');
      const widest = Math.max(...buttons.map((b) => b.offsetWidth));
      foot.classList.remove('measuring');
      const style = getComputedStyle(foot);
      const gap = parseFloat(style.columnGap) || 0;
      const inner =
        foot.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const half = (inner - gap * (buttons.length - 1)) / buttons.length;
      foot.classList.toggle('stacked', widest > half);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(foot);
    return () => ro.disconnect();
  }, [open, present]);

  return (
    <dialog
      ref={ref}
      className={className}
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
          <header
            className="sheet-head"
            onPointerDown={(e) => {
              if (docked()) swipe.onPointerDown(e);
            }}
            onPointerMove={swipe.onPointerMove}
            onPointerUp={swipe.onPointerUp}
            onPointerCancel={swipe.onPointerCancel}
          >
            <h2 id={`${id}-t`} tabIndex={-1}>
              {view.title}
            </h2>
            {!actions && (
              <button type="button" className="btn ghost icon" aria-label="Close" onClick={dismiss}>
                <CloseIcon />
              </button>
            )}
          </header>
          <div
            className={bodyClassName ? `sheet-content ${bodyClassName}` : 'sheet-content'}
            id={contentId}
            onScroll={(e) => {
              // A hairline under the head once the content has scrolled beneath it.
              e.currentTarget.previousElementSibling?.toggleAttribute(
                'data-scrolled',
                e.currentTarget.scrollTop > 0,
              );
            }}
          >
            {view.children}
          </div>
          {actions && (
            <div className={footClassName ? `sheet-foot ${footClassName}` : 'sheet-foot'}>
              {view.footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
