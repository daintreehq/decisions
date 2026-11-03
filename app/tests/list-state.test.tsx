// @vitest-environment happy-dom
import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Recent Node versions define a global `localStorage` that is undefined without a backing file, which hides
// happy-dom's. Give the tests a plain in-memory one.
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
});

type Mod = typeof import('../src/app/listState.js');

async function fresh(): Promise<Mod> {
  vi.resetModules();
  return import('../src/app/listState.js');
}

beforeEach(() => {
  history.replaceState(null, '', '/');
});
afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('list preferences', () => {
  it('persists scope, sort and History mode per device, and filters only as digests', async () => {
    let m = await fresh();
    m.setQuestions({ scope: 'model', sort: 'newest', project: 'billing-api', computer: 'Studio' });
    m.setHistory({ mode: 'all', query: 'secret words' });
    const stored = window.localStorage.getItem('decisions:lists:v1')!;
    expect(stored).not.toContain('billing-api');
    expect(stored).not.toContain('Studio');
    expect(stored).not.toContain('secret');

    m = await fresh();
    const s = m.getNavState();
    expect(s.questions).toMatchObject({ scope: 'model', sort: 'newest', project: null, query: '' });
    expect(s.history).toMatchObject({ mode: 'all', query: '' });
    // The filter comes back once its label is on the device again.
    m.resolvePersistedFilters(['daintree', 'billing-api'], ['MacBook', 'Studio']);
    expect(m.getNavState().questions).toMatchObject({ project: 'billing-api', computer: 'Studio' });
  });

  it('forgets everything on reset (unpair or revoke)', async () => {
    const m = await fresh();
    m.setQuestions({ scope: 'all', query: 'x' });
    m.resetNavState();
    expect(m.getNavState().questions).toMatchObject({ scope: 'needs', query: '' });
    expect(window.localStorage.getItem('decisions:lists:v1')).toBeNull();
  });
});

describe('origin-aware Back', () => {
  it('a question opened from Questions pops back to it', async () => {
    const m = await fresh();
    const go = vi.spyOn(history, 'go').mockImplementation(() => undefined);
    m.openQuestion('q1', 'questions');
    expect(location.pathname).toBe('/q/q1');
    expect(m.backTarget()).toBe('/');
    expect(m.backLabel()).toBe('Questions');
    m.goBack();
    expect(go).toHaveBeenCalledWith(-1);
  });

  it('from History it returns to History; a lateral move keeps that origin', async () => {
    const m = await fresh();
    history.replaceState(null, '', '/history');
    m.setHistory({ query: 'rename' });
    m.openQuestion('q1', 'history');
    expect(m.backTarget()).toBe('/history');
    expect(m.backLabel()).toBe('History');
    // Choosing another question from the navigator: Back still goes to History, by navigating there.
    m.openQuestion('q2', 'questions');
    expect(location.pathname).toBe('/q/q2');
    expect(m.backTarget()).toBe('/history');
    m.goBack();
    expect(location.pathname).toBe('/history');
    // The list's session state is intact for it to restore.
    expect(m.getNavState().history.query).toBe('rename');
  });

  it('survives a reload through the history entry', async () => {
    let m = await fresh();
    history.replaceState(null, '', '/history');
    m.openQuestion('q9', 'history');
    m = await fresh(); // a new module instance has an empty in-memory map
    expect(m.backTarget()).toBe('/history');
  });

  it('a direct link goes Back to Questions, replacing itself', async () => {
    const m = await fresh();
    history.replaceState(null, '', '/q/direct');
    const replace = vi.spyOn(history, 'replaceState');
    expect(m.backTarget()).toBe('/');
    m.goBack();
    expect(location.pathname).toBe('/');
    expect(replace).toHaveBeenCalled();
  });
});

describe('list restoration', () => {
  it('remembers the opened row and gives it focus back once on the next mount', async () => {
    const m = await fresh();
    m.rememberRow('questions', 'b', null);
    expect(m.getNavState().questions).toMatchObject({ anchor: { id: 'b' }, focusId: 'b' });

    function List() {
      const ref = useRef<HTMLDivElement>(null);
      m.useRestoreList('questions', ref, true);
      return createElement(
        'div',
        { ref },
        ['a', 'b', 'c'].map((id) =>
          createElement('a', { key: id, href: `#${id}`, 'data-row-id': id }, id),
        ),
      );
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(List)));
    expect((document.activeElement as HTMLElement).dataset.rowId).toBe('b');
    expect(m.getNavState().questions.focusId).toBeNull();
    expect(m.getNavState().questions.anchor?.id).toBe('b');
    await act(async () => root.unmount());
    host.remove();
  });

  it('keeps a remembered position when reopened without a row', async () => {
    const m = await fresh();
    m.setHistory({ anchor: { id: 'r', offset: 240 } });
    m.rememberRow('history', 'r', null);
    expect(m.getNavState().history.anchor).toEqual({ id: 'r', offset: 240 });
  });
});
