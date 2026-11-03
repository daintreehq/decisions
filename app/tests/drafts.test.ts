import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/data/db.js';
import { Drafts, draftRowId } from '../src/data/outbox.js';
import { generateCacheKey } from '../src/data/seal.js';

/** The real sealed drafts store on fake IndexedDB, behind the app the draft store talks to. */
const h = vi.hoisted(() => ({ drafts: null as unknown }));
vi.mock('../src/app/controller.js', () => ({
  app: {
    subscribe: () => () => undefined,
    getSnapshot: () => ({ phase: 'ready' }),
    get drafts() {
      return h.drafts;
    },
  },
}));

import { drafts as store } from '../src/features/compose/draftStore.js';

let n = 0;
const dbName = () => `drafts-db-${++n}-${Math.random().toString(36).slice(2)}`;
let sealed: Drafts;

beforeEach(async () => {
  sealed = new Drafts(await Db.open(dbName()), await generateCacheKey());
  h.drafts = sealed;
  store.reset();
});

const loaded = async (q: string, mode: 'answer' | 'correction', revision: number) => {
  store.ensure(q, mode, revision);
  await vi.waitFor(() => expect(store.get(draftRowId(q, mode))!.loaded).toBe(true));
  return store.get(draftRowId(q, mode))!;
};

describe('correction drafts persist, reason included', () => {
  it('survive leaving and an app restart, beside the answer draft and sealed to their own row', async () => {
    const d = await loaded('q_corr_aaaa', 'correction', 1);
    store.edit(d.key, { selected: ['no'], reason: 'Canopy is the brand name.' });
    await store.flush(d.key);
    // Restart: memory is gone, storage is not.
    store.reset();
    const back = await loaded('q_corr_aaaa', 'correction', 1);
    expect(back).toMatchObject({
      mode: 'correction',
      selected: ['no'],
      reason: 'Canopy is the brand name.',
      notice: 'restored',
    });
    // The answer draft for the same question is a different row and stays empty.
    expect((await loaded('q_corr_aaaa', 'answer', 1)).reason).toBe('');
    // A correction row cannot be read as another question's.
    expect(await sealed.load(draftRowId('q_other_bbbb', 'correction'))).toBeNull();
  });

  it('a draft from an earlier revision keeps its words but never its choice', async () => {
    const d = await loaded('q_rev_aaaa', 'answer', 0);
    store.edit(d.key, { selected: ['yes'], text: 'ship it' });
    await store.flush(d.key);
    store.reset();
    const back = await loaded('q_rev_aaaa', 'answer', 2);
    expect(back).toMatchObject({ text: 'ship it', selected: [], notice: 'earlier' });
  });

  it('a restored draft stays bound to the revision it was reviewed against, so Send waits for Review update', async () => {
    const d = await loaded('q_bound_aaaa', 'answer', 0);
    store.edit(d.key, { text: 'ship it' });
    await store.flush(d.key);
    store.reset();
    const back = await loaded('q_bound_aaaa', 'answer', 2);
    // The Workspace's stale check is `draft.revision !== view.revision`.
    expect(back).toMatchObject({ revision: 0, notice: 'earlier', text: 'ship it' });
    store.rebind(back.key, 2);
    expect(store.get(back.key)!.revision).toBe(2);
  });

  it('a version 1 row of unknown revision needs review before it can be sent', async () => {
    await sealed.save('q_v1_cccc', { selected: ['yes'], text: 'old', reason: '' });
    const back = await loaded('q_v1_cccc', 'answer', 0);
    expect(back.revision).not.toBe(0);
    // Saving it again does not invent a revision for it.
    store.edit(back.key, { text: 'old, still' });
    await store.flush(back.key);
    expect((await sealed.load(back.key))!.revision).toBeNull();
  });

  it('reads version 1 rows conservatively, as written against revision 0', async () => {
    await sealed.save('q_v1_aaaa', { selected: ['yes'], text: 'old', reason: '' });
    expect(await sealed.load('q_v1_aaaa')).toMatchObject({ v: 2, revision: null, mode: 'answer' });
    expect(await loaded('q_v1_aaaa', 'answer', 0)).toMatchObject({
      selected: ['yes'],
      text: 'old',
    });
    store.reset();
    expect(await loaded('q_v1_aaaa', 'answer', 1)).toMatchObject({ selected: [], text: 'old' });
  });

  it('a sent draft is erased and nothing late can bring it back', async () => {
    const d = await loaded('q_sent_aaaa', 'answer', 0);
    store.edit(d.key, { text: 'final words' });
    const epoch = store.get(d.key)!.epoch;
    await store.sent(d.key);
    expect(store.write(d.key, { epoch }, () => ({ text: 'late dictation' }))).toBe(false);
    await store.flushAll();
    expect(await sealed.load(d.key)).toBeNull();
    expect(store.get(d.key)!.text).toBe('');
  });

  it('Clear draft offers Undo, and refuses writes planned before the clear', async () => {
    const d = await loaded('q_clear_aaaa', 'answer', 0);
    store.edit(d.key, { text: 'keep me' });
    const epoch = store.get(d.key)!.epoch;
    store.clear(d.key);
    expect(store.get(d.key)!.text).toBe('');
    expect(store.write(d.key, { epoch }, () => ({ text: 'late' }))).toBe(false);
    store.get(d.key)!.undo!.restore();
    expect(store.get(d.key)!.text).toBe('keep me');
  });
});
