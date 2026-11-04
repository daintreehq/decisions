import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
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
import { act, ask, claimRelay, events, pairDevice, raw, type Actor } from './helpers.js';

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
    await act(w, phone, 'answer', answered.questionId, 0);
    const cancelled = await ask(w);
    await act(w, w.owner, 'cancel', cancelled.questionId, 0);
    await ask(w);
    const all = await events(w.owner);
    expect(all.length).toBeGreaterThanOrEqual(5);

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

    // The relay advertises an extension only once it implements it; today it implements none.
    const info = await raw('GET', '/api/v1/info');
    expect(info.json.features).toBeUndefined();
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
