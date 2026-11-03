import { describe, expect, it } from 'vitest';
import { ActionBody, EventData } from '@daintreehq/decisions-protocol';
import { decryptAttachment } from '@daintreehq/decisions-crypto';
// The phone app's own answer-building and verification code, driven against the real bridge.
import { QuestionStore } from '../../../app/src/domain/model.js';
import { TrustStore } from '../../../app/src/domain/trust.js';
import { buildAnswerRequest, highestEpoch } from '../../../app/src/domain/answer.js';
import { MemorySpool, PolicyRegistry, type WorkflowGate } from '../src/index.js';
import { origin, setupBridge } from './helpers.js';

const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);
/** A different image: same header, different bytes, so a different SHA-256. */
const variant = (n: number) => Uint8Array.from([...PNG, n]);

const DESIGN_REVIEW: WorkflowGate = {
  gateId: 'design-review/final',
  minRequirement: 'human-required',
  policyVersion: 1,
  choices: [
    { id: 'approve', label: 'Approve' },
    { id: 'reject', label: 'Reject' },
  ],
  allowText: false,
  bindArtifacts: true,
};

/** Keeps ciphertext after upload so the test phone can download it, as it would from R2. */
class KeepSpool extends MemorySpool {
  override async delete() {}
}

async function designReview(
  images: Record<string, Uint8Array> = { before: PNG, after: variant(1) },
) {
  const policy = new PolicyRegistry();
  policy.register(DESIGN_REVIEW);
  const spool = new KeepSpool();
  let current = images;
  const env = await setupBridge({
    policy,
    spool,
    resolver: { resolve: async (_o, id) => (current[id] ? { bytes: current[id] } : null) },
  });
  const ask = async (correlation_id?: string) => {
    const r = await env.bridge.registerQuestion({
      origin: origin(),
      input: {
        question: 'Approve the final design?',
        workflow_gate_id: 'design-review/final',
        attachments: Object.keys(current).map((id) => ({
          local_resource_id: id,
          role: id === 'before' ? 'before' : 'after',
        })),
        ...(correlation_id ? { correlation_id } : {}),
      },
    });
    await env.bridge.pump();
    return r;
  };
  const setImages = (next: Record<string, Uint8Array>) => {
    current = next;
  };
  return { ...env, spool, ask, setImages };
}

type Env = Awaited<ReturnType<typeof designReview>>;

/**
 * The phone: ingest the relay's ledger with the app's verifying QuestionStore, download and decrypt every
 * attachment the way the app's controller does (the gallery reports the digest of each image that decrypted
 * and verified), then build the signed answer with the app's own `buildAnswerRequest` and let the relay emit it.
 */
async function phoneAnswers(
  env: Env,
  questionId: string,
  answer: { selected: string[]; text?: string; reviewOnly?: number },
) {
  const { identity, relay, phone, spool } = env;
  const installationId = identity.config.installationId;
  const trust = await TrustStore.create(installationId, relay.ownerCert());
  await trust.addCert(phone.cert, null);
  const store = new QuestionStore({ installationId, trust, epochKeys: () => identity.epochs });
  await store.ingestAll(relay.events);
  const view = store.get(questionId)!;
  expect(view.verification).toEqual({ ok: true });

  const reviewed: string[] = [];
  const items = view.content!.attachments.slice(0, answer.reviewOnly ?? Infinity);
  for (const d of items) {
    const cipher = await spool.get(d.attachment_id);
    await decryptAttachment(
      identity.epochs.get(d.key_epoch)!,
      { installationId, questionId, attachmentId: d.attachment_id, keyEpoch: d.key_epoch },
      d.nonce,
      cipher!,
      d.sha256,
    );
    reviewed.push(d.sha256);
  }

  const req = await buildAnswerRequest({
    installationId,
    deviceId: phone.deviceId,
    signingKey: phone.keys.signing.privateKey,
    epochKey: highestEpoch(identity.epochs),
    view,
    kind: 'answer',
    expectedRevision: view.revision,
    selected: answer.selected,
    text: answer.text,
    reviewedDigests: reviewed,
    explicitApproval: view.content!.kind === 'approval' ? true : undefined,
  });
  const body = ActionBody.parse(JSON.parse(req.bodyText));
  relay.push('decision.answer.committed', questionId, view.revision + 1, {
    ...EventData.action.parse({
      action: body.action.record.action,
      record: body.action.record,
      envelope: body.action.envelope,
      provenance: 'human',
      status: 'human-answered',
      revision: view.revision + 1,
      target_host_id: relay.questions.get(questionId)!.signed.record.target_host_id,
      deliverable: true,
    }),
  });
  await env.bridge.catchUp();
  return { view, reviewed };
}

describe('gate declaration', () => {
  it('rejects malformed gates at registration', () => {
    const p = new PolicyRegistry();
    const base = { gateId: 'g', minRequirement: 'human-required' as const, policyVersion: 1 };
    expect(() => p.register({ ...base, choices: [] })).toThrow(/at least one/);
    expect(() =>
      p.register({
        ...base,
        choices: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'B' },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() => p.register({ ...base, choices: [{ id: 'a', label: '' }] })).toThrow();
    expect(() => p.register({ ...base, choices: [{ id: 'x'.repeat(65), label: 'A' }] })).toThrow();
    p.register(DESIGN_REVIEW);
    expect(p.get('design-review/final')?.choices).toHaveLength(2);
  });
});

describe('a gate with choices shapes the question the phone sees', () => {
  it('publishes exactly the gate choices, no free text, as an approval bound to the images', async () => {
    const env = await designReview();
    const r = await env.ask();
    expect(r.requirement).toBe('human-required');
    const content = await env.relay.decryptQuestion(r.questionId);
    expect(content).toMatchObject({
      kind: 'approval',
      allow_text: false,
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    });
    expect(content.attachments).toHaveLength(2);
    const row = (await env.store.getQuestion(r.questionId))!;
    expect(row.origin.workflow_gate_id).toBe('design-review/final');
  });

  it('accepts agent options only when they are exactly the gate choices', async () => {
    const env = await designReview();
    const attachments = [{ local_resource_id: 'before' }];
    const ask = (options: { id: string; label: string }[]) =>
      env.bridge.registerQuestion({
        origin: origin(),
        input: { question: 'q', workflow_gate_id: 'design-review/final', attachments, options },
      });
    await expect(
      ask([
        { id: 'approve', label: 'Approve' },
        { id: 'yolo', label: 'Ship anyway' },
      ]),
    ).rejects.toThrow(/not permitted|exactly/);
    await expect(
      ask([
        { id: 'approve', label: 'Approve and merge to main' },
        { id: 'reject', label: 'Reject' },
      ]),
    ).rejects.toThrow(/label/);
    await expect(ask([{ id: 'approve', label: 'Approve' }])).rejects.toThrow(/exactly/);
    const ok = await ask([
      { id: 'reject', label: 'Reject' },
      { id: 'approve', label: 'Approve' },
    ]);
    await env.bridge.pump();
    expect((await env.relay.decryptQuestion(ok.questionId)).options.map((o) => o.id)).toEqual([
      'approve',
      'reject',
    ]);
  });

  it('a gate bound to artifacts refuses a question without attachments', async () => {
    const env = await designReview();
    await expect(
      env.bridge.registerQuestion({
        origin: origin(),
        input: { question: 'q', workflow_gate_id: 'design-review/final' },
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('a gate that refuses free text needs options to be answerable', async () => {
    const policy = new PolicyRegistry();
    policy.register({
      gateId: 'pick',
      minRequirement: 'human-required',
      policyVersion: 1,
      allowText: false,
    });
    const { bridge, relay } = await setupBridge({ policy });
    await expect(
      bridge.registerQuestion({
        origin: origin({ workflow_gate_id: 'pick' }),
        input: { question: 'q' },
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    const r = await bridge.registerQuestion({
      origin: origin({ workflow_gate_id: 'pick' }),
      input: { question: 'q', kind: 'mixed', options: [{ id: 'a', label: 'A' }] },
    });
    await bridge.pump();
    expect(await relay.decryptQuestion(r.questionId)).toMatchObject({
      kind: 'choice',
      allow_text: false,
    });
  });

  it('an approval without options offers Approve and Reject, and still takes a note', async () => {
    const { bridge, relay } = await setupBridge();
    const r = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'Deploy the migration now?', kind: 'approval' },
    });
    await bridge.pump();
    expect(await relay.decryptQuestion(r.questionId)).toMatchObject({
      kind: 'approval',
      allow_text: true,
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    });
  });

  it('the default Approve and Reject are held to the gates like any other options', async () => {
    const policy = new PolicyRegistry();
    const gate = { minRequirement: 'human-required', policyVersion: 1, allowText: false } as const;
    policy.register({ ...gate, gateId: 'choice-only' });
    policy.register({ ...gate, gateId: 'approve-only', allowedOptionIds: ['approve'] });
    const { bridge, relay } = await setupBridge({ policy });
    const approval = (workflow_gate_id: string) =>
      bridge.registerQuestion({
        origin: origin({ workflow_gate_id }),
        input: { question: 'Deploy the migration now?', kind: 'approval' },
      });
    // A choice-only gate takes the defaults as the choice it needs.
    const r = await approval('choice-only');
    await bridge.pump();
    expect(await relay.decryptQuestion(r.questionId)).toMatchObject({
      kind: 'approval',
      allow_text: false,
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    });
    // A gate that never permits "reject" refuses the defaults rather than publishing it.
    await expect(approval('approve-only')).rejects.toThrow(/"reject" is not permitted/);
  });

  it('without a gate, questions still accept free text', async () => {
    const { bridge, relay } = await setupBridge();
    const r = await bridge.registerQuestion({ origin: origin(), input: { question: 'q' } });
    await bridge.pump();
    expect(await relay.decryptQuestion(r.questionId)).toMatchObject({ allow_text: true });
  });
});

describe('design review end to end through the phone app', () => {
  it('approval of exactly the attached images: human, approve, digests match', async () => {
    const env = await designReview();
    const r = await env.ask();
    const before = await env.bridge.getDecision(r.questionId);
    expect(before).toMatchObject({
      status: 'open',
      provenance: null,
      choice: null,
      text: '',
      reviewedDigestsMatch: false,
      workflowGateId: 'design-review/final',
    });

    const { reviewed } = await phoneAnswers(env, r.questionId, { selected: ['approve'] });
    expect(reviewed).toHaveLength(2);
    const v = await env.bridge.getDecision(r.questionId);
    expect(v).toMatchObject({
      status: 'human-answered',
      provenance: 'human',
      choice: 'approve',
      text: '',
      reviewedDigestsMatch: true,
    });
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain('choice: approve');
  });

  it('an approval that did not review every image does not match', async () => {
    const env = await designReview();
    const r = await env.ask();
    await phoneAnswers(env, r.questionId, { selected: ['approve'], reviewOnly: 1 });
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'human-answered',
      choice: 'approve',
      reviewedDigestsMatch: false,
    });
  });

  it('a rejection is reported as the reject choice', async () => {
    const env = await designReview();
    const r = await env.ask();
    await phoneAnswers(env, r.questionId, { selected: ['reject'] });
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'human-answered',
      provenance: 'human',
      choice: 'reject',
    });
  });

  it('answers outside the gate choices, or with free text, are refused', async () => {
    for (const bad of [
      { selected: ['yolo'] },
      { selected: ['approve', 'reject'] },
      { selected: ['approve'], text: 'also merge it' },
      { selected: [] as string[], text: 'sure' },
    ]) {
      const env = await designReview();
      const r = await env.ask();
      await phoneAnswers(env, r.questionId, bad);
      const v = await env.bridge.getDecision(r.questionId);
      expect(v.status).toBe('open');
      expect(v.choice).toBeNull();
      expect(v.deliveryStatus).toBe('needs-attention');
      expect(env.sink.typed).toHaveLength(0);
    }
  });

  it('changed images mean a new question: an earlier approval never carries over', async () => {
    const env = await designReview();
    const first = await env.ask('design-review-run-1');
    await phoneAnswers(env, first.questionId, { selected: ['approve'] });
    expect((await env.bridge.getDecision(first.questionId)).choice).toBe('approve');

    // Same images, same correlation id: the same question (and its approval) comes back.
    const same = await env.ask('design-review-run-1');
    expect(same).toMatchObject({ duplicate: true, questionId: first.questionId });

    // The agent changed the design after approval and re-asks with the same correlation id.
    env.setImages({ before: PNG, after: variant(2) });
    const second = await env.ask('design-review-run-1');
    expect(second.duplicate).toBe(false);
    expect(second.questionId).not.toBe(first.questionId);
    expect(await env.bridge.getDecision(second.questionId)).toMatchObject({
      status: 'open',
      choice: null,
      reviewedDigestsMatch: false,
    });
    await phoneAnswers(env, second.questionId, { selected: ['approve'] });
    expect(await env.bridge.getDecision(second.questionId)).toMatchObject({
      choice: 'approve',
      reviewedDigestsMatch: true,
    });
  });
});

describe('what never counts as approval', () => {
  it('a proxy answer never satisfies a human-required gate', async () => {
    const env = await designReview();
    const r = await env.ask();
    await env.relay.answerEvent({
      questionId: r.questionId,
      phone: { deviceId: env.identity.config.deviceId, keys: env.identity.keys },
      action: 'proxy-answer',
      options: ['approve'],
    });
    await env.bridge.catchUp();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'open',
      provenance: null,
      choice: null,
      reviewedDigestsMatch: false,
    });
    expect(env.sink.typed).toHaveLength(0);
  });

  it('an expired question never reports approval', async () => {
    const env = await designReview();
    const r = await env.ask();
    env.relay.push('decision.expired', r.questionId, 0, { reason: 'expired' });
    await env.bridge.catchUp();
    expect(await env.bridge.getDecision(r.questionId)).toMatchObject({
      status: 'expired',
      provenance: null,
      choice: null,
      reviewedDigestsMatch: false,
    });
  });

  it('a proxy answer outside a proxy gate’s rules is refused', async () => {
    const policy = new PolicyRegistry();
    policy.register({
      gateId: 'naming',
      minRequirement: 'proxy-ok',
      policyVersion: 1,
      choices: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      allowText: false,
    });
    const env = await setupBridge({ policy });
    const r = await env.bridge.registerQuestion({
      origin: origin({ workflow_gate_id: 'naming' }),
      input: { question: 'Name?' },
    });
    await env.bridge.pump();
    await env.relay.answerEvent({
      questionId: r.questionId,
      phone: { deviceId: env.identity.config.deviceId, keys: env.identity.keys },
      action: 'proxy-answer',
      options: ['a'],
      text: 'free text is not allowed here',
    });
    await env.bridge.catchUp();
    expect((await env.bridge.getDecision(r.questionId)).status).toBe('open');
  });
});

describe('gates only ever add constraints', () => {
  it('re-asking under a different gate with the same correlation id is a new question', async () => {
    const env = await designReview();
    const loose = await env.bridge.registerQuestion({
      origin: origin(),
      input: {
        question: 'Looks fine?',
        attachments: [{ local_resource_id: 'before' }, { local_resource_id: 'after' }],
        correlation_id: 'wf-7',
      },
    });
    const gated = await env.ask('wf-7');
    expect(gated.duplicate).toBe(false);
    expect(gated.questionId).not.toBe(loose.questionId);
    expect((await env.bridge.getDecision(gated.questionId)).workflowGateId).toBe(
      'design-review/final',
    );
  });

  it('a gate the agent names cannot lengthen the default expiry', async () => {
    const policy = new PolicyRegistry();
    policy.register({
      gateId: 'no-expiry-set',
      minRequirement: 'human-required',
      policyVersion: 1,
    });
    const { bridge, store } = await setupBridge({ policy });
    const far = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const r = await bridge.registerQuestion({
      origin: origin(),
      input: { question: 'q', workflow_gate_id: 'no-expiry-set', expires_at: far },
    });
    const exp = Date.parse((await store.getQuestion(r.questionId))!.expires_at!);
    expect(exp - Date.now()).toBeLessThanOrEqual(30 * 86_400_000 + 1000);
  });

  it("one gate's choices must respect another gate's protected option ids", async () => {
    const policy = new PolicyRegistry();
    policy.register({
      gateId: 'only-a',
      minRequirement: 'human-required',
      policyVersion: 1,
      allowedOptionIds: ['a'],
    });
    policy.register({
      gateId: 'a-or-b',
      minRequirement: 'human-required',
      policyVersion: 1,
      choices: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    });
    const { bridge } = await setupBridge({ policy });
    await expect(
      bridge.registerQuestion({
        origin: origin({ workflow_gate_id: 'only-a' }),
        input: { question: 'q', workflow_gate_id: 'a-or-b' },
      }),
    ).rejects.toThrow(/not permitted/);
  });
});

describe('proxy answers and confirmations under a bound gate', () => {
  async function proxyAnswered() {
    const policy = new PolicyRegistry();
    policy.register({ ...DESIGN_REVIEW, gateId: 'preview', minRequirement: 'proxy-ok' });
    const env = await setupBridge({
      policy,
      resolver: { resolve: async () => ({ bytes: PNG }) },
    });
    const r = await env.bridge.registerQuestion({
      origin: origin({ workflow_gate_id: 'preview' }),
      input: { question: 'Preview ok?', attachments: [{ local_resource_id: 'shot' }] },
    });
    await env.bridge.pump();
    const digests = (await env.store.getQuestion(r.questionId))!.attachment_digests;
    const desktop = { deviceId: env.identity.config.deviceId, keys: env.identity.keys };
    const proxyEv = await env.relay.answerEvent({
      questionId: r.questionId,
      phone: desktop,
      action: 'proxy-answer',
      options: ['approve'],
      // Even if a proxy answer listed the digests, it reviewed nothing.
      extra: { reviewed_attachment_digests: digests },
    });
    await env.bridge.catchUp();
    const proxyActionId = (proxyEv.data as { record: { action_id: string } }).record.action_id;
    return { ...env, qid: r.questionId, proxyActionId };
  }

  it('a proxy answer is reported as proxy and never as reviewing the images', async () => {
    const env = await proxyAnswered();
    expect(await env.bridge.getDecision(env.qid)).toMatchObject({
      status: 'proxy-answered',
      provenance: 'proxy',
      choice: 'approve',
      reviewedDigestsMatch: false,
    });
  });

  it('a confirmation counts only for the proxy answer it names, and attests to no images', async () => {
    const env = await proxyAnswered();
    await env.relay.answerEvent({
      questionId: env.qid,
      phone: env.phone,
      action: 'confirm-proxy',
      expectedRevision: 1,
      status: 'human-answered',
      confirmsActionId: 'b'.repeat(26),
    });
    await env.bridge.catchUp();
    expect((await env.bridge.getDecision(env.qid)).status).toBe('proxy-answered');
    expect(
      (await env.store.listAudit(50)).some((a) => a.result === 'confirms-another-answer'),
    ).toBe(true);

    await env.relay.answerEvent({
      questionId: env.qid,
      phone: env.phone,
      action: 'confirm-proxy',
      expectedRevision: 1,
      status: 'human-answered',
      confirmsActionId: env.proxyActionId,
    });
    await env.bridge.catchUp();
    expect(await env.bridge.getDecision(env.qid)).toMatchObject({
      status: 'human-answered',
      provenance: 'human',
      choice: 'approve',
      reviewedDigestsMatch: false,
    });
  });
});
