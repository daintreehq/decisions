import { useEffect, useState, useSyncExternalStore } from 'react';
import { app, type AppSnapshot } from './controller.js';
import type { QuestionView } from '../domain/model.js';

export function useApp(): AppSnapshot {
  return useSyncExternalStore(app.subscribe, app.getSnapshot);
}

/** Re-renders on any change to the question store, outbox or connection. */
export function useQuestions(): QuestionView[] {
  const snap = useApp();
  void snap.rev;
  return app.store ? app.store.list() : [];
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
