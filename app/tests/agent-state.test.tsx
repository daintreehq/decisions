// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@daintreehq/decisions-protocol';
import { buildSignedSnapshot, encryptEnvelope, newId } from '@daintreehq/decisions-crypto';
import { SnapshotStore } from '../src/data/snapshots.js';
import { agentStateView } from '../src/domain/agentState.js';
import { QuestionStore, type QuestionView } from '../src/domain/model.js';
import { verifySnapshotResponse } from '../src/domain/snapshot.js';
import { QuestionRow } from '../src/components/navigator/QuestionRow.js';
import { makeWorld, plainEvent, questionEvent, type Actor, type World } from './helpers.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-04T10:00:00.000Z');

/** A `GET /questions/{id}/snapshot` response as the relay serves it, signed by `signer` (the asking desktop). */
async function snapshotResponse(
  w: World,
  questionId: string,
  o: {
    state?: string;
    sharing?: 'on' | 'off';
    receivedAt: number;
    signer?: Actor;
  },
) {
  const signer = o.signer ?? w.desktop;
  const observedAt = new Date(o.receivedAt - 500).toISOString();
  const snapshotId = newId();
  const envelope =
    o.sharing === 'off'
      ? null
      : await encryptEnvelope({
          epochKey: w.epoch,
          installationId: w.installationId,
          questionId,
          recordId: snapshotId,
          recordType: 'pane.snapshot',
          revision: 0,
          senderDeviceId: signer.id,
          purpose: 'snapshot-content',
          plaintext: {
            content_version: 1,
            observed_at: observedAt,
            agent_state: o.state ?? 'working',
            waiting_reason: null,
            pane_title: 'Claude Code — webhooks',
            terminal_lines: ['$ pnpm test', ' ✓ 214 passed'],
          },
        });
  const snapshot = await buildSignedSnapshot({
    installationId: w.installationId,
    questionId,
    signerDeviceId: signer.id,
    signingKey: signer.keys.signing.privateKey,
    questionRevision: 0,
    observedAt,
    envelope,
    snapshotId,
  });
  return {
    question_id: questionId,
    snapshot,
    received_at: new Date(o.receivedAt).toISOString(),
    refresh: null,
  };
}

async function setup() {
  const w = await makeWorld();
  const questions = new QuestionStore({
    installationId: w.installationId,
    trust: w.trust,
    epochKeys: () => w.epochs,
  });
  const qid = newId();
  await questions.ingest(await questionEvent(w, { questionId: qid }));
  let served: unknown = { question_id: qid, snapshot: null, received_at: null, refresh: null };
  let clock = NOW;
  const timers: (() => void)[] = [];
  const snapshots = new SnapshotStore({
    fetch: async () => served,
    verify: (raw, view) =>
      verifySnapshotResponse(raw, view, {
        installationId: w.installationId,
        trust: w.trust,
        epochKeys: w.epochs,
      }),
    view: (id) => questions.get(id),
    now: () => clock,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => undefined,
  });
  const serve = (r: unknown) => (served = r);
  /** Sends the relay's content-free hint, as sync does, and waits for the read it triggers. */
  const hint = async () => {
    snapshots.noteEvents(
      [
        plainEvent('decision.snapshot.updated', qid, {
          snapshot_id: newId(),
          observed_at: new Date(clock).toISOString(),
          sharing: 'on',
          target_host_id: 'host_aaaaaaaa',
        }),
      ],
      true,
    );
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
  };
  const view = () => questions.get(qid)!;
  const shown = () => agentStateView(snapshots.get(qid), view().status, snapshots.relayNow());
  return {
    w,
    qid,
    snapshots,
    serve,
    hint,
    view,
    shown,
    advance: (ms: number) => (clock += ms),
    /** Runs the store's pending wake-ups, as the browser would once their time comes. */
    fire: () => timers.splice(0).forEach((f) => f()),
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

/** Renders one Home row and returns its markup. */
function renderRow(v: QuestionView, agent: ReturnType<typeof agentStateView>): HTMLElement {
  if (!host) {
    host = document.createElement('ul');
    document.body.append(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      createElement(QuestionRow, {
        v,
        now: NOW,
        selected: false,
        extras: { pending: undefined },
        agent,
        onOpen: () => undefined,
      }),
    ),
  );
  return host.querySelector('.qrow')! as HTMLElement;
}

describe('agent state on question rows', () => {
  it("follows a changed snapshot: the row's label changes without a reload", async () => {
    const t = await setup();
    t.serve(await snapshotResponse(t.w, t.qid, { state: 'working', receivedAt: NOW }));
    let heard = 0;
    t.snapshots.subscribe(() => heard++);
    await t.hint();
    expect(t.shown()).toMatchObject({ state: 'working', label: 'Working', fresh: 'fresh' });
    let row = renderRow(t.view(), t.shown());
    expect(row.querySelector('.agent-state')?.getAttribute('data-state')).toBe('working');
    expect(row.textContent).toContain('Working');
    expect(row.textContent).toContain('Agent working');

    t.advance(5_000);
    t.serve(await snapshotResponse(t.w, t.qid, { state: 'waiting', receivedAt: NOW + 5_000 }));
    const before = heard;
    await t.hint();
    expect(heard).toBeGreaterThan(before);
    expect(t.shown()).toMatchObject({ state: 'waiting', label: 'Waiting' });
    row = renderRow(t.view(), t.shown());
    expect(row.querySelector('.agent-state')?.getAttribute('data-state')).toBe('waiting');
    expect(row.textContent).toContain('Waiting');
    expect(row.textContent).not.toContain('Working');
  });

  it('uses Daintree’s words for every known state and shows nothing for one it does not know', async () => {
    const t = await setup();
    const words: Record<string, string> = {
      working: 'Working',
      waiting: 'Waiting',
      directing: 'Directing',
      idle: 'Idle',
      completed: 'Finished',
      exited: 'Exited',
    };
    for (const [state, label] of Object.entries(words)) {
      t.advance(1_000);
      t.serve(await snapshotResponse(t.w, t.qid, { state, receivedAt: NOW }));
      await t.hint();
      expect(t.shown()?.label).toBe(label);
    }
    t.serve(await snapshotResponse(t.w, t.qid, { state: 'thinking', receivedAt: NOW }));
    await t.hint();
    expect(t.shown()).toBeNull();
  });

  it('mutes a stale snapshot: a hollow ring, secondary text and its age', async () => {
    const t = await setup();
    t.serve(await snapshotResponse(t.w, t.qid, { state: 'waiting', receivedAt: NOW }));
    await t.hint();
    expect(t.shown()?.fresh).toBe('fresh');
    let heard = 0;
    t.snapshots.subscribe(() => heard++);

    t.advance(LIMITS.snapshotFreshMs + 4 * 60_000);
    expect(t.shown()).toMatchObject({ state: 'waiting', fresh: 'stale', age: '5 min ago' });
    const row = renderRow(t.view(), t.shown());
    const mark = row.querySelector('.agent-state')!;
    expect(mark.getAttribute('data-fresh')).toBe('stale');
    expect(mark.textContent).toContain('Agent waiting, as of 5 min ago');
    expect(row.querySelector('.agent-age')?.textContent).toContain('5 min ago');
    // The store wakes rows when the observation turns stale, with no new event from the relay.
    t.fire();
    expect(heard).toBeGreaterThan(0);
  });

  it('leaves an unshared question’s row exactly as it is without the feature', async () => {
    const t = await setup();
    const plain = renderRow(t.view(), null).outerHTML;

    // Sharing off on the desktop.
    t.serve(await snapshotResponse(t.w, t.qid, { sharing: 'off', receivedAt: NOW }));
    await t.hint();
    expect(t.snapshots.get(t.qid)?.observation?.sharing).toBe('off');
    expect(t.shown()).toBeNull();
    expect(renderRow(t.view(), t.shown()).outerHTML).toBe(plain);

    // An older desktop that never publishes one.
    t.serve({ question_id: t.qid, snapshot: null, received_at: null, refresh: null });
    await t.hint();
    expect(t.shown()).toBeNull();
    expect(renderRow(t.view(), t.shown()).outerHTML).toBe(plain);
  });

  it('never shows a snapshot another device signed for the asking pane', async () => {
    const t = await setup();
    t.serve(
      await snapshotResponse(t.w, t.qid, { state: 'working', receivedAt: NOW, signer: t.w.phone }),
    );
    await t.hint();
    expect(t.snapshots.get(t.qid)).toBeUndefined();
    expect(t.shown()).toBeNull();
  });
});
