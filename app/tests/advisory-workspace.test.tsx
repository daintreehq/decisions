// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEvent } from '@daintreehq/decisions-protocol';
import { ADVISORY_QUESTION_FIXTURE } from '@daintreehq/decisions-protocol/fixtures';
import { app } from '../src/app/controller.js';
import { ActivityTimeline } from '../src/components/history/ActivityTimeline.js';
import { Workspace } from '../src/components/workspace/Workspace.js';
import { QuestionStore } from '../src/domain/model.js';
import { onAnnounce } from '../src/lib/announce.js';
import {
  actionEvent,
  deadlineScenario,
  expiredEvent,
  makeWorld,
  MINUTE,
  questionEvent,
  SAMPLE_CONTENT,
  type World,
} from './helpers.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLAN = ADVISORY_QUESTION_FIXTURE.content.planned_fallback;

/** The controller's seams the workspace reads, set as boot sets them. */
type Inside = {
  store: QuestionStore | null;
  outbox: unknown;
  patch(p: Record<string, unknown>): void;
};
const inside = app as unknown as Inside;

/** Nothing of this device's is on its way. */
const quietOutbox = {
  forQuestion: () => [],
  pendingState: () => undefined,
  declineInFlight: () => false,
  list: () => [],
  imagesSent: () => 0,
  discard: async () => undefined,
};

let mounted: { root: Root; host: HTMLElement } | null = null;
let heard: string[] = [];
let stopHearing: () => void = () => undefined;
let asked: string[] = [];

beforeEach(() => {
  // The phone layout: the narrow, single-column workspace.
  (window as unknown as { happyDOM: { setViewport(v: object): void } }).happyDOM.setViewport({
    width: 390,
    height: 844,
  });
  heard = [];
  stopHearing = onAnnounce((m) => heard.push(m));
  asked = [];
  vi.spyOn(app, 'checkDeadline').mockImplementation(() => void asked.push('catch-up'));
});

afterEach(() => {
  if (mounted) act(() => mounted!.root.unmount());
  mounted?.host.remove();
  mounted = null;
  stopHearing();
  vi.useRealTimers();
  vi.restoreAllMocks();
  inside.store = null;
  inside.outbox = null;
});

async function storeFor(w: World, events: LedgerEvent[], keys = true): Promise<QuestionStore> {
  const s = new QuestionStore({
    installationId: w.installationId,
    trust: w.trust,
    epochKeys: () => (keys ? w.epochs : new Map()),
  });
  await s.ingestAll(events);
  s.subscribe(() => inside.patch({}));
  return s;
}

/** The workspace for `id`, as the router mounts it, with this phone's clock at `now`. */
function open(s: QuestionStore, id: string, now: number): HTMLElement {
  vi.useFakeTimers({
    now,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  inside.store = s;
  inside.outbox = quietOutbox;
  inside.patch({});
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Workspace, { id })));
  mounted = { root, host };
  return host;
}

const log = (host: HTMLElement) => host.querySelector<HTMLElement>('[role="log"]')!;
/** What the conversation log would announce: only items added to it (`aria-relevant="additions"`). */
function watchLog(host: HTMLElement): string[] {
  const added: string[] = [];
  new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes)
        if (n.parentNode === log(host) && n instanceof HTMLElement) added.push(n.textContent ?? '');
  }).observe(log(host), { childList: true });
  return added;
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
/** Let the observers' records arrive. */
const settle = () => act(async () => void (await Promise.resolve()));

describe('an advisory question in the phone workspace', () => {
  it('shows the local deadline, the time left and the plan, and turns at the deadline itself', async () => {
    const w = await makeWorld();
    const sc = await deadlineScenario(w, 'advisory');
    const s = await storeFor(w, sc.events);
    const D = sc.deadline!;
    // Off the 30-second ticks, so only the wake at the deadline can turn it in time.
    const start = sc.asked + MINUTE + 7_000;
    const host = open(s, sc.questionId, start);
    const added = watchLog(host);

    const due = host.querySelector('.msg-meta .due')!;
    expect(due.textContent).toMatch(/^Reply by .+ · , 13 minutes left$/);
    expect(due.querySelector('time')!.getAttribute('datetime')).toBe(new Date(D).toISOString());
    const plan = host.querySelector('[role="note"][aria-label="Your agent’s plan"]')!;
    expect(plan.textContent).toContain(PLAN);
    expect(plan.textContent).toMatch(/if no answer reaches your relay by/);
    // It never waits for a person, whatever its requirement says.
    expect(host.textContent).not.toContain('Human decision required');

    // The countdown moves without adding anything to the log or announcing it.
    advance(MINUTE);
    await settle();
    expect(host.querySelector('.msg-meta .due')!.textContent).toMatch(/12 minutes left$/);
    expect(added).toEqual([]);

    // The deadline itself, between two ordinary ticks: one line, added once, and the relay is asked at once.
    advance(D - (start + MINUTE) + 100);
    await settle();
    expect(host.querySelector('.msg-meta .due')).toBeNull();
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('The deadline passed on this phone');
    expect(added[0]).toContain(
      'Waiting for your relay to confirm. If no answer reached it in time, your agent may go ahead with its plan.',
    );
    expect(asked).toEqual(['catch-up']);
    expect(heard).toEqual([]);
    // Until the relay says how it ended, it is asked again on each tick.
    advance(30_000);
    expect(asked).toEqual(['catch-up', 'catch-up']);

    // The relay expires the round: the outcome replaces the provisional line, still once.
    await act(async () => {
      await s.ingest(expiredEvent(sc.questionId, D + 200));
    });
    await settle();
    expect(added).toHaveLength(2);
    expect(added[1]).toContain('No answer by the deadline');
    expect(added[1]).toContain('may now go ahead with its plan');
    expect(added[1]).toContain('can’t see whether your agent has been told yet, or what it did');
    expect(host.textContent).not.toContain('The deadline passed on this phone');
    // The plan that became due stays in view.
    expect(host.querySelector('[aria-label="Your agent’s plan"]')!.textContent).toContain(PLAN);
    expect(heard).toEqual([]);
  });

  it('catches up when the page comes back after the deadline passed while it was hidden, and when the clock moves', async () => {
    const w = await makeWorld();
    const sc = await deadlineScenario(w, 'advisory');
    const s = await storeFor(w, sc.events);
    const D = sc.deadline!;
    const host = open(s, sc.questionId, sc.asked + MINUTE);
    expect(host.querySelector('.msg-meta .due')).not.toBeNull();

    // Suspended in the background across the deadline: no timer ran, then the page is shown again.
    vi.setSystemTime(D + 5 * MINUTE);
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(host.textContent).toContain('The deadline passed on this phone');
    expect(asked).toEqual(['catch-up']);

    // The clock is set back before the deadline: the question is open again, and turns again at the deadline.
    vi.setSystemTime(D - 2 * MINUTE);
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(host.textContent).not.toContain('The deadline passed on this phone');
    expect(host.querySelector('.msg-meta .due')!.textContent).toMatch(/2 minutes left$/);
    advance(2 * MINUTE + 100);
    expect(host.textContent).toContain('The deadline passed on this phone');

    // Restored from the back-forward cache.
    vi.setSystemTime(D - MINUTE);
    act(() => void window.dispatchEvent(new Event('pageshow')));
    expect(host.querySelector('.msg-meta .due')).not.toBeNull();
  });

  it('opens from a stale notification straight to how the round stands', async () => {
    const w = await makeWorld();
    const sc = await deadlineScenario(w, 'advisory');
    const s = await storeFor(w, sc.events);
    const D = sc.deadline!;
    const host = open(s, sc.questionId, D + 10 * MINUTE);
    expect(host.textContent).toContain('The deadline passed on this phone');
    expect(host.querySelector('.msg-meta .due')).toBeNull();
    expect(asked).toEqual(['catch-up']);
    await act(async () => {
      await s.ingest(expiredEvent(sc.questionId, D + 11 * MINUTE));
    });
    expect(host.textContent).toContain('No answer by the deadline');
  });

  it('says what dismissing it does, beside the plan it would otherwise go ahead with', async () => {
    const w = await makeWorld();
    const sc = await deadlineScenario(w, 'advisory');
    const s = await storeFor(w, sc.events);
    const D = sc.deadline!;
    const view = s.get(sc.questionId)!;
    inside.patch({
      devices: {
        devices: [
          {
            device_id: view.originatingDeviceId,
            revoked_at: null,
            features: ['person-declines-v1'],
          },
        ],
      },
    });
    const host = open(s, sc.questionId, sc.asked + MINUTE);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (b) => b.textContent === 'Dismiss question…',
    )!;
    act(() => item.click());
    const sheet = [...document.querySelectorAll<HTMLElement>('dialog, [role="dialog"]')].find((d) =>
      d.textContent?.includes('Dismiss this question?'),
    )!;
    // Only a dismissal the relay gets in time closes it; otherwise the plan still becomes due.
    expect(sheet.textContent).toMatch(
      /If your relay accepts your dismissal before .+ \(14 minutes left\), the question closes on all your devices and reminders stop\. If your agent is still waiting, it is told you declined\. Nothing is approved, and the deadline no longer applies\./,
    );
    expect(sheet.textContent).toContain(
      'If it isn’t accepted in time and no one answers, your agent may go ahead with its plan:',
    );
    expect(sheet.textContent).toContain(PLAN);
    const dismiss = [...sheet.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Dismiss question',
    )!;
    expect(dismiss.disabled).toBe(false);
    // The sheet's own status, there from the start (the thread behind a modal is not read).
    const status = sheet.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('');

    // The deadline passes while the sheet is open: there is nothing left to dismiss, and the sheet says so.
    advance(D - (sc.asked + MINUTE) + 100);
    expect(status.textContent).toBe(
      'The deadline passed on this phone, so there’s nothing left to dismiss.',
    );
    expect(dismiss.disabled).toBe(true);
    // The relay confirms it: the same status says the outcome.
    await act(async () => {
      await s.ingest(expiredEvent(sc.questionId, D + 200));
    });
    expect(status.textContent).toBe(
      'Your relay confirmed no answer arrived in time, so your agent may go ahead with its plan. There’s nothing left to dismiss.',
    );
    expect(dismiss.disabled).toBe(true);
  });

  it('shows the signed deadline of one this phone can’t read, without a plan it can’t know', async () => {
    const w = await makeWorld();
    const sc = await deadlineScenario(w, 'advisory');
    const s = await storeFor(w, sc.events, false);
    const host = open(s, sc.questionId, sc.asked + MINUTE);
    expect(host.textContent).toContain(
      'This device can’t read this question, so it can’t be answered here.',
    );
    const advice = host.querySelector('.dock-line [role="status"]')!;
    expect(advice.textContent).toMatch(
      /^It asks for advice by .+\. If no answer reaches your relay by then, its agent may go ahead with a plan this phone can’t read\.$/,
    );
    // The time left is read beside it, never announced.
    expect(advice.parentElement!.textContent).toContain('(14 minutes left)');
    expect(host.textContent).not.toContain(PLAN);
    advance(sc.deadline! - (sc.asked + MINUTE) + 100);
    expect(advice.textContent).toMatch(/^Its deadline, .+, has passed on this phone\./);
    await act(async () => {
      await s.ingest(expiredEvent(sc.questionId, sc.deadline! + 200));
    });
    expect(advice.textContent).toMatch(
      /^No answer reached your relay by .+, so its agent may go ahead with a plan this phone can’t read\.$/,
    );
    expect(host.textContent).not.toContain(PLAN);
  });

  it('turns at the deadline after the clock jumps forward but stays short of it', async () => {
    const w = await makeWorld();
    const sc = await deadlineScenario(w, 'advisory');
    const s = await storeFor(w, sc.events);
    const D = sc.deadline!;
    const host = open(s, sc.questionId, sc.asked + MINUTE + 7_000);
    // Set forward to 10 s before the deadline, then the page is focused: the wake is armed again for the new time.
    vi.setSystemTime(D - 10_000);
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(host.querySelector('.msg-meta .due')).not.toBeNull();
    advance(10_100);
    expect(host.textContent).toContain('The deadline passed on this phone');
  });
});

describe('a blocking question with a deadline in the phone workspace', () => {
  it('says an approval that runs out of time approves nothing and leaves the step blocked', async () => {
    const w = await makeWorld();
    const sc = await deadlineScenario(w, 'required-expiry', Date.now());
    // Only the question: still open.
    const s = await storeFor(w, sc.events.slice(0, 1));
    const host = open(s, sc.questionId, sc.asked + MINUTE);
    expect(host.querySelector('.msg-meta .due')!.textContent).toMatch(/14 minutes left$/);
    expect(host.textContent).toContain('Human decision required');
    expect(host.querySelector('.msg-meta-note')!.textContent).toBe(
      'If no one decides by then, nothing is approved and the step stays blocked.',
    );
    expect(host.querySelector('[aria-label="Your agent’s plan"]')).toBeNull();
  });

  it('shows a required approval the relay expired as unanswered, with nothing approved', async () => {
    const w = await makeWorld();
    const sc = await deadlineScenario(w, 'required-expiry');
    const s = await storeFor(w, sc.events);
    const host = open(s, sc.questionId, Date.now());
    const line = [...log(host).children].at(-1)!;
    expect(line.textContent).toContain('Expired without an answer');
    expect(line.textContent).toContain(
      'Nothing was approved, and the step stays blocked. To decide now, ask your agent again from your computer.',
    );
    expect(host.textContent).not.toContain('The deadline passed on this phone');
  });

  it('never shows a plan a blocking question happens to carry', async () => {
    const w = await makeWorld();
    const q = await questionEvent(w, {
      expiresAt: new Date(Date.now() + 15 * MINUTE).toISOString(),
      content: { ...SAMPLE_CONTENT, planned_fallback: 'Ship it anyway.' },
    });
    const s = await storeFor(w, [q]);
    const host = open(s, q.question_id!, Date.now());
    expect(host.querySelector('[aria-label="Your agent’s plan"]')).toBeNull();
    expect(host.textContent).not.toContain('Ship it anyway.');
    expect(host.textContent).toContain('Human decision required');
  });

  it('keeps old content and a question with no deadline as they were', async () => {
    const w = await makeWorld();
    const old = await deadlineScenario(w, 'old-content');
    const none = await deadlineScenario(w, 'no-expiry');
    const s = await storeFor(w, [...old.events, ...none.events]);
    const host = open(s, old.questionId, old.asked + MINUTE);
    expect(host.querySelector('.msg-meta .due')!.textContent).toMatch(/14 minutes left$/);
    expect(host.textContent).toContain('Human decision required');
    expect(host.querySelector('.msg-meta-note')).toBeNull();
    act(() => mounted!.root.render(createElement(Workspace, { id: none.questionId })));
    expect(host.querySelector('.msg-meta .due')).toBeNull();
    expect(host.textContent).toContain('Human decision required');
  });
});

describe('an advisory question in its history', () => {
  it('keeps the advisory round going unanswered in place after the agent reopened it', async () => {
    const w = await makeWorld();
    const sc = await deadlineScenario(w, 'advisory');
    const D = sc.deadline!;
    const D2 = D + 30 * MINUTE;
    const s = await storeFor(w, [
      ...sc.events,
      expiredEvent(sc.questionId, D),
      await actionEvent(w, {
        questionId: sc.questionId,
        action: 'reopen',
        signer: w.owner,
        expectedRevision: 0,
        status: 'open',
        expiresAt: new Date(D2).toISOString(),
      }),
      await actionEvent(w, {
        questionId: sc.questionId,
        action: 'answer',
        expectedRevision: 1,
        occurredAt: new Date(D + 5 * MINUTE).toISOString(),
      }),
    ]);
    const view = s.get(sc.questionId)!;
    inside.store = s;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ActivityTimeline, { view, now: D2 + MINUTE })));
    mounted = { root, host };
    const text = host.textContent ?? '';
    // Asked with its plan, never as waiting for a person; then the advisory round ran out; then the reopened round.
    expect(text).toContain('If no answer came in time, your agent planned to:');
    expect(text).toContain(PLAN);
    expect(text).not.toContain('Human decision required');
    const order = ['No answer by the deadline', 'Reopened by your agent', 'You answered'].map((t) =>
      text.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('details and history once the round has ended another way', () => {
  it('says in Question details that a dismissed advisory question’s plan never became due', async () => {
    const w = await makeWorld();
    const sc = await deadlineScenario(w, 'dismissed');
    const s = await storeFor(w, sc.events);
    const host = open(s, sc.questionId, sc.deadline! + MINUTE);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (b) => b.textContent === 'Question details',
    )!;
    act(() => item.click());
    const text = document.body.textContent ?? '';
    expect(text).toContain('Advice: closed before the deadline, so its plan never became due');
    expect(text).not.toContain('may go ahead without an answer');
    expect(host.querySelector('[aria-label="Your agent’s plan"]')).toBeNull();
  });

  it('says nothing provisional in Activity about an answer the relay accepted but this phone hasn’t read back', async () => {
    const w = await makeWorld();
    const sc = await deadlineScenario(w, 'advisory');
    const s = await storeFor(w, sc.events);
    const view = s.get(sc.questionId)!;
    inside.store = s;
    inside.outbox = {
      ...quietOutbox,
      forQuestion: () => [{ id: 'e1', kind: 'answer', state: 'committed', recordId: 'rec_e1' }],
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ActivityTimeline, { view, now: sc.deadline! + MINUTE })));
    mounted = { root, host };
    expect(host.textContent).not.toContain('The deadline passed on this phone');
    expect(host.textContent).toContain(
      'Your relay accepted your answer. It shows here once this device reads it back.',
    );
    // Never dated at the deadline, which would read as late.
    expect(host.querySelector('.activity-summary .summary-meta')).toBeNull();
  });
});
