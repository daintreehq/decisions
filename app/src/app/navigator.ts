import { useSyncExternalStore } from 'react';

/**
 * Whether the Questions & answers navigator sheet is open. Ctrl/⌘+K opens it. Callers that
 * are recording stop first.
 */
let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openNavigator(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeNavigator(): void {
  if (!open) return;
  open = false;
  emit();
}

export function useNavigatorOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}
