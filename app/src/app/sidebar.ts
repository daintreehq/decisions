import { useSyncExternalStore } from 'react';

/**
 * Whether the sidebar overlay is open (below 1100px; from there the sidebar is a persistent column and this stays
 * false). The floating menu button opens it; Back, Escape, the dimmed edge, a left swipe and any navigation close
 * it.
 */
let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openSidebar(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeSidebar(): void {
  if (!open) return;
  open = false;
  emit();
}

export function useSidebarOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => false,
  );
}
