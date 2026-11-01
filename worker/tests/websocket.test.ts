import { describe, expect, it } from 'vitest';
import { evictDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { newId, signRequest } from '@daintree/decisions-crypto';
import { act, ask, claimRelay, pairDevice, raw, stub, type Actor, type World } from './helpers.js';
import { buildRotation } from './devices.helpers.js';

interface Sock {
  ws: WebSocket;
  frames: any[];
  next(pred?: (f: any) => boolean, ms?: number): Promise<any>;
  close(): void;
}

async function connect(a: Actor, ticketOverride?: string): Promise<Sock | Response> {
  const t = ticketOverride ?? (await a.call('POST', '/api/v1/socket-ticket', {})).json.ticket;
  const res = await exports.default.fetch(
    new Request(`https://relay.test/api/v1/socket?ticket=${t}`, {
      headers: { Upgrade: 'websocket' },
    }),
  );
  if (res.status !== 101) return res;
  const ws = res.webSocket!;
  ws.accept();
  const frames: any[] = [];
  const waiters: { pred: (f: any) => boolean; resolve: (f: any) => void }[] = [];
  ws.addEventListener('message', (ev) => {
    let f: any;
    try {
      f = JSON.parse(ev.data as string);
    } catch {
      return; // plain-text keep-alive (pong)
    }
    frames.push(f);
    for (const w of [...waiters])
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
  });
  return {
    ws,
    frames,
    close: () => ws.close(1000, 'bye'),
    next: (pred = () => true, ms = 4000) =>
      new Promise((resolve, reject) => {
        const hit = frames.find(pred);
        if (hit) return resolve(hit);
        const timer = setTimeout(() => reject(new Error('timeout waiting for frame')), ms);
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      }),
  };
}
const asSock = (s: Sock | Response): Sock => {
  if (s instanceof Response) throw new Error(`upgrade failed ${s.status}`);
  return s;
};

describe('hibernatable WebSocket', () => {
  let w: World;
  it('rejects missing, forged and reused tickets', async () => {
    w = await claimRelay();
    const noTicket = await exports.default.fetch(
      new Request('https://relay.test/api/v1/socket', { headers: { Upgrade: 'websocket' } }),
    );
    expect(noTicket.status).toBe(401);
    expect(((await connect(w.owner, 'x'.repeat(32))) as Response).status).toBe(401);
    const t = (await w.owner.call('POST', '/api/v1/socket-ticket', {})).json.ticket;
    const first = asSock(await connect(w.owner, t));
    first.close();
    expect(((await connect(w.owner, t)) as Response).status).toBe(401); // single use
    // non-websocket request to the socket path is a plain error, not a hang
    expect((await raw('GET', '/api/v1/socket')).status).toBe(400);
  });

  it('says hello, pushes new events live and answers sync from a cursor', async () => {
    w = await claimRelay();
    const phone = await pairDevice(w);
    const desktop = asSock(await connect(w.owner));
    const hello = await desktop.next((f) => f.t === 'hello');
    expect(hello).toMatchObject({
      device_id: w.owner.id,
      role: 'owner-desktop',
      key_epoch: 1,
      protocol_version: 1,
    });
    const { questionId } = await ask(w);
    const created = await desktop.next(
      (f) => f.t === 'event' && f.event.event_type === 'decision.created',
    );
    expect(created.event.question_id).toBe(questionId);
    await act(w, phone, 'answer', questionId, 0);
    const committed = await desktop.next(
      (f) => f.t === 'event' && f.event.event_type === 'decision.answer.committed',
    );
    expect(committed.event.data.deliverable).toBe(true);
    expect(committed.event.seq).toBeGreaterThan(created.event.seq);

    // a fresh connection can catch up from its cursor
    const late = asSock(await connect(w.owner));
    late.ws.send(JSON.stringify({ t: 'sync', after: created.event.seq }));
    const caught = await late.next((f) => f.t === 'caught_up');
    expect(caught.high_water).toBe(committed.event.seq);
    const replayed = late.frames.filter((f) => f.t === 'event').map((f) => f.event.seq);
    expect(replayed).toEqual([committed.event.seq]);
    desktop.close();
    late.close();
  });

  it('replaces an older socket from the same device (code 4409)', async () => {
    w = await claimRelay();
    const a = asSock(await connect(w.owner));
    await a.next((f) => f.t === 'hello');
    const closed = new Promise<number>((r) =>
      a.ws.addEventListener('close', (e) => r((e as CloseEvent).code)),
    );
    asSock(await connect(w.owner));
    expect(await closed).toBe(4409);
  });

  it('acks mark deliveries desktop-received and emit delivery.received', async () => {
    w = await claimRelay();
    const phone = await pairDevice(w);
    const desktop = asSock(await connect(w.owner));
    const { questionId } = await ask(w);
    await act(w, phone, 'answer', questionId, 0);
    const committed = await desktop.next(
      (f) => f.t === 'event' && f.event.event_type === 'decision.answer.committed',
    );
    desktop.ws.send(JSON.stringify({ t: 'ack', seq: committed.event.seq }));
    const rec = await desktop.next(
      (f) => f.t === 'event' && f.event.event_type === 'delivery.received',
    );
    expect(rec.event.question_id).toBe(questionId);
    const d = await phone.call('GET', `/api/v1/questions/${questionId}`);
    expect(d.json.deliveries[0].status).toBe('desktop-received');
    // phones cannot ack
    const p = asSock(await connect(phone));
    p.ws.send(JSON.stringify({ t: 'ack', seq: 9999 }));
    await new Promise((r) => setTimeout(r, 100));
    const dev = (await w.owner.call('GET', '/api/v1/devices')).json.devices.find(
      (x: any) => x.device_id === phone.id,
    );
    expect(dev.last_ack_seq).toBe(0);
    desktop.close();
    p.close();
  });

  it('tunnels signed REST requests and rejects unsigned ones', async () => {
    w = await claimRelay();
    const s = asSock(await connect(w.owner));
    const { authorization } = await signRequest({
      method: 'GET',
      path: '/api/v1/devices',
      installationId: w.installationId,
      deviceId: w.owner.id,
      signingKey: w.owner.keys.signing.privateKey,
    });
    s.ws.send(
      JSON.stringify({
        t: 'req',
        id: 'r1',
        method: 'GET',
        path: '/api/v1/devices',
        query: '',
        authorization,
      }),
    );
    const res = await s.next((f) => f.t === 'res' && f.id === 'r1');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).devices).toHaveLength(1);
    s.ws.send(
      JSON.stringify({
        t: 'req',
        id: 'r2',
        method: 'GET',
        path: '/api/v1/devices',
        query: '',
        authorization: 'Decisions-Sig nope',
      }),
    );
    expect((await s.next((f) => f.t === 'res' && f.id === 'r2')).status).toBe(401);
    // the same signed request replayed through the socket is a replay
    s.ws.send(
      JSON.stringify({
        t: 'req',
        id: 'r3',
        method: 'GET',
        path: '/api/v1/devices',
        query: '',
        authorization,
      }),
    );
    expect((await s.next((f) => f.t === 'res' && f.id === 'r3')).status).toBe(401);
    // attachment content cannot be tunnelled
    s.ws.send(
      JSON.stringify({
        t: 'req',
        id: 'r4',
        method: 'PUT',
        path: '/api/v1/attachments/abcdefgh12/content',
        query: '',
        authorization,
      }),
    );
    expect((await s.next((f) => f.t === 'res' && f.id === 'r4')).status).toBe(404);
    s.close();
  });

  it('closes bad frames and survives the object being evicted (hibernation)', async () => {
    w = await claimRelay();
    const s = asSock(await connect(w.owner));
    await s.next((f) => f.t === 'hello');
    await evictDurableObject(stub());
    // after eviction the socket is still usable: the object wakes and re-validates
    s.ws.send(JSON.stringify({ t: 'sync', after: 0 }));
    expect((await s.next((f) => f.t === 'caught_up')).t).toBe('caught_up');
    // new events still reach the hibernated socket after wake
    await ask(w);
    await s.next((f) => f.t === 'event' && f.event.event_type === 'decision.created');
    s.ws.send(JSON.stringify({ t: 'bogus' }));
    expect((await s.next((f) => f.t === 'error')).code).toBe('validation_error');
    s.close();
  });

  it('answers the plain-text ping with pong without the object handling it', async () => {
    w = await claimRelay();
    const s = asSock(await connect(w.owner));
    const pong = new Promise<string>((r) =>
      s.ws.addEventListener('message', (e) => {
        if (e.data === 'pong') r('pong');
      }),
    );
    s.ws.send('ping');
    expect(await pong).toBe('pong');
    s.close();
  });

  it('revoking a device closes its socket with 4401 and blocks reconnection', async () => {
    w = await claimRelay();
    const phone = await pairDevice(w);
    const s = asSock(await connect(phone));
    await s.next((f) => f.t === 'hello');
    const closed = new Promise<number>((r) =>
      s.ws.addEventListener('close', (e) => r((e as CloseEvent).code)),
    );
    const { body } = await buildRotation(w, []);
    expect((await w.owner.call('POST', `/api/v1/devices/${phone.id}/revoke`, body)).status).toBe(
      200,
    );
    expect(await closed).toBe(4401);
    expect(s.frames.some((f) => f.t === 'revoked')).toBe(true);
    expect((await phone.call('POST', '/api/v1/socket-ticket', {})).status).toBe(401);
    void newId;
  });
});
