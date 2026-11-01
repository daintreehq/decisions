import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@daintree/decisions-protocol';
import { newId } from '@daintree/decisions-crypto';
import { act, ask, claimRelay, events, pairDevice } from './helpers.js';

describe('delivery acknowledgements', () => {
  async function answered() {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    await act(w, phone, 'answer', questionId, 0);
    return { w, phone, questionId };
  }

  it('receipt, terminal delivery and failure are distinct, ordered states the phone can see', async () => {
    const { w, phone, questionId } = await answered();
    const seq = (await events(w.owner)).at(-1).seq;
    expect(
      (await w.owner.call('POST', '/api/v1/deliveries/received', { protocol_version: 1, seq }))
        .status,
    ).toBe(200);
    let d = (await phone.call('GET', `/api/v1/questions/${questionId}`)).json.deliveries[0];
    expect(d.status).toBe('desktop-received');
    const injection = newId();
    const body = {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(),
      question_id: questionId,
      answer_revision: 1,
      injection_id: injection,
      host_id: 'host_aaaaaaaa',
    };
    expect((await w.owner.call('POST', '/api/v1/deliveries/terminal', body)).status).toBe(200);
    expect((await w.owner.call('POST', '/api/v1/deliveries/terminal', body)).status).toBe(200); // idempotent
    d = (await phone.call('GET', `/api/v1/questions/${questionId}`)).json.deliveries[0];
    expect(d).toMatchObject({ status: 'terminal-delivered', injection_id: injection });
    expect(
      (await events(phone)).filter((e) => e.event_type === 'delivery.terminal_delivered'),
    ).toHaveLength(1);
    // a different injection id after delivery is refused (no double injection bookkeeping)
    expect(
      (
        await w.owner.call('POST', '/api/v1/deliveries/terminal', {
          ...body,
          injection_id: newId(),
        })
      ).status,
    ).toBe(409);
  });

  it('records needs-attention and delivery-uncertain without claiming delivery', async () => {
    const { w, phone, questionId } = await answered();
    const f = await w.owner.call('POST', '/api/v1/deliveries/failed', {
      protocol_version: 1,
      idempotency_key: newId(),
      question_id: questionId,
      answer_revision: 1,
      host_id: 'host_aaaaaaaa',
      status: 'needs-attention',
      error_code: 'pane_gone',
    });
    expect(f.status).toBe(200);
    expect(
      (await phone.call('GET', `/api/v1/questions/${questionId}`)).json.deliveries[0],
    ).toMatchObject({ status: 'needs-attention', error_code: 'pane_gone' });
    const ev = (await events(phone)).at(-1);
    expect(ev).toMatchObject({ event_type: 'delivery.needs_attention' });
    expect(ev.data).toMatchObject({ status: 'needs-attention', error_code: 'pane_gone' });
  });

  it('unknown deliveries are 404 and phones cannot acknowledge', async () => {
    const { w, phone, questionId } = await answered();
    const miss = {
      protocol_version: 1,
      idempotency_key: newId(),
      question_id: newId(),
      answer_revision: 1,
      injection_id: newId(),
      host_id: 'host_aaaaaaaa',
    };
    expect((await w.owner.call('POST', '/api/v1/deliveries/terminal', miss)).status).toBe(404);
    expect(
      (
        await phone.call('POST', '/api/v1/deliveries/terminal', {
          ...miss,
          question_id: questionId,
        })
      ).status,
    ).toBe(403);
    expect(
      (await phone.call('POST', '/api/v1/deliveries/received', { protocol_version: 1, seq: 99 }))
        .status,
    ).toBe(403);
  });
});
