import { describe, expect, it } from 'vitest';
import type { ActionView, QuestionView } from '../src/domain/model.js';
import {
  answerSummary,
  dayLabel,
  dueLabel,
  filterOptions,
  groupByDay,
  historyEntries,
  homeSections,
  principalStatus,
  searchQuestion,
  stableOrder,
  type ListQuery,
} from '../src/domain/lists.js';

const NOW = Date.parse('2026-11-03T15:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
function q(
  id: string,
  over: Partial<QuestionView> & { project?: string; machine?: string; text?: string } = {},
): QuestionView {
  const { project = 'daintree', machine = 'MacBook', text = `Question ${id}?`, ...rest } = over;
  seq++;
  return {
    id,
    status: 'open',
    revision: 0,
    requirement: 'human-required',
    targetHostId: 'h',
    originatingDeviceId: 'd',
    createdAt: iso(NOW - 2 * H),
    expiresAt: null,
    proxyAbstained: false,
    createdSeq: seq,
    lastSeq: seq,
    lastEventAt: iso(NOW - 2 * H),
    verification: { ok: true },
    content: {
      content_version: 1,
      question: text,
      kind: 'choice',
      options: [
        { id: 'a', label: 'Keep Canopy' },
        { id: 'b', label: 'Yes, rename' },
      ],
      attachments: [],
      allow_text: true,
      project_label: project,
      machine_label: machine,
    },
    actions: [],
    deliveries: {},
    attachmentsAvailable: {},
    integrityIssues: [],
    ...rest,
  };
}

function act(
  action: ActionView['action'],
  at: number,
  content: Partial<NonNullable<ActionView['content']>> = {},
  s = ++seq,
): ActionView {
  return {
    actionId: `act-${s}`,
    action,
    provenance: action === 'proxy-answer' ? 'proxy' : 'human',
    revision: s,
    createdAt: iso(at),
    seq: s,
    signerDeviceId: 'phone',
    signerRole: 'phone',
    content: {
      content_version: 1,
      selected_option_ids: [],
      reviewed_attachment_digests: [],
      ...content,
    } as ActionView['content'],
    verified: true,
  };
}

const base: ListQuery = { sort: 'due', query: '', project: null, computer: null };
const ids = (list: { id: string }[]) => list.map((v) => v.id);
const needs = (list: QuestionView[], q: ListQuery = base) =>
  ids(homeSections(list, q, NOW).find((s) => s.key === 'needs')!.items);
const every = (list: QuestionView[], q: ListQuery = base) =>
  homeSections(list, q, NOW).flatMap((s) => ids(s.items));

describe('Home sections, sorting and filtering', () => {
  it('orders Needs you by soonest deadline (inside a day), then oldest; newest first on request', () => {
    const old = q('old', { createdAt: iso(NOW - 10 * H) });
    const young = q('young', { createdAt: iso(NOW - 1 * H) });
    const dueLater = q('due-later', { createdAt: iso(NOW - 3 * H), expiresAt: iso(NOW + 5 * H) });
    const dueSoon = q('due-soon', { createdAt: iso(NOW - 0.5 * H), expiresAt: iso(NOW + 1 * H) });
    const farDue = q('far-due', { createdAt: iso(NOW - 4 * H), expiresAt: iso(NOW + 72 * H) });
    const list = [old, young, dueLater, dueSoon, farDue];
    expect(needs(list)).toEqual(['due-soon', 'due-later', 'old', 'far-due', 'young']);
    expect(needs(list, { ...base, sort: 'newest' })).toEqual([
      'due-soon',
      'young',
      'due-later',
      'far-due',
      'old',
    ]);
  });

  it('leads Needs you with answers whose delivery needs attention, and moves answers still sending out', () => {
    const open = q('open');
    const stuck = q('stuck', {
      status: 'human-answered',
      actions: [act('answer', NOW - H, { selected_option_ids: ['a'] }, 900)],
      deliveries: { 900: { status: 'needs-attention' } },
    });
    const sections = homeSections([open, stuck], base, NOW);
    expect(sections.map((s) => [s.title, ids(s.items)])).toEqual([
      ['Needs you', ['stuck', 'open']],
    ]);
    // An answer from this device still in its outbox is the person's, not owed: it leaves Needs you.
    const sending = homeSections([open, stuck], { ...base, pending: new Set(['open']) }, NOW);
    expect(sending.map((s) => [s.kind, ids(s.items)])).toEqual([
      ['needs', ['stuck']],
      ['sending', ['open']],
    ]);
    expect(principalStatus(stuck, NOW)).toBe('delivery');
  });

  it('lists model answers to review, then everything else by recent activity, grouped by day', () => {
    // Days are local, so the times are too.
    const now = new Date(2026, 10, 3, 15, 0).getTime();
    const at = (d: number, h: number) => new Date(2026, 10, d, h, 0).getTime();
    const answered = (id: string, lastSeq: number, t: number) =>
      q(id, {
        status: 'human-answered',
        lastSeq,
        lastEventAt: iso(t),
        actions: [act('answer', t, { selected_option_ids: ['a'] })],
      });
    const a = answered('a', 5, at(2, 10));
    const b = answered('b', 9, at(3, 14));
    const model = q('m', {
      status: 'proxy-answered',
      lastSeq: 7,
      actions: [act('proxy-answer', NOW - H, { selected_option_ids: ['a'] })],
    });
    const confirmed = q('c', {
      status: 'proxy-answered',
      lastSeq: 8,
      lastEventAt: iso(at(3, 12)),
      actions: [
        act('proxy-answer', NOW - 2 * H, { selected_option_ids: ['a'] }),
        act('confirm-proxy', NOW - H),
      ],
    });
    const open = q('open');
    const list = [a, b, model, confirmed, open];
    const sections = homeSections(list, base, now, 'en-GB');
    expect(sections.map((s) => [s.kind, ids(s.items)])).toEqual([
      ['needs', ['open']],
      ['review', ['m']],
      ['day', ['b', 'c']],
      ['day', ['a']],
    ]);
    expect(sections[2]!.title).toBe('Today');
    expect(sections[3]!.title).toBe('Yesterday');
    // Needs you keeps its place when nothing needs you; the other sections appear only when they hold something.
    expect(homeSections([a], base, now).map((s) => [s.kind, s.items.length])).toEqual([
      ['needs', 0],
      ['day', 1],
    ]);
    expect(principalStatus(model, now)).toBe('review');
    expect(principalStatus(confirmed, now)).toBe('answered');
    expect(answerSummary(confirmed)).toMatchObject({ author: 'Model', confirmed: true });
  });

  it('filters by project and computer separately, and searches every section', () => {
    const list = [
      q('1', { project: 'billing-api', machine: 'MacBook' }),
      q('2', { project: 'billing-api', machine: 'Studio' }),
      q('3', { project: 'daintree', machine: 'Studio', text: 'Rename the sidebar?' }),
    ];
    expect(filterOptions(list)).toEqual({
      projects: ['billing-api', 'daintree'],
      computers: ['MacBook', 'Studio'],
    });
    const studio = { ...base, computer: 'Studio' };
    expect(every(list, studio).sort()).toEqual(['2', '3']);
    const both = { ...base, project: 'billing-api', computer: 'Studio' };
    expect(every(list, both)).toEqual(['2']);
    expect(every(list, { ...base, query: 'sidebar' })).toEqual(['3']);
  });

  it('shows a due time only for answerable questions, in the warning hue inside a day', () => {
    expect(dueLabel(q('a', { expiresAt: iso(NOW + 2 * H + 60_000) }), NOW)).toEqual({
      label: 'Due in 2 h',
      urgent: true,
    });
    expect(dueLabel(q('b', { expiresAt: iso(NOW + 12 * 60_000) }), NOW)?.label).toBe(
      'Due in 12 min',
    );
    expect(dueLabel(q('c', { expiresAt: iso(NOW + 72 * H) }), NOW)).toEqual({
      label: 'Due in 3 d',
      urgent: false,
    });
    expect(dueLabel(q('d', { status: 'human-answered', expiresAt: iso(NOW + H) }), NOW)).toBeNull();
  });
});

describe('search over everything said', () => {
  const corrected = () =>
    q('r', {
      status: 'human-answered',
      text: 'Rename “Canopy” to “Inbox” in the sidebar?',
      actions: [
        act('answer', NOW - 3 * H, { selected_option_ids: ['b'], text: 'ship the new name' }),
        act('override', NOW - 2 * H, {
          selected_option_ids: ['a'],
          reason: 'Canopy is the brand name; keep it.',
        }),
        act('override', NOW - H, { selected_option_ids: ['a'], text: 'final: brand stays' }),
      ],
    });

  it('matches the question, context, origin and option labels as current', () => {
    const v = q('x', { project: 'billing-api', text: 'Which retry strategy?' });
    v.content!.context = 'Failures are mostly 502s';
    expect(searchQuestion(v, 'retry')).toBe('current');
    expect(searchQuestion(v, '502S')).toBe('current');
    expect(searchQuestion(v, 'billing')).toBe('current');
    expect(searchQuestion(v, 'canopy')).toBe('current'); // an option label
    expect(searchQuestion(v, 'nothing like this')).toBeNull();
  });

  it('labels hits that need an earlier answer or a correction reason', () => {
    const v = corrected();
    expect(searchQuestion(v, 'brand stays')).toBe('current');
    expect(searchQuestion(v, 'ship the new name')).toBe('earlier');
    expect(searchQuestion(v, 'keep it')).toBe('earlier'); // an earlier correction's reason
    // Terms may be split across what is current and what came before.
    expect(searchQuestion(v, 'sidebar ship')).toBe('earlier');
    expect(searchQuestion(v, 'sidebar zebra')).toBeNull();
  });

  it('ignores case and accents', () => {
    const v = q('a', { text: 'Publier le café?' });
    expect(searchQuestion(v, 'CAFE')).toBe('current');
  });

  it('History marks earlier-answer hits and counts corrections', () => {
    const [e] = historyEntries([corrected()], 'decisions', 'ship the new name', NOW);
    expect(e).toMatchObject({ hit: 'earlier', changes: 2, status: 'answered' });
    expect(e!.answer).toMatchObject({ author: 'You', text: 'Keep Canopy — final: brand stays' });
  });
});

describe('History', () => {
  it('keeps Decisions to settled outcomes and adds model answers under review in All activity', () => {
    const human = q('h', { status: 'human-answered', actions: [act('answer', NOW - H)] });
    const review = q('m', {
      status: 'proxy-answered',
      actions: [act('proxy-answer', NOW - 2 * H)],
    });
    const withdrawn = q('w', { status: 'cancelled', actions: [act('cancel', NOW - 3 * H)] });
    const expired = q('e', { expiresAt: iso(NOW - 4 * H) });
    const open = q('o');
    const list = [human, review, withdrawn, expired, open];
    expect(ids(historyEntries(list, 'decisions', '', NOW).map((e) => e.v))).toEqual([
      'h',
      'w',
      'e',
    ]);
    expect(ids(historyEntries(list, 'all', '', NOW).map((e) => e.v))).toEqual(['h', 'm', 'w', 'e']);
    const [, , , exp] = historyEntries(list, 'all', '', NOW);
    expect(exp).toMatchObject({ status: 'expired', at: iso(NOW - 4 * H) });
  });

  it('groups by Today, Yesterday, then dates, in local time', () => {
    const now = new Date(2026, 10, 3, 15, 0).getTime();
    const at = (d: number, h: number) => new Date(2026, 10, d, h, 0).toISOString();
    const oct = new Date(2026, 9, 27, 12, 0).toISOString();
    const items = [at(3, 9), at(3, 1), at(2, 23), at(2, 8), oct];
    const groups = groupByDay(items, (x) => x, now, 'en-GB');
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 2],
      ['Tue 27 Oct', 1],
    ]);
    expect(dayLabel(new Date(2025, 0, 5, 12).toISOString(), now, 'en-GB')).toMatch(
      /^Sun,? 5 Jan 2025$/,
    );
  });
});

describe('stable ordering when questions arrive', () => {
  it('keeps the order on screen, drops rows that left, and holds newcomers back', () => {
    expect(stableOrder(null, ['a', 'b'])).toEqual({ ids: ['a', 'b'], added: [] });
    // A new urgent question sorts first, and "b" was answered elsewhere: nothing moves under the finger.
    expect(stableOrder(['a', 'b', 'c'], ['new', 'c', 'a'])).toEqual({
      ids: ['a', 'c'],
      added: ['new'],
    });
    // Re-sorting alone never reorders what is shown.
    expect(stableOrder(['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual({
      ids: ['a', 'b', 'c'],
      added: [],
    });
  });
});
