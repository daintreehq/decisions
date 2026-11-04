import { describe, expect, it } from 'vitest';
import {
  ActionRecord,
  AgentMessageContentV1,
  ApiError,
  HumanAnswerContentV1,
  HumanMessageContentV1,
  LIMITS,
  MessageBody,
  MessageContentV1,
  MessageReceiptBody,
  MessageRecord,
  PhoneImageReserveBody,
  ProxyAnswerContentV1,
  PushPayload,
  QuestionStatus,
  SignedMessage,
  applyAction,
  applyMessage,
  imagesMatchRecord,
  isTerminalStatus,
  isThreadClosedStatus,
  messageDeliveryKey,
  signingString,
  threadAwaitsHuman,
  type ActionKind,
  type CryptoEnvelope,
  type QuestionState,
  type Role,
} from '../src/index.js';
import { Legacy030, MESSAGE_IMAGE_FIXTURE, THREAD_FIXTURE } from '../src/fixtures.js';

const SIG = 's'.repeat(86);
const DIGEST = 'a'.repeat(64);
const ROLES: Role[] = ['owner-desktop', 'desktop-host', 'phone', 'tablet'];
const STATUSES = QuestionStatus.options;

const [agentAsk, humanReply, agentDone] = THREAD_FIXTURE.messages;
const signed = (r: object) => ({ ...r, envelope_digest: DIGEST, signature: SIG });
const envelopeFor = (r: {
  message_id: string;
  installation_id: string;
  question_id: string;
  signer_device_id: string;
}): CryptoEnvelope => ({
  crypto_version: 1,
  suite: 'P256-ECDH-HKDF-SHA256-A256GCM-ECDSA-P256',
  key_epoch: 1,
  record_id: r.message_id,
  purpose: 'message-content',
  nonce: 'AAECAwQFBgcICQoL',
  ciphertext: 'c'.repeat(64),
  aad: {
    installation_id: r.installation_id,
    question_id: r.question_id,
    record_type: 'thread.message',
    revision: 0,
    sender_device_id: r.signer_device_id,
  },
});
const bytes = (n: number, ch = 'x') => ch.repeat(n);

describe('message records', () => {
  it('accepts both sides of the fixture thread', () => {
    for (const m of THREAD_FIXTURE.messages) {
      expect(MessageRecord.safeParse(signed(m.record)).success, m.record.message_id).toBe(true);
    }
  });
  it('lets only the agent expect a reply, and only the human attach images', () => {
    expect(
      MessageRecord.safeParse(signed({ ...humanReply.record, expects_reply: true })).success,
    ).toBe(false);
    expect(
      MessageRecord.safeParse(signed({ ...agentAsk.record, attachment_ids: ['att_aaaaaaaa'] }))
        .success,
    ).toBe(false);
  });
  it('caps and de-duplicates image ids', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `att_image${i}xx`);
    const at = (attachment_ids: string[]) =>
      MessageRecord.safeParse(signed({ ...humanReply.record, attachment_ids })).success;
    expect(at(ids(LIMITS.phoneImagesPerContent))).toBe(true);
    expect(at(ids(LIMITS.phoneImagesPerContent + 1))).toBe(false);
    expect(at(['att_sameimage', 'att_sameimage'])).toBe(false);
  });
  it('keeps unknown fields, so a newer signer still verifies', () => {
    const r = MessageRecord.parse(signed({ ...agentAsk.record, later_field: 1 }));
    expect((r as Record<string, unknown>).later_field).toBe(1);
  });
  it('binds the envelope to the message id with revision 0', () => {
    const record = signed(agentAsk.record);
    const env = envelopeFor(agentAsk.record);
    expect(SignedMessage.safeParse({ record, envelope: env }).success).toBe(true);
    const bad: [string, CryptoEnvelope][] = [
      ['purpose', { ...env, purpose: 'answer-content' }],
      ['record id', { ...env, record_id: 'msg_other0001' }],
      ['record type', { ...env, aad: { ...env.aad, record_type: 'answer' } }],
      ['revision', { ...env, aad: { ...env.aad, revision: 1 } }],
      ['sender', { ...env, aad: { ...env.aad, sender_device_id: 'dev_someone01' } }],
      ['question', { ...env, aad: { ...env.aad, question_id: 'q_another001' } }],
    ];
    for (const [what, envelope] of bad) {
      expect(SignedMessage.safeParse({ record, envelope }).success, what).toBe(false);
    }
  });
  it('a message body carries one signed message', () => {
    const body = {
      protocol_version: 1,
      idempotency_key: 'idem_aaaaaaaa',
      message: { record: signed(agentAsk.record), envelope: envelopeFor(agentAsk.record) },
    };
    expect(MessageBody.safeParse(body).success).toBe(true);
  });
});

describe('message content', () => {
  it('parses the fixture content on both sides', () => {
    for (const m of THREAD_FIXTURE.messages) {
      expect(MessageContentV1.safeParse(m.content).success, m.record.message_id).toBe(true);
    }
  });
  it('needs text or an image from the person, and text from the agent', () => {
    expect(HumanMessageContentV1.safeParse({ side: 'human', text: '  ' }).success).toBe(false);
    expect(HumanMessageContentV1.safeParse({ side: 'human' }).success).toBe(false);
    expect(
      HumanMessageContentV1.safeParse({ side: 'human', images: [MESSAGE_IMAGE_FIXTURE] }).success,
    ).toBe(true);
    expect(AgentMessageContentV1.safeParse({ side: 'agent', text: ' \n' }).success).toBe(false);
    expect(
      AgentMessageContentV1.safeParse({ side: 'agent', images: [MESSAGE_IMAGE_FIXTURE] }).success,
    ).toBe(false);
  });
  it('limits text by UTF-8 bytes, not characters', () => {
    const max = LIMITS.messageTextBytes;
    expect(AgentMessageContentV1.safeParse({ side: 'agent', text: bytes(max) }).success).toBe(true);
    expect(AgentMessageContentV1.safeParse({ side: 'agent', text: bytes(max + 1) }).success).toBe(
      false,
    );
    // 'é' is two bytes: half as many fit
    expect(
      AgentMessageContentV1.safeParse({ side: 'agent', text: bytes(max / 2, 'é') }).success,
    ).toBe(true);
    expect(
      AgentMessageContentV1.safeParse({ side: 'agent', text: bytes(max / 2 + 1, 'é') }).success,
    ).toBe(false);
    // escaping never counts against the limit: a full message of newlines and quotes is still a message
    expect(HumanMessageContentV1.safeParse({ side: 'human', text: bytes(max, '"') }).success).toBe(
      true,
    );
  });
  it('carries no answer: option, approval and reason fields are dropped', () => {
    const c = HumanMessageContentV1.parse({
      side: 'human',
      text: 'approved',
      selected_option_ids: ['a'],
      explicit_approval: true,
      reason: 'because',
    });
    expect(c).toEqual({ content_version: 1, side: 'human', text: 'approved', images: [] });
  });
  it('caps images per message and rejects duplicates and oversize images', () => {
    const img = (i: number) => ({ ...MESSAGE_IMAGE_FIXTURE, attachment_id: `att_image${i}xx` });
    const images = (n: number) => Array.from({ length: n }, (_, i) => img(i));
    const ok = (list: unknown[]) =>
      HumanMessageContentV1.safeParse({ side: 'human', images: list }).success;
    expect(ok(images(LIMITS.phoneImagesPerContent))).toBe(true);
    expect(ok(images(LIMITS.phoneImagesPerContent + 1))).toBe(false);
    expect(ok([img(1), img(1)])).toBe(false);
    expect(ok([{ ...img(1), size: LIMITS.phoneImageBytes }])).toBe(true);
    expect(ok([{ ...img(1), size: LIMITS.phoneImageBytes + 1 }])).toBe(false);
    expect(ok([{ ...img(1), mime: 'image/gif' }])).toBe(false);
  });
  it('matches content images to the signed record exactly', () => {
    expect(imagesMatchRecord(humanReply.record.attachment_ids, humanReply.content.images)).toBe(
      true,
    );
    expect(imagesMatchRecord(undefined, undefined)).toBe(true);
    expect(imagesMatchRecord([], [MESSAGE_IMAGE_FIXTURE])).toBe(false);
    expect(imagesMatchRecord([MESSAGE_IMAGE_FIXTURE.attachment_id], [])).toBe(false);
    expect(imagesMatchRecord(['att_otherimg1'], [MESSAGE_IMAGE_FIXTURE])).toBe(false);
    expect(
      imagesMatchRecord(
        [MESSAGE_IMAGE_FIXTURE.attachment_id, MESSAGE_IMAGE_FIXTURE.attachment_id],
        [MESSAGE_IMAGE_FIXTURE, MESSAGE_IMAGE_FIXTURE],
      ),
    ).toBe(false);
  });
});

describe('phone images on answers', () => {
  const action = {
    v: 1,
    type: 'action',
    installation_id: 'inst_aaaaaaaa',
    question_id: 'q_aaaaaaaa',
    action_id: 'act_aaaaaaaa',
    expected_revision: 0,
    created_at: '2026-11-01T09:00:00.000Z',
    envelope_digest: DIGEST,
    confirms_action_id: null,
    expires_at: null,
    signer_device_id: 'dev_aaaaaaaa',
    signature: SIG,
  };
  it('lists images only on a human answer or override', () => {
    const withIds = (a: string) =>
      ActionRecord.safeParse({ ...action, action: a, attachment_ids: ['att_aaaaaaaa'] }).success;
    expect(withIds('answer')).toBe(true);
    expect(withIds('override')).toBe(true);
    expect(withIds('proxy-answer')).toBe(false);
    expect(
      ActionRecord.safeParse({
        ...action,
        action: 'confirm-proxy',
        confirms_action_id: 'act_bbbbbbbb',
        attachment_ids: ['att_aaaaaaaa'],
      }).success,
    ).toBe(false);
    expect(
      ActionRecord.safeParse({
        ...action,
        action: 'answer',
        attachment_ids: ['att_aaaaaaaa', 'att_aaaaaaaa'],
      }).success,
    ).toBe(false);
  });
  it('leaves a record signed without images byte-for-byte the same', () => {
    const r = { ...action, action: 'answer' };
    const parsed = ActionRecord.parse(r);
    expect('attachment_ids' in parsed).toBe(false);
    expect(signingString(parsed)).toBe(signingString(r));
  });
  it('human answer content may reference images; proxy content never carries them', () => {
    const answer = THREAD_FIXTURE.answer.content;
    expect(HumanAnswerContentV1.parse(answer).images).toHaveLength(1);
    expect(HumanAnswerContentV1.parse({ text: 'ok' }).images).toBeUndefined();
    const proxy = ProxyAnswerContentV1.parse({
      ...answer,
      model_id: 'm',
      prompt_template_version: '1',
      confidence: 0.5,
    });
    expect('images' in proxy).toBe(false);
    expect(imagesMatchRecord(THREAD_FIXTURE.answer.attachment_ids, answer.images)).toBe(true);
  });
  it('a 0.3.0 client would silently drop the images, which is why it is never sent them', () => {
    const legacy = Legacy030.HumanAnswerContentV1.parse(THREAD_FIXTURE.answer.content);
    expect('images' in legacy).toBe(false);
    expect(legacy.text).toBe(THREAD_FIXTURE.answer.content.text);
  });
  it('reserves one image for one answer or message', () => {
    const body = {
      protocol_version: 1,
      idempotency_key: 'idem_aaaaaaaa',
      attachment_id: 'att_aaaaaaaa',
      binding: { kind: 'message', record_id: 'msg_aaaaaaaa' },
      ciphertext_bytes: 1_000,
      sha256_ciphertext: DIGEST,
      mime_category: 'image',
    };
    expect(PhoneImageReserveBody.safeParse(body).success).toBe(true);
    expect(
      PhoneImageReserveBody.safeParse({ ...body, binding: { kind: 'proxy', record_id: 'x' } })
        .success,
    ).toBe(false);
    expect(
      PhoneImageReserveBody.safeParse({ ...body, ciphertext_bytes: LIMITS.phoneImageBytes + 64 })
        .success,
    ).toBe(true);
    expect(
      PhoneImageReserveBody.safeParse({ ...body, ciphertext_bytes: LIMITS.phoneImageBytes + 65 })
        .success,
    ).toBe(false);
  });
});

describe('message delivery receipts', () => {
  const base = {
    protocol_version: 1,
    idempotency_key: 'idem_aaaaaaaa',
    question_id: 'q_aaaaaaaa',
    message_id: 'msg_aaaaaaaa',
    host_id: 'host_aaaaaaaa',
  };
  it('names what each status needs', () => {
    const ok = (b: object) => MessageReceiptBody.safeParse({ ...base, ...b }).success;
    expect(ok({ status: 'received' })).toBe(true);
    expect(ok({ status: 'terminal-delivered', injection_id: 'inj_aaaaaaaa' })).toBe(true);
    expect(ok({ status: 'terminal-delivered' })).toBe(false);
    expect(ok({ status: 'needs-attention', error_code: 'pane-closed' })).toBe(true);
    expect(ok({ status: 'delivery-uncertain', error_code: 'enter-abandoned' })).toBe(true);
    expect(ok({ status: 'needs-attention' })).toBe(false);
    expect(ok({ status: 'needs-attention', error_code: 'Bad Code' })).toBe(false);
    expect(ok({ status: 'relay-queued' })).toBe(false);
  });
  it('keys crash recovery by question and message, apart from answers', () => {
    const k = messageDeliveryKey('q_aaaaaaaa', 'msg_aaaaaaaa');
    expect(k).toBe(messageDeliveryKey('q_aaaaaaaa', 'msg_aaaaaaaa'));
    expect(k).not.toBe(messageDeliveryKey('q_aaaaaaaa', 'msg_bbbbbbbb'));
    expect(k).not.toBe(messageDeliveryKey('q_bbbbbbbb', 'msg_aaaaaaaa'));
    expect(JSON.parse(k)).toEqual({
      kind: 'message',
      message_id: 'msg_aaaaaaaa',
      question_id: 'q_aaaaaaaa',
    });
  });
});

describe('push payloads', () => {
  it('carry a type and a question id and nothing else', () => {
    expect(
      PushPayload.safeParse({ type: 'decision-reply', question_id: 'q_aaaaaaaa' }).success,
    ).toBe(true);
    expect(PushPayload.safeParse({ type: 'test' }).success).toBe(true);
    for (const extra of [
      { pane_title: 'claude' },
      { terminal_lines: ['x'] },
      { agent_state: 'waiting' },
      { text: 'hello' },
    ]) {
      expect(
        PushPayload.safeParse({ type: 'decision-new', question_id: 'q_aaaaaaaa', ...extra })
          .success,
        Object.keys(extra)[0],
      ).toBe(false);
    }
  });
});

describe('thread state rules', () => {
  const stateOf = (status: QuestionState['status']): QuestionState => ({
    status,
    revision: 3,
    requirement: 'proxy-ok',
    proxyAbstained: true,
    hasHumanAnswer: status === 'human-answered',
  });
  const ACCEPTING = new Set(['open', 'human-answered', 'proxy-answered']);

  it('accepts messages while a question is open or answered, and refuses them once it is closed', () => {
    for (const status of STATUSES) {
      expect(isThreadClosedStatus(status), status).toBe(!ACCEPTING.has(status));
    }
    // answered is terminal for the answer, not for the thread
    expect(isTerminalStatus('human-answered')).toBe(true);
    expect(isThreadClosedStatus('human-answered')).toBe(false);
  });

  it('never changes the answer, revision, deliverable or approval, in any state, from any sender', () => {
    for (const status of STATUSES) {
      for (const role of ROLES) {
        for (const side of ['human', 'agent'] as const) {
          for (const signerIsPublisher of [true, false]) {
            const state = stateOf(status);
            const frozen = structuredClone(state);
            const label = `${status} ${role} ${side} publisher=${signerIsPublisher}`;
            let t;
            try {
              t = applyMessage(state, { side, role, signerIsPublisher, messageCount: 0 });
            } catch (e) {
              expect(e, label).toBeInstanceOf(ApiError);
              expect(state, label).toEqual(frozen); // a refusal mutates nothing either
              continue;
            }
            expect(t.state, label).toEqual(frozen);
            expect(t.deliverable, label).toBe(false);
            expect(t.approval, label).toBe(false);
            expect(t.deliverToHost, label).toBe(side === 'human');
            expect(state, label).toEqual(frozen);
          }
        }
      }
    }
  });

  it('takes human messages from paired phones and agent messages only from the publishing desktop', () => {
    const open = stateOf('open');
    const code = (f: () => unknown) => {
      try {
        f();
        return 'ok';
      } catch (e) {
        return (e as ApiError).code;
      }
    };
    const msg = (side: 'human' | 'agent', role: Role, signerIsPublisher = false) =>
      code(() => applyMessage(open, { side, role, signerIsPublisher, messageCount: 0 }));
    expect(msg('human', 'phone')).toBe('ok');
    expect(msg('human', 'tablet')).toBe('ok');
    expect(msg('human', 'owner-desktop', true)).toBe('forbidden');
    expect(msg('agent', 'desktop-host', true)).toBe('ok');
    expect(msg('agent', 'owner-desktop', true)).toBe('ok');
    // the owner has no exemption for another host's question
    expect(msg('agent', 'owner-desktop', false)).toBe('forbidden');
    expect(msg('agent', 'phone', true)).toBe('forbidden');
  });

  it('refuses expired and withdrawn (cancelled) questions, and allows them again after a reopen', () => {
    const code = (status: QuestionState['status']) => {
      try {
        applyMessage(stateOf(status), {
          side: 'human',
          role: 'phone',
          signerIsPublisher: false,
          messageCount: 0,
        });
        return 'ok';
      } catch (e) {
        return (e as ApiError).code;
      }
    };
    expect(code('expired')).toBe('expired');
    expect(code('cancelled')).toBe('invalid_state');
    const reopened = applyAction(stateOf('cancelled'), 'reopen', 'owner-desktop', 3);
    expect(
      applyMessage(
        { ...stateOf('cancelled'), status: reopened.status, revision: reopened.revision },
        { side: 'human', role: 'phone', signerIsPublisher: false, messageCount: 0 },
      ).state.status,
    ).toBe('open');
  });

  it('caps messages per question', () => {
    const m = (messageCount: number) => () =>
      applyMessage(stateOf('human-answered'), {
        side: 'agent',
        role: 'desktop-host',
        signerIsPublisher: true,
        messageCount,
      });
    expect(m(LIMITS.messagesPerQuestion - 1)).not.toThrow();
    expect(m(LIMITS.messagesPerQuestion)).toThrow(/message limit/);
  });

  it('leaves every action outcome as it was without the messages', () => {
    // A message between actions hands back the same state, so the next action sees exactly what it would have.
    const actions: [QuestionState['status'], ActionKind, Role][] = [
      ['open', 'answer', 'phone'],
      ['proxy-answered', 'confirm-proxy', 'phone'],
      ['proxy-answered', 'override', 'tablet'],
      ['open', 'proxy-answer', 'desktop-host'],
      ['open', 'cancel', 'owner-desktop'],
    ];
    for (const [status, action, role] of actions) {
      const before = stateOf(status);
      let after = before;
      for (const side of ['agent', 'human', 'agent'] as const) {
        after = applyMessage(after, {
          side,
          role: side === 'human' ? 'phone' : 'desktop-host',
          signerIsPublisher: true,
          messageCount: 0,
        }).state;
      }
      expect(applyAction(after, action, role, 3), `${status} ${action}`).toEqual(
        applyAction(before, action, role, 3),
      );
    }
    // a model answer is still unconfirmed after the person writes "approved" in the thread
    const proxy = applyMessage(stateOf('proxy-answered'), {
      side: 'human',
      role: 'phone',
      signerIsPublisher: false,
      messageCount: 0,
    }).state;
    expect(proxy.status).toBe('proxy-answered');
    expect(proxy.hasHumanAnswer).toBe(false);
  });

  it('keeps accepting the deprecated override of a human answer, unchanged', () => {
    expect(applyAction(stateOf('human-answered'), 'override', 'phone', 3)).toMatchObject({
      status: 'human-answered',
      revision: 4,
      deliverable: true,
      eventType: 'decision.answer.overridden',
    });
  });
});

describe('whose turn it is', () => {
  const msgs = (n: number) =>
    THREAD_FIXTURE.messages.slice(0, n).map((m) => ({
      side: m.record.side,
      expects_reply: m.record.expects_reply,
      event_seq: m.event_seq,
    }));
  const awaits = (n: number, status = THREAD_FIXTURE.status, lastHumanActionSeq?: number) =>
    threadAwaitsHuman({
      status,
      messages: msgs(n),
      lastHumanActionSeq: lastHumanActionSeq ?? THREAD_FIXTURE.answer_event_seq,
    });
  it('an agent question brings an answered thread back to the person until they reply', () => {
    expect(awaits(0)).toBe(false);
    expect(awaits(1)).toBe(true);
    expect(awaits(2)).toBe(false);
    expect(awaits(3)).toBe(false);
  });
  it('a later agent message that asks nothing withdraws the request', () => {
    const list = [
      { side: 'agent' as const, expects_reply: true, event_seq: 4 },
      { side: 'agent' as const, expects_reply: false, event_seq: 5 },
    ];
    expect(threadAwaitsHuman({ status: 'human-answered', messages: list })).toBe(false);
  });
  it('a human answer after the request is a reply, and closed threads await nobody', () => {
    expect(awaits(1, 'human-answered', agentAsk.event_seq + 1)).toBe(false);
    expect(awaits(1, 'expired')).toBe(false);
    expect(awaits(1, 'cancelled')).toBe(false);
    expect(agentDone.record.expects_reply).toBe(false);
  });
});
