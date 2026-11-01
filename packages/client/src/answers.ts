/** Locally stored, already-verified-and-decrypted answer history for one question. */
export interface AnswerEntry {
  entry_id: string;
  kind: 'answer' | 'expired';
  action: 'answer' | 'override' | 'proxy-answer' | 'confirm-proxy' | 'expire';
  revision: number;
  source: 'human' | 'proxy' | 'system';
  choices: { id: string; label?: string }[];
  text: string;
  reviewed_attachment_digests: string[];
  /** Replaces an earlier answer. */
  correction: boolean;
  confidence?: number;
  model_id?: string;
  created_at: string;
  /** Needs to be typed into the terminal. */
  deliver: boolean;
  delivered: boolean;
  injection_id?: string;
}

export function parseAnswers(json: string): AnswerEntry[] {
  try {
    const v = JSON.parse(json) as AnswerEntry[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export const serializeAnswers = (a: AnswerEntry[]): string => JSON.stringify(a);

/** True when two digest lists hold the same digests the same number of times, in any order. */
export function sameDigests(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.map((d) => d.toLowerCase()).sort();
  const y = b.map((d) => d.toLowerCase()).sort();
  return x.every((d, i) => d === y[i]);
}
