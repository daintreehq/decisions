import { describe, expect, it } from 'vitest';
import {
  applyToRegion,
  buildKeyterms,
  dictationLanguage,
  precedingText,
  resolveSpan,
  runCorrection,
  validSpans,
  type Span,
} from '../src/features/voice/correction.js';

const ok = (corrected: string, spans: unknown[] = [], warnings: string[] = []) =>
  new Response(
    JSON.stringify({
      model: 'claude-test',
      result: {
        corrected_text: corrected,
        uncertain_spans: spans,
        applied_commands: [],
        warnings,
      },
    }),
    { status: 200 },
  );

function req(
  raw: string,
  post: (p: string, b: unknown, s: AbortSignal) => Promise<Response>,
  over: Partial<Parameters<typeof runCorrection>[0]> = {},
) {
  let editor = raw;
  return {
    setEditor: (t: string) => (editor = t),
    run: () =>
      runCorrection({
        post,
        provider: 'anthropic',
        raw,
        question: 'Use the compact sidebar?',
        options: [{ label: 'Yes' }, { label: 'No' }],
        editorAtStart: raw,
        getEditorText: () => editor,
        timeoutMs: 50,
        ...over,
      }),
  };
}

describe('runCorrection keeps the raw text when the clean-up fails', () => {
  const raw = 'yes keep the sidebar';
  it('applies a good result and returns well-formed spans', async () => {
    const r = await req(raw, async () =>
      ok('Yes, keep the sidebar.', [
        { start: 5, end: 9, raw: 'keep', candidate: 'keen', reason: 'unclear' },
      ]),
    ).run();
    expect(r).toMatchObject({ kind: 'applied', model: 'claude-test' });
    if (r.kind === 'applied') expect(r.spans).toHaveLength(1);
  });
  it('keeps raw on timeout', async () => {
    const r = await req(
      raw,
      (_p, _b, signal) =>
        new Promise((_res, rej) =>
          signal.addEventListener('abort', () => rej(new Error('aborted'))),
        ),
    ).run();
    expect(r).toEqual({ kind: 'kept-raw', reason: 'timeout' });
  });
  it('keeps raw on provider error, network failure and malformed JSON', async () => {
    expect(await req(raw, async () => new Response('{}', { status: 502 })).run()).toEqual({
      kind: 'kept-raw',
      reason: 'provider-error',
    });
    expect(await req(raw, async () => Promise.reject(new TypeError('offline'))).run()).toEqual({
      kind: 'kept-raw',
      reason: 'unavailable',
    });
    expect(await req(raw, async () => new Response('not json', { status: 200 })).run()).toEqual({
      kind: 'kept-raw',
      reason: 'malformed',
    });
  });
  it('keeps raw when the schema is violated (strict: extra fields, missing fields)', async () => {
    const extra = new Response(
      JSON.stringify({
        result: {
          corrected_text: 'Yes, keep the sidebar.',
          uncertain_spans: [],
          applied_commands: [],
          warnings: [],
          approve: true,
        },
      }),
    );
    expect(await req(raw, async () => extra).run()).toEqual({
      kind: 'kept-raw',
      reason: 'malformed',
    });
    const missing = new Response(JSON.stringify({ result: { corrected_text: 'x' } }));
    expect(await req(raw, async () => missing).run()).toEqual({
      kind: 'kept-raw',
      reason: 'malformed',
    });
  });
  it('keeps raw when the editor changed while the request was in flight', async () => {
    const t = req(raw, async () => ok('Yes, keep the sidebar.'));
    t.setEditor(raw + ' and more');
    expect(await t.run()).toEqual({ kind: 'kept-raw', reason: 'editor-changed' });
  });
  it('lands the clean-up as written, with no meaning guard (the person reads it and can go back)', async () => {
    const r = await req('do not delete prod delete dev', async () =>
      ok('Delete prod. Do not delete dev.'),
    ).run();
    expect(r).toMatchObject({ kind: 'applied', changed: true, lowConfidence: false });
    if (r.kind === 'applied')
      expect(r.result.corrected_text).toBe('Delete prod. Do not delete dev.');
    // A dropped negation and a changed number land too: the old guard refused both.
    for (const [said, cleaned] of [
      ["don't ship it", 'Ship it.'],
      ['use port 8080', 'Use port 8081.'],
    ]) {
      const flipped = await req(said!, async () => ok(cleaned!)).run();
      expect(flipped).toMatchObject({ kind: 'applied', changed: true });
      if (flipped.kind === 'applied') expect(flipped.result.corrected_text).toBe(cleaned);
    }
  });
  it('reports an unchanged passage and a low-confidence clean-up', async () => {
    expect(await req(raw, async () => ok(raw)).run()).toMatchObject({
      kind: 'applied',
      changed: false,
    });
    expect(
      await req(raw, async () => ok('Yes, keep the sidebar.', [], ['low-confidence'])).run(),
    ).toMatchObject({ kind: 'applied', changed: true, lowConfidence: true });
  });
  it('sends one request with the consent flag, the passage and the question as context', async () => {
    let sent: Record<string, unknown> = {};
    await req(
      raw,
      async (p, b) => {
        sent = { p, ...(b as object) };
        return ok('Yes, keep the sidebar.');
      },
      {
        context: 'x'.repeat(5000) + ' the sidebar is 64 px wide.',
        options: [{ label: 'Yes', description: 'Ship it' }, { label: 'No' }],
        askedAt: '2026-11-02T10:00:00.000Z',
        projectLabel: 'web-app',
        precedingText: 'About the layout:',
        transcriber: 'xai',
        language: 'en',
      },
    ).run();
    expect(sent).toMatchObject({
      p: '/voice/correct',
      consent: true,
      provider: 'anthropic',
      raw_transcript: raw,
      question: 'Use the compact sidebar?',
      options: [{ label: 'Yes', description: 'Ship it' }, { label: 'No' }],
      asked_at: '2026-11-02T10:00:00.000Z',
      project_label: 'web-app',
      preceding_text: 'About the layout:',
      transcriber: 'xai',
      language: 'en',
    });
    // Only the newest part of a long context leaves the phone; the clean-up keeps no more than that.
    expect((sent.context as string).length).toBe(3000);
    expect(sent.context).toMatch(/64 px wide\.$/);
    expect(sent).not.toHaveProperty('keyterms');
  });
});

describe('span offsets are UTF-16 code units', () => {
  const rocket = String.fromCodePoint(0x1f680);
  const text = `ship ${rocket} now please`;
  it('keeps spans that align with code points and drops ones that split a surrogate pair', () => {
    const start = text.indexOf('now');
    expect(start).toBe(8); // the emoji occupies two code units
    const good: Span = { start, end: start + 3, raw: 'no', candidate: 'know', reason: '' };
    const splitsPair: Span = { start: 6, end: 9, raw: '', candidate: '', reason: '' }; // starts on the low surrogate
    const endsMid: Span = { start: 0, end: 6, raw: '', candidate: '', reason: '' }; // ends after the high surrogate
    const outOfRange: Span = { start: 2, end: 999, raw: '', candidate: '', reason: '' };
    const empty: Span = { start: 3, end: 3, raw: '', candidate: '', reason: '' };
    expect(validSpans(text, [good, splitsPair, endsMid, outOfRange, empty])).toEqual([good]);
  });
  it('drops overlapping spans, keeping the first', () => {
    const a: Span = { start: 0, end: 4, raw: '', candidate: '', reason: '' };
    const b: Span = { start: 2, end: 6, raw: '', candidate: '', reason: '' };
    const c: Span = { start: 6, end: 8, raw: '', candidate: '', reason: '' };
    expect(validSpans('abcdefghij', [b, a, c])).toEqual([a, c]);
  });
  it('resolving a span shifts the ones after it', () => {
    const t = 'use foo and bar now';
    const spans: Span[] = [
      { start: 4, end: 7, raw: 'fu', candidate: 'phew', reason: '' },
      { start: 12, end: 15, raw: 'bar', candidate: 'baz', reason: '' },
    ];
    const r = resolveSpan(t, spans, 0, 'candidate');
    expect(r.text).toBe('use phew and bar now');
    expect(r.spans).toEqual([{ start: 13, end: 16, raw: 'bar', candidate: 'baz', reason: '' }]);
    expect(r.text.slice(r.spans[0]!.start, r.spans[0]!.end)).toBe('bar');
    expect(resolveSpan(t, spans, 0, 'raw').text).toBe('use fu and bar now');
    expect(resolveSpan(t, spans, 0, 'corrected').text).toBe(t);
    expect(resolveSpan(t, spans, 9, 'raw')).toEqual({ text: t, spans });
  });
});

describe('dictation region replacement', () => {
  it('replaces only an intact region', () => {
    const region = { start: 6, end: 6 + 'yes keep it'.length, raw: 'yes keep it' };
    const editor = 'Note: yes keep it';
    expect(applyToRegion(editor, region, 'Yes, keep it.')?.text).toBe('Note: Yes, keep it.');
    expect(applyToRegion('Note: yes kept it', region, 'Yes, keep it.')).toBeNull();
  });
});

describe('keyterms', () => {
  it('collects option labels and distinctive question words within limits', () => {
    const t = buildKeyterms(
      'Should the SidebarNav use useEffect, or the plain compact layout for daintree.org?',
      ['Yes', 'No thanks'],
      ['x'.repeat(80)],
    );
    expect(t).toContain('Yes');
    expect(t).toContain('SidebarNav');
    expect(t).toContain('useEffect');
    expect(t.every((k) => k.length <= 50)).toBe(true);
    expect(t.length).toBeLessThanOrEqual(100);
  });
});

describe('preceding text', () => {
  it('is the answer before the passage, bounded, without the trailing space', () => {
    expect(precedingText('About the layout: ', 18)).toBe('About the layout:');
    expect(precedingText('', 0)).toBe('');
    expect(precedingText('   ', 3)).toBe('');
  });
  it('keeps a trailing newline and drops a word the bound cut through', () => {
    expect(precedingText('First line\n', 11)).toBe('First line\n');
    const long = 'abc ' + 'w'.repeat(10) + ' ' + 'y '.repeat(250);
    const got = precedingText(long, long.length);
    expect(got.length).toBeLessThanOrEqual(500);
    expect(got.startsWith('w')).toBe(false);
  });
});

describe('dictation language', () => {
  it('is English for an English phone and left to the provider otherwise', () => {
    expect(dictationLanguage('en-GB')).toBe('en');
    expect(dictationLanguage('EN')).toBe('en');
    expect(dictationLanguage('de-DE')).toBeUndefined();
    expect(dictationLanguage('')).toBeUndefined();
  });
});

describe('the deadline is real', () => {
  const raw = 'yes keep the sidebar';
  it('aborts the request itself when time runs out', async () => {
    let aborted = false;
    const r = await req(
      raw,
      (_p, _b, signal) =>
        new Promise((_res, rej) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            rej(new Error('aborted'));
          }),
        ),
    ).run();
    expect(r).toEqual({ kind: 'kept-raw', reason: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('does not hang and discards a late result even if the transport ignores the abort signal', async () => {
    const t0 = Date.now();
    const r = await req(
      raw,
      () => new Promise((res) => setTimeout(() => res(ok('Yes, keep the sidebar.')), 300)),
    ).run();
    expect(r).toEqual({ kind: 'kept-raw', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it('discards a response whose body arrives after the deadline', async () => {
    const slowBody = {
      ok: true,
      json: () =>
        new Promise((res) =>
          setTimeout(
            () =>
              res({
                model: 'm',
                result: {
                  corrected_text: 'Yes, keep the sidebar.',
                  uncertain_spans: [],
                  applied_commands: [],
                  warnings: [],
                },
              }),
            300,
          ),
        ),
    } as unknown as Response;
    const r = await req(raw, async () => slowBody).run();
    expect(r).toEqual({ kind: 'kept-raw', reason: 'timeout' });
  });
});
