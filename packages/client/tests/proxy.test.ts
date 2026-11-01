import { describe, expect, it } from 'vitest';
import { PolicyRegistry, type ProxyEngine, type ProxyOutcome } from '../src/index.js';
import { origin, setupBridge } from './helpers.js';

const answer = (over: Partial<Extract<ProxyOutcome, { action: 'answer' }>> = {}): ProxyOutcome => ({
  action: 'answer',
  selected_option_ids: ['yes'],
  confidence: 0.95,
  model_id: 'dm-1',
  prompt_template_version: 'v1',
  retrieval_reference_ids: ['d1'],
  risk_flags: [],
  ...over,
});

function engine(outcome: ProxyOutcome | (() => never)) {
  const calls: unknown[] = [];
  const e: ProxyEngine = {
    async suggest(input) {
      calls.push(input);
      if (typeof outcome === 'function') return outcome();
      return outcome;
    },
  };
  return { e, calls };
}

const input = {
  question: 'Rename the tab?',
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
};

async function withProxy(
  o: ProxyOutcome | (() => never),
  requested: 'proxy-first' | 'proxy-ok' = 'proxy-first',
) {
  const { e, calls } = engine(o);
  const env = await setupBridge({
    proxy: e,
    policy: new PolicyRegistry({ proxyAllowlisted: true }),
  });
  const r = await env.bridge.registerQuestion({
    origin: origin(),
    input: { ...input, requested_requirement: requested },
  });
  await env.bridge.pump();
  await env.bridge.pump();
  const posts = (suffix: string) =>
    env.relay.calls.filter(
      (c) => c.method === 'POST' && c.path.endsWith(`/${suffix}`) && c.path.includes(r.questionId),
    );
  return { ...env, r, calls, posts };
}

describe('proxy engine hook', () => {
  it('never consults the model for a human-required question and hard-fails if forced', async () => {
    const { e, calls } = engine(answer());
    const env = await setupBridge({ proxy: e });
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { ...input, requested_requirement: 'proxy-ok' },
    });
    await env.bridge.pump();
    expect(r.requirement).toBe('human-required');
    expect(calls).toHaveLength(0);
    await expect(env.bridge.runProxy(r.questionId)).rejects.toMatchObject({
      code: 'proxy_forbidden',
    });
    expect(calls).toHaveLength(0);
    expect(env.relay.calls.some((c) => c.path.endsWith('/proxy-answer'))).toBe(false);
  });

  it('a confident proxy-first answer is posted as a signed proxy-answer (encrypted)', async () => {
    const { posts, calls, relay } = await withProxy(answer());
    expect(calls).toHaveLength(1);
    const sent = posts('proxy-answer');
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body as {
      action: {
        record: { action: string; expected_revision: number };
        envelope: { aad: { record_type: string } };
      };
    };
    expect(body.action.record.action).toBe('proxy-answer');
    expect(body.action.record.expected_revision).toBe(0);
    expect(body.action.envelope.aad.record_type).toBe('answer');
    expect(JSON.stringify(sent[0]!.body)).not.toContain('dm-1'); // model id is inside the ciphertext
    expect(relay.calls.filter((c) => c.path.endsWith('/proxy-abstain'))).toHaveLength(0);
  });

  it('abstain, model errors, bad option ids and risk flags all escalate via proxy-abstain', async () => {
    for (const o of [
      { action: 'abstain', reason: 'not enough history' } as ProxyOutcome,
      (() => {
        throw new Error('model down');
      }) as () => never,
      answer({ selected_option_ids: ['maybe'] }),
      answer({ risk_flags: ['novel-case'] }),
      answer({ confidence: 1.5 }),
    ]) {
      const { posts } = await withProxy(o);
      expect(posts('proxy-abstain')).toHaveLength(1);
      expect(posts('proxy-answer')).toHaveLength(0);
    }
  });

  it('runs at most once per question', async () => {
    const { e, calls } = engine(answer());
    const env = await setupBridge({
      proxy: e,
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
    });
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: { ...input, requested_requirement: 'proxy-ok' },
    });
    await env.bridge.pump();
    expect(await env.bridge.runProxy(r.questionId)).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('proxy-ok abstain also escalates', async () => {
    const { posts } = await withProxy({ action: 'abstain', reason: 'x' }, 'proxy-ok');
    expect(posts('proxy-abstain')).toHaveLength(1);
  });
});
