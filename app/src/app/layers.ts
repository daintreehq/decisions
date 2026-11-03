import { useCallback, useEffect, useRef } from 'react';

/**
 * Back closes the topmost workspace layer (file viewer, sheet, expanded editor, navigator) before it leaves the
 * page. Each open layer owns one history entry that carries only a depth marker (never content, never a path
 * change). Browser Back pops it and closes the layer; closing from a button goes through history too, so history
 * never accumulates dead entries and there is one way a layer closes.
 */
interface Layer {
  id: number;
  close: () => void;
}

const stack: Layer[] = [];
let seq = 0;
/** popstate events we caused ourselves (silent releases) and must not treat as Back. */
let ignorePops = 0;
/** Pushes requested while a silent release is still in flight; history.go is async. */
const deferred: Array<() => void> = [];

function depthOf(state: unknown): number {
  return (state as { layerDepth?: number } | null)?.layerDepth ?? 0;
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (e) => {
    if (ignorePops > 0) {
      ignorePops--;
      if (ignorePops === 0) deferred.splice(0).forEach((f) => f());
      return;
    }
    const depth = depthOf(e.state);
    while (stack.length > depth) stack.pop()!.close();
  });
}

function push(layer: Layer): void {
  const doPush = () => {
    stack.push(layer);
    history.pushState({ layerDepth: stack.length }, '');
  };
  if (ignorePops > 0) deferred.push(doPush);
  else doPush();
}

/** Remove a layer (and any above it) whose UI already closed itself, unwinding its history entries silently. */
function release(id: number): void {
  const i = stack.findIndex((l) => l.id === id);
  // Already closed by Back, or never pushed (still deferred): nothing to unwind.
  if (i < 0) return;
  const removed = stack.splice(i).length;
  // Only unwind entries we are still standing on. If the page already moved on (a replace-navigation, a lock
  // screen after revocation, an external navigation), going back would undo that move instead.
  if (depthOf(history.state) < i + removed) return;
  ignorePops++;
  history.go(-removed);
}

/** Close a layer the way Back would: through history, so the popstate handler runs its close. */
function dismiss(id: number): void {
  const i = stack.findIndex((l) => l.id === id);
  if (i < 0) return;
  history.go(-(stack.length - i));
}

/** Whether any layer is open; navigation replaces rather than pushes while one is. */
export function hasLayers(): boolean {
  return stack.length > 0;
}

/**
 * Close every open layer without touching history; the caller replaces the current entry. Used by `navigate` so
 * choosing a question from the navigator does not leave the navigator's entry behind.
 */
export function dropLayers(): void {
  while (stack.length) stack.pop()!.close();
}

/**
 * Tie a layer's visibility to history. Returns `dismiss`, which buttons and Escape should call to close the layer
 * (it goes through history, exactly like Back). If the component closes the layer by state instead, its history
 * entry is unwound silently.
 */
export function useLayer(open: boolean, onClose: () => void): () => void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const idRef = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    const id = ++seq;
    idRef.current = id;
    push({ id, close: () => closeRef.current() });
    return () => {
      if (idRef.current === id) idRef.current = null;
      release(id);
    };
  }, [open]);
  return useCallback(() => {
    if (idRef.current != null) dismiss(idRef.current);
    else closeRef.current();
  }, []);
}
