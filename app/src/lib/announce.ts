type Listener = (msg: string) => void;
const listeners = new Set<Listener>();

/** Screen-reader announcements for state that changes without a focus move (queued, saved, conflict). */
export function announce(message: string): void {
  for (const l of listeners) l(message);
}
export function onAnnounce(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
