import { sanitizeText } from '../lib/safe-text.js';

/**
 * The owner computer's name as every surface shows it, from the label in its certificate: "Studio Mac", or "your
 * computer" when it has none or only a generated `host_…` id. The owner chose the name and its key signed it, but it
 * is still shown as text: control and escape characters are dropped and line breaks folded, as for the asking
 * computer's name.
 */
export function computerName(label: string | null | undefined): string {
  const name = sanitizeText(label ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return name && !/^host_[0-9a-z]{6,}$/i.test(name) ? name : 'your computer';
}
