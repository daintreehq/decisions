import { describe, expect, it } from 'vitest';
import { LIMITS, type DecisionContentV1 } from '@daintreehq/decisions-protocol';
import { composeShape, verdict, type ComposeInput } from '../src/domain/compose.js';

const content = (over: Partial<DecisionContentV1> = {}): DecisionContentV1 => ({
  content_version: 1,
  question: 'Ship it?',
  kind: 'text',
  options: [],
  attachments: [],
  allow_text: true,
  ...over,
});
const OPTIONS = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
];

function input(over: Partial<ComposeInput> & { c?: DecisionContentV1 } = {}): ComposeInput {
  const { c = content(), ...rest } = over;
  const mode = rest.mode ?? 'answer';
  return {
    shape: composeShape(c, mode),
    mode,
    selected: [],
    text: '',
    reason: '',
    attachments: c.attachments.length,
    evidence: { total: 0, loaded: 0, expired: 0, failed: 0 },
    stale: false,
    capturing: false,
    ...rest,
  };
}

describe('send labels and fields', () => {
  it('names Send for what it does', () => {
    expect(composeShape(content(), 'answer').sendLabel).toBe('Send answer');
    expect(composeShape(content({ kind: 'approval', options: OPTIONS }), 'answer').sendLabel).toBe(
      'Send decision',
    );
    expect(composeShape(content(), 'correction').sendLabel).toBe('Send correction');
  });

  it('a correction to a choice is the choice plus a reason; to text, the text plus a reason', () => {
    expect(
      composeShape(content({ kind: 'choice', options: OPTIONS }), 'correction').fields,
    ).toEqual(['reason']);
    expect(composeShape(content(), 'correction').fields).toEqual(['text', 'reason']);
    expect(
      composeShape(content({ kind: 'choice', options: OPTIONS, allow_text: false }), 'answer')
        .fields,
    ).toEqual([]);
  });
});

describe('byte-accurate limits', () => {
  it('measures answer text in UTF-8 bytes, not characters, and keeps over-limit text', () => {
    const emoji = '😀'; // 4 bytes, 2 UTF-16 units, 1 character
    const fits = emoji.repeat(LIMITS.answerTextBytes / 4);
    expect(verdict(input({ text: fits })).canSend).toBe(true);
    const over = fits + 'é'; // 2 more bytes
    const v = verdict(input({ text: over }));
    expect(v.canSend).toBe(false);
    expect(v.textOver).toBe(2);
    expect(v.textBytes).toBe(LIMITS.answerTextBytes + 2);
    expect(v.hint).toBe('Shorten your answer by 2 bytes');
  });

  it('limits the correction reason to 2,000 characters', () => {
    const c = content({ kind: 'choice', options: OPTIONS });
    const base = {
      c,
      mode: 'correction' as const,
      selected: ['no'],
      current: { selected: ['yes'], text: '' },
    };
    expect(verdict(input({ ...base, reason: 'x'.repeat(2000) })).canSend).toBe(true);
    const v = verdict(input({ ...base, reason: 'x'.repeat(2001) }));
    expect(v.canSend).toBe(false);
    expect(v.reasonOver).toBe(1);
  });
});

describe('what Send needs', () => {
  it('asks for one short reason only when it helps', () => {
    expect(verdict(input()).hint).toBe('Write an answer');
    expect(verdict(input({ c: content({ kind: 'choice', options: OPTIONS }) })).hint).toBe(
      'Choose an option',
    );
    expect(verdict(input({ c: content({ kind: 'mixed', options: OPTIONS }) })).hint).toBe(
      'Choose an option or write an answer',
    );
    expect(verdict(input({ text: 'ok', stale: true })).hint).toBe('Review the updated question');
  });

  it('a mixed question takes text instead of a choice', () => {
    expect(
      verdict(input({ c: content({ kind: 'mixed', options: OPTIONS }), text: 'neither' })).canSend,
    ).toBe(true);
  });

  it('never sends while capture or cleanup has not settled', () => {
    expect(verdict(input({ text: 'ok', capturing: 'capturing' })).canSend).toBe(false);
    expect(verdict(input({ text: 'ok', capturing: 'cleaning' })).canSend).toBe(false);
    expect(verdict(input({ text: 'ok' })).canSend).toBe(true);
  });

  it('a correction needs a changed answer and a reason', () => {
    const c = content({ kind: 'choice', options: OPTIONS });
    const base = { c, mode: 'correction' as const, current: { selected: ['yes'], text: '' } };
    expect(verdict(input({ ...base, selected: ['yes'], reason: 'why' })).hint).toBe(
      'Change the answer to send a correction',
    );
    expect(verdict(input({ ...base, selected: ['no'] })).hint).toBe('Add a reason for the change');
    expect(verdict(input({ ...base, selected: ['no'], reason: 'why' })).canSend).toBe(true);
  });
});

describe('evidence for approvals', () => {
  const c = content({
    kind: 'approval',
    options: OPTIONS,
    attachments: [{} as never, {} as never],
  });

  it('waits until every file is presented, and says how many remain', () => {
    const v = verdict(
      input({
        c,
        selected: ['yes'],
        evidence: { total: 2, loaded: 2, presented: 1, expired: 0, failed: 0 },
      }),
    );
    expect(v.canSend).toBe(false);
    expect(v.remainingFiles).toBe(1);
    expect(v.hint).toBe('Review the remaining file');
    expect(
      verdict(
        input({
          c,
          selected: ['yes'],
          evidence: { total: 2, loaded: 2, presented: 2, expired: 0, failed: 0 },
        }),
      ).canSend,
    ).toBe(true);
  });

  it('prefetch alone does not unblock once presentation is tracked; the older gallery falls back to loaded', () => {
    const prefetched = { total: 2, loaded: 2, presented: 0, expired: 0, failed: 0 };
    expect(verdict(input({ c, selected: ['yes'], evidence: prefetched })).canSend).toBe(false);
    const legacy = { total: 2, loaded: 2, expired: 0, failed: 0 };
    expect(verdict(input({ c, selected: ['yes'], evidence: legacy })).canSend).toBe(true);
  });

  it('an approval with no files reported yet is not approvable', () => {
    expect(verdict(input({ c, selected: ['yes'] })).canSend).toBe(false);
  });
});
