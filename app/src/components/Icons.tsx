import type { ReactNode } from 'react';
import type { QuestionView } from '../domain/model.js';
import { originParts } from '../domain/selectors.js';

/**
 * The app's one icon set: inline SVG drawn on Lucide's 24-unit geometry at Daintree's 1.75 stroke (no icon font or
 * external assets: the CSP allows neither). Decorative unless labelled. One glyph per recurring action.
 */
function Svg({
  size = 16,
  d,
  children,
  strokeWidth = 1.75,
}: {
  size?: number;
  d?: string;
  children?: ReactNode;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
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

type P = { size?: number };
const icon = (d: string, def = 18) =>
  function Icon({ size = def }: P) {
    return <Svg size={size} d={d} />;
  };

export const ChevronRight = icon('M9 5l7 7-7 7');
export const ChevronDown = icon('M5 9l7 7 7-7');
export const ArrowLeft = icon('M19 12H5M12 19l-7-7 7-7');
export const ArrowRight = icon('M5 12h14M12 5l7 7-7 7');
export const CloseIcon = icon('M18 6 6 18M6 6l12 12');
/** The sidebar's menu button: Lucide's menu. */
export const MenuIcon = icon('M4 6h16M4 12h16M4 18h16', 22);
export const MicIcon = icon(
  'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  20,
);
export const StopIcon = ({ size = 16 }: P) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
    <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
  </svg>
);
export const SendIcon = icon('M12 19V5M5 12l7-7 7 7');
export const KeyboardIcon = icon(
  'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4M7 16h10',
);
/** All Q&A: messages-square. */
export const QuestionsIcon = icon(
  'M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2zM18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1',
  20,
);
export const FilesIcon = icon(
  'M18 22H4a2 2 0 0 1-2-2V6M22 13l-1.3-1.3a2.4 2.4 0 0 0-3.4 0L12 17M8 2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM13 8h.01',
);
export const GridIcon = icon('M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z');
export const CompareIcon = icon(
  'M12 3v18M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
);
export const ZoomInIcon = icon('M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.3-4.3M11 8v6M8 11h6');
export const ZoomOutIcon = icon('M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.3-4.3M8 11h6');
export const FitIcon = icon(
  'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
);
export const MoveIcon = icon(
  'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
);
export const SearchIcon = icon('M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.3-4.3');
/** Lucide's list-filter: three narrowing lines (Settings already owns the sliders). */
export const FilterIcon = icon('M3 6h18M7 12h10M10 18h4');
export const MoreIcon = icon('M5 12h.01M12 12h.01M19 12h.01', 20);
export const CopyIcon = icon(
  'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2zM4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2',
);
export const DownloadIcon = icon('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3');
export const ExternalIcon = icon(
  'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
);
export const RefreshIcon = icon(
  'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5',
);
export const UndoIcon = icon('M3 7v6h6M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13');
export const PencilIcon = icon(
  'M21.17 6.81a2.83 2.83 0 0 0-4-4L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5zM15 5l4 4',
);
export const InfoIcon = icon('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 16v-4M12 8h.01');
export const WarningIcon = icon(
  'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
);
export const ErrorIcon = icon('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM15 9l-6 6M9 9l6 6');
export const SuccessIcon = icon('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM9 12l2 2 4-4');
export const PhoneIcon = icon(
  'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01',
);
export const LaptopIcon = icon(
  'M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16',
);
export const BellIcon = icon(
  'M10.27 21a2 2 0 0 0 3.46 0M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33',
);
export const MoonIcon = icon('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z');
export const PaletteIcon = icon(
  'M12 22a10 10 0 1 1 10-10c0 2.5-2 3.5-3.5 3.5H16a2 2 0 0 0-1.5 3.3A1.5 1.5 0 0 1 13 22zM13.5 6.5h.01M17.5 10.5h.01M8.5 7.5h.01M6.5 12.5h.01',
);
export const ShieldIcon = icon(
  'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
);
export const HelpIcon = icon(
  'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
);
export const LockIcon = icon(
  'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4',
);
export const OfflineIcon = icon(
  'M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.18-2.65M19 12.86a10 10 0 0 0-2.29-1.5M22 8.82a15 15 0 0 0-11.29-3.76M5 12.86a10 10 0 0 1 5.17-2.69M2 2l20 20',
);
export const ScanIcon = icon(
  'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10',
);
export const LinkIcon = icon(
  'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
);
export const SparkleIcon = icon(
  'M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z',
);
/** Model provenance: Daintree's rotated-square decision node, small. */
export const ModelIcon = icon('M12 3l9 9-9 9-9-9z');

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
