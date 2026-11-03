import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Back closes the topmost workspace layer (file viewer, sheet, expanded editor, navigator) before it leaves the
 * page. Each open layer owns one history entry that carries only a depth marker (never content, never a path
 * change). Browser Back pops it and closes the layer; a layer closed any other way (its Close button, Escape, its
 * own state) has its entry unwound silently, so history never accumulates dead entries.
 *
 * `history.go` is asynchronous. While one of our own traversals is in flight, every other history change (a layer's
 * push, another unwind, a route navigation) waits for its popstate and then runs in order, against the entry the
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
/** Work that changes history, waiting for our traversal in flight to land. Runs in order. */
const waiting: Array<() => void> = [];
/** History entries of layers that have closed and are still to be unwound (they sit above the open ones). */
let stale = 0;

/**
 * A `history.go` of ours whose popstate has not arrived. The browser performs traversals in the order they were
 * asked for, so popstates are matched to them oldest first.
 */
interface Traversal {
  delta: number;
  /** Whether history stands where this traversal was going. */
  lands: () => boolean;
  /** Route Back: once it lands, close the layers above the entry, as Back would. */
  closes: boolean;
  /** Given up on: if its popstate still comes, history moved on without it, and the move is undone. */
  late: boolean;
  /** Issued from where an undone late traversal left history: the traversal undoing it settles instead. */
  displaced: boolean;
  /** For a late traversal: after this (`Date.now()`), it is taken as never coming. */
  expires: number;
}
const traversals: Traversal[] = [];
let watchdog: ReturnType<typeof setTimeout> | null = null;
/** A traversal whose popstate never arrives (the browser refused it) must not stall navigation for good. */
const TRAVERSAL_TIMEOUT_MS = 1000;
/** How long a traversal given up on may still arrive and be undone; past it, a popstate is the person's own. */
const LATE_WINDOW_MS = 2000;

function depthOf(state: unknown): number {
  return (state as { layerDepth?: number } | null)?.layerDepth ?? 0;
}

/** Dead entries under (and including) the current one, left by an unwind the browser never performed. */
function skipOf(state: unknown): number {
  return (state as { layerSkip?: number } | null)?.layerSkip ?? 0;
}

const busy = () => traversals.some((t) => !t.late);

function closeAbove(depth: number): void {
  while (stack.length > depth) stack.pop()!.close();
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (e) => {
    while (traversals[0]?.late && traversals[0].expires < Date.now()) traversals.shift();
    const t = traversals.shift();
    if (!t) {
      closeAbove(depthOf(e.state));
      return;
    }
    if (t.late) {
      // The browser performed a traversal we gave up on, after history moved on without it: step back. Traversals
      // still to come were issued from where it left, so they are intermediate steps; the return settles them.
      const rest = traversals.filter((r) => !r.late);
      for (const r of rest) r.displaced = true;
      traverse(
        -t.delta,
        rest.at(-1)?.lands ?? (() => true),
        rest.some((r) => r.closes),
      );
      return;
    }
    if (t.displaced) return;
    // Verify where it landed: layers above the entry history stands on have lost their entries, whatever we expected.
    if (t.closes || !t.lands()) closeAbove(depthOf(e.state));
    if (!busy()) landed();
  });
}

function landed(): void {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  reconcile();
}

/** Our popstate did not come in time: establish where history stands before anything else changes it. */
function timedOut(): void {
  watchdog = null;
  const pending = traversals.filter((t) => !t.late);
  const last = pending.at(-1);
  if (!last) return;
  if (last.lands()) {
    // It happened; only its popstate was lost.
    traversals.length = 0;
    if (last.closes) closeAbove(depthOf(history.state));
  } else {
    const expires = Date.now() + LATE_WINDOW_MS;
    for (const t of pending) Object.assign(t, { late: true, displaced: false, expires });
    const unwound = depthOf(history.state) - stack.filter((l) => l.pushed).length;
    if (unwound > 0) {
      // Still standing on entries a silent unwind was to remove: this one now stands for the page under them, and
      // the next entry (a navigation, a layer) takes its place instead of stacking on it.
      history.replaceState(
        {
          ...(history.state as object | null),
          layerDepth: depthOf(history.state) - unwound,
          layerSkip: unwound,
        },
        '',
      );
    }
  }
  reconcile();
}

/** Start a traversal of ours. Everything else that changes history waits until it lands. */
function traverse(delta: number, lands: () => boolean, closes = false): void {
  traversals.push({ delta, lands, closes, late: false, displaced: false, expires: 0 });
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(timedOut, TRAVERSAL_TIMEOUT_MS);
  history.go(delta);
}

/** Go back `n` entries without treating the popstate as Back. */
function unwindSilently(n: number): void {
  const expect = depthOf(history.state) - n;
  traverse(-n, () => depthOf(history.state) === expect);
}

/**
 * Add a history entry. An entry left by an unwind the browser never performed is taken over (replaced) instead, so
 * Back does not meet it.
 */
export function addEntry(state: unknown, url?: string, replace = false): void {
  history[replace || skipOf(history.state) > 0 ? 'replaceState' : 'pushState'](state, '', url);
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
    addEntry({ layerDepth: pushed + 1 });
  }
}

/** Run `fn` once history stands where the open layers say it should: now, or after our traversal in flight. */
export function afterHistorySettles(fn: () => void): void {
  waiting.push(fn);
  reconcile();
}

/**
 * Leave the page for the history entry `back` entries below it (layer entries above it not counted), once any
 * traversal in flight has landed. Open layers close when it lands, as Back closes them, and history work asked for
 * meanwhile waits for it.
 */
export function goBackPast(back: number): void {
  afterHistorySettles(() => {
    const from = location.href;
    const fromDepth = depthOf(history.state);
    const n = fromDepth + skipOf(history.state) + back;
    traverse(-n, () => location.href !== from || depthOf(history.state) !== fromDepth, true);
  });
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

/**
 * Close a layer from its own UI (a Close button, Escape): close it and any above it now, and unwind their entries
 * as one tracked traversal. A second Close before that lands finds nothing left to unwind.
 */
function dismiss(id: number): void {
  const i = stack.findIndex((l) => l.id === id);
  if (i < 0) return;
  for (const l of drop(i).reverse()) l.close();
  reconcile();
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
 * (it closes the layer and any above it at once, then unwinds their entries; calling it again is harmless). If the
 * component closes the layer by state instead, its history entry is unwound silently too.
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
