import { describe, expect, it } from 'vitest';
import { Db } from '../src/data/db.js';
import { Outbox, type OutboxImage, type Poster, type Rebuilt } from '../src/data/outbox.js';
import { RelayError } from '../src/data/relay.js';
import { generateCacheKey } from '../src/data/seal.js';

let n = 0;
const dbName = () => `photos-db-${++n}-${Math.random().toString(36).slice(2)}`;

/** Recognisable bytes standing in for a photo's ciphertext, so the tests can look for them at rest. */
const MARK = new TextEncoder().encode('CIPHERTEXT-OF-A-PHOTO-0123456789');

const image = (id: string, over: Partial<OutboxImage> = {}): OutboxImage => ({
  attachmentId: id,
  reserveKey: `rk_${id}`,
  mime: 'image/jpeg',
  size: MARK.length - 16,
  sha256: 'a'.repeat(64),
  nonce: 'AAAAAAAAAAAAAAAA',
  keyEpoch: 1,
  ciphertextBytes: MARK.length,
  sha256Ciphertext: 'b'.repeat(64),
  width: 2048,
  height: 1536,
  stage: 'new',
  ...over,
});

function entry(id: string, images: OutboxImage[], kind: 'answer' | 'message' = 'answer') {
  return {
    id,
    questionId: 'question_aaaa',
    kind,
    recordId: `rec_${id}`,
    ...(kind === 'message' ? { messageId: `rec_${id}` } : {}),
    path:
      kind === 'message' ? '/questions/question_aaaa/messages' : '/questions/question_aaaa/answer',
    bodyText: JSON.stringify({ body: id }),
    idempotencyKey: `idem_${id}`,
    expectedRevision: 0,
    selected: [],
    text: 'WORDS-THAT-MUST-SURVIVE',
    reason: '',
    images,
  };
}

/** A fake relay: records every call in order, and fails the ones a test asks it to. */
function relay(fail: (step: string, path: string) => RelayError | null = () => null) {
  const calls: string[] = [];
  const p: Poster = {
    jsonRaw: (async (_m: string, path: string, body: string) => {
      const step = path.endsWith('/images/reservations')
        ? 'reserve'
        : path.endsWith('/complete')
          ? 'complete'
          : 'commit';
      calls.push(`${step} ${step === 'reserve' ? JSON.parse(body).attachment_id : path}`);
      const err = fail(step, path);
      if (err) throw err;
      return {};
    }) as Poster['jsonRaw'],
    upload: async (path, bytes, _sha, onProgress) => {
      calls.push(`upload ${path}`);
      const err = fail('upload', path);
      if (err) throw err;
      expect(bytes).toEqual(MARK);
      onProgress?.(0.5);
      onProgress?.(1);
      return {};
    },
  };
  return { p, calls };
}

const ciphertexts = (...ids: string[]) => new Map(ids.map((id) => [id, MARK]));

describe('photos in the outbox', () => {
  it('reserves, uploads and completes each photo before the record, and keeps only ciphertext at rest', async () => {
    const db = await Db.open(dbName());
    const key = await generateCacheKey();
    const { p, calls } = relay();
    const ob = new Outbox(db, key, () => p, {}, []);
    await ob.enqueue(
      entry('e1', [image('img_one_aaaa'), image('img_two_bbbb')]),
      ciphertexts('img_one_aaaa', 'img_two_bbbb'),
    );
    // Sealed: neither the words nor the photo's bytes are readable in storage.
    expect(await db.countBlobs()).toBe(2);
    const row = await db.getBlob('outbox-image:e1:img_one_aaaa');
    expect(Buffer.from(row!.sealed.ct).includes(Buffer.from(MARK))).toBe(false);
    await ob.flush();
    expect(calls).toEqual([
      'reserve img_one_aaaa',
      'upload /attachments/img_one_aaaa/content',
      'complete /attachments/img_one_aaaa/complete',
      'reserve img_two_bbbb',
      'upload /attachments/img_two_bbbb/content',
      'complete /attachments/img_two_bbbb/complete',
      'commit /questions/question_aaaa/answer',
    ]);
    expect(ob.list()).toHaveLength(0);
    expect(await db.countBlobs()).toBe(0);
  });

  it('keeps the words and carries on from where it stopped when an upload drops', async () => {
    const db = await Db.open(dbName());
    const key = await generateCacheKey();
    let down = true;
    const { p, calls } = relay((step) =>
      step === 'upload' && down ? new RelayError('network', 0, 'Could not reach the relay') : null,
    );
    const ob = new Outbox(db, key, () => p, {}, []);
    await ob.enqueue(entry('e2', [image('img_drop_aaaa')]), ciphertexts('img_drop_aaaa'));
    await ob.flush();
    const [e] = ob.list();
    expect(e).toMatchObject({ state: 'queued', text: 'WORDS-THAT-MUST-SURVIVE' });
    expect(e!.images![0]!.stage).toBe('reserved');
    expect(ob.uploadStopped('e2')).toBe(true);
    expect(ob.photoState(e!, 'img_drop_aaaa')).toEqual({ kind: 'interrupted' });
    // A restart in between loses nothing: the stage is stored with the entry.
    const again = new Outbox(db, key, () => p, {}, []);
    await again.load();
    down = false;
    await again.retryNow();
    expect(calls.filter((c) => c.startsWith('reserve'))).toHaveLength(1);
    expect(calls.at(-1)).toBe('commit /questions/question_aaaa/answer');
    expect(again.list()).toHaveLength(0);
  });

  it('marks a photo the relay refuses, and keeps the entry for the person', async () => {
    const db = await Db.open(dbName());
    const key = await generateCacheKey();
    const { p, calls } = relay((step) =>
      step === 'reserve'
        ? new RelayError('payload_too_large', 413, 'too many images for this question')
        : null,
    );
    const ob = new Outbox(db, key, () => p, {}, []);
    await ob.enqueue(
      entry('e3', [image('img_full_aaaa')], 'message'),
      ciphertexts('img_full_aaaa'),
    );
    await ob.flush();
    expect(ob.list()[0]).toMatchObject({
      state: 'rejected',
      refusedAt: 'image',
      errorCode: 'payload_too_large',
      text: 'WORDS-THAT-MUST-SURVIVE',
    });
    expect(calls.some((c) => c.startsWith('commit'))).toBe(false);
  });

  it('signs the record again with fresh photo ids once, when the relay lost a reservation', async () => {
    const db = await Db.open(dbName());
    const key = await generateCacheKey();
    let commits = 0;
    const { p, calls } = relay((step) =>
      step === 'commit' && ++commits === 1
        ? new RelayError('validation_error', 400, 'image is not an uploaded image reserved')
        : null,
    );
    const rebuilt: Rebuilt = {
      entry: {
        path: '/questions/question_aaaa/answer',
        bodyText: JSON.stringify({ body: 'e4-again' }),
        idempotencyKey: 'idem_e4_again',
        recordId: 'rec_e4_again',
        images: [image('img_fresh_bbbb')],
      },
      ciphertexts: ciphertexts('img_fresh_bbbb'),
    };
    const ob = new Outbox(
      db,
      key,
      () => p,
      {
        decrypt: async () => new Uint8Array([1, 2, 3]),
        rebuild: async (_e, plaintexts) => {
          expect(plaintexts).toHaveLength(1);
          return rebuilt;
        },
      },
      [],
    );
    await ob.enqueue(entry('e4', [image('img_lost_aaaa')]), ciphertexts('img_lost_aaaa'));
    await ob.flush();
    expect(calls).toContain('reserve img_fresh_bbbb');
    expect(calls.filter((c) => c.startsWith('commit'))).toHaveLength(2);
    expect(ob.list()).toHaveLength(0);
    expect(await db.countBlobs()).toBe(0);
  });

  it('keeps a committed entry until the thread has read it back', async () => {
    const db = await Db.open(dbName());
    const key = await generateCacheKey();
    const { p, calls } = relay();
    let inThread = false;
    const ob = new Outbox(
      db,
      key,
      () => p,
      { settle: async () => undefined, inThread: () => inThread },
      [],
    );
    await ob.enqueue(entry('e5', [image('img_kept_aaaa')]), ciphertexts('img_kept_aaaa'));
    await ob.flush();
    // On the relay, never sent again, but still shown here as saved on the relay.
    expect(ob.list()[0]).toMatchObject({ state: 'committed', text: 'WORDS-THAT-MUST-SURVIVE' });
    await ob.flush();
    expect(calls.filter((c) => c.startsWith('commit'))).toHaveLength(1);
    inThread = true;
    ob.reconcile();
    await new Promise((r) => setTimeout(r, 20));
    expect(ob.list()).toHaveLength(0);
    expect(await db.countBlobs()).toBe(0);
  });
});
