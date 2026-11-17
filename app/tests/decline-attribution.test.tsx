// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionView, QuestionView } from '../src/domain/model.js';
import { historyEntries } from '../src/domain/lists.js';
import { ActivityTimeline } from '../src/components/history/ActivityTimeline.js';
import { QuestionRow } from '../src/components/navigator/QuestionRow.js';
import { CancelLine } from '../src/components/workspace/Thread.js';
import { HistoryRow } from '../src/routes/History.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-17T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A verified cancel: the owner desktop's by default, `decline: true` making it the person's decline there. */
const cancel = (over: Partial<ActionView> = {}): ActionView => ({
  actionId: 'act-1',
  action: 'cancel',
  provenance: null,
  revision: 0,
  createdAt: iso(NOW - 60_000),
  seq: 2,
  signerDeviceId: 'desktop',
  signerRole: 'owner-desktop',
  signerLabel: 'Studio Mac',
  content: null,
  verified: true,
  ...over,
});
const computerDecline = (over: Partial<ActionView> = {}) => cancel({ decline: true, ...over });
const phoneDecline = () =>
  cancel({ signerDeviceId: 'phone', signerRole: 'phone', signerLabel: 'phone' });

const view = (a: ActionView, id = 'q1'): QuestionView => ({
  id,
  status: 'cancelled',
  revision: 0,
  requirement: 'human-required',
  targetHostId: 'h',
  originatingDeviceId: 'host',
  createdAt: iso(NOW - 3_600_000),
  expiresAt: null,
  proxyAbstained: false,
  createdSeq: 1,
  lastSeq: a.seq,
  lastEventAt: a.createdAt,
  verification: { ok: true },
  content: {
    content_version: 1,
    question: 'Keep the name?',
    kind: 'choice',
    options: [
      { id: 'a', label: 'Keep Canopy' },
      { id: 'b', label: 'Rename' },
    ],
    attachments: [],
    allow_text: true,
    project_label: 'daintree',
    // The computer that asked: a Remote Host, not the one the person declined on.
    machine_label: 'build-box',
  },
  actions: [a],
  messages: [],
  deliveries: {},
  attachmentsAvailable: {},
  integrityIssues: [],
});

let mounted: { root: Root; host: HTMLElement } | null = null;
afterEach(() => {
  if (mounted) act(() => mounted!.root.unmount());
  mounted?.host.remove();
  mounted = null;
});

function render(el: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(el));
  mounted = { root, host };
  return host;
}

describe("a decline made on the computer, as the person's", () => {
  it('lists it in History with the declined glyph, beside a phone decline and a withdrawal', () => {
    const list = [
      view(phoneDecline(), 'phone'),
      view(computerDecline(), 'computer'),
      view(cancel(), 'withdrawn'),
    ];
    const host = render(
      createElement(
        'ul',
        null,
        historyEntries(list, 'decisions', '', NOW).map((e) =>
          createElement(HistoryRow, {
            key: e.v.id,
            e,
            query: '',
            selected: false,
            onOpen: () => {},
          }),
        ),
      ),
    );
    const rows = [...host.querySelectorAll<HTMLElement>('.hrow')].map((r) => [
      r.dataset.rowId,
      r.dataset.status,
      r.querySelector('.sglyph')!.getAttribute('class'),
      r.querySelector('.qrow-a.closed')!.textContent,
    ]);
    expect(rows).toEqual([
      ['phone', 'declined', 'sglyph declined', 'Declined by you'],
      ['computer', 'declined', 'sglyph declined', 'Declined by you on Studio Mac'],
      ['withdrawn', 'withdrawn', 'sglyph withdrawn', 'Withdrawn on build-box'],
    ]);
  });

  it('lists it on Home with the declined glyph and the computer named', () => {
    const host = render(
      createElement(
        'ul',
        null,
        createElement(QuestionRow, {
          v: view(computerDecline()),
          now: NOW,
          selected: false,
          extras: { pending: undefined },
          onOpen: () => {},
        }),
      ),
    );
    const row = host.querySelector<HTMLElement>('.qrow')!;
    expect(row.dataset.status).toBe('declined');
    expect(row.querySelector('.sglyph.declined .sr-only')!.textContent).toBe('Declined');
    expect(row.querySelector('.qrow-a.closed')!.textContent).toBe('Declined by you on Studio Mac');
    expect(row.textContent).not.toMatch(/withdrawn/i);
  });

  it('says so on its question, in the thread and the activity timeline', () => {
    const a = computerDecline();
    const line = render(createElement(CancelLine, { view: view(a), a, now: NOW }));
    expect(line.querySelector('.sys-text')!.textContent).toBe('Declined by you on Studio Mac');
    expect(line.querySelector('.sys-detail')!.textContent).toBe(
      'You chose not to answer it, so nothing was approved.',
    );
    act(() => mounted!.root.unmount());
    mounted = null;
    const host = render(createElement(ActivityTimeline, { view: view(a), now: NOW }));
    expect(host.querySelector('.summary-closed')!.textContent).toBe(
      'Declined by you on Studio Mac',
    );
    const entry = host.querySelector<HTMLElement>('.tl-item[data-kind="declined"]')!;
    expect(entry.querySelector('.tl-title span')!.textContent).toBe(
      'Declined by you on Studio Mac',
    );
    expect(host.querySelector('.tl-item[data-kind="withdrawn"]')).toBeNull();
    expect(host.textContent).not.toMatch(/withdrawn/i);
  });

  it("keeps the same computer's plain cancel a withdrawal, and an unverified flag nobody's decline", () => {
    for (const a of [cancel(), computerDecline({ verified: false, signerRole: null })]) {
      const host = render(createElement(CancelLine, { view: view(a), a, now: NOW }));
      expect(host.querySelector('.sys-text')!.textContent).toBe('Withdrawn on build-box');
      act(() => mounted!.root.unmount());
      mounted = null;
    }
    const timeline = render(createElement(ActivityTimeline, { view: view(cancel()), now: NOW }));
    expect(timeline.querySelector('.summary-closed')!.textContent).toBe('Withdrawn on build-box');
    expect(timeline.querySelector('.tl-item[data-kind="withdrawn"]')).not.toBeNull();
  });
});
