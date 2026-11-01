import { describe, expect, it } from 'vitest';
import {
  applyToRegion,
  classifyChange,
  buildKeyterms,
  detectDrift,
  polarityCounts,
  resolveSpan,
  runCorrection,
  validSpans,
  type Span,
} from '../src/features/voice/correction.js';

const ok = (corrected: string, spans: unknown[] = []) =>
  new Response(
    JSON.stringify({
      model: 'claude-test',
      result: {
        corrected_text: corrected,
        uncertain_spans: spans,
        applied_commands: [],
        warnings: [],
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
        optionLabels: ['Yes', 'No'],
        keyterms: ['sidebar'],
        editorAtStart: raw,
        getEditorText: () => editor,
        timeoutMs: 50,
        ...over,
      }),
  };
}

describe('drift guard', () => {
  it('passes a faithful clean-up', () => {
    expect(
      detectDrift(
        'the modal should be smaller but keep the keyboard shortcuts',
        'The modal should be smaller, but keep the keyboard shortcuts.',
        [],
      ),
    ).toBeNull();
  });
  it.each([
    ['yes do it', 'No, do it.', /yes|no/],
    ['approve this change', 'Reject this change.', /approve|reject/],
    ['do not merge it', 'Do merge it.', /not/],
    ["don't merge it", 'Do not merge it.', null], // same polarity, different spelling: allowed
    ['we can ship', "we can't ship", /not/],
    ['go ahead without tests', 'Go ahead with tests.', /without/],
  ])('polarity: %s → %s', (raw, fixed, expected) => {
    const r = detectDrift(raw, fixed, []);
    if (expected === null) expect(r).toBeNull();
    else expect(r).toMatch(expected);
  });
  it('rejects absurd length changes in both directions', () => {
    expect(
      detectDrift('use the sidebar please', 'Use the sidebar please. '.repeat(10), []),
    ).toMatch(/length/);
    expect(detectDrift('use the sidebar for navigation always', 'Use.', [])).toMatch(/length/);
    expect(detectDrift('', 'anything', [])).toMatch(/nothing/);
  });
  it('rejects new numbers and identifiers unless they were said or are keyterms', () => {
    expect(detectDrift('set the width to something wide', 'Set the width to 480px.', [])).toMatch(
      /480px/,
    );
    expect(
      detectDrift('call the helper in utils', 'Call the helper in utils/format.ts.', []),
    ).toMatch(/format/);
    expect(detectDrift('use effect for this', 'Use useEffect for this.', [])).toMatch(/useEffect/);
    expect(detectDrift('use effect for this', 'Use useEffect for this.', ['useEffect'])).toBeNull();
    expect(detectDrift('width of 480 pixels', 'Width of 480 pixels.', [])).toBeNull();
  });
  it('counts polarity words consistently', () => {
    expect(polarityCounts("Don't, never, no. NOT!")).toEqual({ not: 2, never: 1, no: 1 });
  });
});

describe('runCorrection keeps the raw text unless everything checks out', () => {
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
  it('keeps raw when the model flips a decision', async () => {
    const r = await req(raw, async () => ok('No, keep the sidebar.')).run();
    expect(r).toMatchObject({ kind: 'kept-raw', reason: 'drift' });
  });
  it('sends one request with the consent flag and the dictated passage', async () => {
    let sent: Record<string, unknown> = {};
    await req(raw, async (p, b) => {
      sent = { p, ...(b as object) };
      return ok('Yes, keep the sidebar.');
    }).run();
    expect(sent).toMatchObject({
      p: '/voice/correct',
      consent: true,
      provider: 'anthropic',
      raw_transcript: raw,
      option_labels: ['Yes', 'No'],
    });
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

describe('conservative auto-apply', () => {
  const auto = (raw: string, fixed: string) => classifyChange(raw, fixed);

  it('auto-applies formatting-only clean-ups that keep order and negation', () => {
    expect(auto('yes keep the sidebar', 'Yes, keep the sidebar.').auto).toBe(true);
    expect(auto('do not delete prod', "Don't delete prod.").auto).toBe(true);
    expect(
      auto(
        'the modal should be smaller but keep the keyboard shortcuts',
        'The modal should be smaller, but keep the keyboard shortcuts.',
      ).auto,
    ).toBe(true);
  });

  it('requires explicit acceptance when a negation moves to another clause (the reviewed attack)', () => {
    const raw = 'Do not delete prod. Delete dev.';
    const fixed = 'Delete prod. Do not delete dev.';
    expect(detectDrift(raw, fixed, [])).toBeNull(); // the older guards alone let this through
    const c = auto(raw, fixed);
    expect(c.auto).toBe(false);
    expect(c.reason).toMatch(/around "not"/);
  });

  it('requires acceptance for reordering without any negation', () => {
    expect(
      auto('ship the api then the web app today', 'Ship the web app today, then the api.').auto,
    ).toBe(false);
  });

  it('requires acceptance when a negation is added, dropped or swapped', () => {
    expect(auto('merge it', 'Do not merge it.').auto).toBe(false);
    expect(auto('do not merge it', 'Merge it.').auto).toBe(false);
    expect(auto('approve this', 'Reject this.').auto).toBe(false);
  });

  it('requires acceptance when words next to a negation change', () => {
    expect(auto('do not merge the branch now', 'Do not rebase the branch now.').auto).toBe(false);
  });

  it('refuses to auto-apply very long passages instead of guessing', () => {
    const long = 'word '.repeat(2500);
    expect(auto(long, long).auto).toBe(false);
  });

  it('runCorrection reports the moved-negation case as a suggestion, not an auto-apply', async () => {
    const raw = 'Do not delete prod. Delete dev.';
    const r = await req(raw, async () => ok('Delete prod. Do not delete dev.'), {
      keyterms: [],
    }).run();
    expect(r).toMatchObject({ kind: 'applied', autoApply: false });
    const good = await req('yes keep the sidebar', async () => ok('Yes, keep the sidebar.')).run();
    expect(good).toMatchObject({ kind: 'applied', autoApply: true });
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
