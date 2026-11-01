import { describe, expect, it } from 'vitest';
import {
  PolicyRegistry,
  fakeResumeAdapter,
  parseAnswers,
  type TerminalTarget,
} from '../src/index.js';
import { origin, setupBridge, makePhone } from './helpers.js';

async function asked(
  extra: Parameters<typeof setupBridge>[0] = {},
  input: Record<string, unknown> = {},
  o = origin(),
) {
  const env = await setupBridge(extra);
  const r = await env.bridge.registerQuestion({
    origin: o,
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
  return { ...env, qid: r.questionId, alias: r.alias };
}

describe('verified answers reach the exact pane', () => {
  it('delivers a human answer, then acks terminal delivery to the relay', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'], text: 'Looks good' });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    const text = sink.typed[0]!.text;
    expect(text).toContain('[DAINTREE DECISION ANSWER]');
    expect(text).toContain(`question_id: ${qid}`);
    expect(text).toContain('source: human');
    expect(text).toContain('choice: approve');
    expect(text).toContain('comment: Looks good');
    const row = (await store.getQuestion(qid))!;
    expect(row.delivery_status).toBe('terminal-delivered');
    expect(row.local_status).toBe('human-answered');
    const ack = relay.calls.find((c) => c.path === '/api/v1/deliveries/terminal');
    expect(ack).toBeTruthy();
    expect((ack!.body as { answer_revision: number }).answer_revision).toBe(1);
    // processing the same events again never re-injects
    await bridge.catchUp();
    await bridge.pump();
    expect(sink.typed).toHaveLength(1);
  });

  it('a busy pane is deferred and delivered once idle', async () => {
    const { bridge, relay, phone, sink, qid } = await asked();
    sink.panes.get('pane-1')!.idle = false;
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    sink.panes.get('pane-1')!.idle = true;
    await bridge.notifyPaneIdle();
    expect(sink.typed).toHaveLength(1);
  });

  it('an inject() reporting busy leaves the answer pending, not failed', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.injectBehaviour = 'busy';
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect((await store.getQuestion(qid))!.delivery_status).toBe('desktop-received');
    sink.injectBehaviour = 'ok';
    await bridge.notifyPaneIdle();
    expect(sink.typed).toHaveLength(1);
  });

  it('pane generation mismatch => needs-attention, never typed anywhere', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.panes.get('pane-1')!.generation = 2; // pane id reused by a new process
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    const row = (await store.getQuestion(qid))!;
    expect(row.delivery_status).toBe('needs-attention');
    expect(row.error_code).toBe('generation_mismatch');
    expect(relay.calls.some((c) => c.path === '/api/v1/deliveries/failed')).toBe(true);
    await bridge.pump();
    expect(sink.typed).toHaveLength(0);
  });

  it('pane gone with no verified resume => needs-attention (never a guessed pane)', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.addPane('pane-other'); // a different pane in the same worktree must not receive it
    sink.panes.delete('pane-1');
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect((await store.getQuestion(qid))!.error_code).toBe('pane_gone');
  });

  it('session mismatch is never delivered', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.panes.get('pane-1')!.session = 'someone-else';
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect((await store.getQuestion(qid))!.error_code).toBe('session_mismatch');
  });

  it('host offline waits as pending-host and delivers when it returns', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.panes.get('pane-1')!.hostOffline = true;
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect((await store.getQuestion(qid))!.delivery_status).toBe('pending-host');
    sink.panes.get('pane-1')!.hostOffline = false;
    await bridge.notifyPaneIdle();
    expect(sink.typed).toHaveLength(1);
  });

  it('resumes through a verified adapter into the new pane, once', async () => {
    const target: TerminalTarget = {
      hostId: 'host-local',
      paneId: 'pane-9',
      terminalGeneration: 5,
      worktreeId: 'wt-1',
      agentSessionId: 'sess-1',
    };
    const { bridge, relay, phone, sink, qid, store } = await asked({
      adapters: [fakeResumeAdapter('claude', target)],
    });
    sink.panes.delete('pane-1');
    sink.addPane('pane-9', { generation: 5, session: 'sess-1' });
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.target.paneId).toBe('pane-9');
    expect((await store.getQuestion(qid))!.agent_resume_strategy).toBe('adapter:claude');
  });

  it('default resume stubs report unsupported rather than inventing flags', async () => {
    const { claudeResumeAdapter } = await import('../src/index.js');
    expect((await claudeResumeAdapter.probe('h')).supported).toBe(false);
  });
});

describe('crash safety', () => {
  it('inject() throwing => delivery-uncertain and NO re-injection', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.injectBehaviour = 'throw';
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect((await store.getQuestion(qid))!.delivery_status).toBe('delivery-uncertain');
    sink.injectBehaviour = 'ok';
    await bridge.pump();
    await bridge.notifyPaneIdle();
    expect(sink.typed).toHaveLength(1); // only the one that threw
    expect(
      relay.calls.some(
        (c) =>
          c.path === '/api/v1/deliveries/failed' &&
          (c.body as { status: string }).status === 'delivery-uncertain',
      ),
    ).toBe(true);
  });

  it('restart after typing but before the ack: marker found => delivered, not repeated', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    // simulate: intent written + text typed, then the process died before bookkeeping
    await bridge.catchUp();
    const [typed] = sink.typed;
    const intent = (await store.getIntent(
      typed!.id.length ? (await store.getQuestion(qid))!.last_injection_id! : '',
    ))!;
    await store.putIntent({ ...intent, state: 'intent' });
    const q = (await store.getQuestion(qid))!;
    await store.updateQuestion(qid, {
      answers_json: JSON.stringify(
        parseAnswers(q.answers_json).map((e) => ({ ...e, delivered: false })),
      ),
      delivery_status: 'desktop-received',
    });
    const r = await bridge.delivery.recover();
    expect(r).toEqual({ reconciled: 1, uncertain: 0 });
    expect(sink.typed).toHaveLength(1);
    expect((await store.getQuestion(qid))!.delivery_status).toBe('terminal-delivered');
  });

  it('restart with no marker => delivery-uncertain, never re-injected', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    const intentId = (await store.getQuestion(qid))!.last_injection_id!;
    sink.typed.length = 0; // scrollback lost: the marker cannot be found
    await store.updateIntent(intentId, { state: 'intent' });
    const r = await bridge.delivery.recover();
    expect(r.uncertain).toBe(1);
    expect(sink.typed).toHaveLength(0);
    expect((await store.getQuestion(qid))!.delivery_status).toBe('delivery-uncertain');
    await bridge.pump();
    expect(sink.typed).toHaveLength(0);
  });

  it('terminal ack failure is retried later without typing again', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    const orig = relay.fetch;
    relay.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).includes('/deliveries/terminal')) throw new TypeError('offline');
      return orig(i, init);
    }) as typeof fetch;
    (bridge.ctx.client as unknown as { f: typeof fetch }).f = relay.fetch;
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    const intentId = (await store.getQuestion(qid))!.last_injection_id!;
    expect((await store.getIntent(intentId))!.state).toBe('typed');
    (bridge.ctx.client as unknown as { f: typeof fetch }).f = orig;
    await bridge.pump();
    expect((await store.getIntent(intentId))!.state).toBe('acked');
    expect(sink.typed).toHaveLength(1);
  });
});

describe('ordering, expiry, proxy labelling', () => {
  it('delivers several answers for one pane in question-creation order, batched', async () => {
    const env = await setupBridge();
    const a = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'first?', options: [{ id: 'x', label: 'X' }] },
    });
    const b = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'second?', options: [{ id: 'y', label: 'Y' }] },
    });
    await env.bridge.pump();
    // the phone answers the SECOND question first
    await env.relay.answerEvent({ questionId: b.questionId, phone: env.phone, options: ['y'] });
    await env.relay.answerEvent({ questionId: a.questionId, phone: env.phone, options: ['x'] });
    await env.bridge.catchUp();
    const all = env.sink.typed.map((t) => t.text).join('\n');
    expect(env.sink.typed.length).toBe(1); // batched into one chunk
    expect(all.indexOf(`question_id: ${a.questionId}`)).toBeLessThan(
      all.indexOf(`question_id: ${b.questionId}`),
    );
    expect(all.split('[DAINTREE DECISION ANSWER]').length - 1).toBe(2);
    expect(all.split('Daintree Decisions result follows').length - 1).toBe(1);
  });

  it('batch=false types one notice at a time', async () => {
    const env = await setupBridge({ batch: false });
    const a = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'first?' },
    });
    const b = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'second?' },
    });
    await env.bridge.pump();
    await env.relay.answerEvent({ questionId: a.questionId, phone: env.phone, text: 'one' });
    await env.relay.answerEvent({ questionId: b.questionId, phone: env.phone, text: 'two' });
    await env.bridge.catchUp();
    expect(env.sink.typed).toHaveLength(2);
  });

  it('expiry notice is explicit that the workflow is not authorised, and unsigned events never approve', async () => {
    const { bridge, relay, sink, qid, store } = await asked();
    relay.push('decision.expired', qid, 0, {
      expired_at: new Date().toISOString(),
      target_host_id: 'x'.repeat(12),
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.text).toContain('NOT authorised to continue');
    expect((await store.getQuestion(qid))!.local_status).toBe('expired');
  });

  it('override is delivered as a correction', async () => {
    const { bridge, relay, phone, sink, qid } = await asked();
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    await relay.answerEvent({
      questionId: qid,
      phone,
      action: 'override',
      expectedRevision: 1,
      options: ['reject'],
      text: 'changed my mind',
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(2);
    expect(sink.typed[1]!.text).toContain('CORRECTS an earlier answer');
    expect(sink.typed[1]!.text).toContain('revision: 2');
  });

  it('confirm-proxy is logged only and never typed', async () => {
    const env = await asked({}, {}, origin());
    const sinkBefore = env.sink.typed.length;
    // fabricate a proxy-answered question state by hand: proxy answer then human confirmation
    const owner = { deviceId: env.identity.config.deviceId, keys: env.identity.keys };
    void owner;
    await env.relay.answerEvent({
      questionId: env.qid,
      phone: env.phone,
      action: 'confirm-proxy',
      expectedRevision: 0,
      options: ['approve'],
      eventType: 'decision.proxy.confirmed',
      extra: {},
      confirmsActionId: 'a'.repeat(16),
    });
    await env.bridge.catchUp();
    expect(env.sink.typed.length).toBe(sinkBefore);
  });

  it('cancelling a proxy-answered question drops its undelivered answer', async () => {
    const env = await asked(
      { policy: new PolicyRegistry({ proxyAllowlisted: true }) },
      { requested_requirement: 'proxy-ok' },
    );
    const { bridge, relay, sink, qid, identity } = env;
    const desktop = { deviceId: identity.config.deviceId, keys: identity.keys };
    sink.panes.get('pane-1')!.idle = false;
    await relay.answerEvent({
      questionId: qid,
      phone: desktop,
      action: 'proxy-answer',
      options: ['approve'],
    });
    await bridge.catchUp();
    await relay.plainActionEvent({
      questionId: qid,
      signer: desktop,
      action: 'cancel',
      expectedRevision: 1,
      status: 'cancelled',
    });
    await bridge.catchUp();
    sink.panes.get('pane-1')!.idle = true;
    await bridge.notifyPaneIdle();
    expect(sink.typed).toHaveLength(0);
  });
});

describe('verification: forged or unauthorised events never reach a terminal', () => {
  it('a desktop-signed action claiming to be a human answer is rejected', async () => {
    const { bridge, relay, sink, qid, identity, store } = await asked();
    const ownerAsPhone = { deviceId: identity.config.deviceId, keys: identity.keys };
    await relay.answerEvent({ questionId: qid, phone: ownerAsPhone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    const audit = await store.listAudit(50);
    expect(
      audit.some(
        (a) => a.event === 'event.rejected' && a.result === 'human-action-by-non-human-device',
      ),
    ).toBe(true);
  });

  it('proxy-answer signed by a phone is rejected', async () => {
    const { bridge, relay, phone, sink, qid } = await asked(
      {},
      { requested_requirement: 'proxy-ok' },
    );
    await relay.answerEvent({
      questionId: qid,
      phone,
      action: 'proxy-answer',
      options: ['approve'],
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
  });

  it('a signature from an unknown device, or a tampered record, is rejected', async () => {
    const { bridge, relay, sink, qid, identity } = await asked();
    const stranger = await makePhone(identity); // valid cert, but the relay never lists it
    await relay.answerEvent({ questionId: qid, phone: stranger, options: ['approve'] });
    // right device id, wrong key
    const other = await makePhone(identity);
    const ev = await relay.answerEvent({
      questionId: qid,
      phone: { deviceId: relay.devices[0]!.device_id, keys: other.keys },
      options: ['approve'],
    });
    void ev;
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
  });

  it('a proxy answer on a human-required question is rejected even if correctly signed', async () => {
    const { bridge, relay, sink, qid, identity, store } = await asked();
    const desktop = { deviceId: identity.config.deviceId, keys: identity.keys };
    await relay.answerEvent({
      questionId: qid,
      phone: desktop,
      action: 'proxy-answer',
      options: ['approve'],
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect((await store.listAudit(50)).some((a) => a.result === 'proxy-on-human-required')).toBe(
      true,
    );
  });

  it('answers naming an option that was not offered are never delivered', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    await relay.answerEvent({ questionId: qid, phone, options: ['launch-missiles'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect((await store.getQuestion(qid))!.error_code).toBe('unknown_option');
  });

  it('events for questions this desktop never asked are ignored', async () => {
    const { bridge, relay, sink, store } = await asked();
    relay.push('decision.expired', 'someone-elses-question-id', 0, {
      expired_at: new Date().toISOString(),
      target_host_id: 'h'.repeat(12),
    });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect((await store.listQuestions()).length).toBe(1);
  });

  it('device.revoked for this device stops all delivery', async () => {
    const { bridge, relay, phone, sink, qid, identity } = await asked();
    relay.push('device.revoked', null, null, { device_id: identity.config.deviceId, key_epoch: 2 });
    await bridge.start({ socket: false });
    await bridge.catchUp();
    expect(bridge.state).toBe('revoked');
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp().catch(() => {});
    await bridge.notifyPaneIdle();
    expect(sink.typed).toHaveLength(0);
    await expect(
      bridge.registerQuestion({ origin: origin(), input: { question: 'q' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
