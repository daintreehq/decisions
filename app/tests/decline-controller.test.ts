// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATOR_MISSING_FEATURE,
  type DeviceInfo,
  type DevicesResponse,
  type LedgerEvent,
} from '@daintreehq/decisions-protocol';
import { AppController } from '../src/app/controller.js';
import { Db } from '../src/data/db.js';
import { Drafts, Outbox, type OutboxEntry, type OutboxHooks } from '../src/data/outbox.js';
import { RelayError } from '../src/data/relay.js';
import { generateCacheKey } from '../src/data/seal.js';
import { StaleQuestionError } from '../src/domain/answer.js';
import {
  DeclineBlockedError,
  DeclineInFlightError,
  declineStanding,
} from '../src/domain/decline.js';
import { QuestionStore, type QuestionView } from '../src/domain/model.js';
import { actionEvent, makeWorld, plainEvent, questionEvent } from './helpers.js';

/** The controller's private seams, reached the way its own code reaches them. */
type Inside = {
  patch(p: { devices: DevicesResponse | null }): void;
  keys: unknown;
  relay: unknown;
  snap: { config: unknown };
  store: QuestionStore | null;
  outbox: Outbox | null;
  sync: unknown;
  epochKeys: unknown;
  refreshDevices(): Promise<void>;
  resume(): void;
  outboxHooks(): OutboxHooks;
};
const inside = (c: AppController) => c as unknown as Inside;

const device = (id: string, o: { features?: string[]; revoked?: boolean } = {}): DeviceInfo =>
  ({
    device_id: id,
    role: 'owner-desktop',
    label: 'Mac',
    revoked_at: o.revoked ? new Date().toISOString() : null,
    ...(o.features ? { features: o.features } : {}),
  }) as unknown as DeviceInfo;

async function openQuestion(): Promise<{
  w: Awaited<ReturnType<typeof makeWorld>>;
  view: QuestionView;
  store: QuestionStore;
}> {
  const w = await makeWorld();
  const s = new QuestionStore({
    installationId: w.installationId,
    trust: w.trust,
    epochKeys: () => w.epochs,
  });
  const q = await questionEvent(w);
  await s.ingest(q);
  return { w, view: s.get(q.question_id!)!, store: s };
}

let dbN = 0;

/**
 * A paired phone with one open question and a relay that answers as `relay.answer` says. What the relay commits is
 * read back by `catchUp`, as the sync engine would. The outbox is the one the app builds, on IndexedDB, so a new
 * harness on the same database is the app reopened.
 */
async function phone(
  o: {
    q?: Awaited<ReturnType<typeof openQuestion>>;
    dbName?: string;
    cacheKey?: CryptoKey;
    /** How long a failed send waits before the outbox tries again on its own; never, by default. */
    retryDelays?: number[];
  } = {},
) {
  const q = o.q ?? (await openQuestion());
  const { w, store, view } = q;
  const dbName = o.dbName ?? `decline-db-${++dbN}-${Math.random().toString(36).slice(2)}`;
  const cacheKey = o.cacheKey ?? (await generateCacheKey());
  const db = await Db.open(dbName);
  const c = new AppController('https://relay.example');
  const refresh = vi.fn(async () => undefined);
  inside(c).refreshDevices = refresh;
  inside(c).keys = { signingPrivate: w.phone.keys.signing.privateKey };
  inside(c).epochKeys = w.epochs;
  inside(c).snap.config = { installationId: w.installationId, deviceId: w.phone.id };
  inside(c).store = store;
  /** Events the relay committed that this phone has not read yet. */
  const unread: LedgerEvent[] = [];
  // Joins a read already under way, as the sync engine's does.
  let reading: Promise<void> | null = null;
  const catchUp = vi.fn(() => {
    reading ??= (async () => {
      while (unread.length) await store.ingestAll(unread.splice(0));
    })().finally(() => {
      reading = null;
    });
    return reading;
  });
  inside(c).sync = { catchUp };
  const posts: { path: string; body: string }[] = [];
  const relay = {
    /** What the relay does with the next post; a cancel it takes is committed and read back on catch-up. */
    answer: async (_body: string): Promise<unknown> => {
      throw new RelayError('network_error', 0, 'offline');
    },
  };
  const outbox = new Outbox(
    db,
    cacheKey,
    () => ({
      jsonRaw: (async (_m: string, path: string, body: string) => {
        posts.push({ path, body });
        return relay.answer(body);
      }) as never,
    }),
    inside(c).outboxHooks(),
    o.retryDelays ?? [],
  );
  inside(c).outbox = outbox;
  const unsubscribe = store.subscribe(() => outbox.reconcile());
  await outbox.load();
  /** The app closes: nothing of it hears the thread any more. */
  const close = () => {
    unsubscribe();
    outbox.stop();
    db.close();
  };
  /** The relay commits the cancel posted in `body` (exactly as signed) and serves it on the next catch-up. */
  const commit = (body: string) => {
    const action = (JSON.parse(body) as { action: { record: { expected_revision: number } } })
      .action;
    unread.push(
      plainEvent(
        'decision.cancelled',
        view.id,
        {
          action: 'cancel',
          record: action.record,
          envelope: null,
          provenance: null,
          status: 'cancelled',
          revision: action.record.expected_revision,
          target_host_id: 'host_aaaaaaaa',
          deliverable: false,
        },
        { question_revision: action.record.expected_revision, origin_device_id: w.phone.id },
      ),
    );
    return { question_id: view.id, revision: 0, status: 'cancelled', event_seq: 1 };
  };
  /** Every send the outbox has under way has finished, and what it read back has been filed. */
  const idle = async () => {
    await vi.waitFor(() =>
      expect((outbox as unknown as { flushing: unknown }).flushing).toBeNull(),
    );
    await reading;
  };
  const standing = () => {
    const e = outbox.forQuestion(view.id).find((x) => x.kind === 'decline');
    return e ? declineStanding(e, store.get(view.id), w.phone.id) : null;
  };
  return {
    c,
    w,
    q,
    view,
    store,
    db,
    dbName,
    cacheKey,
    outbox,
    relay,
    posts,
    commit,
    unread,
    catchUp,
    refresh,
    standing,
    idle,
    close,
  };
}

// `init` asks the relay for `GET /info`: offline here, so nothing leaves the test.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('dismissing a question (docs/protocol.md section 6.1)', () => {
  it('is offered only where the desktop that asked files declines', async () => {
    const { view } = await openQuestion();
    const c = new AppController('https://relay.example');
    const asker = view.originatingDeviceId;
    const withDevices = (devices: DeviceInfo[]) =>
      inside(c).patch({ devices: { devices } as DevicesResponse });

    // Until the device list is read, nothing says the desktop takes a decline.
    expect(c.declinesFor(view)).toBe(false);
    // A desktop that predates declines would keep the question open: no Dismiss.
    withDevices([device(asker)]);
    expect(c.declinesFor(view)).toBe(false);
    withDevices([device(asker, { features: ['thread-messages-v1', 'owner-desktop-answers-v1'] })]);
    expect(c.declinesFor(view)).toBe(false);
    // Another desktop's declaration never counts.
    withDevices([device(asker), device('dev_other00001', { features: ['person-declines-v1'] })]);
    expect(c.declinesFor(view)).toBe(false);
    withDevices([device(asker, { features: ['person-declines-v1'] })]);
    expect(c.declinesFor(view)).toBe(true);
    // A revoked or unknown desktop is sent nothing, so its leftover question can always be let go.
    withDevices([device(asker, { revoked: true })]);
    expect(c.declinesFor(view)).toBe(true);
    withDevices([]);
    expect(c.declinesFor(view)).toBe(true);
  });

  it('reads the device list again when the app comes back, so an upgraded desktop is offered Dismiss', () => {
    const c = new AppController('https://relay.example');
    const refresh = vi.fn(async () => undefined);
    inside(c).refreshDevices = refresh;
    // Not paired yet: there is no relay to ask.
    inside(c).resume();
    expect(refresh).not.toHaveBeenCalled();
    inside(c).relay = {};
    inside(c).resume();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('a dismissal queued on this device until it settles', () => {
  it('is sealed with its exact signed body before anything is sent, and survives airplane mode and a restart', async () => {
    const p = await phone();
    // Airplane mode: every send fails as a dropped connection.
    const e = await p.c.declineQuestion(p.view, 0);
    expect(e).toMatchObject({ kind: 'decline', expectedRevision: 0, recordId: expect.any(String) });
    // Durable before it is sent: the sealed row holds no plaintext, only what the outbox reads back.
    const rows = await p.db.outbox();
    expect(rows.map((r) => r.id)).toEqual([e.id]);
    await p.idle();
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0]!.path).toBe(`/questions/${p.view.id}/cancel`);
    expect(JSON.parse(p.posts[0]!.body)).toMatchObject({
      idempotency_key: e.idempotencyKey,
      action: { record: { action: 'cancel', action_id: e.recordId, expected_revision: 0 } },
    });
    // Sent once with no answer: the relay may have it, and the phone says only that it is saved here.
    expect(p.standing()).toEqual({ kind: 'unconfirmed' });
    // The question is still open everywhere else: nothing on the relay says otherwise.
    expect(p.store.get(p.view.id)!.status).toBe('open');
    p.close();

    // Closed and reopened: the same decline, still pending, sent byte for byte as it was signed.
    const again = await phone({ q: p.q, dbName: p.dbName, cacheKey: p.cacheKey });
    expect(again.outbox.list()).toMatchObject([
      { id: e.id, kind: 'decline', state: 'queued', attempts: 1, bodyText: e.bodyText },
    ]);
    expect(again.standing()).toEqual({ kind: 'unconfirmed' });
    again.relay.answer = async (body) => again.commit(body);
    await again.outbox.flush();
    await again.idle();
    expect(again.posts.map((x) => x.body)).toEqual([p.posts[0]!.body]);
    // The relay took it and the thread holds this device's own verified cancel: the question is declined, and the
    // local copy goes.
    expect(again.store.get(p.view.id)!.status).toBe('cancelled');
    expect(again.outbox.list()).toEqual([]);
    await vi.waitFor(async () => expect(await again.db.outbox()).toEqual([]));
  });

  it('reconciles a lost answer: a retry of the same request finds it taken', async () => {
    const p = await phone();
    let taken: unknown = null;
    // The relay commits the first send, but its answer never arrives.
    p.relay.answer = async (body) => {
      taken = p.commit(body);
      throw new RelayError('network_error', 0, 'connection reset');
    };
    await p.c.declineQuestion(p.view, 0);
    await p.idle();
    expect(p.standing()).toEqual({ kind: 'unconfirmed' });
    // The thread reads the committed cancel (a socket event) before the outbox tries again: it settles from that.
    await p.catchUp();
    await vi.waitFor(() => expect(p.outbox.list()).toEqual([]));
    expect(taken).not.toBeNull();
    expect(p.posts).toHaveLength(1);
    expect(p.store.get(p.view.id)!.status).toBe('cancelled');
  });

  it('a retry after a lost answer gets the stored receipt and settles the same way', async () => {
    const p = await phone();
    let first = true;
    let receipt: unknown = null;
    p.relay.answer = async (body) => {
      if (first) {
        first = false;
        receipt = p.commit(body);
        throw new RelayError('network_error', 0, 'connection reset');
      }
      // The relay's receipt for the same device and idempotency key: the original answer, nothing new stored.
      return receipt;
    };
    await p.c.declineQuestion(p.view, 0);
    await p.idle();
    expect(p.standing()).toEqual({ kind: 'unconfirmed' });
    // Back online: the same request again.
    await p.outbox.flush();
    await p.idle();
    expect(p.posts).toHaveLength(2);
    expect(p.posts[1]!.body).toBe(p.posts[0]!.body);
    expect(p.outbox.list()).toEqual([]);
    expect(p.store.get(p.view.id)!.status).toBe('cancelled');
  });

  it('settles as answered when a desktop answer wins, and leaves the draft as it was', async () => {
    const p = await phone();
    const drafts = new Drafts(p.db, p.cacheKey);
    await drafts.save(p.view.id, { selected: ['no'], text: 'my unsent words', reason: '' });
    await p.c.declineQuestion(p.view, 0);
    await p.idle();
    // The person answered at the computer while the phone was offline.
    p.unread.push(
      await actionEvent(p.w, { questionId: p.view.id, action: 'answer', signer: p.w.owner }),
    );
    p.relay.answer = async () => {
      throw new RelayError('revision_conflict', 409, 'question changed since you last saw it', {
        latest_revision: 1,
        status: 'human-answered',
      });
    };
    await p.outbox.flush();
    await p.idle();
    expect(p.standing()).toEqual({ kind: 'settled', outcome: { status: 'answered' } });
    expect(p.posts).toHaveLength(2);
    // Only a desktop that no longer takes declines sends the phone to read the device list again.
    expect(p.refresh).not.toHaveBeenCalled();
    // Kept as a note until the person lets it go, and never sent again.
    await p.outbox.retry(p.outbox.list()[0]!.id);
    await p.outbox.flush();
    expect(p.posts).toHaveLength(2);
    expect((await drafts.load(p.view.id))?.text).toBe('my unsent words');
    // Read back: the question was answered, so nothing on this device offers to dismiss that round again.
    await p.catchUp();
    expect(p.store.get(p.view.id)!.status).toBe('human-answered');
    await expect(p.c.declineQuestion(p.view, 0)).rejects.toBeInstanceOf(StaleQuestionError);
  });

  it('settles as expired when the deadline passes while it waits to be sent', async () => {
    const p = await phone();
    await p.c.declineQuestion(p.view, 0);
    await p.idle();
    // Back online after the deadline: the relay expires the question then and there.
    p.relay.answer = async () => {
      throw new RelayError('expired', 410, 'question expired');
    };
    await p.outbox.flush();
    await p.idle();
    expect(p.standing()).toEqual({ kind: 'settled', outcome: { status: 'expired' } });
    expect(p.posts).toHaveLength(2);
    expect(new Set(p.posts.map((x) => x.body)).size).toBe(1);
    // A note about how it settled is not unsent work.
    expect((await p.c.localDataSummary()).unsent).toBe(0);
  });

  it('keeps who withdrew it when the relay answers 200 for a cancel another cancel beat', async () => {
    const p = await phone();
    await p.c.declineQuestion(p.view, 0);
    p.relay.answer = async () => {
      // The desktop withdrew it first at the same revision; the phone's cancel is a no-op that stores nothing.
      p.unread.push(await actionEvent(p.w, { questionId: p.view.id, action: 'cancel' }));
      return { question_id: p.view.id, revision: 0, status: 'cancelled', event_seq: 9 };
    };
    await p.outbox.flush();
    await p.idle();
    expect(p.standing()).toEqual({
      kind: 'settled',
      outcome: { status: 'withdrawn', label: 'Withdrawn on studio-mac' },
    });
    // Reopened since: the note still says what happened to the round it was signed for.
    await p.store.ingest(
      await actionEvent(p.w, { questionId: p.view.id, action: 'reopen', expectedRevision: 0 }),
    );
    expect(p.standing()).toMatchObject({ kind: 'settled', outcome: { status: 'withdrawn' } });
    expect(p.outbox.declineInFlight(p.view.id)).toBeUndefined();
  });

  it('says so when the asking desktop does not take a dismissal, and reads the device list again', async () => {
    const p = await phone();
    p.relay.answer = async () => {
      throw new RelayError(
        'invalid_state',
        409,
        "the question's desktop does not accept declines",
        {
          reason: CREATOR_MISSING_FEATURE,
          required_feature: 'person-declines-v1',
        },
      );
    };
    await p.c.declineQuestion(p.view, 0);
    await p.idle();
    expect(p.standing()).toEqual({ kind: 'settled', outcome: { status: 'unsupported' } });
    expect(p.refresh).toHaveBeenCalled();
    expect(p.store.get(p.view.id)!.status).toBe('open');
  });

  it('is one dismissal however often it is asked for, and holds the question while on its way', async () => {
    const p = await phone();
    // A double tap: both join the first, and one decline is signed and stored.
    const [a, b] = await Promise.all([
      p.c.declineQuestion(p.view, 0),
      p.c.declineQuestion(p.view, 0),
    ]);
    expect(a.id).toBe(b.id);
    expect(await p.c.declineQuestion(p.view, 0)).toMatchObject({ id: a.id });
    expect(p.outbox.list()).toHaveLength(1);
    expect((await p.db.outbox()).length).toBe(1);
    // Nothing else is sent on the question meanwhile.
    await expect(
      p.c.submit({
        view: p.view,
        kind: 'answer',
        expectedRevision: 0,
        selected: ['yes'],
        text: '',
        reviewedDigests: [],
      }),
    ).rejects.toBeInstanceOf(DeclineInFlightError);
    await expect(p.c.sendMessage({ view: p.view, text: 'hello' })).rejects.toBeInstanceOf(
      DeclineInFlightError,
    );
    expect(p.outbox.list()).toHaveLength(1);
  });

  it('waits for an answer from this device already on its way, and never moves it', async () => {
    const p = await phone();
    const answer = await p.outbox.enqueue({
      id: 'answer_1',
      questionId: p.view.id,
      kind: 'answer',
      path: `/questions/${p.view.id}/answer`,
      bodyText: '{}',
      idempotencyKey: 'idem_answer_1',
      expectedRevision: 0,
      selected: ['yes'],
      text: 'kept',
      reason: '',
    });
    await expect(p.c.declineQuestion(p.view, 0)).rejects.toBeInstanceOf(DeclineBlockedError);
    expect(p.outbox.list()).toEqual([expect.objectContaining({ id: answer.id, text: 'kept' })]);
  });

  it('replaces an earlier refused dismissal with a new one signed for the round in view', async () => {
    const p = await phone();
    p.relay.answer = async () => {
      throw new RelayError('revision_conflict', 409, 'changed', {
        latest_revision: 1,
        status: 'open',
      });
    };
    // An answer of the person's the relay refused earlier: its words stay, whatever happens to dismissals.
    const refusedAnswer = await p.outbox.enqueue({
      id: 'answer_refused',
      questionId: p.view.id,
      kind: 'answer',
      path: `/questions/${p.view.id}/answer`,
      bodyText: '{}',
      idempotencyKey: 'idem_answer_refused',
      expectedRevision: 0,
      selected: ['yes'],
      text: 'kept words',
      reason: '',
    });
    await p.outbox.flush();
    await p.idle();
    expect(p.outbox.list()[0]).toMatchObject({ id: refusedAnswer.id, state: 'conflicted' });
    const first = await p.c.declineQuestion(p.view, 0);
    await p.idle();
    expect(p.standing()).toEqual({ kind: 'settled', outcome: { status: 'changed' } });
    // The desktop withdrew and reopened it meanwhile: the old decline is never moved onto the new round.
    p.unread.push(await actionEvent(p.w, { questionId: p.view.id, action: 'cancel' }));
    p.unread.push(
      await actionEvent(p.w, { questionId: p.view.id, action: 'reopen', expectedRevision: 0 }),
    );
    await p.catchUp();
    expect(p.store.get(p.view.id)).toMatchObject({ status: 'open', revision: 1 });
    expect(p.standing()).toEqual({ kind: 'settled', outcome: { status: 'changed' } });
    await expect(p.c.declineQuestion(p.view, 0)).rejects.toBeInstanceOf(StaleQuestionError);
    // Dismissing again is a new decline, deliberately confirmed for the round in view.
    p.relay.answer = async (body) => p.commit(body);
    const second = await p.c.declineQuestion(p.view, 1);
    expect(second.id).not.toBe(first.id);
    expect(second.recordId).not.toBe(first.recordId);
    expect(JSON.parse(second.bodyText).action.record.expected_revision).toBe(1);
    // The note about the first goes with it; the second settles as declined. The refused answer stays.
    await p.idle();
    expect(p.outbox.list().map((e: OutboxEntry) => e.id)).toEqual([refusedAnswer.id]);
    expect(p.store.get(p.view.id)!.status).toBe('cancelled');
  });

  it('is remembered as sent from the moment it goes, so a restart mid-send never calls it unsent', async () => {
    const p = await phone();
    // The request leaves and nothing comes back: the app is closed while it hangs.
    let posted = false;
    p.relay.answer = () => {
      posted = true;
      return new Promise(() => undefined);
    };
    const e = await p.c.declineQuestion(p.view, 0);
    await vi.waitFor(() => expect(posted).toBe(true));
    await vi.waitFor(async () => {
      const reread = new Outbox(p.db, p.cacheKey, () => ({ jsonRaw: (async () => ({})) as never }));
      await reread.load();
      expect(reread.list()).toMatchObject([{ id: e.id, state: 'queued', attempts: 1 }]);
    });
  });

  it('admits one of an answer and a dismissal confirmed at the same moment, never both', async () => {
    const p = await phone();
    const [answer, dismissal] = await Promise.allSettled([
      p.c.submit({
        view: p.view,
        kind: 'answer',
        expectedRevision: 0,
        selected: ['yes'],
        text: 'go',
        reviewedDigests: [],
      }),
      p.c.declineQuestion(p.view, 0),
    ]);
    expect(answer.status).toBe('fulfilled');
    expect(dismissal).toMatchObject({
      status: 'rejected',
      reason: expect.any(DeclineBlockedError),
    });
    expect(p.outbox.list().map((e) => e.kind)).toEqual(['answer']);

    // And the other way round: the dismissal first, the answer refused.
    const q = await phone();
    const [d2, a2] = await Promise.allSettled([
      q.c.declineQuestion(q.view, 0),
      q.c.submit({
        view: q.view,
        kind: 'answer',
        expectedRevision: 0,
        selected: ['yes'],
        text: 'go',
        reviewedDigests: [],
      }),
    ]);
    expect(d2.status).toBe('fulfilled');
    expect(a2).toMatchObject({ status: 'rejected', reason: expect.any(DeclineInFlightError) });
    expect(q.outbox.list().map((e) => e.kind)).toEqual(['decline']);
  });

  it('tries again on its own after a relay hiccup, with nothing else to prompt it', async () => {
    const p = await phone({ retryDelays: [5] });
    let first = true;
    p.relay.answer = async (body) => {
      if (first) {
        first = false;
        throw new RelayError('unavailable', 503, 'try later');
      }
      return p.commit(body);
    };
    await p.c.declineQuestion(p.view, 0);
    await vi.waitFor(() => expect(p.posts).toHaveLength(2));
    await p.idle();
    expect(p.posts[1]!.body).toBe(p.posts[0]!.body);
    expect(p.outbox.list()).toEqual([]);
    expect(p.store.get(p.view.id)!.status).toBe('cancelled');
  });
});
