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
    expect(body.action.envelope.aad.record_type).toBe('proxy-answer');
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

describe('proxy hook receives everything the model guards need', () => {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5, 4, 3, 2,
  ]);
  const gatedPolicy = () => {
    const p = new PolicyRegistry();
    p.register({ gateId: 'naming', minRequirement: 'proxy-first', policyVersion: 1 });
    return p;
  };
  const gatedInput = {
    question: 'Rename the tab?',
    kind: 'approval' as const,
    options: [{ id: 'yes', label: 'Yes' }],
    attachments: [{ local_resource_id: 'shot', role: 'after' as const }],
  };
  const resolver = { resolve: async () => ({ bytes: png }) };

  it('passes kind, trusted gate, enforced requirement, project and attachment role+sha256', async () => {
    const seen: unknown[] = [];
    const proxy: ProxyEngine = {
      gateAware: true,
      async suggest(input) {
        seen.push(input);
        return { action: 'abstain', reason: 'test' };
      },
    };
    const env = await setupBridge({ proxy, policy: gatedPolicy(), resolver });
    await env.bridge.registerQuestion({
      origin: origin({ workflow_gate_id: 'naming' }),
      input: gatedInput,
    });
    await env.bridge.pump();
    await env.bridge.pump();
    expect(seen).toHaveLength(1);
    const { sha256Hex } = await import('@daintreehq/decisions-crypto');
    expect(seen[0]).toMatchObject({
      kind: 'approval',
      workflowGateId: 'naming',
      requirement: 'proxy-first',
      projectId: 'proj-1',
      attachments: [{ role: 'after', sha256: await sha256Hex(png) }],
    });
  });

  it("the gate is the origin's trusted one: an agent-named gate is never forwarded", async () => {
    const seen: { workflowGateId?: string }[] = [];
    const policy = gatedPolicy();
    policy.register({ gateId: 'agent-picked', minRequirement: 'proxy-ok', policyVersion: 1 });
    const proxy: ProxyEngine = {
      gateAware: true,
      async suggest(input) {
        seen.push(input);
        return { action: 'abstain', reason: 'test' };
      },
    };
    const env = await setupBridge({ proxy, policy, resolver });
    await env.bridge.registerQuestion({
      origin: origin({ workflow_gate_id: 'naming' }),
      input: { ...gatedInput, workflow_gate_id: 'agent-picked' },
    });
    await env.bridge.pump();
    await env.bridge.pump();
    expect(seen[0]?.workflowGateId).toBe('naming');
  });

  it('a gated question is never offered to an engine that cannot see the gate (fail closed)', async () => {
    const { e, calls } = engine(answer());
    expect(e.gateAware).toBeUndefined();
    const env = await setupBridge({ proxy: e, policy: gatedPolicy(), resolver });
    const r = await env.bridge.registerQuestion({
      origin: origin({ workflow_gate_id: 'naming' }),
      input: gatedInput,
    });
    await env.bridge.pump();
    await env.bridge.pump();
    expect(calls).toHaveLength(0);
    const posts = env.relay.calls.filter(
      (c) => c.method === 'POST' && c.path.includes(r.questionId),
    );
    expect(posts.some((c) => c.path.endsWith('/proxy-abstain'))).toBe(true);
    expect(posts.some((c) => c.path.endsWith('/proxy-answer'))).toBe(false);
    expect(
      (await env.store.listAudit(50)).some(
        (a) => a.event === 'proxy.abstain' && a.result === 'engine-cannot-see-workflow-gate',
      ),
    ).toBe(true);
  });

  it('an ungated question may still use an engine that does not declare gate support', async () => {
    const { e, calls } = engine(answer());
    const env = await setupBridge({
      proxy: e,
      policy: new PolicyRegistry({ proxyAllowlisted: true }),
    });
    await env.bridge.registerQuestion({
      origin: origin(),
      input: {
        question: 'q',
        options: [{ id: 'yes', label: 'Y' }],
        requested_requirement: 'proxy-ok',
      },
    });
    await env.bridge.pump();
    await env.bridge.pump();
    expect(calls).toHaveLength(1);
    expect((calls[0] as { workflowGateId?: string }).workflowGateId).toBeUndefined();
  });
});
