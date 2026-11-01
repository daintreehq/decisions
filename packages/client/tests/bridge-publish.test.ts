import { describe, expect, it } from 'vitest';
import { BridgeError, PolicyRegistry } from '../src/index.js';
import { origin, setupBridge } from './helpers.js';

describe('requirement enforcement', () => {
  it('defaults to human-required and the agent cannot downgrade it', async () => {
    const { bridge, store } = await setupBridge();
    const r = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Q?', requested_requirement: 'proxy-ok' },
    });
    expect(r.requirement).toBe('human-required');
    expect((await store.getQuestion(r.questionId))!.requirement).toBe('human-required');
  });
  it('a trusted gate sets the floor; callers may only strengthen', async () => {
    const policy = new PolicyRegistry();
    policy.register({
      gateId: 'design-review',
      minRequirement: 'human-required',
      policyVersion: 3,
    });
    policy.register({ gateId: 'naming', minRequirement: 'proxy-first', policyVersion: 1 });
    const { bridge } = await setupBridge({ policy });
    const a = await bridge.registerQuestion({
      origin: origin(),
      input: {
        question: 'a',
        workflow_gate_id: 'design-review',
        requested_requirement: 'proxy-first',
      },
    });
    const b = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'b', workflow_gate_id: 'naming', requested_requirement: 'proxy-ok' },
    });
    const c = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'c', workflow_gate_id: 'naming', requested_requirement: 'human-required' },
    });
    expect([a.requirement, b.requirement, c.requirement]).toEqual([
      'human-required',
      'proxy-first',
      'human-required',
    ]);
  });
  it('an unknown gate id grants nothing; allowlist enables proxy levels', async () => {
    const closed = await setupBridge();
    expect(
      (
        await closed.bridge.registerQuestion({
          origin: origin(),
          input: { question: 'a', workflow_gate_id: 'made-up', requested_requirement: 'proxy-ok' },
        })
      ).requirement,
    ).toBe('human-required');
    const open = await setupBridge({ policy: new PolicyRegistry({ proxyAllowlisted: true }) });
    expect(
      (
        await open.bridge.registerQuestion({
          origin: origin(),
          input: { question: 'a', requested_requirement: 'proxy-ok' },
        })
      ).requirement,
    ).toBe('proxy-ok');
  });
  it('protected gates restrict option ids', async () => {
    const policy = new PolicyRegistry();
    policy.register({
      gateId: 'g',
      minRequirement: 'human-required',
      policyVersion: 1,
      allowedOptionIds: ['approve', 'reject'],
    });
    const { bridge } = await setupBridge({ policy });
    await expect(
      bridge.registerQuestion({
        origin: origin(),
        input: { question: 'q', workflow_gate_id: 'g', options: [{ id: 'yolo', label: 'Yolo' }] },
      }),
    ).rejects.toThrow(/not permitted/);
  });
});

describe('validation', () => {
  it('rejects bad input and duplicate option ids', async () => {
    const { bridge } = await setupBridge();
    await expect(
      bridge.registerQuestion({ origin: origin(), input: { question: '' } }),
    ).rejects.toBeInstanceOf(BridgeError);
    await expect(
      bridge.registerQuestion({ origin: origin(), input: { question: 'x'.repeat(8001) } }),
    ).rejects.toThrow();
    await expect(
      bridge.registerQuestion({
        origin: origin(),
        input: { question: 'q', context: 'é'.repeat(20000) },
      }),
    ).rejects.toThrow(/32 KiB/);
    await expect(
      bridge.registerQuestion({
        origin: origin(),
        input: {
          question: 'q',
          options: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'B' },
          ],
        },
      }),
    ).rejects.toThrow(/duplicate/);
  });
  it('limits open questions per pane', async () => {
    const { bridge } = await setupBridge();
    for (let i = 0; i < 10; i++)
      await bridge.registerQuestion({ origin: origin(), input: { question: `q${i}` } });
    await expect(
      bridge.registerQuestion({ origin: origin(), input: { question: 'one too many' } }),
    ).rejects.toMatchObject({ code: 'too_many_open_questions' });
  });
  it('correlation_id makes repeat calls return the same question', async () => {
    const { bridge, store } = await setupBridge();
    const a = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q', correlation_id: 'wf-1' },
    });
    const b = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q', correlation_id: 'wf-1' },
    });
    expect(b.duplicate).toBe(true);
    expect(b.questionId).toBe(a.questionId);
    expect((await store.listQuestions()).length).toBe(1);
    // a different pane may reuse the same correlation id
    const c = await bridge.registerQuestion({
      origin: origin({ pane_id: 'pane-2' }),
      input: { question: 'q', correlation_id: 'wf-1' },
    });
    expect(c.questionId).not.toBe(a.questionId);
  });
  it('clamps agent-requested expiry to the gate', async () => {
    const policy = new PolicyRegistry();
    policy.register({
      gateId: 'g',
      minRequirement: 'human-required',
      policyVersion: 1,
      expiryMs: 3_600_000,
    });
    const { bridge, store } = await setupBridge({ policy });
    const far = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const r = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q', workflow_gate_id: 'g', expires_at: far },
    });
    const exp = Date.parse((await store.getQuestion(r.questionId))!.expires_at!);
    expect(exp - Date.now()).toBeLessThanOrEqual(3_600_000 + 1000);
  });
});

describe('local commit before network, exactly-once publish', () => {
  it('returns immediately and commits locally with no relay contact', async () => {
    const { bridge, relay, store } = await setupBridge();
    relay.down = 1000;
    const r = await bridge.registerQuestion({ origin: origin(), input: { question: 'Offline?' } });
    expect(r.status).toBe('queued');
    const row = await store.getQuestion(r.questionId);
    expect(row!.local_status).toBe('queued');
    expect(await store.outboxFor(r.questionId)).toHaveLength(1);
    expect(relay.questions.size).toBe(0);
  });
  it('publishes later exactly once with a stable idempotency key', async () => {
    const { bridge, relay, store } = await setupBridge();
    relay.down = 1000;
    const r = await bridge.registerQuestion({ origin: origin(), input: { question: 'Offline?' } });
    await bridge.pump();
    expect((await store.getQuestion(r.questionId))!.local_status).toBe('queued');
    relay.down = 0;
    // make the backoff window pass
    for (const o of await store.dueOutbox(Number.MAX_SAFE_INTEGER, 10))
      await store.putOutbox({ ...o, next_attempt_at: 0 });
    await bridge.pump();
    await bridge.pump();
    expect(relay.questions.size).toBe(1);
    expect((await store.getQuestion(r.questionId))!.local_status).toBe('open');
    expect(await store.outboxFor(r.questionId)).toHaveLength(0);
    const creates = relay.calls.filter(
      (c) => c.path === '/api/v1/questions' && c.method === 'POST',
    );
    expect(creates).toHaveLength(1);
  });
  it('retries on 5xx but drops permanently rejected questions with an error code', async () => {
    const { bridge, relay, store } = await setupBridge();
    relay.status5xx = 1;
    const r = await bridge.registerQuestion({ origin: origin(), input: { question: 'q' } });
    await bridge.pump();
    expect((await store.getQuestion(r.questionId))!.local_status).toBe('queued');
    const { bridge: b2, relay: r2, store: s2 } = await setupBridge();
    r2.rejectCreate = 400;
    const bad = await b2.registerQuestion({ origin: origin(), input: { question: 'q' } });
    await b2.pump();
    const row = await s2.getQuestion(bad.questionId);
    expect(row!.local_status).toBe('publish-failed');
    expect(row!.error_code).toBe('validation_error');
    expect(await s2.outboxFor(bad.questionId)).toHaveLength(0);
  });
  it('question content is encrypted: the relay never sees the text', async () => {
    const { bridge, relay } = await setupBridge();
    await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'TOP-SECRET-MARKER', context: 'ctx-secret' },
    });
    await bridge.pump();
    const wire = JSON.stringify([...relay.questions.values()].map((q) => q.signed));
    expect(wire).not.toContain('TOP-SECRET-MARKER');
    expect(wire).not.toContain('ctx-secret');
    expect(wire).not.toContain('pane-1');
    expect(wire).not.toContain('/work/proj-1');
    const [id] = [...relay.questions.keys()];
    expect((await relay.decryptQuestion(id!)).question).toBe('TOP-SECRET-MARKER');
  });
});

describe('attachments', () => {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  it('encrypts, reserves, uploads with X-Content-Sha256 and then publishes', async () => {
    const { bridge, relay } = await setupBridge({
      resolver: { resolve: async (_o, id) => (id === 'shot-1' ? { bytes: png } : null) },
    });
    await bridge.registerQuestion({
      origin: origin(),
      input: {
        question: 'Approve?',
        attachments: [{ local_resource_id: 'shot-1', role: 'after' }],
      },
    });
    await bridge.pump();
    const order = relay.calls.map(
      (c) => `${c.method} ${c.path.replace(/\/[0-9a-f]{32}/g, '/:id')}`,
    );
    expect(order.indexOf('POST /api/v1/attachments/reservations')).toBeLessThan(
      order.indexOf('PUT /api/v1/attachments/:id/content'),
    );
    expect(order.indexOf('POST /api/v1/attachments/:id/complete')).toBeLessThan(
      order.indexOf('POST /api/v1/questions'),
    );
    expect(relay.uploads[0]!.sha).toMatch(/^[0-9a-f]{64}$/);
    const res = relay.calls.find((c) => c.path === '/api/v1/attachments/reservations')!
      .body as Record<string, unknown>;
    expect(res.attachment_id).toMatch(/^[0-9a-f]{32}$/);
    const content = await relay.decryptQuestion([...relay.questions.keys()][0]!);
    expect(content.attachments).toHaveLength(1);
  });
  it('rejects unknown ids, non-images and a missing resolver', async () => {
    const a = await setupBridge({ resolver: { resolve: async () => null } });
    await expect(
      a.bridge.registerQuestion({
        origin: origin(),
        input: { question: 'q', attachments: [{ local_resource_id: 'nope' }] },
      }),
    ).rejects.toThrow(/unknown attachment/);
    const b = await setupBridge({
      resolver: {
        resolve: async () => ({ bytes: new TextEncoder().encode('<svg onload=alert(1)>') }),
      },
    });
    await expect(
      b.bridge.registerQuestion({
        origin: origin(),
        input: { question: 'q', attachments: [{ local_resource_id: 'x' }] },
      }),
    ).rejects.toThrow(/PNG, JPEG/);
    const c = await setupBridge();
    await expect(
      c.bridge.registerQuestion({
        origin: origin(),
        input: { question: 'q', attachments: [{ local_resource_id: 'x' }] },
      }),
    ).rejects.toThrow(/not configured/);
  });
});
