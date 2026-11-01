/**
 * Question, context and answer text is untrusted (agents and models wrote it). It is never turned into HTML:
 * this module strips terminal control sequences and bidi/format tricks, then parses a tiny, closed subset of
 * formatting into data. React renders that data as text nodes, so nothing in here can create markup.
 */
export type Inline = { t: 'text' | 'code' | 'bold'; text: string };
export type Block = { type: 'p'; lines: Inline[][] } | { type: 'code'; text: string };

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_CSI = new RegExp(ESC + '\\[[0-?]*[ -/]*[@-~]', 'g');
const ANSI_OSC = new RegExp(ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)?', 'g');
const ANSI_OTHER = new RegExp(ESC + '[@-Z\\\\-_]|' + ESC + '.', 'g');

// Removed outright: C0 controls except tab and newline, DEL, C1 controls, bidi embeddings/overrides/isolates,
// BOM, and the line/paragraph separators. Built from numeric ranges so no raw control characters live in source.
const CONTROL_RANGES: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const hex4 = (n: number) => n.toString(16).padStart(4, '0');
const CONTROL = new RegExp(
  '[' + CONTROL_RANGES.map(([a, b]) => '\\u' + hex4(a) + '-\\u' + hex4(b)).join('') + ']',
  'g',
);

export const MAX_TEXT_CHARS = 64 * 1024;

export function sanitizeText(input: string): string {
  let s = input.length > MAX_TEXT_CHARS ? input.slice(0, MAX_TEXT_CHARS) : input;
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(ANSI_CSI, '').replace(ANSI_OSC, '').replace(ANSI_OTHER, '');
  s = s.replace(CONTROL, '');
  return s;
}

function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', text: buf });
    buf = '';
  };
  while (i < line.length) {
    if (line[i] === '`') {
      const end = line.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', text: line.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (line.startsWith('**', i)) {
      const end = line.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'bold', text: line.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    buf += line[i];
    i++;
  }
  flush();
  return out;
}

export function parseSafeText(input: string): Block[] {
  const text = sanitizeText(input);
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', lines: para.map(parseInline) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```')) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        code.push(lines[i]!);
        i++;
      }
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

/** Collapse to a single plain-text line for notifications, list previews and aria labels. */
export function previewText(input: string, max = 140): string {
  // Previews are one plain line: drop the light formatting markers instead of showing them literally.
  const s = sanitizeText(input)
    .replace(/```/g, ' ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
