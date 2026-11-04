import type { ReactNode } from 'react';

export { MOD } from './Composer.js';

/**
 * The dock: a real layout row at the foot of the workspace, labelled as a region. While a question can be answered
 * it holds the composer; once an answer is on its way (or the question closed) it holds what comes next. Anything
 * that grows (the field, the lane, a word check) grows upward, so what sits at the bottom edge stays put.
 */
export function AnswerDock({
  children,
  label = 'Answer',
}: {
  children?: ReactNode;
  label?: string;
}) {
  return (
    <section className="dock" aria-label={label}>
      {children}
    </section>
  );
}
