// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionView, QuestionView, ThreadMessage } from '../src/domain/model.js';
import { followUpBy, messageProgress, type FollowUpBy } from '../src/domain/selectors.js';
import { ActivityTimeline } from '../src/components/history/ActivityTimeline.js';
import { FollowUpReceipt } from '../src/components/workspace/DeliveryStatus.js';
import { HumanFollowUp } from '../src/components/workspace/Thread.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-17T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const message = (over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  messageId: 'msg-1',
  messageSeq: 1,
  seq: 3,
  side: 'human',
  expectsReply: false,
  createdAt: iso(NOW - 30_000),
  committedAt: iso(NOW - 30_000),
  signerDeviceId: 'owner',
  signerRole: 'owner-desktop',
  signerLabel: 'Studio Mac',
  text: 'Use the staging branch.',
  images: [],
  verified: true,
  delivery: null,
  ...over,
});

const answer: ActionView = {
  actionId: 'act-1',
  action: 'answer',
  provenance: 'human',
  revision: 1,
  createdAt: iso(NOW - 120_000),
  seq: 2,
  signerDeviceId: 'phone',
  signerRole: 'phone',
  signerLabel: 'phone',
  content: {
    content_version: 1,
    selected_option_ids: ['a'],
    text: '',
    reviewed_attachment_digests: [],
  },
  verified: true,
  imagesOk: true,
};

const view = (messages: ThreadMessage[]): QuestionView => ({
  id: 'q1',
  status: 'human-answered',
  revision: 1,
  requirement: 'human-required',
  targetHostId: 'h',
  originatingDeviceId: 'host',
  createdAt: iso(NOW - 3_600_000),
  expiresAt: null,
  replyMode: 'blocking',
  proxyAbstained: false,
  createdSeq: 1,
  lastSeq: Math.max(2, ...messages.map((m) => m.seq)),
  lastEventAt: iso(NOW - 10_000),
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
    // The computer that asked: a Remote Host, not the one the person wrote on.
    machine_label: 'build-box',
    origin_summary: 'claude · build-box',
  },
  actions: [answer],
  messages,
  expiries: [],
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
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.host.remove();
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(el));
  mounted = { root, host };
  return host;
}

const texts = (host: HTMLElement, sel: string) =>
  [...host.querySelectorAll(sel)].map((n) => n.textContent ?? '');

/** The committed follow-up as the thread shows it, with its receipt. */
const bubble = (m: ThreadMessage) => {
  const by = followUpBy(m) as FollowUpBy;
  const p = messageProgress(m);
  return render(
    createElement(HumanFollowUp, {
      view: view([m]),
      by,
      text: m.text,
      images: m.images,
      at: m.createdAt,
      now: NOW,
      flagged: p.step === 'attention',
      receipt: createElement(FollowUpReceipt, { by, progress: p }),
    }),
  );
};

describe('who sent a follow-up', () => {
  it('names the computer for the owner desktop, and a phone or tablet as the phone', () => {
    expect(followUpBy(message())).toEqual({
      computer: 'Studio Mac',
      label: 'Follow-up on Studio Mac',
      subject: 'Your follow-up on Studio Mac',
    });
    for (const role of ['phone', 'tablet'] as const)
      expect(followUpBy(message({ signerRole: role, signerLabel: role }))).toEqual({
        computer: null,
        label: 'Follow-up',
        subject: 'Your follow-up',
      });
  });

  it('shows the certified name as plain text, and an unnamed computer as "your computer"', () => {
    expect(followUpBy(message({ signerLabel: 'Studio\n Mac\u0007' }))?.computer).toBe('Studio Mac');
    expect(followUpBy(message({ signerLabel: '' }))?.label).toBe('Follow-up on your computer');
    expect(followUpBy(message({ signerLabel: 'host_a1b2c3d4' }))?.subject).toBe(
      'Your follow-up on your computer',
    );
  });

  it("is never the person's when unverified, from a Host, unattributed or the agent's", () => {
    expect(followUpBy(message({ verified: false }))).toBeNull();
    expect(followUpBy(message({ signerRole: 'desktop-host' }))).toBeNull();
    expect(followUpBy(message({ signerRole: null }))).toBeNull();
    expect(followUpBy(message({ side: 'agent' }))).toBeNull();
  });
});

describe("a follow-up sent on the computer, as the person's", () => {
  it('names the computer in the thread, and its receipt starts at the relay', () => {
    const host = bubble(message());
    expect(texts(host, '.bubble-label')).toEqual(['Follow-up on Studio Mac']);
    // Said in full, the computer's name keeps its capitals.
    expect(host.querySelector('.bubble .sr-only')!.textContent).toBe(
      'You, follow-up on Studio Mac: ',
    );
    expect(host.querySelector('.msg.out')).not.toBeNull();
    expect(host.querySelector('[role="status"]')!.textContent).toBe(
      'Your follow-up on Studio Mac: Saved on your relay',
    );
    act(() => host.querySelector<HTMLButtonElement>('.receipt-button')!.click());
    expect(texts(host, '.stepper li')).toEqual([
      'Saved on your relay (done)',
      'Received by your computer (waiting)',
      'Typed into the terminal (not yet)',
    ]);
  });

  it('keeps the phone label and steps for a follow-up sent on a phone', () => {
    const host = bubble(message({ signerRole: 'phone', signerLabel: 'phone' }));
    expect(texts(host, '.bubble-label')).toEqual(['Follow-up']);
    expect(host.querySelector('.bubble .sr-only')!.textContent).toBe('You, follow-up: ');
    expect(host.querySelector('[role="status"]')!.textContent).toBe(
      'Your follow-up: Saved on your relay',
    );
    act(() => host.querySelector<HTMLButtonElement>('.receipt-button')!.click());
    expect(texts(host, '.stepper li')[0]).toBe('Queued on this device (done)');
  });

  it('says a delivery problem is about the follow-up sent on the computer', () => {
    const host = bubble(
      message({
        delivery: {
          status: 'needs-attention',
          received_at: iso(NOW - 20_000),
          terminal_delivered_at: null,
          injection_id: null,
          error_code: 'pane_gone',
        },
      }),
    );
    expect(host.querySelector('.msg.out.flagged')).not.toBeNull();
    expect(host.querySelector('.callout-text')!.textContent).toContain(
      'Your follow-up on Studio Mac is saved on your relay',
    );
  });

  it('lists a thread mixing phone, computer and agent follow-ups in the activity timeline', () => {
    const phone = message({
      messageId: 'm-phone',
      seq: 3,
      signerRole: 'phone',
      signerLabel: 'phone',
      text: 'Also bump the version.',
    });
    const agent = message({
      messageId: 'm-agent',
      seq: 4,
      side: 'agent',
      expectsReply: true,
      signerRole: 'desktop-host',
      signerLabel: 'build-box',
      text: 'Which version?',
    });
    const computer = message({ messageId: 'm-computer', seq: 5, text: 'v3.' });
    const forged = message({
      messageId: 'm-forged',
      seq: 6,
      verified: false,
      signerRole: null,
      signerLabel: undefined,
      text: '',
    });
    const host = render(
      createElement(ActivityTimeline, { view: view([phone, agent, computer, forged]), now: NOW }),
    );
    // In ledger order after the answer, the one that could not be verified left out.
    expect(texts(host, '.tl-item .tl-title span')).toEqual([
      'Asked by your agent',
      'You answered',
      'You sent a follow-up',
      'Claude Code replied',
      'You sent a follow-up on Studio Mac',
    ]);
    const mine = [...host.querySelectorAll('.tl-item[data-kind="message"]')].map((n) =>
      n.hasAttribute('data-mine'),
    );
    expect(mine).toEqual([true, false, true]);
  });

  it("never lists a Host's human message as the person's", () => {
    const host = render(
      createElement(ActivityTimeline, {
        view: view([message({ signerRole: 'desktop-host', signerLabel: 'build-box' })]),
        now: NOW,
      }),
    );
    expect(host.querySelector('.tl-item[data-kind="message"]')).toBeNull();
    expect(host.textContent).not.toContain('You sent a follow-up');
  });
});
