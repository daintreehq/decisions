import { describe, expect, it } from 'vitest';
import { fakeResumeAdapter, parseAnswers, type TerminalTarget } from '../src/index.js';
import { origin, setupBridge } from './helpers.js';

async function twoQuestions(
  extra: Parameters<typeof setupBridge>[0] = {},
  secondOrigin = origin(),
) {
  const env = await setupBridge(extra);
  const a = await env.bridge.registerQuestion({
    origin: origin(),
    input: { question: 'first?', options: [{ id: 'x', label: 'X' }] },
  });
  const b = await env.bridge.registerQuestion({
    origin: secondOrigin,
    input: { question: 'second?', options: [{ id: 'y', label: 'Y' }] },
  });
  await env.bridge.pump();
  return { ...env, a: a.questionId, b: b.questionId };
}

describe('B: batching only joins items with an identical complete destination', () => {
  it("never puts one session's answer into another session's injection (same pane and generation)", async () => {
    // q2 belongs to an older session in the same pane; resuming it lands in session B of the same pane+generation
    const sessionB: TerminalTarget = {
      hostId: 'host-local',
      paneId: 'pane-1',
      terminalGeneration: 1,
      ownershipPrincipal: 'principal-1',
      agentIncarnation: 'inc-1',
      agentSessionId: 'sess-B',
      worktreeId: 'wt-1',
    };
    const env = await twoQuestions(
      { adapters: [fakeResumeAdapter('claude', sessionB)] },
      origin({ agent_session_id: 'sess-OLD' }),
    );
    await env.relay.answerEvent({ questionId: env.a, phone: env.phone, options: ['x'] });
    await env.relay.answerEvent({ questionId: env.b, phone: env.phone, options: ['y'] });
    await env.bridge.catchUp();
    for (const t of env.sink.typed) {
      const ids = [env.a, env.b].filter((id) => t.text.includes(`question_id: ${id}`));
      expect(ids.length).toBeLessThanOrEqual(1); // one injection never mixes the two sessions
    }
    const first = env.sink.typed[0];
    expect(first?.text).toContain(`question_id: ${env.a}`);
    expect(first?.text).not.toContain(`question_id: ${env.b}`);
  });

  it('a different worktree is a different destination', async () => {
    const env = await twoQuestions();
    // the sink reports q2's pane as the same pane/generation/session but another worktree
    env.sink.locateOverride = (_n, o) =>
      o.worktree_id === 'wt-2'
        ? {
            state: 'alive',
            target: {
              hostId: o.host_id,
              paneId: o.pane_id,
              terminalGeneration: 1,
              ownershipPrincipal: 'principal-1',
              agentIncarnation: 'inc-1',
              agentSessionId: 'sess-1',
              worktreeId: 'wt-2',
            },
          }
        : undefined;
    await env.store.updateQuestion(env.b, { origin: { ...origin(), worktree_id: 'wt-2' } });
    await env.relay.answerEvent({ questionId: env.a, phone: env.phone, options: ['x'] });
    await env.relay.answerEvent({ questionId: env.b, phone: env.phone, options: ['y'] });
    await env.bridge.catchUp();
    for (const t of env.sink.typed) {
      expect(
        [env.a, env.b].filter((id) => t.text.includes(`question_id: ${id}`)).length,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('revalidates the destination immediately before typing', async () => {
    const env = await twoQuestions();
    await env.relay.answerEvent({ questionId: env.a, phone: env.phone, options: ['x'] });
    await env.bridge.inbox.persist(env.relay.events.at(-1)!);
    // The lane resolves the pane fine, then the terminal is relaunched before we type
    let calls = 0;
    env.sink.locateOverride = () => (++calls >= 2 ? { state: 'generation-mismatch' } : undefined);
    await env.bridge.catchUp();
    expect(env.sink.typed).toHaveLength(0);
  });
});

describe('B: uncertain injections are atomic and block delivery', () => {
  it('recovery settles the intent and the question together (no crash window)', async () => {
    const env = await twoQuestions();
    await env.relay.answerEvent({ questionId: env.a, phone: env.phone, options: ['x'] });
    await env.bridge.catchUp();
    const q = (await env.store.getQuestion(env.a))!;
    const intentId = q.last_injection_id!;
    env.sink.typed.length = 0; // marker lost
    await env.store.updateIntent(intentId, { state: 'intent' });
    // A crash can strike between two separate writes; the only allowed write path is the atomic settle.
    env.store.updateQuestion = async () => {
      throw new Error('crash between writes');
    };
    env.store.updateIntent = async () => {
      throw new Error('crash between writes');
    };
    await expect(env.bridge.delivery.recover()).resolves.toMatchObject({ uncertain: 1 });
    const row = (await env.store.getQuestion(env.a))!;
    expect(row.delivery_status).toBe('delivery-uncertain');
    expect((await env.store.getIntent(intentId))!.state).toBe('uncertain');
  });

  it('an uncertain intent blocks delivery even if the question flag was lost', async () => {
    const env = await twoQuestions();
    await env.relay.answerEvent({ questionId: env.a, phone: env.phone, options: ['x'] });
    await env.bridge.catchUp();
    const q = (await env.store.getQuestion(env.a))!;
    // simulate the post-crash state: intent says uncertain, but the question looks deliverable again
    await env.store.updateIntent(q.last_injection_id!, { state: 'uncertain' });
    const entries = parseAnswers(q.answers_json).map((e) => ({ ...e, delivered: false }));
    await env.store.updateQuestion(env.a, {
      answers_json: JSON.stringify(entries),
      delivery_status: 'desktop-received',
    });
    env.sink.typed.length = 0;
    await env.bridge.notifyPaneIdle();
    await env.bridge.pump();
    expect(env.sink.typed).toHaveLength(0);
  });

  it('the inject() exception path also settles atomically', async () => {
    const env = await twoQuestions();
    env.sink.injectBehaviour = 'throw';
    await env.relay.answerEvent({ questionId: env.a, phone: env.phone, options: ['x'] });
    await env.bridge.catchUp();
    const row = (await env.store.getQuestion(env.a))!;
    expect(row.delivery_status).toBe('delivery-uncertain');
    expect(await env.store.hasUncertainIntent(env.a)).toBe(true);
  });
});
