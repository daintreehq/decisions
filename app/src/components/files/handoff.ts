/**
 * Handing a verified file to the browser (guide 5.6): Open puts the original in a new tab through its Blob URL;
 * Download saves it under an honest name. Both leave a readable copy outside Decisions, so the first use explains
 * that once. Neither is ever offered for a file that failed verification.
 */

const EXPLAINED_KEY = 'decisions.files.handoff-explained';

export function handoffExplained(): boolean {
  try {
    return localStorage.getItem(EXPLAINED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markHandoffExplained(): void {
  try {
    localStorage.setItem(EXPLAINED_KEY, '1');
  } catch {
    /* private mode: explain again next time */
  }
}

/**
 * Something that must settle before a file leaves the app. The dictation owner registers one: while recording,
 * Open first stops and saves dictation, then asks for a fresh tap ("Open file now"), because the stop is async and
 * the browser only opens a tab from a direct tap.
 */
export interface HandoffGuard {
  /** True while something (dictation) must be stopped before a file can leave. */
  busy(): boolean;
  /** Stop and save it. */
  settle(): Promise<void>;
}

let guard: HandoffGuard | null = null;

export function registerHandoffGuard(g: HandoffGuard): () => void {
  guard = g;
  return () => {
    if (guard === g) guard = null;
  };
}

export const handoffBusy = (): boolean => guard?.busy() ?? false;
export const settleHandoff = async (): Promise<void> => {
  await guard?.settle();
};

/** Opens the Blob URL in a new tab. Returns false when the browser blocked it. Must run inside a tap. */
export function openInNewTab(url: string): boolean {
  let w: Window | null = null;
  try {
    w = window.open(url, '_blank');
  } catch {
    w = null;
  }
  if (!w) return false;
  try {
    w.opener = null;
  } catch {
    /* cross-origin hardening is best effort; the tab shows a same-origin Blob */
  }
  return true;
}

export function downloadBlobUrl(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
