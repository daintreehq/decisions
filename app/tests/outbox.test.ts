import { describe, expect, it, vi } from 'vitest';
import { Db, openAppDb, type Migration, MIGRATIONS } from '../src/data/db.js';
import { Drafts, Outbox, type Poster } from '../src/data/outbox.js';
import { RelayError } from '../src/data/relay.js';
import { generateCacheKey } from '../src/data/seal.js';

let n = 0;
const dbName = () => `test-db-${++n}-${Math.random().toString(36).slice(2)}`;

function entry(over: Partial<Parameters<Outbox['enqueue']>[0]> = {}) {
  const id = over.id ?? `id_${Math.random().toString(36).slice(2, 12)}`;
  return {
    id,
    questionId: 'question_aaaa',
    kind: 'answer' as const,
    path: '/questions/question_aaaa/answer',
    bodyText: JSON.stringify({ body: id }),
    idempotencyKey: `idem_${id}`,
    expectedRevision: 0,
    selected: ['yes'],
    text: 'SECRET-USER-TEXT',
    reason: '',
    ...over,
  };
}

const poster = (impl: (path: string, body: string) => Promise<unknown>): Poster => ({
  jsonRaw: ((_m: string, path: string, body: string) => impl(path, body)) as Poster['jsonRaw'],
});

describe('outbox', () => {
  it('stores nothing in plaintext and survives a restart', async () => {
    const name = dbName();
    const key = await generateCacheKey();
    const db = await Db.open(name);
    const ob = new Outbox(db, key, () => poster(async () => ({})));
    await ob.enqueue(entry({ id: 'durable_1' }));
    const row = (await db.outbox())[0]!;
    const blob = JSON.stringify([...row.sealed.ct]) + JSON.stringify(row);
    expect(blob).not.toContain('SECRET-USER-TEXT');
    expect(row.sealed.ct.length).toBeGreaterThan(20);
    db.close();

    const db2 = await Db.open(name);
    const ob2 = new Outbox(db2, key, () => poster(async () => ({})));
    await ob2.load();
    expect(ob2.list().map((e) => e.id)).toEqual(['durable_1']);
    expect(ob2.list()[0]).toMatchObject({ text: 'SECRET-USER-TEXT', state: 'queued' });
    db2.close();
  });

  it('refuses rows sealed for a different id (tamper / swap)', async () => {
    const name = dbName();
    const key = await generateCacheKey();
    const db = await Db.open(name);
    const ob = new Outbox(db, key, () => poster(async () => ({})));
    await ob.enqueue(entry({ id: 'row_a' }));
    const [row] = await db.outbox();
    await db.putOutbox({ ...row!, id: 'row_b' }); // sealed under the label of row_a
    await db.deleteOutbox('row_a');
    const reloaded = new Outbox(db, key, () => poster(async () => ({})));
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(0);
    expect(await db.outbox()).toHaveLength(0); // the unreadable row was removed, not trusted
  });

  it('sends oldest first with the exact stored body and removes on success', async () => {
    const key = await generateCacheKey();
    const db = await Db.open(dbName());
    const sent: [string, string][] = [];
    const committed: string[] = [];
    const ob = new Outbox(db, key, () => poster(async (p, b) => void sent.push([p, b])), {
      onCommitted: (e) => committed.push(e.id),
    });
    await ob.enqueue(entry({ id: 'c', createdAt: 3 }));
    await ob.enqueue(entry({ id: 'a', createdAt: 1 }));
    await ob.enqueue(entry({ id: 'b', createdAt: 2 }));
    await ob.flush();
    expect(sent.map(([, b]) => JSON.parse(b).body)).toEqual(['a', 'b', 'c']);
    expect(committed).toEqual(['a', 'b', 'c']);
    expect(ob.list()).toHaveLength(0);
    expect(await db.outbox()).toHaveLength(0);
  });

  it('keeps everything queued on a network error and retries byte-identically', async () => {
    const key = await generateCacheKey();
    const db = await Db.open(dbName());
    let online = false;
    const bodies: string[] = [];
    const ob = new Outbox(db, key, () =>
      poster(async (_p, b) => {
        bodies.push(b);
        if (!online) throw new RelayError('network', 0, 'offline');
      }),
    );
    await ob.enqueue(entry({ id: 'first', createdAt: 1 }));
    await ob.enqueue(entry({ id: 'second', createdAt: 2 }));
    await ob.flush();
    expect(bodies).toHaveLength(1); // stopped at the first failure; order is preserved
    expect(ob.list().map((e) => [e.id, e.state, e.attempts])).toEqual([
      ['first', 'queued', 1],
      ['second', 'queued', 0],
    ]);
    expect(ob.pendingState('question_aaaa')).toBe('queued');
    online = true;
    await ob.flush();
    expect(bodies.slice(1)).toEqual([bodies[0], JSON.stringify({ body: 'second' })]);
    expect(ob.list()).toHaveLength(0);
  });

  it('marks a revision conflict, keeps the human’s text, and does not retry it', async () => {
    const key = await generateCacheKey();
    const db = await Db.open(dbName());
    const post = vi.fn(async (_p: string, b: string) => {
      if (JSON.parse(b).body === 'loser')
        throw new RelayError('revision_conflict', 409, 'changed', { latest_revision: 1 });
    });
    const ob = new Outbox(db, key, () => poster(post));
    await ob.enqueue(entry({ id: 'loser', createdAt: 1, text: 'my careful reasoning' }));
    await ob.enqueue(
      entry({
        id: 'other',
        createdAt: 2,
        questionId: 'question_bbbb',
        path: '/questions/question_bbbb/answer',
      }),
    );
    await ob.flush();
    const loser = ob.list().find((e) => e.id === 'loser')!;
    expect(loser).toMatchObject({
      state: 'conflicted',
      text: 'my careful reasoning',
      latestRevision: 1,
    });
    expect(ob.pendingState('question_aaaa')).toBeUndefined();
    expect(ob.list().find((e) => e.id === 'other')).toBeUndefined(); // later entries still went through
    await ob.flush();
    expect(post).toHaveBeenCalledTimes(2); // the conflicted one is not re-sent

    // Survives a restart so the human can still copy their words.
    const again = new Outbox(db, key, () => poster(post));
    await again.load();
    expect(again.list()[0]).toMatchObject({
      id: 'loser',
      state: 'conflicted',
      text: 'my careful reasoning',
    });
    await again.discard('loser');
    expect(again.list()).toHaveLength(0);
  });

  it('maps expiry and other definitive refusals to their own states', async () => {
    const key = await generateCacheKey();
    const db = await Db.open(dbName());
    const ob = new Outbox(db, key, () =>
      poster(async (_p, b) => {
        const id = JSON.parse(b).body;
        if (id === 'x') throw new RelayError('expired', 410, 'expired');
        throw new RelayError('forbidden', 403, 'nope');
      }),
    );
    await ob.enqueue(entry({ id: 'x', createdAt: 1 }));
    await ob.enqueue(entry({ id: 'y', createdAt: 2 }));
    await ob.flush();
    expect(ob.list().map((e) => e.state)).toEqual(['expired', 'rejected']);
  });

  it('treats a crash mid-send as queued after restart (idempotency key makes the resend safe)', async () => {
    const name = dbName();
    const key = await generateCacheKey();
    const db = await Db.open(name);
    let release: () => void = () => undefined;
    const ob = new Outbox(db, key, () => poster(() => new Promise<void>((r) => (release = r))));
    await ob.enqueue(entry({ id: 'mid' }));
    const flushing = ob.flush();
    await Promise.resolve();
    expect(ob.list()[0]!.state).toBe('sending');
    // Simulate a kill: reopen from storage while the first send never finished.
    const db2 = await Db.open(name);
    const revived = new Outbox(db2, key, () => poster(async () => undefined));
    await revived.load();
    expect(revived.list()[0]).toMatchObject({
      id: 'mid',
      state: 'queued',
      idempotencyKey: 'idem_mid',
    });
    release();
    await flushing;
  });

  it('coalesces concurrent flushes', async () => {
    const key = await generateCacheKey();
    const db = await Db.open(dbName());
    const post = vi.fn(async () => undefined);
    const ob = new Outbox(db, key, () => poster(post));
    await ob.enqueue(entry({ id: 'once' }));
    await Promise.all([ob.flush(), ob.flush(), ob.flush()]);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('drafts', () => {
  it('round-trips sealed drafts and refuses a draft moved to another question', async () => {
    const key = await generateCacheKey();
    const db = await Db.open(dbName());
    const d = new Drafts(db, key);
    await d.save('q_one_aaaa', { selected: ['yes'], text: 'half-written', reason: '' });
    expect(await d.load('q_one_aaaa')).toMatchObject({ text: 'half-written' });
    const raw = await db.getDraft('q_one_aaaa');
    await db.putDraft({ ...raw!, questionId: 'q_two_bbbb' });
    expect(await d.load('q_two_bbbb')).toBeNull();
    await d.delete('q_one_aaaa');
    expect(await d.load('q_one_aaaa')).toBeNull();
  });
});

describe('schema migrations never destroy unsent work', () => {
  it('keeps outbox and drafts when a later version adds a store', async () => {
    const name = dbName();
    const key = await generateCacheKey();
    const v1 = await Db.open(name, MIGRATIONS);
    const ob = new Outbox(v1, key, () => poster(async () => undefined));
    await ob.enqueue(entry({ id: 'keepme' }));
    await new Drafts(v1, key).save('qdraft_aaaa', {
      selected: [],
      text: 'draft survives',
      reason: '',
    });
    v1.close();

    const v2Migration: Migration = (db) => {
      db.createObjectStore('notes');
    };
    const raw = await openAppDb(name, [...MIGRATIONS, v2Migration]);
    expect([...raw.objectStoreNames]).toContain('notes');
    raw.close();

    const v2 = await Db.open(name, [...MIGRATIONS, v2Migration]);
    const ob2 = new Outbox(v2, key, () => poster(async () => undefined));
    await ob2.load();
    expect(ob2.list().map((e) => e.id)).toEqual(['keepme']);
    expect(await new Drafts(v2, key).load('qdraft_aaaa')).toMatchObject({ text: 'draft survives' });
  });
});
