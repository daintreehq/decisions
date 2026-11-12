import type { RowStatus } from '../../domain/lists.js';
import { STATUS_LABEL } from '../../domain/lists.js';

/**
 * One glyph per principal status, all drawn on the same 16px ring so a column of them reads as one family
 * (Daintree's agent-state rule): the amber waiting ring for Needs you, the model diamond for review, a ring with a
 * check for answered, a clock for expired, a slashed ring for withdrawn, a ring with a level stroke for declined,
 * the warning triangle for delivery
 * attention, a ring with a rising arrow for an answer still waiting to leave this device. Colour sits on the glyph only; the words are always available (visible or to screen readers).
 */
export function StatusGlyph({ status, label = true }: { status: RowStatus; label?: boolean }) {
  return (
    <span className={`sglyph ${status}`}>
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.333"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {status === 'needs' && <circle className="wash" cx="8" cy="8" r="5.5" />}
        {status === 'review' && <path className="fill" d="M8 2.5 13.5 8 8 13.5 2.5 8Z" />}
        {status === 'answered' && (
          <>
            <circle cx="8" cy="8" r="5.5" />
            <path d="m5.6 8.1 1.7 1.7 3.1-3.3" />
          </>
        )}
        {status === 'expired' && (
          <>
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5.2V8l1.9 1.2" />
          </>
        )}
        {status === 'withdrawn' && (
          <>
            <circle cx="8" cy="8" r="5.5" />
            {/* Lucide's ban: the slash falls left to right, so it never reads as the rising stroke of a check. */}
            <path d="m4.2 4.2 7.6 7.6" />
          </>
        )}
        {status === 'declined' && (
          <>
            <circle cx="8" cy="8" r="5.5" />
            {/* A level stroke: set aside by the person, neither answered nor taken back. */}
            <path d="M5.4 8h5.2" />
          </>
        )}
        {status === 'delivery' && (
          <path d="M7.1 2.9 1.9 12a1 1 0 0 0 .9 1.5h10.4a1 1 0 0 0 .9-1.5L8.9 2.9a1 1 0 0 0-1.8 0ZM8 6.4v2.8M8 11.4h.01" />
        )}
        {status === 'unverified' && (
          <>
            <circle cx="8" cy="8" r="5.5" />
            <path d="m6 6 4 4M10 6l-4 4" />
          </>
        )}
        {status === 'sending' && (
          <>
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 10.6V5.6M5.9 7.6 8 5.5l2.1 2.1" />
          </>
        )}
        {status === 'unreadable' && (
          <path d="M4.5 7.5h7a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1ZM5.8 7.5V5.6a2.2 2.2 0 0 1 4.4 0v1.9" />
        )}
      </svg>
      {label && <span className="sr-only">{STATUS_LABEL[status]}</span>}
    </span>
  );
}
