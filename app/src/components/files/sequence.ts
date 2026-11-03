import type { AttachmentDescriptor } from '@daintreehq/decisions-protocol';

/**
 * The one canonical sequence of a question's files, in signed order (guide 5.1). Before/After are labels on items
 * in the sequence; they never pull a file out of it. The active index is shared by the inline gallery, the
 * viewer, the thumbnail strip and the All files grid.
 */
export interface FileItem {
  d: AttachmentDescriptor;
  index: number;
  /** Visible label: "Before", "After", the supplied caption, or "Image 3". Never an invented filename. */
  label: string;
  /** What a screen reader hears when this file becomes active, before "file 2 of 4". */
  spoken: string;
  /** Identity of these exact bytes: presentation and remembered zoom are keyed by it. */
  key: string;
}

export const fileKey = (d: Pick<AttachmentDescriptor, 'attachment_id' | 'sha256'>): string =>
  `${d.attachment_id}:${d.sha256}`;

export function buildSequence(attachments: readonly AttachmentDescriptor[]): FileItem[] {
  return attachments.map((d, index) => {
    const caption = d.alt?.trim();
    const role = d.role === 'before' ? 'Before' : d.role === 'after' ? 'After' : null;
    const label = role ?? caption ?? `Image ${index + 1}`;
    const spoken = role ? `${role} screenshot` : label;
    return { d, index, label, spoken, key: fileKey(d) };
  });
}

/** "After screenshot, file 2 of 4". */
export const announceFor = (item: FileItem, total: number): string =>
  `${item.spoken}, file ${item.index + 1} of ${total}`;

/** Alt text for the image itself: the caption when supplied, otherwise the honest role label. */
export const altFor = (item: FileItem): string => item.d.alt?.trim() || item.label;

/** Auto-pair only when there is exactly one Before and one After. */
export function autoPair(items: readonly FileItem[]): { before: number; after: number } | null {
  const befores = items.filter((i) => i.d.role === 'before');
  const afters = items.filter((i) => i.d.role === 'after');
  if (befores.length !== 1 || afters.length !== 1) return null;
  return { before: befores[0]!.index, after: afters[0]!.index };
}

/** Move one step without wrapping. */
export const stepIndex = (index: number, dir: number, total: number): number =>
  Math.min(total - 1, Math.max(0, index + Math.sign(dir)));

/** Load order: the active file first, then its neighbours outwards (next before previous). */
export function loadOrder(total: number, active: number): number[] {
  const out: number[] = [];
  if (total <= 0) return out;
  const a = Math.min(total - 1, Math.max(0, active));
  out.push(a);
  for (let d = 1; out.length < total; d++) {
    if (a + d < total) out.push(a + d);
    if (a - d >= 0) out.push(a - d);
  }
  return out;
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** An honest download name: `decision-image-3.png`. */
export const downloadName = (index: number, mime: string): string =>
  `decision-image-${index + 1}.${EXT[mime] ?? 'img'}`;
