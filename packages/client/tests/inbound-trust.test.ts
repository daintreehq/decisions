import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@daintree/decisions-protocol';
import { PolicyRegistry, parseAnswers } from '../src/index.js';
import { makePhone, origin, setupBridge, tick } from './helpers.js';

async function asked(
  extra: Parameters<typeof setupBridge>[0] = {},
  input: Record<string, unknown> = {},
) {
  const env = await setupBridge(extra);
  const r = await env.bridge.registerQuestion({
    origin: origin(),
    input: {
      question: 'Ship it?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      ...input,
    },
  });
  await env.bridge.pump();
  const desktop = { deviceId: env.identity.config.deviceId, keys: env.identity.keys };
  return { ...env, qid: r.questionId, desktop };
}
const reasons = async (s: {
  listAudit(n: number): Promise<{ event: string; result?: string | undefined }[]>;
}) => (await s.listAudit(100)).filter((a) => a.event === 'event.rejected').map((a) => a.result);

describe('A: event type is bound to the signed action', () => {
  it('a signed cancel wrapped in decision.answer.committed is never delivered as an answer', async () => {
    const { bridge, relay, sink, qid, desktop, store } = await asked();
    await relay.plainActionEvent({
      questionId: qid,
      signer: desktop,
      action: 'cancel',
      eventType: 'decision.answer.committed',
      status: 'human-answered',
      revision: 1,
      provenance: null,
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect(await reasons(store)).toContain('event-action-mismatch');
    expect((await store.getQuestion(qid))!.local_status).toBe('open');
  });
  it('declaring a different action than the signed record is rejected too', async () => {
    const { bridge, relay, sink, qid, phone, store } = await asked();
    await relay.answerEvent({
      questionId: qid,
      phone,
      options: ['approve'],
      dataOverride: { action: 'override' },
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect(await reasons(store)).toContain('event-action-mismatch');
  });
  it('null provenance is never treated as human', async () => {
    const { bridge, relay, sink, qid, phone, store } = await asked();
    await relay.answerEvent({
      questionId: qid,
      phone,
      options: ['approve'],
      dataOverride: { provenance: null },
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect(await reasons(store)).toContain('provenance-mismatch');
  });
  it('a cancel record signed by a phone is rejected', async () => {
    const { bridge, relay, qid, phone, store } = await asked();
    await relay.plainActionEvent({
      questionId: qid,
      signer: phone,
      action: 'cancel',
      status: 'cancelled',
    });
    await bridge.catchUp();
    expect((await store.getQuestion(qid))!.local_status).toBe('open');
    expect(
      (await reasons(store)).some(
        (r) => r === 'desktop-action-by-non-desktop-device' || r?.startsWith('transition:'),
      ),
    ).toBe(true);
  });
});

describe('A: status and revision come from the shared transition table, not the relay', () => {
  it('a losing signed answer replayed by the relay is not typed again', async () => {
    const { bridge, relay, sink, qid, phone, store, identity } = await asked();
    const second = await makePhone(identity, 'tablet');
    relay.devices.push(second.cert);
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] }); // wins, revision 1
    await relay.answerEvent({ questionId: qid, phone: second, options: ['reject'] }); // signed at revision 0, lost the race
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.text).toContain('choice: approve');
    expect(await reasons(store)).toContain('transition:revision_conflict');
    expect(parseAnswers((await store.getQuestion(qid))!.answers_json)).toHaveLength(1);
  });
  it('relay-lied status/revision metadata is rejected', async () => {
    const { bridge, relay, sink, qid, phone, store } = await asked();
    await relay.answerEvent({
      questionId: qid,
      phone,
      options: ['approve'],
      dataOverride: { revision: 5, status: 'cancelled' },
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect(await reasons(store)).toContain('relay-metadata-mismatch');
  });
  it('answering a cancelled question is rejected', async () => {
    const { bridge, relay, sink, qid, phone, desktop, store } = await asked();
    await relay.plainActionEvent({
      questionId: qid,
      signer: desktop,
      action: 'cancel',
      status: 'cancelled',
    });
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect((await reasons(store)).some((r) => r?.startsWith('transition:'))).toBe(true);
  });
});

describe('A: compare-and-swap is enforced locally even when the relay lies consistently', () => {
  it('a signed answer for another revision is rejected although the open question and metadata look right', async () => {
    const { bridge, relay, sink, qid, phone, store } = await asked();
    // the phone legitimately signed this against revision 3 some other time; the relay replays it here
    await relay.answerEvent({
      questionId: qid,
      phone,
      options: ['approve'],
      expectedRevision: 3,
      dataOverride: { revision: 1, status: 'human-answered' },
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect(await reasons(store)).toContain('transition:revision_conflict');
  });
});

describe('A: device changes refresh the signer directory', () => {
  it('a device approved after the directory was cached can answer immediately', async () => {
    const { bridge, relay, sink, qid, phone, identity } = await asked();
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp(); // directory cached with the first phone only
    const q2 = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'second?', options: [{ id: 'approve', label: 'A' }] },
    });
    await bridge.pump();
    const tablet = await makePhone(identity, 'tablet');
    relay.devices.push(tablet.cert);
    relay.push('device.approved', null, null, { cert: tablet.cert });
    await relay.answerEvent({ questionId: q2.questionId, phone: tablet, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(2);
  });
});

describe('A: envelope record_type equals the action kind on both paths', () => {
  it('an override sealed as record_type "answer" is rejected; "override" is accepted', async () => {
    const { bridge, relay, sink, qid, phone, store } = await asked();
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await relay.answerEvent({
      questionId: qid,
      phone,
      action: 'override',
      expectedRevision: 1,
      options: ['reject'],
      recordType: 'answer',
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(await reasons(store)).toContain('decryption-failed');
    await relay.answerEvent({
      questionId: qid,
      phone,
      action: 'override',
      expectedRevision: 1,
      options: ['reject'],
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(2);
  });
  it('outbound proxy answers are sealed as record_type "proxy-answer"', async () => {
    const env = await setupBridge({
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
      proxy: {
        async suggest() {
          return {
            action: 'answer',
            selected_option_ids: ['yes'],
            confidence: 0.9,
            model_id: 'm',
            prompt_template_version: 'v1',
            retrieval_reference_ids: [],
            risk_flags: [],
          };
        },
      },
    });
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: {
        question: 'q',
        options: [{ id: 'yes', label: 'Y' }],
        requested_requirement: 'proxy-ok',
      },
    });
    await env.bridge.pump();
    await env.bridge.pump();
    const sent = env.relay.calls.find(
      (c) => c.path === `/api/v1/questions/${r.questionId}/proxy-answer`,
    )!;
    const body = sent.body as {
      action: { record: { action: string }; envelope: { aad: { record_type: string } } };
    };
    expect(body.action.envelope.aad.record_type).toBe(body.action.record.action);
    expect(body.action.envelope.aad.record_type).toBe('proxy-answer');
  });
});

describe('A: revocation sticks', () => {
  it('after a device.revoked event, a stale device directory cannot re-authorise the signer', async () => {
    const env = await asked();
    const { bridge, relay, sink, qid, phone, store } = env;
    // the directory keeps listing the phone as active (stale), but the ledger says it was revoked
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp(); // phone is now cached as a good signer
    expect(sink.typed).toHaveLength(1);
    relay.push('device.revoked', null, null, { device_id: phone.deviceId, key_epoch: 2 });
    const q2 = await bridge.registerQuestion({
      origin: origin({ pane_id: 'pane-1' }),
      input: { question: 'again?', options: [{ id: 'approve', label: 'A' }] },
    });
    await bridge.pump();
    await relay.answerEvent({ questionId: q2.questionId, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(await reasons(store)).toContain('signer-revoked');
    expect(await store.getMeta(`revoked:${phone.deviceId}`)).not.toBeNull();
  });
});

describe('A: only the confirmed frontier is processed; gaps are recovered, holes are tolerated', () => {
  it('an event beyond a missing one is not applied until the gap is resolved', async () => {
    const { bridge, relay, sink, qid, phone, store } = await asked();
    await bridge.catchUp(); // cursor at the created event
    relay.skipSeq(1); // seq N+1 is "lost"
    const ev = await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.inbox.persist(ev); // arrives live, ahead of the hole
    expect(await bridge.inbox.processPending()).toBe(false);
    expect(sink.typed).toHaveLength(0);
    expect(await bridge.inbox.hasGap()).toBe(true);
    expect((await store.getCursor()) < ev.seq).toBe(true);
    await bridge.catchUp(); // authoritative paging: the hole is a legitimate tombstone
    expect(sink.typed).toHaveLength(1);
    expect(await store.getCursor()).toBe(ev.seq);
  });
  it('HTTP catch-up crosses a hole spanning multiple pages without refetching the same page', async () => {
    const env = await setupBridge();
    env.relay.skipSeq(30);
    for (let i = 0; i < 260; i++) env.relay.push('decision.expired', null, null, {});
    const cursor = await env.bridge.catchUp();
    expect(cursor).toBe(env.relay.seqCounter);
    const pages = env.relay.calls.filter((c) => c.path === '/api/v1/events');
    expect(pages.length).toBeLessThanOrEqual(5);
  });
  it('caught_up with has_more continues from high_water and moves the cursor past holes', async () => {
    const env = await setupBridge();
    env.relay.skipSeq(5);
    const ev = env.relay.push('decision.expired', null, null, {});
    await env.bridge.inbox.persist(ev);
    expect(await env.store.getCursor()).toBe(0); // hole before it
    await (
      env.bridge as unknown as { onCaughtUp(h: number, m: boolean): Promise<void> }
    ).onCaughtUp(ev.seq, true);
    expect(await env.store.getCursor()).toBe(ev.seq);
    void PROTOCOL_VERSION;
  });
});

describe('A: transient failures retry in order; permanent ones do not', () => {
  it('a failed device-directory fetch leaves the answer unprocessed and it is applied on retry', async () => {
    const { bridge, relay, sink, qid, phone, store } = await asked();
    await bridge.catchUp();
    const ev = await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.inbox.persist(ev);
    relay.down = 50; // the directory cannot be fetched
    await bridge.inbox.processPending();
    expect(sink.typed).toHaveLength(0);
    expect((await store.unprocessedEvents(10)).map((e) => e.seq)).toContain(ev.seq);
    relay.down = 0;
    await bridge.inbox.processPending();
    await bridge.pump();
    expect(sink.typed).toHaveLength(1);
  });
  it('a permanent rejection is consumed (not retried forever)', async () => {
    const { bridge, relay, qid, phone, store } = await asked();
    await bridge.catchUp();
    const ev = await relay.answerEvent({
      questionId: qid,
      phone,
      options: ['approve'],
      dataOverride: { provenance: null },
    });
    await bridge.inbox.persist(ev);
    await bridge.inbox.processPending();
    expect((await store.unprocessedEvents(10)).some((e) => e.seq === ev.seq)).toBe(false);
  });
});

describe('B: serialised inbox, atomic dedupe', () => {
  it('concurrent consumers never record or deliver an answer twice', async () => {
    const { bridge, relay, sink, qid, phone, store } = await asked();
    await bridge.catchUp();
    sink.typed.length = 0;
    const ev = await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.inbox.persist(ev);
    // A store that yields between operations makes the read-modify-write race real.
    const orig = store.getQuestion.bind(store);
    store.getQuestion = async (id) => {
      const r = await orig(id);
      await tick(3);
      return r;
    };
    const applied = await Promise.all([
      bridge.inbox.processPending(),
      bridge.inbox.processPending(),
    ]);
    expect(applied.filter(Boolean)).toHaveLength(1); // exactly one consumer applies the event
    await Promise.all([bridge.pump(), bridge.pump()]);
    await bridge.pump();
    expect(sink.typed).toHaveLength(1);
    expect(parseAnswers((await store.getQuestion(qid))!.answers_json)).toHaveLength(1);
  });
});
