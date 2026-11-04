import { describe, expect, it } from 'vitest';
import { runDurableObjectAlarm } from 'cloudflare:test';
import {
  ActionRecord,
  HumanAnswerContentV1,
  LIMITS,
  PROTOCOL_VERSION,
  imagesMatchRecord,
  type PhoneImageBinding,
} from '@daintreehq/decisions-protocol';
import { decryptAttachment, decryptEnvelope, newId } from '@daintreehq/decisions-crypto';
import { testEnv as env } from './env.js';
import {
  PNG,
  act,
  ask,
  claimRelay,
  declare,
  download,
  enrollHost,
  inRoom,
  pairDevice,
  putCiphertext,
  raw,
  say,
  settle,
  sha256Hex,
  stub,
  thread,
  uploadImage,
  uploadPhoneImage,
  type Actor,
  type PhoneUpload,
  type World,
} from './helpers.js';

/*
 * Phone images on the relay (docs/protocol.md section 17, issue #33): a phone reserves, uploads and completes an
 * encrypted image for one answer or message on an existing question; it becomes readable only when that record
 * commits, and is cleaned up when nothing references it.
 */

const IMAGES = ['phone-images-v1', 'thread-messages-v1'];

async function setup() {
  const w = await claimRelay();
  await declare(w.owner, IMAGES);
  const phone = await pairDevice(w);
  const { questionId } = await ask(w);
  return { w, phone, questionId };
}

const forAnswer = (record_id = newId()): PhoneImageBinding => ({ kind: 'answer', record_id });
const forMessage = (record_id = newId()): PhoneImageBinding => ({ kind: 'message', record_id });

/** Answers with the images, listing them in the signed record and in the encrypted content alike. */
const answerWith = (
  w: World,
  actor: Actor,
  questionId: string,
  actionId: string,
  images: PhoneUpload[],
  kind: 'answer' | 'override' = 'answer',
  expected = 0,
) =>
  act(w, actor, kind, questionId, expected, {
    actionId,
    attachmentIds: images.map((i) => i.attachmentId),
    content: {
      selected_option_ids: ['approve'],
      text: 'see the screenshot',
      images: images.map((i) => i.ref),
    },
  });

const row = (id: string) =>
  inRoom((room) =>
    room.q1<{
      object_key: string;
      state: string;
      kind: string;
      bound: number;
      bound_at: number | null;
      delete_after: number | null;
      created_at: number;
      object_deleted: number;
    }>(`SELECT * FROM attachments WHERE attachment_id = ?`, id),
  );

const stored = async (id: string) => env.ATTACHMENTS.head((await row(id))!.object_key);

/** Makes the matching pending jobs due now and runs the alarm until nothing due is left. */
async function runDue(kind: string, attachmentId?: string) {
  await inRoom((room) =>
    attachmentId
      ? room.run(
          `UPDATE scheduled_jobs SET run_at = ? WHERE kind = ? AND attachment_id = ? AND status = 'pending'`,
          Date.now() - 1,
          kind,
          attachmentId,
        )
      : room.run(
          `UPDATE scheduled_jobs SET run_at = ? WHERE kind = ? AND status = 'pending'`,
          Date.now() - 1,
          kind,
        ),
  );
  await runDurableObjectAlarm(stub());
  await settle();
}

const question = async (a: Actor, id: string) =>
  (await a.call('GET', `/api/v1/questions/${id}`)).json;

describe('uploading phone images (end to end)', () => {
  it('a phone attaches an image to its answer, and every paired device reads only ciphertext after the commit', async () => {
    const { w, phone, questionId } = await setup();
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    const { host } = await enrollHost(w);
    const actionId = newId();
    const img = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    expect(img.reserve.status).toBe(201);
    expect(img.reserve.json).toMatchObject({
      attachment_id: img.attachmentId,
      upload_path: `/api/v1/attachments/${img.attachmentId}/content`,
    });
    expect(img.put!.status).toBe(200);
    expect(img.complete!.json).toEqual({ attachment_id: img.attachmentId, state: 'available' });

    // R2 holds ciphertext only.
    const object = await env.ATTACHMENTS.get((await row(img.attachmentId))!.object_key);
    const bytes = new Uint8Array(await object!.arrayBuffer());
    expect(bytes).toEqual(img.enc.ciphertext);
    expect(Array.from(bytes.slice(0, 4))).not.toEqual([0x89, 0x50, 0x4e, 0x47]);

    // Before the answer commits nothing shows the image: no download, no listing, no event.
    for (const a of [w.owner, host, phone, tablet])
      expect((await download(a, img.attachmentId)).status).toBe(404);
    expect((await question(w.owner, questionId)).attachments).toEqual([]);
    const feed = async () =>
      (
        await w.owner.call(
          'GET',
          '/api/v1/events',
          undefined,
          'after=0&limit=100&features=phone-images-v1,thread-messages-v1',
        )
      ).json.events as { event_type: string; data: any }[];
    expect(JSON.stringify(await feed())).not.toContain(img.attachmentId);

    const answered = await answerWith(w, phone, questionId, actionId, [img]);
    expect(answered.res.status).toBe(201);
    const committed = (await feed()).find((e) => e.event_type === 'decision.answer.committed')!;
    expect(committed.data.record.attachment_ids).toEqual([img.attachmentId]);
    expect((await feed()).map((e) => e.event_type)).not.toContain('attachment.available');

    // The publishing desktop, a host and both human devices download it; it decrypts to the image.
    for (const a of [w.owner, host, phone, tablet]) {
      const dl = await download(a, img.attachmentId);
      expect(dl.status).toBe(200);
      expect(dl.bytes).toEqual(img.enc.ciphertext);
    }
    const plain = await decryptAttachment(
      w.epoch,
      {
        installationId: w.installationId,
        questionId,
        attachmentId: img.attachmentId,
        keyEpoch: img.ref.key_epoch,
      },
      img.ref.nonce,
      (await download(w.owner, img.attachmentId)).bytes,
      img.ref.sha256,
    );
    expect(plain).toEqual(PNG);
    // Phone images never join the question's own attachments.
    expect((await question(w.owner, questionId)).attachments).toEqual([]);
    expect(await row(img.attachmentId)).toMatchObject({ kind: 'phone', bound: 1 });
  });

  it('a tablet attaches images to a follow-up message, bound to that message', async () => {
    const { w, questionId } = await setup();
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    const messageId = newId();
    const a = await uploadPhoneImage(w, tablet, questionId, forMessage(messageId));
    const b = await uploadPhoneImage(w, tablet, questionId, forMessage(messageId), {
      plaintext: new Uint8Array([...PNG, 1, 2, 3]),
    });
    expect([a.complete!.status, b.complete!.status]).toEqual([200, 200]);
    const said = await say(w, tablet, questionId, {
      messageId,
      text: 'both screens',
      attachmentIds: [a.attachmentId, b.attachmentId],
      images: [a.ref, b.ref],
    });
    expect(said.res.status).toBe(201);
    for (const img of [a, b]) {
      const dl = await download(w.owner, img.attachmentId);
      expect(dl.status).toBe(200);
      expect(dl.bytes).toEqual(img.enc.ciphertext);
    }
    const [m] = await thread(w.owner, questionId);
    expect(m.record.attachment_ids).toEqual([a.attachmentId, b.attachmentId]);
  });

  it('an override of a proxy answer carries images, reserved as an answer binding', async () => {
    const { w, phone } = await setup();
    const { questionId } = await ask(w, { requirement: 'proxy-ok' });
    expect((await act(w, w.owner, 'proxy-answer', questionId, 0)).res.status).toBe(201);
    const actionId = newId();
    const img = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    expect(img.reserve.status).toBe(201);
    const overridden = await answerWith(w, phone, questionId, actionId, [img], 'override', 1);
    expect(overridden.res.status).toBe(201);
    expect((await download(w.owner, img.attachmentId)).status).toBe(200);
  });

  it('the relay serves the records that list the images back complete, for export', async () => {
    const { w, phone, questionId } = await setup();
    const actionId = newId();
    const img = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    await answerWith(w, phone, questionId, actionId, [img]);
    const messageId = newId();
    const late = await uploadPhoneImage(w, phone, questionId, forMessage(messageId));
    await say(w, phone, questionId, {
      messageId,
      attachmentIds: [late.attachmentId],
      images: [late.ref],
    });

    const detail = await question(phone, questionId);
    const entry = detail.actions.find((a: any) => a.action === 'answer');
    const record = ActionRecord.parse(entry.record);
    expect(record.attachment_ids).toEqual([img.attachmentId]);
    const content = HumanAnswerContentV1.parse(
      await decryptEnvelope(entry.envelope, new Map([[w.epoch.epoch, w.epoch]]), {
        installationId: w.installationId,
        questionId,
        recordType: 'answer',
        revision: 1,
        senderDeviceId: phone.id,
        purpose: 'answer-content',
      }),
    );
    expect(imagesMatchRecord(record.attachment_ids ?? [], content.images ?? [])).toBe(true);
    expect(content.images).toEqual([img.ref]);
    const [m] = await thread(phone, questionId);
    expect(m.record.attachment_ids).toEqual([late.attachmentId]);
    // Every listed image downloads, under its reference's size once decrypted.
    for (const i of [img, late]) expect((await download(w.owner, i.attachmentId)).status).toBe(200);
  });
});

describe('reserving', () => {
  it('takes images on questions that take messages, and refuses the rest', async () => {
    const { w, phone, questionId } = await setup();
    const reserve = async (qid: string) =>
      (await uploadPhoneImage(w, phone, qid, forAnswer(), { until: 'reserve' })).reserve;
    expect((await reserve(questionId)).status).toBe(201);
    // Answered and model-answered questions still take images, for follow-ups.
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(201);
    expect((await reserve(questionId)).status).toBe(201);
    const proxied = (await ask(w, { requirement: 'proxy-ok' })).questionId;
    expect((await act(w, w.owner, 'proxy-answer', proxied, 0)).res.status).toBe(201);
    expect((await reserve(proxied)).status).toBe(201);
    // Unknown, cancelled ("withdrawn") and expired questions do not.
    expect((await reserve(newId())).status).toBe(404);
    const cancelled = (await ask(w)).questionId;
    expect((await act(w, w.owner, 'cancel', cancelled, 0)).res.status).toBe(201);
    const refused = await reserve(cancelled);
    expect([refused.status, refused.json.code]).toEqual([409, 'invalid_state']);
    const overdue = (await ask(w)).questionId;
    await inRoom((room) =>
      room.run(`UPDATE questions SET expires_at = ? WHERE question_id = ?`, Date.now() - 1, overdue),
    );
    const late = await reserve(overdue);
    expect([late.status, late.json.code]).toEqual([410, 'expired']);
    // The expiry it found was committed, not rolled back with the refusal.
    expect((await question(w.owner, overdue)).status).toBe('expired');
    expect((await reserve(overdue)).status).toBe(410);
    // Desktops never reserve phone images.
    const asDesktop = await uploadPhoneImage(w, w.owner, questionId, forAnswer(), {
      until: 'reserve',
    });
    expect(asDesktop.reserve.status).toBe(403);
  });

  it('refuses images for a question whose publishing desktop does not take them', async () => {
    const w = await claimRelay();
    await declare(w.owner, ['thread-messages-v1']);
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    const r = (await uploadPhoneImage(w, phone, questionId, forAnswer(), { until: 'reserve' }))
      .reserve;
    expect([r.status, r.json.code]).toEqual([409, 'invalid_state']);
    // Another device declaring images does not speak for the publisher.
    await declare(phone, IMAGES);
    expect(
      (await uploadPhoneImage(w, phone, questionId, forAnswer(), { until: 'reserve' })).reserve
        .status,
    ).toBe(409);
    await declare(w.owner, IMAGES);
    expect(
      (await uploadPhoneImage(w, phone, questionId, forAnswer(), { until: 'reserve' })).reserve
        .status,
    ).toBe(201);
  });

  it('is idempotent on its key, and the key is bound to the question', async () => {
    const { w, phone, questionId } = await setup();
    const body = {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(),
      attachment_id: newId(),
      binding: forAnswer(),
      ciphertext_bytes: 1000,
      sha256_ciphertext: 'a'.repeat(64),
      mime_category: 'image',
    };
    const path = (q: string) => `/api/v1/questions/${q}/images/reservations`;
    const first = await phone.call('POST', path(questionId), body);
    expect(first.status).toBe(201);
    const again = await phone.call('POST', path(questionId), body);
    expect([again.status, again.json]).toEqual([201, first.json]);
    const other = (await ask(w)).questionId;
    expect((await phone.call('POST', path(other), body)).json.code).toBe('idempotency_collision');
    expect(
      (await phone.call('POST', path(questionId), { ...body, ciphertext_bytes: 1001 })).json.code,
    ).toBe('idempotency_collision');
    // A fresh key cannot take an id already in use.
    expect(
      (await phone.call('POST', path(questionId), { ...body, idempotency_key: newId() })).json
        .code,
    ).toBe('invalid_state');
    const count = await inRoom(
      (room) => room.q1<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments`)!.n,
    );
    expect(count).toBe(1);
  });
});

describe('limits', () => {
  const reserveBytes = (
    phone: Actor,
    questionId: string,
    bytes: number,
    binding: PhoneImageBinding = forAnswer(),
  ) =>
    phone.call('POST', `/api/v1/questions/${questionId}/images/reservations`, {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(),
      attachment_id: newId(),
      binding,
      ciphertext_bytes: bytes,
      sha256_ciphertext: 'a'.repeat(64),
      mime_category: 'image',
    });
  const MAX = LIMITS.phoneImageBytes + 64;

  it('caps one image at 10 MiB and one answer or message at 4 images', async () => {
    const { phone, questionId } = await setup();
    expect((await reserveBytes(phone, questionId, MAX + 1)).status).toBe(400);
    const binding = forMessage();
    for (let i = 0; i < LIMITS.phoneImagesPerContent; i++)
      expect((await reserveBytes(phone, questionId, MAX, binding)).status).toBe(201);
    const fifth = await reserveBytes(phone, questionId, 1000, binding);
    expect([fifth.status, fifth.json.code]).toEqual([413, 'payload_too_large']);
    // Another record of the same question has its own four.
    expect((await reserveBytes(phone, questionId, 1000, forMessage())).status).toBe(201);
  });

  it('caps the unbound reservations one device holds at 8, completed uploads included', async () => {
    const { w, phone, questionId } = await setup();
    const other = (await ask(w)).questionId;
    const actionId = newId();
    const done = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    expect(done.complete!.status).toBe(200);
    for (let i = 1; i < LIMITS.phoneImageUnboundPerDevice; i++)
      expect((await reserveBytes(phone, i % 2 ? other : questionId, 1000)).status).toBe(201);
    const ninth = await reserveBytes(phone, other, 1000);
    expect([ninth.status, ninth.json.code]).toEqual([429, 'rate_limited']);
    // The budget is the device's own: another phone still reserves.
    const second = await pairDevice(w, 'phone', 'Second phone');
    expect((await reserveBytes(second, questionId, 1000)).status).toBe(201);
    // Binding the completed one frees its slot.
    expect((await answerWith(w, phone, questionId, actionId, [done])).res.status).toBe(201);
    expect((await reserveBytes(phone, other, 1000)).status).toBe(201);
    expect((await reserveBytes(phone, other, 1000)).status).toBe(429);
  });

  it('caps a question at 64 MiB of image ciphertext and 16 images over its lifetime', async () => {
    const w = await claimRelay();
    await declare(w.owner, IMAGES);
    const phones = [
      await pairDevice(w),
      await pairDevice(w, 'phone', 'Second phone'),
      await pairDevice(w, 'tablet', 'Tablet'),
    ];
    const big = (await ask(w)).questionId;
    const fit = Math.floor(LIMITS.phoneImageTotalBytes / MAX);
    for (let i = 0; i < fit; i++)
      expect((await reserveBytes(phones[i % 3]!, big, MAX)).status).toBe(201);
    const over = await reserveBytes(phones[0]!, big, LIMITS.phoneImageTotalBytes - fit * MAX + 1);
    expect([over.status, over.json.code]).toEqual([413, 'payload_too_large']);
    expect(
      (await reserveBytes(phones[1]!, big, LIMITS.phoneImageTotalBytes - fit * MAX)).status,
    ).toBe(201);

    const many = (await ask(w)).questionId;
    for (let i = 0; i < LIMITS.phoneImagesPerQuestion; i++)
      expect((await reserveBytes(phones[i % 3]!, many, 1000)).status).toBe(201);
    // Collected orphans still count: the budget is for the question's lifetime.
    await runDue('gc_orphan');
    const gone = await inRoom(
      (room) =>
        room.q1<{ n: number }>(
          `SELECT COUNT(*) AS n FROM attachments WHERE question_id = ? AND state = 'deleted'`,
          many,
        )!.n,
    );
    expect(gone).toBe(LIMITS.phoneImagesPerQuestion);
    const seventeenth = await reserveBytes(phones[2]!, many, 1000);
    expect([seventeenth.status, seventeenth.json.code]).toEqual([413, 'payload_too_large']);
  });

  it('keeps phone image budgets apart from the desktop question-image budgets', async () => {
    const { w, phone, questionId } = await setup();
    for (let i = 0; i < LIMITS.phoneImageUnboundPerDevice; i++)
      expect((await reserveBytes(phone, questionId, 1000, forMessage())).status).toBe(201);
    // The desktop still reserves its full question-image budget for another question.
    const next = newId();
    for (let i = 0; i < LIMITS.attachmentsPerQuestion; i++) {
      const up = await uploadImage(w, next, PNG, { skipComplete: true });
      expect(up.put.status).toBe(200);
    }
  });
});

describe('binding at commit', () => {
  it('refuses an answer or message that lists a missing upload, and commits nothing', async () => {
    const { w, phone, questionId } = await setup();
    const actionId = newId();
    const good = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    const ghostId = newId();
    const ghost = { ...good, attachmentId: ghostId, ref: { ...good.ref, attachment_id: ghostId } };
    const r = await answerWith(w, phone, questionId, actionId, [good, ghost]);
    expect([r.res.status, r.res.json.code]).toEqual([400, 'validation_error']);
    expect(r.res.json.message).toMatch(/not an uploaded image/);
    // All or nothing: the good image stays unbound and the question open.
    expect(await row(good.attachmentId)).toMatchObject({ bound: 0, bound_at: null });
    expect((await question(w.owner, questionId)).status).toBe('open');
    expect((await download(w.owner, good.attachmentId)).status).toBe(404);
    // The same for a message.
    const messageId = newId();
    const m = await say(w, phone, questionId, { messageId, attachmentIds: [newId()] });
    expect([m.res.status, m.res.json.code]).toEqual([400, 'validation_error']);
    expect(await thread(phone, questionId)).toEqual([]);
    // Fixed, the answer goes through with its image.
    expect((await answerWith(w, phone, questionId, actionId, [good])).res.status).toBe(201);
  });

  it('binds only completed images the signer reserved for exactly this record, once', async () => {
    const { w, phone, questionId } = await setup();
    const other = await pairDevice(w, 'phone', 'Second phone');
    const actionId = newId();
    const refused = async (img: PhoneUpload, id = actionId) =>
      (await answerWith(w, phone, questionId, id, [img])).res;

    const reservedOnly = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId), {
      until: 'reserve',
    });
    expect((await refused(reservedOnly)).status).toBe(400);
    const notCompleted = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId), {
      until: 'put',
    });
    expect((await refused(notCompleted)).status).toBe(400);
    const elsewhere = await uploadPhoneImage(w, phone, questionId, forAnswer());
    expect((await refused(elsewhere)).status).toBe(400);
    const asMessage = await uploadPhoneImage(w, phone, questionId, forMessage(actionId));
    expect((await refused(asMessage)).status).toBe(400);
    const foreign = await uploadPhoneImage(w, other, questionId, forAnswer(actionId));
    expect((await refused(foreign)).status).toBe(400);
    const otherQuestion = (await ask(w)).questionId;
    const wrongQuestion = await uploadPhoneImage(w, phone, otherQuestion, forAnswer(actionId));
    expect((await refused(wrongQuestion)).status).toBe(400);
    // A desktop's question image is never a phone image.
    const desktopImage = await uploadImage(w, newId(), PNG);
    expect((await refused({ ...elsewhere, attachmentId: desktopImage.attachmentId })).status).toBe(
      400,
    );
    // An image past its orphan deadline is garbage even if the alarm has not run yet.
    const aged = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    await inRoom((room) =>
      room.run(
        `UPDATE attachments SET created_at = created_at - ? WHERE attachment_id = ?`,
        LIMITS.phoneImageOrphanMs,
        aged.attachmentId,
      ),
    );
    expect((await refused(aged)).status).toBe(400);
    expect((await question(w.owner, questionId)).status).toBe('open');

    const good = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    const answered = await answerWith(w, phone, questionId, actionId, [good]);
    expect(answered.res.status).toBe(201);
    // A retry of the same signed answer is the same commit; it neither rebinds nor extends retention.
    const before = await row(good.attachmentId);
    const retry = await phone.call('POST', `/api/v1/questions/${questionId}/answer`, {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(),
      action: answered.signed,
    });
    expect(retry.status).toBe(200);
    expect(await row(good.attachmentId)).toEqual(before);
    // An image binds once: an override that lists it again is refused.
    const reuse = await answerWith(w, phone, questionId, newId(), [good], 'override', 1);
    expect(reuse.res.status).toBe(400);
  });

  it('refuses images once the publishing desktop stops declaring them', async () => {
    const { w, phone, questionId } = await setup();
    const actionId = newId();
    const img = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    // Daintree downgraded to 0.3.0: its next socket ticket declares nothing.
    await w.owner.call('POST', '/api/v1/socket-ticket', { protocol_version: PROTOCOL_VERSION });
    const r = await answerWith(w, phone, questionId, actionId, [img]);
    expect([r.res.status, r.res.json.code]).toEqual([409, 'invalid_state']);
    expect((await question(w.owner, questionId)).status).toBe('open');
    // Text-only answers are unaffected.
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(201);
  });
});

describe('digest mismatch', () => {
  it('stores nothing for a body that differs from the reserved digest, and refuses a record listing it', async () => {
    const { w, phone, questionId } = await setup();
    const actionId = newId();
    const forged = new Uint8Array(PNG.length + 16).fill(7);
    const img = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId), {
      sendBytes: forged,
    });
    expect(img.put!.status).toBe(400);
    expect(await row(img.attachmentId)).toMatchObject({ state: 'reserved' });
    expect(await stored(img.attachmentId)).toBeNull();
    const done = await phone.call('POST', `/api/v1/attachments/${img.attachmentId}/complete`, {
      protocol_version: PROTOCOL_VERSION,
    });
    expect([done.status, done.json.code]).toEqual([409, 'invalid_state']);
    const r = await answerWith(w, phone, questionId, actionId, [img]);
    expect([r.res.status, r.res.json.code]).toEqual([400, 'validation_error']);
    expect((await question(w.owner, questionId)).status).toBe('open');

    // Validly signed bytes whose digest is not the reserved one are refused before anything streams.
    const other = new Uint8Array(img.enc.ciphertext.length).fill(9);
    const wrong = await putCiphertext(w, phone, img.attachmentId, {
      ciphertext: other,
      sha256Ciphertext: await sha256Hex(other),
    });
    expect([wrong.status, wrong.json.message]).toEqual([
      400,
      'length or digest differs from the reservation',
    ]);
    expect(await stored(img.attachmentId)).toBeNull();
    // The phone retries the same reservation with the right bytes, and the answer binds.
    expect((await putCiphertext(w, phone, img.attachmentId, img.enc)).status).toBe(200);
    expect(
      (
        await phone.call('POST', `/api/v1/attachments/${img.attachmentId}/complete`, {
          protocol_version: PROTOCOL_VERSION,
        })
      ).status,
    ).toBe(200);
    expect((await answerWith(w, phone, questionId, actionId, [img])).res.status).toBe(201);
  });

  it('refuses to complete an upload whose stored object no longer matches the reservation', async () => {
    const { w, phone, questionId } = await setup();
    const img = await uploadPhoneImage(w, phone, questionId, forAnswer(), { until: 'put' });
    expect(img.put!.status).toBe(200);
    // Same length, different bytes, written behind the relay's back.
    const key = (await row(img.attachmentId))!.object_key;
    await env.ATTACHMENTS.put(key, new Uint8Array(img.enc.ciphertext.length).fill(1));
    const done = await phone.call('POST', `/api/v1/attachments/${img.attachmentId}/complete`, {
      protocol_version: PROTOCOL_VERSION,
    });
    expect([done.status, done.json.code]).toEqual([400, 'validation_error']);
    expect(await row(img.attachmentId)).toMatchObject({ state: 'uploaded' });
  });
});

describe('who may upload, complete and download', () => {
  it('only the reserving phone uploads and completes; desktops are refused as a role', async () => {
    const { w, phone, questionId } = await setup();
    const other = await pairDevice(w, 'phone', 'Second phone');
    const img = await uploadPhoneImage(w, phone, questionId, forAnswer(), { until: 'reserve' });
    expect((await putCiphertext(w, w.owner, img.attachmentId, img.enc)).status).toBe(403);
    expect((await putCiphertext(w, other, img.attachmentId, img.enc)).status).toBe(404);
    const unsigned = await raw('PUT', `/api/v1/attachments/${img.attachmentId}/content`, {
      body: img.enc.ciphertext,
      headers: {
        'x-content-sha256': img.enc.sha256Ciphertext,
        'content-length': String(img.enc.ciphertext.length),
      },
    });
    expect(unsigned.status).toBe(401);
    expect((await putCiphertext(w, phone, img.attachmentId, img.enc)).status).toBe(200);
    const complete = (a: Actor) =>
      a.call('POST', `/api/v1/attachments/${img.attachmentId}/complete`, {
        protocol_version: PROTOCOL_VERSION,
      });
    expect((await complete(w.owner)).status).toBe(403);
    expect((await complete(other)).status).toBe(404);
    expect((await complete(phone)).status).toBe(200);
    // Phones still cannot touch a desktop's question image.
    const desktop = await uploadImage(w, newId(), PNG, { skipComplete: true });
    expect(
      (
        await phone.call('POST', `/api/v1/attachments/${desktop.attachmentId}/complete`, {
          protocol_version: PROTOCOL_VERSION,
        })
      ).status,
    ).toBe(403);
  });

  it('downloads by role: nobody before the commit, every active paired device after, nobody unsigned or revoked', async () => {
    const { w, phone, questionId } = await setup();
    const tablet = await pairDevice(w, 'tablet', 'Test iPad');
    const gone = await pairDevice(w, 'phone', 'Lost phone');
    const { host } = await enrollHost(w);
    const actionId = newId();
    const img = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    const everyone = [w.owner, host, phone, tablet, gone];
    for (const a of everyone) expect((await download(a, img.attachmentId)).status).toBe(404);
    await answerWith(w, phone, questionId, actionId, [img]);
    for (const a of everyone) expect((await download(a, img.attachmentId)).status).toBe(200);
    const path = `/api/v1/attachments/${img.attachmentId}/content`;
    expect((await raw('GET', path)).status).toBe(401);
    await inRoom((room) =>
      room.run(`UPDATE devices SET revoked_at = ? WHERE device_id = ?`, Date.now(), gone.id),
    );
    expect((await download(gone, img.attachmentId)).status).not.toBe(200);
  });
});

describe('cleanup and retention', () => {
  it('deletes images nothing references 2 hours after reservation, however far they got', async () => {
    const { w, phone, questionId } = await setup();
    const reserved = await uploadPhoneImage(w, phone, questionId, forAnswer(), {
      until: 'reserve',
    });
    const uploaded = await uploadPhoneImage(w, phone, questionId, forAnswer(), { until: 'put' });
    const completedFor = forMessage();
    const completed = await uploadPhoneImage(w, phone, questionId, completedFor);
    const actionId = newId();
    const kept = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    expect((await answerWith(w, phone, questionId, actionId, [kept])).res.status).toBe(201);

    const jobs = await inRoom((room) =>
      room.q<{ attachment_id: string; run_at: number; question_id: string | null }>(
        `SELECT attachment_id, run_at, question_id FROM scheduled_jobs WHERE kind = 'gc_orphan'`,
      ),
    );
    for (const img of [reserved, uploaded, completed, kept]) {
      const job = jobs.find((j) => j.attachment_id === img.attachmentId)!;
      expect(job.run_at).toBe((await row(img.attachmentId))!.created_at + LIMITS.phoneImageOrphanMs);
      expect(job.question_id).toBeNull();
    }
    expect(await stored(uploaded.attachmentId)).not.toBeNull();
    expect(await stored(completed.attachmentId)).not.toBeNull();

    await runDue('gc_orphan');
    for (const img of [reserved, uploaded, completed]) {
      expect(await row(img.attachmentId)).toMatchObject({ state: 'deleted', object_deleted: 1 });
      expect(await stored(img.attachmentId)).toBeNull();
    }
    // The answered image survives its orphan deadline.
    expect(await row(kept.attachmentId)).toMatchObject({ state: 'available', bound: 1 });
    expect(await stored(kept.attachmentId)).not.toBeNull();
    // A collected image can no longer be bound.
    const late = await say(w, phone, questionId, {
      messageId: completedFor.record_id,
      attachmentIds: [completed.attachmentId],
      images: [completed.ref],
    });
    expect(late.res.status).toBe(400);
  });

  it('keeps a bound image for the retention period from its own commit, whatever the question does', async () => {
    const { w, phone, questionId } = await setup();
    const actionId = newId();
    const answerImage = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    const t0 = Date.now();
    await answerWith(w, phone, questionId, actionId, [answerImage]);
    const bound = (await row(answerImage.attachmentId))!;
    expect(bound.bound_at).toBeGreaterThanOrEqual(t0);
    expect(bound.delete_after).toBe(bound.bound_at! + 30 * 86_400_000);
    const job = await inRoom((room) =>
      room.q1<{ run_at: number; question_id: string | null; status: string }>(
        `SELECT run_at, question_id, status FROM scheduled_jobs WHERE kind = 'delete_phone_image' AND attachment_id = ?`,
        answerImage.attachmentId,
      ),
    );
    expect(job).toEqual({ run_at: bound.delete_after, question_id: null, status: 'pending' });

    // A follow-up's image binds later and keeps its own clock.
    const messageId = newId();
    const followUp = await uploadPhoneImage(w, phone, questionId, forMessage(messageId));
    await say(w, phone, questionId, {
      messageId,
      attachmentIds: [followUp.attachmentId],
      images: [followUp.ref],
    });
    // The question's own retention (scheduled by the answer) leaves both phone images alone.
    await runDue('delete_attachments');
    for (const img of [answerImage, followUp]) {
      expect(await row(img.attachmentId)).toMatchObject({ state: 'available', object_deleted: 0 });
      expect((await download(phone, img.attachmentId)).status).toBe(200);
    }
    // Once its retention has passed an image reads as unavailable, even before the alarm deletes it.
    await inRoom((room) =>
      room.run(
        `UPDATE attachments SET delete_after = ? WHERE attachment_id = ?`,
        Date.now() - 1,
        answerImage.attachmentId,
      ),
    );
    expect((await download(w.owner, answerImage.attachmentId)).status).toBe(404);
    await runDue('delete_phone_image', answerImage.attachmentId);
    expect(await row(answerImage.attachmentId)).toMatchObject({
      state: 'deleted',
      object_deleted: 1,
    });
    expect(await stored(answerImage.attachmentId)).toBeNull();
    // The follow-up's image is still there; the answer's reference stays in its content.
    expect((await download(w.owner, followUp.attachmentId)).status).toBe(200);
    const detail = await question(phone, questionId);
    expect(detail.actions.find((a: any) => a.action === 'answer').record.attachment_ids).toEqual([
      answerImage.attachmentId,
    ]);
  });

  it('keeps retention running when the question is cancelled after an image binds', async () => {
    const { w, phone, questionId } = await setup();
    const messageId = newId();
    const img = await uploadPhoneImage(w, phone, questionId, forMessage(messageId));
    await say(w, phone, questionId, {
      messageId,
      attachmentIds: [img.attachmentId],
      images: [img.ref],
    });
    expect((await act(w, w.owner, 'cancel', questionId, 0)).res.status).toBe(201);
    const job = await inRoom((room) =>
      room.q1<{ status: string }>(
        `SELECT status FROM scheduled_jobs WHERE kind = 'delete_phone_image' AND attachment_id = ?`,
        img.attachmentId,
      ),
    );
    expect(job!.status).toBe('pending');
    expect((await download(w.owner, img.attachmentId)).status).toBe(200);
  });
});

describe('delete', () => {
  it('deleting a question removes its phone images from R2, bound or not', async () => {
    const { w, phone, questionId } = await setup();
    const keep = (await ask(w)).questionId;
    const actionId = newId();
    const bound = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
    await answerWith(w, phone, questionId, actionId, [bound]);
    const unbound = await uploadPhoneImage(w, phone, questionId, forMessage());
    const reserved = await uploadPhoneImage(w, phone, questionId, forMessage(), {
      until: 'reserve',
    });
    const otherActionId = newId();
    const elsewhere = await uploadPhoneImage(w, phone, keep, forAnswer(otherActionId));
    await answerWith(w, phone, keep, otherActionId, [elsewhere]);

    expect((await w.owner.call('DELETE', `/api/v1/questions/${questionId}`)).status).toBe(200);
    await runDurableObjectAlarm(stub());
    await settle();
    for (const img of [bound, unbound, reserved]) {
      expect(await row(img.attachmentId)).toMatchObject({ state: 'deleted' });
      expect(await stored(img.attachmentId)).toBeNull();
      expect((await download(w.owner, img.attachmentId)).status).toBe(404);
    }
    expect((await download(w.owner, elsewhere.attachmentId)).status).toBe(200);
  });

  it.each(['questions', 'everything'] as const)(
    'deleting relay data removes every phone image and reservation (%s)',
    async (scope) => {
      const { w, phone, questionId } = await setup();
      const actionId = newId();
      const bound = await uploadPhoneImage(w, phone, questionId, forAnswer(actionId));
      await answerWith(w, phone, questionId, actionId, [bound]);
      const unbound = await uploadPhoneImage(w, phone, questionId, forMessage());
      const keys = [
        (await row(bound.attachmentId))!.object_key,
        (await row(unbound.attachmentId))!.object_key,
      ];
      const res = await w.owner.call('POST', '/api/v1/admin/delete-data', {
        protocol_version: PROTOCOL_VERSION,
        confirm: 'DELETE',
        scope,
      });
      expect(res.status).toBe(200);
      for (const k of keys) expect(await env.ATTACHMENTS.head(k)).toBeNull();
      const left = await inRoom(
        (room) => room.q1<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments`)!.n,
      );
      expect(left).toBe(0);
    },
  );
});
