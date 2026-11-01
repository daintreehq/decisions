import { describe, expect, it } from 'vitest';
import {
  openEpochGrant,
  importEpochKey,
  decryptEnvelope,
  encryptEnvelope,
  newId,
} from '@daintree/decisions-crypto';
import { act, ask, claimRelay, events, pairDevice } from './helpers.js';
import { buildRotation } from './devices.helpers.js';

describe('revocation and epoch rotation', () => {
  it('revoking blocks the device immediately, removes push subscriptions and rotates the key', async () => {
    const w = await claimRelay();
    const keep = await pairDevice(w, 'phone', 'Keeper');
    const lose = await pairDevice(w, 'tablet', 'Lost iPad');
    const { body, raw, epoch } = await buildRotation(w, [keep]);
    const r = await w.owner.call('POST', `/api/v1/devices/${lose.id}/revoke`, body);
    expect(r.status).toBe(200);
    expect((await lose.call('GET', '/api/v1/devices')).status).toBe(401);
    expect((await lose.call('GET', '/api/v1/events')).status).toBe(401);
    // the remaining device keeps working and can fetch + open the new grant
    const grants = await keep.call('GET', `/api/v1/devices/${keep.id}/key-grants`);
    expect(grants.json.current_epoch).toBe(2);
    expect(grants.json.grants.map((g: any) => g.key_epoch)).toEqual([1, 2]);
    const opened = await openEpochGrant({
      grant: grants.json.grants[1],
      ownerSigningPublicKey: w.owner.keys.signing.publicKey,
      exchangePrivateKey: keep.keys.exchange.privateKey,
      expectedInstallationId: w.installationId,
      expectedDeviceId: keep.id,
    });
    // new content written under the new epoch is readable by the keeper only
    w.epoch = epoch;
    void raw;
    void importEpochKey;
    const types = (await events(keep)).map((e) => e.event_type);
    expect(types).toContain('device.revoked');
    expect(types).toContain('device.key_rotated');
    const info = await keep.call('GET', '/api/v1/devices');
    expect(info.json.key_epoch).toBe(2);
    expect(info.json.devices.find((d: any) => d.device_id === lose.id).revoked_at).toBeTruthy(); // cert kept for history
    const env = await encryptEnvelope({
      epochKey: epoch,
      installationId: w.installationId,
      questionId: newId(),
      recordId: newId(),
      recordType: 'question',
      revision: 0,
      senderDeviceId: w.owner.id,
      purpose: 'question-content',
      plaintext: { q: 'new epoch' },
    });
    expect(await decryptEnvelope(env, new Map([[2, opened]]))).toEqual({ q: 'new epoch' });
    await expect(decryptEnvelope(env, new Map([[1, lose.epoch]]))).rejects.toThrow();
  });

  it('refuses incomplete, extra or mis-signed grant sets', async () => {
    const w = await claimRelay();
    const a = await pairDevice(w, 'phone', 'A');
    const b = await pairDevice(w, 'phone', 'B');
    const victim = await pairDevice(w, 'tablet', 'C');
    const miss = await buildRotation(w, [a]); // forgot b
    expect(
      (await w.owner.call('POST', `/api/v1/devices/${victim.id}/revoke`, miss.body)).status,
    ).toBe(400);
    const extra = await buildRotation(w, [a, b, victim]); // includes the revoked device
    expect(
      (await w.owner.call('POST', `/api/v1/devices/${victim.id}/revoke`, extra.body)).status,
    ).toBe(400);
    const wrongEpoch = await buildRotation(w, [a, b]);
    expect(
      (
        await w.owner.call('POST', `/api/v1/devices/${victim.id}/revoke`, {
          ...wrongEpoch.body,
          new_key_epoch: 5,
        })
      ).status,
    ).toBe(400);
    // grants signed by a phone key rather than the owner
    const forged = await buildRotation(w, [a, b]);
    const bad = await buildRotation({ ...w, owner: a } as never, [a, b]);
    expect(
      (
        await w.owner.call('POST', `/api/v1/devices/${victim.id}/revoke`, {
          ...forged.body,
          grants: bad.body.grants,
        })
      ).status,
    ).toBe(400);
    expect((await victim.call('GET', '/api/v1/devices')).status).toBe(200); // still active: nothing was applied
  });

  it('the owner cannot be revoked, phones cannot revoke, and revoke is not repeatable', async () => {
    const w = await claimRelay();
    const a = await pairDevice(w, 'phone', 'A');
    const b = await pairDevice(w, 'phone', 'B');
    const rot = await buildRotation(w, [b]);
    expect((await a.call('POST', `/api/v1/devices/${b.id}/revoke`, rot.body)).status).toBe(403);
    expect(
      (await w.owner.call('POST', `/api/v1/devices/${w.owner.id}/revoke`, rot.body)).status,
    ).toBe(403);
    expect((await w.owner.call('POST', `/api/v1/devices/${a.id}/revoke`, rot.body)).status).toBe(
      200,
    );
    const again = await buildRotation({ ...w, epoch: rot.epoch } as never, [b]);
    expect((await w.owner.call('POST', `/api/v1/devices/${a.id}/revoke`, again.body)).status).toBe(
      409,
    );
  });

  it('an in-flight answer from a just-revoked device is rejected', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { questionId } = await ask(w);
    const rot = await buildRotation(w, []);
    await w.owner.call('POST', `/api/v1/devices/${phone.id}/revoke`, rot.body);
    expect((await act(w, phone, 'answer', questionId, 0)).res.status).toBe(401);
  });

  it('manual rotation requires exactly the active non-owner devices', async () => {
    const w = await claimRelay();
    const a = await pairDevice(w);
    const rot = await buildRotation(w, [a]);
    expect((await w.owner.call('POST', '/api/v1/epoch/rotate', rot.body)).status).toBe(200);
    expect((await a.call('GET', `/api/v1/devices/${a.id}/key-grants`)).json.grants).toHaveLength(2);
    expect((await w.owner.call('POST', '/api/v1/epoch/rotate', rot.body)).status).toBe(400); // epoch already advanced
  });
});

describe('desktop-host enrollment', () => {
  async function enroll(w: Awaited<ReturnType<typeof claimRelay>>) {
    const { Actor } = await import('./helpers.js');
    const { issueDeviceCert, createEpochGrant } = await import('@daintree/decisions-crypto');
    const host = await Actor.create('desktop-host', 'Remote Host');
    host.installationId = w.installationId;
    const cert = await issueDeviceCert({
      issuerDeviceId: w.owner.id,
      issuerSigningKey: w.owner.keys.signing.privateKey,
      installationId: w.installationId,
      deviceId: host.id,
      role: 'desktop-host',
      label: 'Remote Host',
      signingPub: host.signingPub,
      exchangePub: host.exchangePub,
    });
    const grant = await createEpochGrant({
      issuerDeviceId: w.owner.id,
      issuerSigningKey: w.owner.keys.signing.privateKey,
      installationId: w.installationId,
      recipientDeviceId: host.id,
      recipientExchangePub: host.exchangePub,
      epoch: 1,
      epochKeyRaw: w.epochRaw,
    });
    const res = await w.owner.call('POST', '/api/v1/devices/enroll-host', {
      protocol_version: 1,
      cert,
      grant,
    });
    return { host, cert, grant, res };
  }

  it('lets an enrolled host create questions and proxy-answer, but never answer as a human', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { host, res } = await enroll(w);
    expect(res.status).toBe(201);
    // the host's own key opens the epoch grant, and it can sign questions for its own host id
    const q = await (
      await import('./helpers.js')
    ).ask({ ...w, owner: host } as never, { host: 'host_remote001', requirement: 'proxy-ok' });
    expect(q.res.status).toBe(201);
    const proxy = await act({ ...w, owner: host } as never, host, 'proxy-answer', q.questionId, 0, {
      content: {
        selected_option_ids: ['approve'],
        model_id: 'm',
        prompt_template_version: '1',
        confidence: 0.9,
      },
    });
    expect(proxy.res.status).toBe(201);
    expect((await act(w, host, 'override', q.questionId, 1)).res.status).toBe(403);
    expect((await host.call('POST', '/api/v1/pairing/invitations', {})).status).toBe(403);
    expect((await host.call('POST', `/api/v1/devices/${phone.id}/revoke`, {})).status).toBe(403);
    expect((await act(w, host, 'reopen', q.questionId, 1, { content: null })).res.status).toBe(403);
  });

  it('is owner-only and rejects wrong roles, stale epochs and duplicate ids', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const first = await enroll(w);
    expect(first.res.status).toBe(201);
    expect(
      (
        await w.owner.call('POST', '/api/v1/devices/enroll-host', {
          protocol_version: 1,
          cert: first.cert,
          grant: first.grant,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await phone.call('POST', '/api/v1/devices/enroll-host', {
          protocol_version: 1,
          cert: first.cert,
          grant: first.grant,
        })
      ).status,
    ).toBe(403);
    const rot = await buildRotation(w, [phone, first.host]);
    expect((await w.owner.call('POST', '/api/v1/epoch/rotate', rot.body)).status).toBe(200);
    const stale = await enroll(w);
    expect(stale.res.status).toBe(409); // grant sealed to epoch 1 after rotation
  });

  it('a revoked host is locked out and the rotation must cover remaining hosts', async () => {
    const w = await claimRelay();
    const phone = await pairDevice(w);
    const { host } = await enroll(w);
    const missing = await buildRotation(w, [phone]); // forgot the host
    expect(
      (await w.owner.call('POST', `/api/v1/devices/${phone.id}/revoke`, missing.body)).status,
    ).toBe(400);
    const ok = await buildRotation(w, [host]);
    expect((await w.owner.call('POST', `/api/v1/devices/${phone.id}/revoke`, ok.body)).status).toBe(
      200,
    );
    const rot = await buildRotation({ ...w, epoch: ok.epoch } as never, []);
    expect((await w.owner.call('POST', `/api/v1/devices/${host.id}/revoke`, rot.body)).status).toBe(
      200,
    );
    expect((await host.call('GET', '/api/v1/devices')).status).toBe(401);
  });
});
