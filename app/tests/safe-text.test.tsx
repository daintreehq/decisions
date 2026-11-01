import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SafeText } from '../src/components/SafeText.js';
import { parseSafeText, previewText, sanitizeText } from '../src/lib/safe-text.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const RLO = String.fromCharCode(0x202e);

describe('sanitizeText', () => {
  it('removes ANSI CSI, OSC and other escape sequences', () => {
    expect(sanitizeText(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitizeText(`${ESC}]0;window title${BEL}after`)).toBe('after');
    expect(sanitizeText(`${ESC}]8;;https://evil.example${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe(
      'link',
    );
    expect(sanitizeText(`a${ESC}cb`)).toBe('ab');
  });
  it('removes control characters, bidi overrides and separators but keeps tabs and newlines', () => {
    const dirty = `a${String.fromCharCode(0)}b${String.fromCharCode(8)}c\td\ne${RLO}f${String.fromCharCode(0x2028)}g${String.fromCharCode(0x85)}h`;
    expect(sanitizeText(dirty)).toBe('abc\td\nefgh');
  });
  it('normalises line endings and caps absurd input', () => {
    expect(sanitizeText('a\r\nb\rc')).toBe('a\nb\nc');
    expect(sanitizeText('x'.repeat(200_000)).length).toBe(64 * 1024);
  });
  it('keeps emoji and non-latin text intact', () => {
    expect(sanitizeText('naïve 日本語 👩‍💻')).toBe('naïve 日本語 👩‍💻');
  });
});

describe('parseSafeText', () => {
  it('parses paragraphs, line breaks, inline code, bold and fenced blocks', () => {
    const b = parseSafeText(
      'hello **world** and `code`\nsecond line\n\n```\nline1\n  line2\n```\nlast',
    );
    expect(b).toEqual([
      {
        type: 'p',
        lines: [
          [
            { t: 'text', text: 'hello ' },
            { t: 'bold', text: 'world' },
            { t: 'text', text: ' and ' },
            { t: 'code', text: 'code' },
          ],
          [{ t: 'text', text: 'second line' }],
        ],
      },
      { type: 'code', text: 'line1\n  line2' },
      { type: 'p', lines: [[{ t: 'text', text: 'last' }]] },
    ]);
  });
  it('treats unmatched markers literally', () => {
    expect(parseSafeText('2 ** 3 and `open')).toEqual([
      { type: 'p', lines: [[{ t: 'text', text: '2 ** 3 and `open' }]] },
    ]);
  });
});

describe('rendering untrusted text', () => {
  const html = (t: string) => renderToStaticMarkup(<SafeText text={t} />);
  it('escapes markup instead of creating it', () => {
    const out = html(
      '<script>alert(1)</script><img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>',
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<a ');
    expect(out).toContain('&lt;script&gt;');
  });
  it('does not turn markdown links or images into elements', () => {
    const out = html('[click](javascript:alert(1)) ![x](https://evil.example/p.png)');
    expect(out).not.toContain('<a');
    expect(out).not.toContain('<img');
  });
  it('escapes markup inside code and bold runs too', () => {
    const out = html('`<b>x</b>` **<i>y</i>**\n```\n<iframe></iframe>\n```');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<i>');
    expect(out).toContain('&lt;iframe&gt;');
  });
  it('strips terminal escapes before rendering', () => {
    const out = html(`${ESC}[2J${ESC}[Hclear screen`);
    expect(out).toContain('clear screen');
    expect(out).not.toContain(ESC);
  });
});

describe('previewText', () => {
  it('flattens whitespace and truncates', () => {
    expect(previewText('a\n\n  b   c')).toBe('a b c');
    expect(previewText('x'.repeat(300), 20)).toHaveLength(20);
    expect(previewText(`${ESC}[1mbold${ESC}[0m`)).toBe('bold');
    expect(previewText('The **compact** layout, see `Sidebar.tsx`')).toBe(
      'The compact layout, see Sidebar.tsx',
    );
    expect(previewText('2 ** 3 and `open')).toBe('2 ** 3 and `open');
  });
});
