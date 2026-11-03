import type { ImageResult } from '../../data/images.js';
import type { QuestionView } from '../../domain/model.js';
import type { FileItem } from './sequence.js';
import type { NormalView, Size } from './zoom.js';

/** What every file surface (inline gallery, viewer, comparison, All files) shares. */
export interface FilesModel {
  view: QuestionView;
  items: readonly FileItem[];
  results: Readonly<Record<string, ImageResult | undefined>>;
  naturals: Readonly<Record<string, Size>>;
  onNatural: (id: string, size: Size) => void;
  retry: (id: string) => void;
  zoomOf: (key: string) => NormalView;
  setZoom: (key: string, v: NormalView) => void;
  /** A surface displayed this file to the person (counts towards evidence). */
  present: (item: FileItem) => void;
}

/** Zoom and pan per file for the session; a changed file has a different key and starts at Fit. */
export const zoomMemory = new Map<string, NormalView>();
