import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Back closes the topmost workspace layer (file viewer, sheet, expanded editor, navigator) before it leaves the
 * page. Each open layer owns one history entry that carries only a depth marker (never content, never a path
 * change). Browser Back pops it and closes the layer; closing from a button goes through history too, so history
 * never accumulates dead entries and there is one way a layer closes.
 *
 * `history.go` is asynchronous. While one of our own traversals is in flight, every other history change (a layer's
 * push, another release, a route navigation) waits for its popstate and then runs in order, against the entry the
 * traversal actually landed on. Nothing reads a stale `history.state` or races a traversal it cannot see.
 */
interface Layer {
  id: number;
  close: () => void;
  /** Whether its history entry exists yet; a layer opened during a traversal is pushed once it lands. */
  pushed: boolean;
}

const stack: Layer[] = [];
let seq = 0;
/** popstate events we caused ourselves (silent unwinds) and must not treat as Back. */
let ownPops = 0;
/** Work that changes history, waiting for our traversal in flight to land. Runs in order. */
const waiting: Array<() => void> = [];
/** History entries of layers that have closed and are still to be unwound (they sit above the open ones). */
let stale = 0;
let watchdog: ReturnType<typeof setTimeout> | null = null;
/** A traversal whose popstate never arrives (the browser refused it) must not stall navigation for good. */
const TRAVERSAL_TIMEOUT_MS = 1000;

function depthOf(state: unknown): number {
  return (state as { layerDepth?: number } | null)?.layerDepth ?? 0;
}

const busy = () => ownPops > 0;

function landed(): void {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  reconcile();
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (e) => {
    if (ownPops > 0) {
      ownPops--;
      if (ownPops === 0) landed();
      return;
    }
    const depth = depthOf(e.state);
    while (stack.length > depth) stack.pop()!.close();
  });
}

/** Go back `n` entries without treating the popstate as Back. Everything else waits until it lands. */
function unwindSilently(n: number): void {
  ownPops++;
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    ownPops = 0;
    landed();
  }, TRAVERSAL_TIMEOUT_MS);
  history.go(-n);
}

/**
 * Bring history in line with the open layers, one traversal at a time: unwind the entries of layers that closed,
 * run waiting work (a navigation), then push entries for layers opened meanwhile.
 */
function reconcile(): void {
  while (!busy()) {
    let pushed = 0;
    while (pushed < stack.length && stack[pushed]!.pushed) pushed++;
    // Only unwind entries we are standing on. If the page already moved on (a replace-navigation, an external
    // navigation), the current entry carries less depth and there is nothing of ours above it to unwind.
    const surplus = Math.min(stale, depthOf(history.state) - pushed);
    stale = 0;
    if (surplus > 0) {
      unwindSilently(surplus);
      return;
    }
    const next = waiting.shift();
    if (next) {
      next();
      continue;
    }
    if (pushed === stack.length) return;
    stack[pushed]!.pushed = true;
    history.pushState({ layerDepth: pushed + 1 }, '');
  }
}

/** Run `fn` once history stands where the open layers say it should: now, or after our traversal in flight. */
export function afterHistorySettles(fn: () => void): void {
  waiting.push(fn);
  reconcile();
}

/** Take layers `from` and above off the stack; the entries they had become stale, to be unwound. */
function drop(from: number): Layer[] {
  const removed = stack.splice(from);
  stale += removed.filter((l) => l.pushed).length;
  return removed;
}

function push(layer: Layer): void {
  stack.push(layer);
  reconcile();
}

/** Remove a layer (and any above it) whose UI already closed itself, unwinding its history entries silently. */
function release(id: number): void {
  const i = stack.findIndex((l) => l.id === id);
  // Already closed by Back or by a navigation: nothing to unwind.
  if (i < 0) return;
  // A layer that never got its entry (opened during a traversal) is simply forgotten: nothing will push for it.
  drop(i);
  reconcile();
}

/** Close a layer the way Back would: through history, so the popstate handler runs its close. */
function dismiss(id: number): void {
  const i = stack.findIndex((l) => l.id === id);
  if (i < 0) return;
  if (busy() || !stack[i]!.pushed) {
    // History is mid-traversal or holds no entry for it yet: close it directly and unwind once it is safe.
    for (const l of drop(i).reverse()) l.close();
    reconcile();
    return;
  }
  history.go(-(stack.length - i));
}

/** Whether any layer is open. */
export function hasLayers(): boolean {
  return stack.length > 0;
}

/**
 * Leave the current route: close every open layer, unwind their history entries, and only then run `commit` (the
 * route push or replace), so the new route gets exactly one entry and no traversal still in flight can undo it.
 * `commit` runs synchronously when nothing is open and nothing is in flight.
 */
export function leaveLayers(commit: () => void): void {
  for (const l of drop(0).reverse()) l.close();
  afterHistorySettles(commit);
}

/**
 * The app locked (revoked or unpaired) under its layers: close them all and forget their entries, without any
 * history traversal, so nothing steps the locked page back or races the navigation that follows.
 */
export function abandonLayers(): void {
  for (const l of drop(0).reverse()) l.close();
  stale = 0;
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
    push({ id, close: () => closeRef.current(), pushed: false });
    return () => {
      if (idRef.current === id) idRef.current = null;
      release(id);
    };
  }, [open]);
  return useCallback(() => {
    if (idRef.current != null && stack.some((l) => l.id === idRef.current)) dismiss(idRef.current);
    else closeRef.current();
  }, []);
}

/* ---------------- what covers the stage ---------------- */

/**
 * Whether something covers the workspace stage, so nothing on it can count as seen: the page is hidden, a modal
 * `<dialog>` is open (the navigator sheet, a workspace or settings sheet, a confirmation), or the editor is
 * expanded to full height. The file layers (viewer, comparison, All files) are not dialogs; the gallery tracks
 * those itself.
 */
export function stageCovered(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState === 'hidden') return true;
  return document.querySelector('dialog[open], .ws.editor-full') !== null;
}

const coverListeners = new Set<() => void>();
let coverObserver: MutationObserver | null = null;
const notifyCover = () => coverListeners.forEach((l) => l());

function subscribeCover(l: () => void): () => void {
  coverListeners.add(l);
  if (coverListeners.size === 1 && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', notifyCover);
    if (typeof MutationObserver !== 'undefined') {
      coverObserver = new MutationObserver(notifyCover);
      coverObserver.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['open', 'class'],
      });
    }
  }
  return () => {
    coverListeners.delete(l);
    if (coverListeners.size || typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', notifyCover);
    coverObserver?.disconnect();
    coverObserver = null;
  };
}

/** `stageCovered()`, as React state that follows it. */
export function useStageCovered(): boolean {
  return useSyncExternalStore(subscribeCover, stageCovered, () => false);
}
