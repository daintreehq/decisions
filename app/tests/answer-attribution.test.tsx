// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { OutboxEntry } from '../src/data/outbox.js';
import type { ActionView, QuestionView } from '../src/domain/model.js';
import { ActivityTimeline } from '../src/components/history/ActivityTimeline.js';
import { ConflictCard } from '../src/components/workspace/DecisionArea.js';
import { AnswerReceipt } from '../src/components/workspace/DeliveryStatus.js';
import { HumanAnswer } from '../src/components/workspace/Thread.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-17T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const answer = (over: Partial<ActionView> = {}): ActionView => ({
  actionId: 'act-1',
  action: 'answer',
  provenance: 'human-desktop',
  revision: 1,
  createdAt: iso(NOW - 60_000),
  seq: 2,
  signerDeviceId: 'desktop',
  signerRole: 'owner-desktop',
  signerLabel: 'Studio Mac',
  content: {
    content_version: 1,
    selected_option_ids: ['a'],
    text: 'ship it',
    reviewed_attachment_digests: [],
  },
  verified: true,
  imagesOk: true,
  ...over,
});

const view = (a: ActionView): QuestionView => ({
  id: 'q1',
  status: 'human-answered',
  revision: 1,
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
    // The computer that asked: a Remote Host, not the one the person answered on.
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

const texts = (host: HTMLElement, sel: string) =>
  [...host.querySelectorAll(sel)].map((n) => n.textContent ?? '');

describe("an answer made on the computer, as the person's", () => {
  it('names the computer in the thread, and its receipt starts at the relay', () => {
    const a = answer();
    const host = render(
      createElement(HumanAnswer, {
        view: view(a),
        a,
        now: NOW,
        receipt: createElement(AnswerReceipt, {
          a,
          progress: { step: 'confirmed', label: 'Saved on your relay' },
        }),
      }),
    );
    expect(texts(host, '.bubble-label')).toEqual(['Your answer on Studio Mac']);
    // Said in full, the computer's name keeps its capitals.
    expect(host.querySelector('.bubble .sr-only')!.textContent).toBe(
      'You, your answer on Studio Mac: ',
    );
    expect(host.querySelector('[role="status"]')!.textContent).toBe(
      'Your answer on Studio Mac: Saved on your relay',
    );
    expect(host.textContent).not.toMatch(/model/i);
    act(() => host.querySelector<HTMLButtonElement>('.receipt-button')!.click());
    expect(texts(host, '.stepper li')).toEqual([
      'Saved on your relay (done)',
      'Received by your computer (waiting)',
      'Typed into the terminal (not yet)',
    ]);
  });

  it('says a delivery problem is about the answer made on the computer, not the model', () => {
    const a = answer();
    const host = render(
      createElement(AnswerReceipt, {
        a,
        progress: { step: 'attention', label: 'Needs attention on your computer', detail: 'pane_gone' },
      }),
    );
    expect(host.querySelector('[role="status"]')!.textContent).toBe(
      'Your answer on Studio Mac: Needs attention on your computer',
    );
    expect(host.querySelector('.callout-text')!.textContent).toContain(
      'Your answer on Studio Mac is saved on your relay',
    );
  });

  it('keeps the phone steps for an answer from a phone, and the model its own words', () => {
    const phone = answer({ provenance: 'human', signerRole: 'phone', signerLabel: 'phone' });
    const host = render(
      createElement(AnswerReceipt, { a: phone, progress: { step: 'terminal', label: '' } }),
    );
    expect(host.querySelector('[role="status"]')!.textContent).toBe(
      'Your answer: Typed into the terminal',
    );
    act(() => host.querySelector<HTMLButtonElement>('.receipt-button')!.click());
    expect(texts(host, '.stepper li')[0]).toBe('Queued on this device (done)');
    act(() => mounted!.root.unmount());
    mounted = null;
    const model = answer({ action: 'proxy-answer', provenance: 'proxy' });
    const other = render(
      createElement(AnswerReceipt, { a: model, progress: { step: 'terminal', label: '' } }),
    );
    expect(other.querySelector('[role="status"]')!.textContent).toBe(
      'The model answer: Typed into the terminal',
    );
  });

  it('lists it in the activity timeline as the person answering on the computer', () => {
    const a = answer();
    const host = render(createElement(ActivityTimeline, { view: view(a), now: NOW }));
    expect(host.textContent).toContain('You answered on Studio Mac');
    expect(host.querySelector('.summary-meta .by')!.textContent).toBe('Your answer on Studio Mac');
    expect(host.querySelector('.summary-meta .by.model')).toBeNull();
    expect(host.textContent).not.toMatch(/model answer/i);
  });

  it('tells an unsent answer on this phone that it was answered on the computer first', () => {
    const a = answer();
    const entry: OutboxEntry = {
      id: 'e1',
      createdAt: NOW - 120_000,
      questionId: 'q1',
      kind: 'answer',
      path: '/v1/questions/q1/actions',
      bodyText: '{}',
      idempotencyKey: 'k',
      expectedRevision: 0,
      selected: ['b'],
      text: '',
      reason: '',
      state: 'conflict',
      attempts: 1,
      latestRevision: 1,
    };
    const host = render(
      createElement(ConflictCard, {
        view: view(a),
        entry,
        current: a,
        now: NOW,
        canCorrect: false,
        onUseAsCorrection: () => {},
        onSendAsFollowUp: () => {},
        onDismiss: () => {},
      }),
    );
    expect(host.querySelector('.callout-text')!.textContent).toMatch(
      /^Your answer on Studio Mac, “Keep Canopy”, was saved first at .+\. Nothing was overwritten\.$/,
    );
    expect(texts(host, 'button')).not.toContain('Use as correction');
    expect(texts(host, 'button')).not.toContain('Confirm model answer');
    expect(texts(host, 'button')).toContain('Send as a follow-up');
  });
});
