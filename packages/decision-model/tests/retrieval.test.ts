import { describe, expect, it } from 'vitest';
import { MemoryHistoryStore } from '../src/history.js';
import { answerKey, retrieve } from '../src/retrieval.js';
import { stem, tokenize } from '../src/text.js';
import { OPTIONS, day, ex, input } from './helpers.js';

const NOW = new Date(day(120));

function store(...items: ReturnType<typeof ex>[]): MemoryHistoryStore {
  const s = new MemoryHistoryStore({ learningEnabled: true });
  for (const i of items) expect(s.record(i).recorded).toBe(true);
  return s;
}

describe('tokenizer', () => {
  it('drops stopwords, stems lightly and is deterministic', () => {
    expect(tokenize('The sidebars are being resized quickly!')).toEqual([
      'sidebar',
      'resiz',
      'quick',
    ]);
    expect(stem('policies')).toBe('policy');
    expect(tokenize('')).toEqual([]);
  });
});

describe('retrieve', () => {
  it('ranks lexically relevant decisions above unrelated ones', () => {
    const s = store(
      ex('terminal', {
        question: 'Terminal scrollback length for long builds',
        options: [
          { id: 'a', label: 'Short' },
          { id: 'b', label: 'Long' },
        ],
        selected_option_ids: ['b'],
      }),
      ex('sidebar1', { question: 'Sidebar density for the settings panel', chosen_at: day(10) }),
      ex('sidebar2', { question: 'Sidebar density in the file tree panel', chosen_at: day(11) }),
    );
    const r = retrieve(s, input(), { now: NOW });
    expect(r.referenceIds[0]).toMatch(/^sidebar/);
    expect(r.referenceIds).not.toContain('terminal');
    expect(r.examples[0]!.relevance).toBe(1);
  });

  it('returns nothing when there is no lexical overlap', () => {
    const s = store(
      ex('x', {
        question: 'Postgres connection pool sizing',
        options: [
          { id: 'a', label: 'Ten' },
          { id: 'b', label: 'Fifty' },
        ],
        selected_option_ids: ['a'],
      }),
    );
    expect(retrieve(s, input(), { now: NOW }).examples).toEqual([]);
  });

  it('prefers more recent decisions when relevance is equal', () => {
    const s = store(
      ex('old', { question: 'Sidebar density for the settings panel', chosen_at: day(1) }),
      ex('new', { question: 'Sidebar density for the settings panel', chosen_at: day(110) }),
    );
    const r = retrieve(s, input(), { now: NOW });
    expect(r.referenceIds).toEqual(['new', 'old']);
    expect(r.examples[0]!.recency).toBeGreaterThan(r.examples[1]!.recency);
  });

  it('boosts decisions from the same project', () => {
    const q = 'Sidebar density for the settings panel';
    const s = store(
      ex('other', { question: q, project_tags: ['web'], chosen_at: day(50) }),
      ex('same', { question: q, project_tags: ['daintree'], chosen_at: day(50) }),
    );
    const r = retrieve(s, input({ project_tags: ['daintree'] }), { now: NOW });
    expect(r.referenceIds[0]).toBe('same');
    expect(r.examples[0]!.tagOverlap).toBe(1);
  });

  it('boosts examples whose option structure matches', () => {
    const q = 'Panel layout for the settings dialog';
    const s = store(
      ex('same-opts', { question: q, chosen_at: day(50) }),
      ex('diff-opts', {
        question: q,
        options: [
          { id: 'x', label: 'Wide' },
          { id: 'y', label: 'Narrow' },
        ],
        selected_option_ids: ['x'],
        chosen_at: day(50),
      }),
    );
    const r = retrieve(s, input({ question: 'Panel layout for the new settings dialog' }), {
      now: NOW,
    });
    expect(r.referenceIds[0]).toBe('same-opts');
    expect(r.examples[0]!.optionSimilarity).toBe(1);
  });

  it('flags contradictions and pulls dissenters in past the limit', () => {
    const items = [];
    for (let i = 0; i < 10; i++)
      items.push(
        ex(`agree${i}`, {
          question: `Sidebar density for the settings panel variant ${i}`,
          chosen_at: day(100 + i),
        }),
      );
    items.push(
      ex('dissent1', {
        question: 'Sidebar density for the settings panel older',
        selected_option_ids: ['comfortable'],
        chosen_at: day(2),
      }),
    );
    items.push(
      ex('dissent2', {
        question: 'Sidebar density for the settings panel oldest',
        selected_option_ids: ['comfortable'],
        chosen_at: day(1),
      }),
    );
    const s = store(...items);
    const r = retrieve(s, input(), { now: NOW, limit: 5 });
    expect(r.referenceIds).toEqual(expect.arrayContaining(['dissent1']));
    expect(r.examples.length).toBeLessThanOrEqual(12);
    expect(r.contradictory).toBe(true);
    expect(r.contradictions.length).toBeGreaterThan(0);
    expect(r.examples.some((e) => e.contradiction)).toBe(true);
  });

  it('is not contradictory when decisions agree, or when options differ', () => {
    const agree = store(
      ...[1, 2, 3].map((i) =>
        ex(`a${i}`, { question: `Sidebar density panel ${i}`, chosen_at: day(i) }),
      ),
    );
    expect(retrieve(agree, input(), { now: NOW }).contradictory).toBe(false);
    const unrelatedOptions = store(
      ex('p', { question: 'Sidebar density panel', chosen_at: day(1) }),
      ex('q', {
        question: 'Sidebar density panel',
        options: [
          { id: 'dark', label: 'Dark' },
          { id: 'light', label: 'Light' },
        ],
        selected_option_ids: ['light'],
        chosen_at: day(2),
      }),
    );
    expect(retrieve(unrelatedOptions, input(), { now: NOW }).contradictory).toBe(false);
  });

  it('clamps the limit to 12 and never returns the question itself', () => {
    const s = new MemoryHistoryStore({ learningEnabled: true });
    for (let i = 0; i < 30; i++)
      s.record(ex(`m${i}`, { question: `Sidebar density panel ${i}`, chosen_at: day(i) }));
    s.record(ex('q-new', { question: 'Sidebar density panel itself' }));
    const r = retrieve(s, input(), { now: NOW, limit: 99 });
    expect(r.examples).toHaveLength(12);
    expect(r.referenceIds).not.toContain('q-new');
  });

  it('answerKey normalises selected labels', () => {
    expect(answerKey(ex('a', { selected_option_ids: ['compact'] }))).toBe('compact');
    expect(answerKey(ex('a', { selected_option_ids: [] }))).toBeNull();
    expect(OPTIONS).toHaveLength(2);
  });
});
