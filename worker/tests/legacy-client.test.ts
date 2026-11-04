import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { LEGACY_EVENT_TYPES, PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import {
  legacyDesktopCatchUp,
  legacyPhoneCatchUp,
  legacySocketReceive,
} from '@daintreehq/decisions-protocol/fixtures';
import {
  encryptEnvelope,
  envelopeDigest,
  newId,
  nowIso,
  signObject,
} from '@daintreehq/decisions-crypto';
import {
  act,
  ask,
  claimRelay,
  declare,
  enrollHost,
  events,
  pairDevice,
  raw,
  say,
  type Actor,
} from './helpers.js';

/** A socket that keeps every raw frame, as a 0.3.0 client receives them. */
async function hold(ticket: string) {
  const res = await exports.default.fetch(
    new Request(`https://relay.test/api/v1/socket?ticket=${ticket}`, {
      headers: { Upgrade: 'websocket' },
    }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const frames: string[] = [];
  ws.addEventListener('message', (ev) => {
    if (ev.data !== 'pong') frames.push(ev.data as string);
  });
  const parsed = () => frames.map((f) => JSON.parse(f) as { t: string; [k: string]: any });
  const until = async (pred: (f: { t: string; [k: string]: any }) => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!parsed().some(pred)) {
      if (Date.now() > end) throw new Error('timeout waiting for a frame');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  /** `sync {after}` until a `caught_up` with nothing more; returns its cursor. */
  const sync = async (after: number): Promise<number> => {
    for (;;) {
      const seen = parsed().filter((f) => f.t === 'caught_up').length;
      ws.send(JSON.stringify({ t: 'sync', after }));
      await until(() => parsed().filter((f) => f.t === 'caught_up').length > seen);
      const last = parsed()
        .filter((f) => f.t === 'caught_up')
        .at(-1)!;
      after = last.high_water;
      if (!last.has_more) return after;
    }
  };
  return { ws, frames, parsed, until, sync, close: () => ws.close(1000, 'bye') };
}

/** Collects socket frames until the replay that `sync {after}` starts reports it is fully caught up. */
async function socketReplay(a: Actor, after: number): Promise<unknown[]> {
  // The 0.3.0 client's ticket body: no feature declaration.
  const ticket = (
    await a.call('POST', '/api/v1/socket-ticket', { protocol_version: PROTOCOL_VERSION })
  ).json.ticket;
  const res = await exports.default.fetch(
    new Request(`https://relay.test/api/v1/socket?ticket=${ticket}`, {
      headers: { Upgrade: 'websocket' },
    }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no caught_up')), 4000);
    ws.addEventListener('message', (ev) => {
      if (ev.data === 'pong') return;
      frames.push(ev.data);
      const f = JSON.parse(ev.data as string) as {
        t: string;
        has_more?: boolean;
        high_water?: number;
      };
      if (f.t === 'caught_up') {
        if (f.has_more) ws.send(JSON.stringify({ t: 'sync', after: f.high_water }));
        else {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });
  ws.send(JSON.stringify({ t: 'sync', after }));
  await done;
  ws.close(1000, 'bye');
  return frames;
}

describe('a client pinned to 0.3.0 (docs/protocol.md section 19)', () => {
  it('parses every page, frame and info response the relay sends it', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const answered = await ask(w);
    expect(answered.res.status).toBe(201);
    expect((await act(w, phone, 'answer', answered.questionId, 0)).res.status).toBe(201);
    const cancelled = await ask(w);
    expect((await act(w, w.owner, 'cancel', cancelled.questionId, 0)).res.status).toBe(201);
    expect((await ask(w)).res.status).toBe(201);
    const all = await events(w.owner);
    const types = all.map((e) => e.event_type);
    expect(types.filter((t) => t === 'decision.created')).toHaveLength(3);
    expect(types).toContain('decision.answer.committed');
    expect(types).toContain('decision.cancelled');

    const pages = (a: Actor) => async (after: number) =>
      (await a.call('GET', '/api/v1/events', undefined, `after=${after}&limit=2`)).json;
    const desktop = await legacyDesktopCatchUp(pages(w.owner));
    const handset = await legacyPhoneCatchUp(pages(phone));
    expect(desktop.events.map((e) => e.seq)).toEqual(all.map((e) => e.seq));
    expect(handset.events.map((e) => e.seq)).toEqual(all.map((e) => e.seq));
    expect(desktop.pages).toBeGreaterThan(1);

    const frames = await socketReplay(w.owner, 0);
    const { accepted, dropped } = legacySocketReceive(frames);
    expect(dropped).toEqual([]);
    expect(accepted.filter((f) => f.t === 'event')).toHaveLength(all.length);

    // The relay advertises the extensions it implements; a 0.3.0 client's info schema ignores the field.
    const info = await raw('GET', '/api/v1/info');
    expect(info.status).toBe(200);
    expect(info.json.name).toBe('daintree-decisions');
    expect(info.json.features).toEqual(['thread-messages-v1']);
  });

  it('pages events and holds a socket while messages flow, without a parse failure (issue #32)', async () => {
    const w = await claimRelay();
    await declare(w.owner);
    const phone = await pairDevice(w);
    // Two clients still on 0.3.0: a Daintree Host and a phone running a cached app. Neither declares features.
    const oldPhone = await pairDevice(w, 'phone', 'Old iPhone');
    const { host } = await enrollHost(w);
    const ticket = async (a: Actor) =>
      (await a.call('POST', '/api/v1/socket-ticket', { protocol_version: PROTOCOL_VERSION })).json
        .ticket as string;
    const legacy = await hold(await ticket(host));
    const legacyPhone = await hold(await ticket(oldPhone));
    const modern = await hold(await declare(phone));
    await legacy.until((f) => f.t === 'hello');
    let legacyCursor = await legacy.sync(0);
    await legacyPhone.sync(0);
    await modern.sync(0);

    // Messages in both directions and their receipts, interleaved with the 0.3.0 lifecycle.
    const { questionId } = await ask(w);
    const human = await say(w, phone, questionId);
    expect(human.res.status).toBe(201);
    expect((await say(w, w.owner, questionId, { expectsReply: true })).res.status).toBe(201);
    for (const status of ['received', 'terminal-delivered'] as const) {
      const r = await w.owner.call('POST', '/api/v1/deliveries/messages', {
        protocol_version: PROTOCOL_VERSION,
        idempotency_key: newId(),
        question_id: questionId,
        message_id: human.messageId,
        host_id: 'host_aaaaaaaa',
        status,
        ...(status === 'terminal-delivered' ? { injection_id: newId() } : {}),
      });
      expect(r.status).toBe(200);
    }
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(201);
    expect((await say(w, phone, questionId)).res.status).toBe(201);
    const second = await ask(w);
    expect((await say(w, w.owner, second.questionId)).res.status).toBe(201);
    expect((await act(w, w.owner, 'cancel', second.questionId, 0)).res.status).toBe(201);
    // Hidden events end the stream: the 0.3.0 page must still end and move past them.
    expect((await say(w, phone, questionId)).res.status).toBe(201);

    const all = await events(w.owner); // no declaration: the 0.3.0 baseline
    const full = (
      await w.owner.call(
        'GET',
        '/api/v1/events',
        undefined,
        'after=0&limit=100&features=thread-messages-v1',
      )
    ).json;
    const legacyTypes = new Set<string>(LEGACY_EVENT_TYPES);
    const visible = full.events.filter((e: any) => legacyTypes.has(e.event_type));
    expect(full.events.length).toBeGreaterThan(visible.length);
    expect(all.map((e) => e.seq)).toEqual(visible.map((e: any) => e.seq));
    const highWater = full.high_water_seq;
    expect(full.events.at(-1).event_type).toBe('decision.message.posted');

    // The frozen 0.3.0 catch-up loops, a page of two at a time.
    const pages = (a: Actor) => async (after: number) =>
      (await a.call('GET', '/api/v1/events', undefined, `after=${after}&limit=2`)).json;
    const desktop = await legacyDesktopCatchUp(pages(host));
    const handset = await legacyPhoneCatchUp(pages(oldPhone));
    expect(desktop.events.map((e) => e.seq)).toEqual(visible.map((e: any) => e.seq));
    expect(handset.events.map((e) => e.seq)).toEqual(visible.map((e: any) => e.seq));
    expect(desktop.cursor).toBe(highWater);
    expect(handset.cursor).toBe(highWater);
    // Starting from the cursor a 0.3.0 client already holds, the rest of the stream is just as clean.
    const resumed = await legacyDesktopCatchUp(pages(host), visible[2].seq);
    expect(resumed.events.map((e) => e.seq)).toEqual(visible.slice(3).map((e: any) => e.seq));

    // The held sockets got every 0.3.0 event live and nothing else; the modern one got the thread too.
    await legacy.until((f) => f.t === 'event' && f.event.seq === visible.at(-1).seq);
    await modern.until((f) => f.t === 'event' && f.event.seq === highWater);
    legacyCursor = await legacy.sync(legacyCursor);
    expect(legacyCursor).toBe(highWater);
    await legacyPhone.until((f) => f.t === 'event' && f.event.seq === visible.at(-1).seq);
    for (const sock of [legacy, legacyPhone]) {
      const { accepted, dropped } = legacySocketReceive(sock.frames);
      expect(dropped).toEqual([]);
      const seqs = [
        ...new Set(accepted.flatMap((f) => (f.t === 'event' ? [f.event.seq] : []))),
      ].sort((a, b) => a - b);
      expect(seqs).toEqual(visible.map((e: any) => e.seq));
    }
    const modernSeqs = modern
      .parsed()
      .flatMap((f) => (f.t === 'event' ? [f.event.seq as number] : []));
    expect([...new Set(modernSeqs)].sort((a, b) => a - b)).toEqual(
      full.events.map((e: any) => e.seq),
    );
    // A fresh 0.3.0 replay from zero is clean as well.
    const replay = legacySocketReceive(await socketReplay(host, 0));
    expect(replay.dropped).toEqual([]);
    expect(replay.accepted.filter((f) => f.t === 'event')).toHaveLength(visible.length);
    for (const s of [legacy, legacyPhone, modern]) s.close();
  });

  it('refuses an answer that references phone images, which this relay cannot bind yet', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    const envelope = await encryptEnvelope({
      epochKey: phone.epoch ?? w.epoch,
      installationId: w.installationId,
      questionId,
      recordId: newId(),
      recordType: 'answer',
      revision: 1,
      senderDeviceId: phone.id,
      purpose: 'answer-content',
      plaintext: { selected_option_ids: ['approve'], images: [] },
    });
    const record = await signObject(phone.keys.signing.privateKey, {
      v: PROTOCOL_VERSION,
      type: 'action' as const,
      action: 'answer' as const,
      installation_id: w.installationId,
      question_id: questionId,
      action_id: newId(),
      expected_revision: 0,
      created_at: nowIso(),
      envelope_digest: await envelopeDigest(envelope),
      confirms_action_id: null,
      expires_at: null,
      attachment_ids: [newId()],
      signer_device_id: phone.id,
    });
    const res = await phone.call('POST', `/api/v1/questions/${questionId}/answer`, {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(),
      action: { record, envelope },
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('validation_error');
    // The question is still open: nothing was committed.
    expect((await phone.call('GET', `/api/v1/questions/${questionId}`)).json.status).toBe('open');
  });
});
