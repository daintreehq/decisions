import type { ReactNode } from 'react';
import type { QuestionView } from '../domain/model.js';
import { originParts } from '../domain/selectors.js';

/** Small inline icons (no icon font or external assets: the CSP allows neither). Decorative unless labelled. */
function Svg({ size = 16, d, children }: { size?: number; d?: string; children?: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

export const ClockIcon = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);

export const CheckIcon = ({ size = 26 }: { size?: number }) => (
  <Svg size={size} d="M5 12.5l4.5 4.5L19 7.5" />
);

export const PersonIcon = ({ size = 13 }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </Svg>
);

export const ExpandIcon = ({ size = 16 }: { size?: number }) => (
  <Svg size={size} d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
);

export const ChevronLeft = ({ size = 18 }: { size?: number }) => (
  <Svg size={size} d="M15 5l-7 7 7 7" />
);

/** Project first (it is what you recognise), machine beside it in a quieter weight, never dropped (H5). */
export function Origin({ v, as: Tag = 'span' }: { v: QuestionView; as?: 'span' | 'p' }) {
  const { project, machine } = originParts(v);
  return (
    <Tag className="origin">
      <span className="project">{project}</span>
      {machine && (
        <span className="machine">
          <span className="sr-only"> on </span>
          {machine}
        </span>
      )}
    </Tag>
  );
}
