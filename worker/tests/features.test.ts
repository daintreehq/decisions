import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { EventsPage, PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import {
  ask,
  claimRelay,
  declare,
  pairDevice,
  raw,
  say,
  type Actor,
  type World,
} from './helpers.js';

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
    expect((await raw('GET', '/api/v1/info')).json.features).toEqual(['thread-messages-v1']);
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

    // A baseline socket from the same device: no message events, and the cursor still reaches the end.
    const baseline = await socket(
      (await phone.call('POST', '/api/v1/socket-ticket', {})).json.ticket,
    );
    baseline.ws.send(JSON.stringify({ t: 'sync', after: 0 }));
    const done = await baseline.until((f) => f.t === 'caught_up');
    expect(done).toMatchObject({ high_water: caught.high_water, has_more: false });
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
    ).toHaveLength(5);
    void w;
    modern.ws.close(1000, 'bye');
    baseline.ws.close(1000, 'bye');
  });
});
