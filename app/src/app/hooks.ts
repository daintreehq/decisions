import { useEffect, useState, useSyncExternalStore } from 'react';
import { app, type AppSnapshot } from './controller.js';
import type { QuestionView } from '../domain/model.js';
import { agentStateView, type AgentStateView } from '../domain/agentState.js';

export function useApp(): AppSnapshot {
  return useSyncExternalStore(app.subscribe, app.getSnapshot);
}

/** Re-renders on any change to the question store, outbox or connection. */
export function useQuestions(): QuestionView[] {
  const snap = useApp();
  void snap.rev;
  return app.store ? app.store.list() : [];
}

const noSubscribe = () => () => undefined;
const noVersion = () => 0;

/**
 * What each row shows about its asking agent (`agentStateView`), re-rendering when a shown state, its sharing or
 * its freshness changes. Ages are read at render time, so a list that ticks (`useNow`) keeps them current.
 */
export function useAgentStates(): (v: QuestionView) => AgentStateView | null {
  useApp(); // the snapshot store appears when the app boots
  const store = app.snapshots;
  useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getVersion ?? noVersion);
  const relayNow = store?.relayNow() ?? Date.now();
  return (v) => (store ? agentStateView(store.get(v.id), v.status, relayNow) : null);
}

/**
 * Whether the person is touching or scrolling right now: a pointer is down, or the page (or any list in it)
 * scrolled within the last `idleMs`. Lists hold updates that would change a row's height while it is true, so
 * nothing moves under a finger. A pointer whose release never arrives (it left the window) stops counting after
 * a few seconds.
 */
export function useInteracting(idleMs = 400): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const down = new Set<number>();
    let idle: ReturnType<typeof setTimeout> | null = null;
    let stuck: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        idle = null;
        if (down.size === 0) setOn(false);
      }, idleMs);
    };
    const start = (e: PointerEvent) => {
      down.add(e.pointerId);
      setOn(true);
      if (stuck) clearTimeout(stuck);
      stuck = setTimeout(() => {
        down.clear();
        settle();
      }, 5_000);
    };
    const end = (e: PointerEvent) => {
      down.delete(e.pointerId);
      settle();
    };
    const scroll = () => {
      setOn(true);
      settle();
    };
    const reset = () => {
      down.clear();
      settle();
    };
    document.addEventListener('pointerdown', start, true);
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
    document.addEventListener('scroll', scroll, { capture: true, passive: true });
    window.addEventListener('blur', reset);
    return () => {
      document.removeEventListener('pointerdown', start, true);
      document.removeEventListener('pointerup', end, true);
      document.removeEventListener('pointercancel', end, true);
      document.removeEventListener('scroll', scroll, { capture: true });
      window.removeEventListener('blur', reset);
      if (idle) clearTimeout(idle);
      if (stuck) clearTimeout(stuck);
    };
  }, [idleMs]);
  return on;
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
