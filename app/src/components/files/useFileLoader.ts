import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { app, type ImageResult } from '../../app/controller.js';
import type { QuestionView } from '../../domain/model.js';
import { loadOrder, type FileItem } from './sequence.js';

/** How many files download and verify at once. */
export const LOAD_CONCURRENCY = 2;

/**
 * Bounded, prioritised loading (guide 5.2): the active file first, then its neighbours outwards, at most
 * LOAD_CONCURRENCY at a time. When the active file changes, the next free slot goes to the new neighbourhood.
 * Failures are not retried automatically; `retry` asks again for one file. Expired and unverified files are final.
 */
export function useFileLoader(view: QuestionView, items: readonly FileItem[], active: number) {
  // Keyed by the file's identity (attachment and digest), so a changed file never inherits an old result.
  const [byKey, setResults] = useState<Record<string, ImageResult>>({});
  const resultsRef = useRef(byKey);
  const inflight = useRef(new Set<string>());
  const gen = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeRef = useRef(active);
  activeRef.current = active;
  const itemKey = items.map((i) => i.key).join(',');

  const pump = useCallback(() => {
    const list = itemsRef.current;
    const g = gen.current;
    for (const i of loadOrder(list.length, activeRef.current)) {
      if (inflight.current.size >= LOAD_CONCURRENCY) break;
      const { d, key } = list[i]!;
      if (resultsRef.current[key] || inflight.current.has(key)) continue;
      inflight.current.add(key);
      void app.loadImage(viewRef.current, d).then((loaded) => {
        if (g !== gen.current) return;
        inflight.current.delete(key);
        // The image cache is keyed by attachment; bytes that are not the ones this descriptor signs are not shown.
        const r: ImageResult =
          loaded.ok && loaded.image.sha256 !== d.sha256
            ? { ok: false, reason: 'unverified', message: 'This file could not be verified' }
            : loaded;
        resultsRef.current = { ...resultsRef.current, [key]: r };
        setResults(resultsRef.current);
        pump();
      });
    }
  }, []);

  // A new question or a changed set of files starts over; results for files that are still present survive.
  // The files shown are held in the image cache while mounted; letting go aborts their downloads and lets the
  // cache revoke their decrypted URLs.
  useEffect(() => {
    const holds = items.map((it) => app.images.retain(it.d.attachment_id));
    gen.current++;
    inflight.current.clear();
    const keep: Record<string, ImageResult> = {};
    for (const it of items) {
      const r = resultsRef.current[it.key];
      if (r) keep[it.key] = r;
    }
    resultsRef.current = keep;
    setResults(keep);
    pump();
    return () => {
      gen.current++;
      inflight.current.clear();
      holds.forEach((release) => release());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id, itemKey, pump]);

  useEffect(() => pump(), [active, pump]);

  const retry = useCallback(
    (id: string) => {
      const key = itemsRef.current.find((i) => i.d.attachment_id === id)?.key;
      const r = key ? resultsRef.current[key] : undefined;
      if (!key || !r || r.ok || r.reason !== 'error') return;
      const next = { ...resultsRef.current };
      delete next[key];
      resultsRef.current = next;
      setResults(next);
      pump();
    },
    [pump],
  );

  // Callers read results by attachment id, for the files currently in the sequence only.
  const results = useMemo(() => {
    const out: Record<string, ImageResult> = {};
    for (const it of items) {
      const r = byKey[it.key];
      if (r) out[it.d.attachment_id] = r;
    }
    return out;
  }, [byKey, items]);

  return { results, retry };
}
