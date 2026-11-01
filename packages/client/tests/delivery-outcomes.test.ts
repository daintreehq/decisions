import { describe, expect, it } from 'vitest';
import {
  fakeResumeAdapter,
  paneIdentityOf,
  sameTarget,
  type AgentResumeAdapter,
  type QuestionOrigin,
  type TerminalTarget,
} from '../src/index.js';
import { origin, setupBridge } from './helpers.js';

async function asked(extra: Parameters<typeof setupBridge>[0] = {}, o: QuestionOrigin = origin()) {
  const env = await setupBridge(extra);
  const r = await env.bridge.registerQuestion({
    origin: o,
    input: { question: 'Ship it?', options: [{ id: 'approve', label: 'Approve' }] },
  });
  await env.bridge.pump();
  return { ...env, qid: r.questionId };
}

const failedCalls = (relay: { calls: { path: string; body: unknown }[] }) =>
  relay.calls
    .filter((c) => c.path === '/api/v1/deliveries/failed')
    .map((c) => c.body as { status: string; error_code: string });
const terminalAcks = (relay: { calls: { path: string }[] }) =>
  relay.calls.filter((c) => c.path === '/api/v1/deliveries/terminal');

const target = (over: Partial<TerminalTarget> = {}): TerminalTarget => ({
  hostId: 'host-local',
  paneId: 'pane-1',
  terminalGeneration: 1,
  ownershipPrincipal: 'principal-1',
  agentIncarnation: 'inc-1',
  agentSessionId: 'sess-1',
  worktreeId: 'wt-1',
  ...over,
});

/** A resume adapter that records whether it was asked to act. */
function spyAdapter(t: TerminalTarget | null): AgentResumeAdapter & { resumed: number } {
  const inner = fakeResumeAdapter('claude', t);
  const spy = {
    ...inner,
    resumed: 0,
    async resume(o: QuestionOrigin) {
      spy.resumed++;
      return inner.resume(o);
    },
  };
  return spy;
}

describe('the full pane identity includes the ownership principal and agent incarnation', () => {
  it('sameTarget compares every identity field', () => {
    expect(sameTarget(target(), target())).toBe(true);
    for (const over of [
      { hostId: 'h2' },
      { paneId: 'p2' },
      { terminalGeneration: 2 },
      { ownershipPrincipal: 'principal-2' },
      { agentIncarnation: 'inc-2' },
      { agentSessionId: 'sess-2' },
      { worktreeId: 'wt-2' },
    ])
      expect(sameTarget(target(), target(over))).toBe(false);
  });

  it('paneIdentityOf carries the principal and incarnation from the origin', () => {
    expect(paneIdentityOf(origin())).toEqual({
      host_id: 'host-local',
      pane_id: 'pane-1',
      terminal_generation: 1,
      ownership_principal: 'principal-1',
      agent_incarnation: 'inc-1',
      agent_session_id: 'sess-1',
      worktree_id: 'wt-1',
    });
  });

  it('a question needs a non-empty principal and incarnation from the host', async () => {
    const env = await setupBridge();
    for (const o of [origin({ ownership_principal: '' }), origin({ agent_incarnation: '' })]) {
      await expect(
        env.bridge.registerQuestion({ origin: o, input: { question: 'q?' } }),
      ).rejects.toMatchObject({ code: 'validation_error' });
    }
    // a host built against the old origin type (fields missing entirely) is refused too
    const legacy = { ...origin() } as Partial<QuestionOrigin>;
    delete legacy.ownership_principal;
    delete legacy.agent_incarnation;
    await expect(
      env.bridge.registerQuestion({ origin: legacy as QuestionOrigin, input: { question: 'q?' } }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('a reused pane id with a new principal never receives the old pane answer', () => {
  it('relaunched pane (same pane id, generation and session; new principal) => needs-attention, nothing typed', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.panes.get('pane-1')!.principal = 'principal-2';
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    await bridge.pump();
    expect(sink.typed).toHaveLength(0);
    const row = (await store.getQuestion(qid))!;
    expect(row.delivery_status).toBe('needs-attention');
    expect(row.error_code).toBe('relaunched');
    expect(failedCalls(relay)).toEqual([
      expect.objectContaining({ status: 'needs-attention', error_code: 'relaunched' }),
    ]);
  });

  it('a new agent incarnation in the same pane is also a different run', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.panes.get('pane-1')!.incarnation = 'inc-2';
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect((await store.getQuestion(qid))!.error_code).toBe('relaunched');
  });

  it('the new run gets only its own answer, never the old run one', async () => {
    const env = await setupBridge();
    const old = await env.bridge.registerQuestion({
      origin: origin(),
      input: { question: 'old run?', options: [{ id: 'x', label: 'X' }] },
    });
    // Daintree relaunches the pane: same pane id, new principal
    env.sink.panes.get('pane-1')!.principal = 'principal-2';
    const fresh = await env.bridge.registerQuestion({
      origin: origin({ ownership_principal: 'principal-2' }),
      input: { question: 'new run?', options: [{ id: 'y', label: 'Y' }] },
    });
    await env.bridge.pump();
    await env.relay.answerEvent({ questionId: old.questionId, phone: env.phone, options: ['x'] });
    await env.relay.answerEvent({
      questionId: fresh.questionId,
      phone: env.phone,
      options: ['y'],
    });
    await env.bridge.catchUp();
    await env.bridge.pump();
    const all = env.sink.typed.map((t) => t.text).join('\n');
    expect(all).toContain(`question_id: ${fresh.questionId}`);
    expect(all).not.toContain(`question_id: ${old.questionId}`);
    expect(env.sink.typed.every((t) => t.target.ownershipPrincipal === 'principal-2')).toBe(true);
    expect((await env.store.getQuestion(old.questionId))!.delivery_status).toBe('needs-attention');
    // and the new run cannot read or cancel the old run's question
    const newPane = paneIdentityOf(origin({ ownership_principal: 'principal-2' }));
    await expect(env.bridge.getDecision(old.questionId, newPane)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(env.bridge.cancelQuestion(old.questionId, newPane)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('a sink that reports "alive" for a different run is caught before anything is typed', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    // a naive sink that only compares pane id and generation
    sink.locateOverride = (_n, o) => ({
      state: 'alive',
      target: target({ paneId: o.pane_id, ownershipPrincipal: 'principal-OTHER' }),
    });
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(0);
    expect(sink.injectCalls).toBe(0);
    const row = (await store.getQuestion(qid))!;
    expect(row.delivery_status).toBe('needs-attention');
    expect(row.error_code).toBe('target_mismatch');
  });

  it('a relaunched pane is resumed through a verified adapter when one can', async () => {
    const resumed = target({
      paneId: 'pane-7',
      terminalGeneration: 3,
      ownershipPrincipal: 'principal-7',
      agentIncarnation: 'inc-7',
    });
    const adapter = spyAdapter(resumed);
    const { bridge, relay, phone, sink, qid, store } = await asked({ adapters: [adapter] });
    sink.panes.get('pane-1')!.principal = 'principal-2';
    sink.addPane('pane-7', { generation: 3, principal: 'principal-7', incarnation: 'inc-7' });
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(adapter.resumed).toBe(1);
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.target).toEqual(resumed);
    expect((await store.getQuestion(qid))!.delivery_status).toBe('terminal-delivered');
  });
});

describe('sink outcomes', () => {
  it('delivered with proof => terminal-delivered, acked to the relay, proof in the audit', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(sink.typed).toHaveLength(1);
    const row = (await store.getQuestion(qid))!;
    expect(row.delivery_status).toBe('terminal-delivered');
    expect((await store.getIntent(row.last_injection_id!))!.state).toBe('acked');
    expect(terminalAcks(relay)).toHaveLength(1);
    const audit = (await store.listAudit(100)).find((a) => a.event === 'answer.delivered');
    expect(audit?.detail?.proof).toBe(`pty_written:${row.last_injection_id}`);
  });

  it('"delivered" without proof is not delivered: it becomes delivery-uncertain and is never re-typed', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.injectBehaviour = 'no-proof';
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    const row = (await store.getQuestion(qid))!;
    expect(row.delivery_status).toBe('delivery-uncertain');
    expect(row.error_code).toBe('delivered_without_proof');
    expect(await store.hasUncertainIntent(qid)).toBe(true);
    expect(terminalAcks(relay)).toHaveLength(0);
    sink.injectBehaviour = 'ok';
    await bridge.pump();
    await bridge.notifyPaneIdle();
    expect(sink.typed).toHaveLength(1);
  });

  it('an unrecognised result (the old { ok: true } shape) is treated as ambiguous, never delivered', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.injectBehaviour = 'legacy-ok';
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    const row = (await store.getQuestion(qid))!;
    expect(row.delivery_status).toBe('delivery-uncertain');
    expect(row.error_code).toBe('invalid_inject_result');
    expect(terminalAcks(relay)).toHaveLength(0);
  });

  it('held => no attention, nothing reported to the relay, delivered on a later pass', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.injectBehaviour = 'held';
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    const r = await bridge.notifyPaneIdle();
    expect(r).toMatchObject({ delivered: 0, needsAttention: 0, uncertain: 0 });
    expect(r.deferred).toBeGreaterThan(0);
    const row = (await store.getQuestion(qid))!;
    expect(row.delivery_status).toBe('desktop-received');
    expect(row.error_code).toBeNull();
    expect(failedCalls(relay)).toEqual([]);
    expect(await store.hasUncertainIntent(qid)).toBe(false);
    expect(await store.openIntents()).toEqual([]); // the held attempt's intent is closed
    sink.injectBehaviour = 'ok';
    await bridge.notifyPaneIdle();
    expect(sink.typed).toHaveLength(1);
    expect((await store.getQuestion(qid))!.delivery_status).toBe('terminal-delivered');
  });

  it('unavailable: relaunched, no adapter => needs-attention with the reason', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.injectBehaviour = { unavailable: 'relaunched' };
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    const row = (await store.getQuestion(qid))!;
    expect(row.delivery_status).toBe('needs-attention');
    expect(row.error_code).toBe('relaunched');
    expect(await store.hasUncertainIntent(qid)).toBe(false);
    expect(failedCalls(relay)).toEqual([
      expect.objectContaining({ status: 'needs-attention', error_code: 'relaunched' }),
    ]);
  });

  it('unavailable: gone, with a verified adapter => resumed and delivered there', async () => {
    const resumed = target({ paneId: 'pane-8', ownershipPrincipal: 'principal-8' });
    const adapter = spyAdapter(resumed);
    const { bridge, relay, phone, sink, qid, store } = await asked({ adapters: [adapter] });
    sink.addPane('pane-8', { principal: 'principal-8' });
    // locate() still believes in pane-1, but the write finds it gone
    sink.injectBehaviour = { unavailable: 'gone' };
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(adapter.resumed).toBe(1);
    expect(sink.typed).toHaveLength(0);
    const mid = (await store.getQuestion(qid))!;
    expect(mid.delivery_status).not.toBe('needs-attention');
    expect(mid.origin.pane_id).toBe('pane-8');
    expect(mid.origin.ownership_principal).toBe('principal-8');
    sink.injectBehaviour = 'ok';
    await bridge.notifyPaneIdle();
    expect(sink.typed).toHaveLength(1);
    expect(sink.typed[0]!.target.paneId).toBe('pane-8');
    expect((await store.getQuestion(qid))!.delivery_status).toBe('terminal-delivered');
  });

  it('unavailable: gone, no adapter => needs-attention pane_gone', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.injectBehaviour = { unavailable: 'gone' };
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect((await store.getQuestion(qid))!).toMatchObject({
      delivery_status: 'needs-attention',
      error_code: 'pane_gone',
    });
  });

  it('unavailable: host-offline => pending-host, delivered when it returns', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.injectBehaviour = { unavailable: 'host-offline' };
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect((await store.getQuestion(qid))!.delivery_status).toBe('pending-host');
    expect(failedCalls(relay)).toEqual([]);
    sink.injectBehaviour = 'ok';
    await bridge.notifyPaneIdle();
    expect(sink.typed).toHaveLength(1);
  });

  it('unavailable: rejected => needs-attention, no resume attempted', async () => {
    const adapter = spyAdapter(target({ paneId: 'pane-x' }));
    const { bridge, relay, phone, sink, qid, store } = await asked({ adapters: [adapter] });
    sink.injectBehaviour = { unavailable: 'rejected' };
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    expect(adapter.resumed).toBe(0);
    expect((await store.getQuestion(qid))!).toMatchObject({
      delivery_status: 'needs-attention',
      error_code: 'inject_rejected',
    });
  });

  it('ambiguous => delivery-uncertain atomically with the intent, never re-typed', async () => {
    const { bridge, relay, phone, sink, qid, store } = await asked();
    sink.injectBehaviour = 'ambiguous';
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    await bridge.catchUp();
    const r = await bridge.notifyPaneIdle();
    expect(r.delivered).toBe(0);
    const row = (await store.getQuestion(qid))!;
    expect(row.delivery_status).toBe('delivery-uncertain');
    expect((await store.getIntent(row.last_injection_id!))!.state).toBe('uncertain');
    expect(failedCalls(relay)).toEqual([expect.objectContaining({ status: 'delivery-uncertain' })]);
    expect(terminalAcks(relay)).toHaveLength(0);
    sink.injectBehaviour = 'ok';
    await bridge.pump();
    await bridge.notifyPaneIdle();
    expect(sink.typed).toHaveLength(1); // only the ambiguous attempt
  });

  it('drain() reports uncertain injections separately from needs-attention', async () => {
    const { bridge, relay, phone, sink, qid } = await asked();
    sink.injectBehaviour = 'ambiguous';
    await relay.answerEvent({ questionId: qid, phone, options: ['approve'] });
    for (const ev of relay.events) await bridge.inbox.persist(ev);
    await bridge.inbox.processPending();
    const r = await bridge.delivery.drain();
    expect(r).toMatchObject({ delivered: 0, uncertain: 1, needsAttention: 0 });
  });
});
