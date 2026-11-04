import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { EventsPage, InfoResponse, LIMITS, PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import { newId, signRequest } from '@daintreehq/decisions-crypto';
import { legacyDesktopCatchUp, legacyPhoneCatchUp } from '@daintreehq/decisions-protocol/fixtures';
import {
  ask,
  claimRelay,
  declare,
  events,
  inRoom,
  pairDevice,
  raw,
  say,
  type Actor,
  type World,
} from './helpers.js';
import { SNAPSHOTS, eventsWith, openSocket, publish } from './snapshots.helpers.js';

/*
 * Feature negotiation (docs/protocol.md section 19): what a client declares on its socket ticket, and on each
 * `GET /events`, decides what it is sent. The 0.3.0 catch-up loops themselves are in legacy-client.test.ts.
 */

const features = async (a: Actor, of: Actor) =>
  ((await a.call('GET', '/api/v1/devices')).json.devices as any[]).find(
    (d) => d.device_id === of.id,
  )!.features;

const page = (a: Actor, query: string) =>
  a.call('GET', '/api/v1/events', undefined, query).then((r) => r);

/** An owner that declares threads, a phone, and a question whose tail is a run of message events. */
async function hiddenTail(): Promise<{ w: World; phone: Actor; questionId: string }> {
  const w = await claimRelay();
  await declare(w.owner);
  const phone = await pairDevice(w);
  const { questionId } = await ask(w);
  // Visible and hidden events interleave, and the stream ends in a run of hidden ones.
  await say(w, phone, questionId);
  await ask(w);
  await say(w, w.owner, questionId);
  await ask(w);
  for (let i = 0; i < 3; i++) await say(w, i % 2 ? w.owner : phone, questionId);
  return { w, phone, questionId };
}

describe('declaring features', () => {
  it("records each device's latest socket-ticket declaration and lists it", async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    expect(await features(w.owner, phone)).toEqual([]);
    await declare(phone, ['thread-messages-v1', 'phone-images-v1', 'some-future-thing']);
    // Kept as declared (sorted), unknown tokens included: a phone compares what both sides advertise.
    expect(await features(w.owner, phone)).toEqual([
      'phone-images-v1',
      'some-future-thing',
      'thread-messages-v1',
    ]);
    // Today's phone app sends `{}`; an older client sends only the protocol version. Both are the baseline.
    expect((await phone.call('POST', '/api/v1/socket-ticket', {})).status).toBe(200);
    expect(await features(w.owner, phone)).toEqual([]);
    await declare(phone);
    expect(
      (await phone.call('POST', '/api/v1/socket-ticket', { protocol_version: PROTOCOL_VERSION }))
        .status,
    ).toBe(200);
    expect(await features(phone, phone)).toEqual([]);
  });

  it('refuses a malformed declaration', async () => {
    const w = await claimRelay();
    const bad = async (body: unknown) =>
      (await w.owner.call('POST', '/api/v1/socket-ticket', body)).status;
    expect(await bad({ protocol_version: PROTOCOL_VERSION, features: ['Not A Token'] })).toBe(400);
    expect(
      await bad({
        protocol_version: PROTOCOL_VERSION,
        features: Array.from({ length: 17 }, (_, i) => `f${i}`),
      }),
    ).toBe(400);
    expect(await bad({ protocol_version: 2 })).toBe(400);
    expect(await features(w.owner, w.owner)).toEqual([]);
  });

  it('advertises the extensions the relay implements', async () => {
    expect((await raw('GET', '/api/v1/info')).json.features).toEqual([
      'pane-snapshots-v1',
      'phone-images-v1',
      'thread-messages-v1',
    ]);
  });
});

describe('filtering the event feed', () => {
  it('sends message events only to a request that declares threads', async () => {
    const { phone } = await hiddenTail();
    const baseline = (await page(phone, 'after=0')).json;
    const declared = (await page(phone, 'after=0&features=thread-messages-v1')).json;
    expect(baseline.events.map((e: any) => e.event_type)).not.toContain('decision.message.posted');
    expect(
      declared.events.filter((e: any) => e.event_type === 'decision.message.posted'),
    ).toHaveLength(5);
    // Unknown tokens are ignored; images alone do not unlock threads.
    const other = (await page(phone, 'after=0&features=phone-images-v1,zzz-later')).json;
    expect(other.events).toEqual(baseline.events);
    // The declaration is per request: declaring on a ticket changes nothing for a request without one.
    await declare(phone);
    expect((await page(phone, 'after=0')).json.events).toEqual(baseline.events);
  });

  it('never stalls a client on events it is not sent', async () => {
    const { phone } = await hiddenTail();
    const all = (await page(phone, 'after=0&features=thread-messages-v1&limit=100')).json;
    const high = all.high_water_seq;
    const baseline = (await page(phone, 'after=0&limit=100')).json;
    const lastVisible = baseline.events.at(-1).seq;
    expect(lastVisible).toBeLessThan(high);
    expect(baseline.events.length).toBeGreaterThan(2);

    // A page ending the stream moves the cursor to the high-water mark, past the hidden tail.
    expect(EventsPage.parse(baseline)).toMatchObject({ next_after: high, has_more: false });
    // A page cut by its limit says "more" only when a visible event is left, and is never empty.
    const firstTwo = (await page(phone, 'after=0&limit=2')).json;
    expect(firstTwo.events).toHaveLength(2);
    expect(firstTwo).toMatchObject({ has_more: true, next_after: firstTwo.events[1].seq });
    const cutAtLast = (await page(phone, `after=0&limit=${baseline.events.length}`)).json;
    expect(cutAtLast).toMatchObject({ has_more: false, next_after: high });
    // From inside the hidden tail, a 0.3.0 page is empty and complete, at the high-water mark.
    expect((await page(phone, `after=${lastVisible}`)).json).toMatchObject({
      events: [],
      next_after: high,
      has_more: false,
      high_water_seq: high,
    });
  });

  it('refuses a malformed declaration on the feed', async () => {
    const w = await claimRelay();
    expect((await page(w.owner, 'after=0&features=Bad%20Token')).status).toBe(400);
    const many = Array.from({ length: 17 }, (_, i) => `f${i}`).join(',');
    expect((await page(w.owner, `after=0&features=${many}`)).status).toBe(400);
  });
});

describe('filtering the socket', () => {
  async function socket(ticket: string) {
    const res = await exports.default.fetch(
      new Request(`https://relay.test/api/v1/socket?ticket=${ticket}`, {
        headers: { Upgrade: 'websocket' },
      }),
    );
    const ws = res.webSocket!;
    ws.accept();
    const frames: any[] = [];
    ws.addEventListener('message', (ev) => {
      if (ev.data !== 'pong') frames.push(JSON.parse(ev.data as string));
    });
    const until = async (pred: (f: any) => boolean) => {
      const end = Date.now() + 4000;
      while (!frames.some(pred)) {
        if (Date.now() > end) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 20));
      }
      return frames.find(pred);
    };
    return { ws, frames, until };
  }

  it("replays and tunnels by the socket's own declaration", async () => {
    const { w, phone } = await hiddenTail();
    const modern = await socket(await declare(phone));
    modern.ws.send(JSON.stringify({ t: 'sync', after: 0 }));
    const caught = await modern.until((f) => f.t === 'caught_up');
    const replayed = modern.frames.filter((f) => f.t === 'event');
    expect(replayed.filter((f) => f.event.event_type === 'decision.message.posted')).toHaveLength(
      5,
    );
    expect(caught.high_water).toBe(replayed.at(-1).event.seq);

    // The device's declaration changes with its next ticket (minted, never connected); the open socket keeps
    // the declaration it was accepted with, for live frames and for replays.
    await phone.call('POST', '/api/v1/socket-ticket', {});
    expect(
      ((await phone.call('GET', '/api/v1/devices')).json.devices as any[]).find(
        (d) => d.device_id === phone.id,
      ).features,
    ).toEqual([]);
    const live = await say(w, w.owner, (await ask(w)).questionId);
    expect(live.res.status).toBe(201);
    await modern.until((f) => f.t === 'event' && f.event.seq === live.res.json.event_seq);
    const seen = modern.frames.length;
    modern.ws.send(JSON.stringify({ t: 'sync', after: caught.high_water }));
    await modern.until((f) => f.t === 'caught_up' && modern.frames.indexOf(f) >= seen);
    expect(
      modern.frames
        .slice(seen)
        .some((f) => f.t === 'event' && f.event.seq === live.res.json.event_seq),
    ).toBe(true);

    // A baseline socket from the same device: no message events, and the cursor still reaches the end.
    const baseline = await socket(
      (await phone.call('POST', '/api/v1/socket-ticket', {})).json.ticket,
    );
    baseline.ws.send(JSON.stringify({ t: 'sync', after: 0 }));
    const done = await baseline.until((f) => f.t === 'caught_up');
    expect(done).toMatchObject({ high_water: live.res.json.event_seq, has_more: false });
    expect(
      baseline.frames.some(
        (f) => f.t === 'event' && f.event.event_type.startsWith('decision.message'),
      ),
    ).toBe(false);

    // A tunnelled `GET /events` follows its own signed query, like HTTP.
    const query = 'after=0&features=thread-messages-v1&limit=100';
    baseline.ws.send(
      JSON.stringify({
        t: 'req',
        id: 'r1',
        method: 'GET',
        path: '/api/v1/events',
        query,
        authorization: await phone.authHeader('GET', '/api/v1/events', query),
      }),
    );
    const res = await baseline.until((f) => f.t === 'res' && f.id === 'r1');
    expect(res.status).toBe(200);
    const tunnelled = JSON.parse(res.body);
    expect(
      tunnelled.events.filter((e: any) => e.event_type === 'decision.message.posted'),
    ).toHaveLength(6);
    modern.ws.close(1000, 'bye');
    baseline.ws.close(1000, 'bye');
  });
});

const featuresOf = async (w: Awaited<ReturnType<typeof claimRelay>>, id: string) =>
  ((await w.owner.call('GET', '/api/v1/devices')).json.devices as any[]).find(
    (d) => d.device_id === id,
  ).features;

describe('feature negotiation with pane snapshots (docs/protocol.md section 19)', () => {
  it('advertises the features the relay implements', async () => {
    const info = await raw('GET', '/api/v1/info');
    expect(InfoResponse.parse(info.json).features).toEqual([
      'pane-snapshots-v1',
      'phone-images-v1',
      'thread-messages-v1',
    ]);
  });

  it("records each device's latest ticket declaration, and no declaration is the baseline", async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    expect(await featuresOf(w, phone.id)).toEqual([]);
    // Unknown tokens from a newer client are kept for others to read, deduped and sorted.
    await declare(phone, ['zz-future-v9', 'pane-snapshots-v1', 'pane-snapshots-v1']);
    expect(await featuresOf(w, phone.id)).toEqual(['pane-snapshots-v1', 'zz-future-v9']);
    // Today's phone app sends `{}`, a 0.3.0 client `{protocol_version}`, some clients nothing at all.
    for (const body of [{}, { protocol_version: PROTOCOL_VERSION }, undefined]) {
      await declare(phone, ['pane-snapshots-v1']);
      expect((await phone.call('POST', '/api/v1/socket-ticket', body)).status).toBe(200);
      expect(await featuresOf(w, phone.id)).toEqual([]);
    }
  });

  it('refuses a malformed declaration', async () => {
    const w = await claimRelay();
    const tooMany = Array.from({ length: LIMITS.featuresPerDeclaration + 1 }, (_, i) => `f${i}`);
    for (const features of [['Bad Token'], tooMany]) {
      const r = await w.owner.call('POST', '/api/v1/socket-ticket', {
        protocol_version: PROTOCOL_VERSION,
        features,
      });
      expect(r.status).toBe(400);
    }
    const bad = await w.owner.call(
      'GET',
      '/api/v1/events',
      undefined,
      'after=0&features=Bad%20Token',
    );
    expect(bad.status).toBe(400);
  });

  it('filters GET /events by the request, not by what the device declared elsewhere', async () => {
    const w = await claimRelay();
    await declare(w.owner, SNAPSHOTS);
    const { questionId } = await ask(w);
    await publish(w, w.owner, questionId);
    expect((await events(w.owner)).map((e) => e.event_type)).toEqual(['decision.created']);
    expect((await eventsWith(w.owner, SNAPSHOTS)).map((e) => e.event_type)).toEqual([
      'decision.created',
      'decision.snapshot.updated',
    ]);
    // Unknown tokens are ignored rather than refused.
    const r = await w.owner.call(
      'GET',
      '/api/v1/events',
      undefined,
      'after=0&features=zz-future-v9',
    );
    expect(r.status).toBe(200);
    expect(r.json.events).toHaveLength(1);
  });

  it('pages past hidden events without stalling a baseline client', async () => {
    const w = await claimRelay();
    await declare(w.owner, SNAPSHOTS);
    const { questionId } = await ask(w);
    await publish(w, w.owner, questionId);
    // Nothing visible after the creation: the page ends the stream and its cursor passes the hidden hint.
    const page = (await w.owner.call('GET', '/api/v1/events', undefined, 'after=0&limit=1')).json;
    expect(page.events.map((e: any) => e.event_type)).toEqual(['decision.created']);
    expect(page.has_more).toBe(false);
    expect(page.next_after).toBe(page.high_water_seq);
    expect(page.next_after).toBeGreaterThan(page.events[0].seq);
  });

  it('applies the signed query of a tunnelled request, whatever the socket declared', async () => {
    const w = await claimRelay();
    await declare(w.owner, SNAPSHOTS);
    const { questionId } = await ask(w);
    await publish(w, w.owner, questionId);
    const sock = await openSocket(w.owner, SNAPSHOTS);
    const tunnel = async (query: string) => {
      const id = newId();
      const { authorization } = await signRequest({
        method: 'GET',
        path: '/api/v1/events',
        query,
        body: '',
        installationId: w.installationId,
        deviceId: w.owner.id,
        signingKey: w.owner.keys.signing.privateKey,
      });
      sock.ws.send(
        JSON.stringify({
          t: 'req',
          id,
          method: 'GET',
          path: '/api/v1/events',
          query,
          authorization,
        }),
      );
      const res = await sock.waitFor((f) => f.t === 'res' && f.id === id);
      return JSON.parse(res.body).events.map((e: any) => e.event_type);
    };
    expect(await tunnel('after=0')).toEqual(['decision.created']);
    expect(await tunnel('after=0&features=pane-snapshots-v1')).toContain(
      'decision.snapshot.updated',
    );
    sock.close();
  });

  it('replays to each socket only what its own ticket declared', async () => {
    const w = await claimRelay();
    await declare(w.owner, SNAPSHOTS);
    const { questionId } = await ask(w);
    await publish(w, w.owner, questionId);
    for (const [features, want] of [
      [undefined, ['decision.created']],
      [SNAPSHOTS, ['decision.created', 'decision.snapshot.updated']],
    ] as const) {
      const sock = await openSocket(w.owner, features as string[] | undefined);
      sock.ws.send(JSON.stringify({ t: 'sync', after: 0 }));
      const caught = await sock.waitFor((f) => f.t === 'caught_up');
      expect(sock.frames.filter((f) => f.t === 'event').map((f) => f.event.event_type)).toEqual(
        want,
      );
      expect(caught.has_more).toBe(false);
      expect(caught.high_water).toBe(
        await inRoom((room) => room.q1<{ m: number }>(`SELECT MAX(seq) AS m FROM events`)!.m),
      );
      sock.close();
    }
  });

  it('treats a socket whose stored attachment predates features as the baseline', async () => {
    const w = await claimRelay();
    await declare(w.owner, SNAPSHOTS);
    const { questionId } = await ask(w);
    const sock = await openSocket(w.owner, SNAPSHOTS);
    // A socket accepted before this release carries only its device and role.
    await inRoom((_room, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { deviceId: string; role: string };
        ws.serializeAttachment({ deviceId: att.deviceId, role: att.role });
      }
    });
    await publish(w, w.owner, questionId);
    const next = await ask(w);
    await sock.waitFor((f) => f.t === 'event' && f.event.question_id === next.questionId);
    sock.ws.send(JSON.stringify({ t: 'sync', after: 0 }));
    await sock.waitFor((f) => f.t === 'caught_up');
    expect(
      sock.frames.some(
        (f) => f.t === 'event' && f.event.event_type.startsWith('decision.snapshot.'),
      ),
    ).toBe(false);
    expect(sock.frames.filter((f) => f.t === 'event').length).toBeGreaterThanOrEqual(3);
    sock.close();
  });

  it('pages a 0.3.0 client one event at a time across hidden spans longer than a ledger batch', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const hidden = (n: number) =>
      inRoom((room) => {
        for (let i = 0; i < n; i++) {
          room.run(
            `INSERT INTO events (event_id, event_type, question_id, question_revision, origin_device_id, data, created_at)
             VALUES (?, 'decision.snapshot.updated', NULL, NULL, NULL, '{}', ?)`,
            newId(),
            Date.now(),
          );
        }
      });
    await hidden(LIMITS.eventPageSize * 2 + 50);
    await ask(w);
    await hidden(LIMITS.eventPageSize + 20);
    await ask(w);
    await hidden(LIMITS.eventPageSize * 2);
    const visible = (await events(w.owner)).map((e) => e.seq);
    expect(visible).toHaveLength(3); // the phone's pairing and two questions
    const pages = (a: Actor) => async (after: number) =>
      (await a.call('GET', '/api/v1/events', undefined, `after=${after}&limit=1`)).json;
    for (const run of [legacyDesktopCatchUp, legacyPhoneCatchUp]) {
      const caught = await run(pages(phone));
      expect(caught.events.map((e) => e.seq)).toEqual(visible);
    }
    // A hidden-only tail ends the stream at the high-water mark.
    const tail = (await pages(phone)(visible.at(-1)!)) as any;
    expect(tail.events).toEqual([]);
    expect(tail.has_more).toBe(false);
    expect(tail.next_after).toBe(tail.high_water_seq);
    expect(tail.next_after).toBe(visible.at(-1)! + LIMITS.eventPageSize * 2);
  });

  it('bounds a socket replay by the UTF-8 bytes of the frames it sends', async () => {
    const w = await claimRelay();
    // Ten events of about 900 kB in UTF-8 but 300 k characters each: 9 MB of frames, 3 M characters.
    const wide = JSON.stringify({ note: '漢'.repeat(300_000) });
    await inRoom((room) => {
      for (let i = 0; i < 10; i++) {
        room.run(
          `INSERT INTO events (event_id, event_type, question_id, question_revision, origin_device_id, data, created_at)
           VALUES (?, 'attachment.available', NULL, NULL, NULL, ?, ?)`,
          newId(),
          wide,
          Date.now(),
        );
      }
    });
    const sock = await openSocket(w.owner);
    sock.ws.send(JSON.stringify({ t: 'sync', after: 0 }));
    const first = await sock.waitFor((f) => f.t === 'caught_up', 10_000);
    const sent = sock.frames.filter((f) => f.t === 'event');
    expect(first.has_more).toBe(true);
    expect(sent).toHaveLength(9);
    expect(first.high_water).toBe(sent.at(-1).event.seq);
    sock.close();
  });
});
