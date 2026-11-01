import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { testEnv as env } from './env.js';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { decryptAttachment, sha256Hex, signRequest } from '@daintreehq/decisions-crypto';
import {
  ask,
  claimRelay,
  inRoom,
  pairDevice,
  raw,
  settle,
  stub,
  uploadImage,
  act,
} from './helpers.js';
import { newId } from '@daintreehq/decisions-crypto';

const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...Array.from({ length: 200 }, (_, i) => i & 255),
]);

describe('encrypted attachments', () => {
  it('uploads ciphertext to private R2, publishes it, and a phone decrypts it', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const questionId = newId();
    const up = await uploadImage(w, questionId, PNG);
    expect(up.put.status).toBe(200);
    expect(up.complete!.json).toMatchObject({ state: 'available' });
    // R2 holds ciphertext only
    const row = await inRoom((room) =>
      room.q1<{ object_key: string }>(
        `SELECT object_key FROM attachments WHERE attachment_id = ?`,
        up.attachmentId,
      ),
    );
    expect(row!.object_key).toMatch(/^a\/[0-9a-f]{48}$/);
    const stored = new Uint8Array(
      await (await env.ATTACHMENTS.get(row!.object_key))!.arrayBuffer(),
    );
    expect(stored).toEqual(up.enc.ciphertext);
    expect(Array.from(stored.slice(0, 4))).not.toEqual([0x89, 0x50, 0x4e, 0x47]);
    // question references it
    const { res } = await ask(w, { questionId, attachmentIds: [up.attachmentId] });
    expect(res.status).toBe(201);
    // phone downloads and decrypts
    const path = `/api/v1/attachments/${up.attachmentId}/content`;
    const dl = await exports.default.fetch(
      new Request('https://relay.test' + path, {
        headers: { authorization: await phone.authHeader('GET', path) },
      }),
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get('cache-control')).toBe('no-store');
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');
    const bytes = new Uint8Array(await dl.arrayBuffer());
    const plain = await decryptAttachment(
      phone.epoch,
      { installationId: w.installationId, questionId, attachmentId: up.attachmentId, keyEpoch: 1 },
      up.enc.nonce,
      bytes,
      up.enc.sha256Plaintext,
    );
    expect(plain).toEqual(PNG);
    // a stranger (no signature) cannot download
    expect((await raw('GET', path)).status).toBe(401);
  });

  it('rejects a body whose digest differs from the reservation and stores nothing', async () => {
    const w = await claimRelay();
    const questionId = newId();
    const evil = new Uint8Array(PNG.length + 16).fill(7);
    const up = await uploadImage(w, questionId, PNG, { sendBytes: evil, skipComplete: true });
    expect(up.put.status).toBe(400);
    const row = await inRoom((room) =>
      room.q1<{ object_key: string; state: string }>(
        `SELECT object_key, state FROM attachments WHERE attachment_id = ?`,
        up.attachmentId,
      ),
    );
    expect(row!.state).toBe('reserved');
    expect(await env.ATTACHMENTS.head(row!.object_key)).toBeNull();
  });

  it('rejects wrong length and unauthenticated or foreign uploads', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const questionId = newId();
    const short = await uploadImage(w, questionId, PNG, {
      sendBytes: new Uint8Array(10),
      skipComplete: true,
    });
    expect(short.put.status).toBe(400);
    const up = await uploadImage(w, questionId, PNG, { skipComplete: true });
    expect(up.put.status).toBe(200);
    const path = `/api/v1/attachments/${up.attachmentId}/content`;
    const asPhone = await signRequest({
      method: 'PUT',
      path,
      body: up.enc.ciphertext,
      installationId: w.installationId,
      deviceId: phone.id,
      signingKey: phone.keys.signing.privateKey,
    });
    const r = await raw('PUT', path, {
      body: up.enc.ciphertext,
      headers: {
        authorization: asPhone.authorization,
        'x-content-sha256': up.enc.sha256Ciphertext,
        'content-length': String(up.enc.ciphertext.length),
      },
    });
    expect(r.status).toBe(403);
    expect(
      (
        await raw('PUT', path, {
          body: up.enc.ciphertext,
          headers: {
            'x-content-sha256': up.enc.sha256Ciphertext,
            'content-length': String(up.enc.ciphertext.length),
          },
        })
      ).status,
    ).toBe(401);
  });

  it('a question cannot reference an unavailable, foreign or reused attachment', async () => {
    const w = await claimRelay();
    const qa = newId();
    const pending = await uploadImage(w, qa, PNG, { skipComplete: true });
    expect(
      (await ask(w, { questionId: qa, attachmentIds: [pending.attachmentId] })).res.status,
    ).toBe(400);
    const ok = await uploadImage(w, newId(), PNG);
    expect((await ask(w, { attachmentIds: [ok.attachmentId] })).res.status).toBe(400); // belongs to another question id
    const qb = newId();
    const b = await uploadImage(w, qb, PNG);
    expect((await ask(w, { questionId: qb, attachmentIds: [b.attachmentId] })).res.status).toBe(
      201,
    );
    // same question id with different (freshly encrypted) content is a collision, never a silent overwrite
    expect((await ask(w, { questionId: qb, attachmentIds: [b.attachmentId] })).res.status).toBe(
      409,
    );
    void decryptAttachment;
    void sha256Hex;
  });

  it('enforces count and size limits at reservation', async () => {
    const w = await claimRelay();
    const questionId = newId();
    const reserve = (n: number, attachmentId = newId()) =>
      w.owner.call('POST', '/api/v1/attachments/reservations', {
        protocol_version: 1,
        idempotency_key: newId(),
        question_id: questionId,
        attachment_id: attachmentId,
        ciphertext_bytes: n,
        sha256_ciphertext: 'a'.repeat(64),
        mime_category: 'image',
      });
    expect((await reserve(21 * 1024 * 1024)).status).toBe(400);
    for (let i = 0; i < 8; i++) expect((await reserve(1000)).status).toBe(201);
    expect((await reserve(1000)).status).toBe(413);
    const dupId = newId();
    expect((await reserve(1000, dupId)).status).toBe(413);
  });

  it('garbage-collects unbound uploads and deletes bound ones after retention', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const orphan = await uploadImage(w, newId(), PNG);
    const bound = await uploadImage(w, newId(), PNG);
    const qid = (await inRoom((room) =>
      room.q1<{ question_id: string }>(
        `SELECT question_id FROM attachments WHERE attachment_id = ?`,
        bound.attachmentId,
      ),
    ))!.question_id;
    await ask(w, { questionId: qid, attachmentIds: [bound.attachmentId] });
    const keyOf = (id: string) =>
      inRoom((room) =>
        room.q1<{ object_key: string }>(
          `SELECT object_key FROM attachments WHERE attachment_id = ?`,
          id,
        ),
      )!.then((r) => r!.object_key);
    // orphan GC fires at +2h
    await inRoom((room) =>
      room.run(`UPDATE scheduled_jobs SET run_at = ? WHERE kind = 'gc_orphan'`, Date.now() - 1),
    );
    await runDurableObjectAlarm(stub());
    await settle();
    expect(await env.ATTACHMENTS.head(await keyOf(orphan.attachmentId))).toBeNull();
    expect(await env.ATTACHMENTS.head(await keyOf(bound.attachmentId))).not.toBeNull(); // bound survives
    // an open question keeps its images; answering schedules deletion
    await inRoom((room) =>
      room.run(
        `UPDATE scheduled_jobs SET run_at = ? WHERE kind = 'delete_attachments'`,
        Date.now() - 1,
      ),
    );
    await runDurableObjectAlarm(stub());
    await settle();
    expect(await env.ATTACHMENTS.head(await keyOf(bound.attachmentId))).not.toBeNull();
    await act(w, phone, 'answer', qid, 0);
    await inRoom((room) =>
      room.run(
        `UPDATE scheduled_jobs SET run_at = ? WHERE kind = 'delete_attachments' AND status = 'pending'`,
        Date.now() - 1,
      ),
    );
    await runDurableObjectAlarm(stub());
    await settle();
    await runDurableObjectAlarm(stub());
    await settle();
    expect(await env.ATTACHMENTS.head(await keyOf(bound.attachmentId))).toBeNull();
    const st = await inRoom((room) =>
      room.q1<{ state: string }>(
        `SELECT state FROM attachments WHERE attachment_id = ?`,
        bound.attachmentId,
      ),
    );
    expect(st!.state).toBe('deleted');
    // running the retention job twice is harmless
    await inRoom((room) =>
      room.run(
        `UPDATE scheduled_jobs SET status = 'pending', run_at = ? WHERE kind = 'delete_attachments'`,
        Date.now() - 1,
      ),
    );
    await runDurableObjectAlarm(stub());
    await settle();
  });
});
