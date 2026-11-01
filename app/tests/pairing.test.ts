import { describe, expect, it } from 'vitest';
import type { PairingInvitePayload } from '@daintree/decisions-protocol';
import {
  createEpochGrant,
  decryptEnvelope,
  encryptEnvelope,
  exportPublicKey,
  generateDeviceKeys,
  generatePairingSecret,
  inviteDigest,
  issueDeviceCert,
  newId,
  pairingShortCode,
  sha256Hex,
  verifyPairingPop,
} from '@daintree/decisions-crypto';
import { base64UrlToBytes } from '@daintree/decisions-protocol';
import { Db } from '../src/data/db.js';
import { checkInvite, PairingError, runPairing, type PairingPhase } from '../src/data/pairing.js';
import { makeWorld, type World } from './helpers.js';

const ORIGIN = 'https://relay.example';
let n = 0;

interface Opts {
  mitmOwnerCert?: boolean;
  /** Same installation and device ids as the real owner, but the attacker's own key (self-signed). */
  mitmSameIds?: boolean;
  wrongCode?: boolean;
  badCertSigner?: boolean;
  reject?: boolean;
  flaky?: boolean;
}

async function setup(opts: Opts = {}) {
  const w = await makeWorld();
  const other = opts.mitmOwnerCert || opts.badCertSigner ? await makeWorld() : null;
  const attacker = opts.mitmSameIds ? await generateDeviceKeys(true) : null;
  const forgedOwner = attacker
    ? await issueDeviceCert({
        issuerDeviceId: w.owner.id,
        issuerSigningKey: attacker.signing.privateKey,
        installationId: w.installationId,
        deviceId: w.owner.id,
        role: 'owner-desktop',
        label: 'owner',
        signingPub: await exportPublicKey(attacker.signing.publicKey),
        exchangePub: await exportPublicKey(attacker.exchange.publicKey),
      })
    : null;
  const secret = generatePairingSecret();
  const digest = await inviteDigest(secret);
  const invite: PairingInvitePayload = {
    v: 1,
    o: ORIGIN,
    i: w.installationId,
    p: newId(),
    s: secret,
    e: Date.now() + 120_000,
    k: w.owner.signingPub,
    d: w.owner.id,
    r: 'phone',
  };
  let candidate: {
    device_id: string;
    label: string;
    signing_pub: string;
    exchange_pub: string;
  } | null = null;
  let approved: { cert: unknown; grant: unknown } | null = null;
  const calls: string[] = [];
  let statusCalls = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method} ${path}`);
    if (path === '/api/v1/pairing/candidates') {
      const b = JSON.parse(String(init!.body));
      if ((await sha256Hex(base64UrlToBytes(b.secret))) !== digest)
        return json({ code: 'forbidden', message: 'bad secret' }, 403);
      const ok = await verifyPairingPop(b.pop, {
        pairingId: b.pairing_id,
        deviceId: b.device_id,
        exchangePub: b.exchange_pub,
        signingPub: b.signing_pub,
      });
      if (!ok) return json({ code: 'forbidden', message: 'bad pop' }, 403);
      candidate = b;
      const code = await pairingShortCode({
        pairingId: b.pairing_id,
        signingPub: b.signing_pub,
        exchangePub: b.exchange_pub,
      });
      return json({
        pairing_id: b.pairing_id,
        short_code: opts.wrongCode ? '000 000' : code,
        expires_at: new Date(Date.now() + 120_000).toISOString(),
        owner_cert: forgedOwner ?? (opts.mitmOwnerCert ? other!.owner.cert : w.owner.cert),
        installation_id: w.installationId,
      });
    }
    if (path === `/api/v1/pairing/${invite.p}/status`) {
      statusCalls++;
      if (opts.flaky && statusCalls === 1) throw new TypeError('network down');
      const base = {
        short_code: '123 456',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        owner_cert: w.owner.cert,
      };
      if (opts.reject) return json({ ...base, state: 'rejected', cert: null, grant: null });
      if (!approved) return json({ ...base, state: 'pending-approval', cert: null, grant: null });
      return json({ ...base, state: 'approved', ...approved });
    }
    return json({ code: 'not_found', message: 'nope' }, 404);
  }) as unknown as typeof fetch;

  const approve = async () => {
    const issuer = opts.badCertSigner ? other!.owner : w.owner;
    const cert = await issueDeviceCert({
      issuerDeviceId: w.owner.id,
      issuerSigningKey: issuer.keys.signing.privateKey,
      installationId: w.installationId,
      deviceId: candidate!.device_id,
      role: 'phone',
      label: candidate!.label,
      signingPub: candidate!.signing_pub,
      exchangePub: candidate!.exchange_pub,
    });
    const grant = await createEpochGrant({
      issuerDeviceId: w.owner.id,
      issuerSigningKey: w.owner.keys.signing.privateKey,
      installationId: w.installationId,
      recipientDeviceId: candidate!.device_id,
      recipientExchangePub: candidate!.exchange_pub,
      epoch: 1,
      epochKeyRaw: w.epochRaw,
    });
    approved = { cert, grant };
  };
  const db = await Db.open(`pair-${++n}-${Math.random().toString(36).slice(2)}`);
  return { w, invite, fetchImpl, approve, calls, db };
}

async function run(
  s: Awaited<ReturnType<typeof setup>>,
  extra: Partial<Parameters<typeof runPairing>[0]> = {},
  approveAfter = 2,
) {
  const phases: PairingPhase[] = [];
  let polls = 0;
  const promise = runPairing({
    invite: s.invite,
    expectedOrigin: ORIGIN,
    label: 'Test phone',
    db: s.db,
    fetchImpl: s.fetchImpl,
    onPhase: (p) => phases.push(p),
    sleep: async () => {
      polls++;
      if (polls === approveAfter) await s.approve();
    },
    ...extra,
  });
  return { promise, phases };
}

describe('pairing handshake', () => {
  it('walks register → show code → await approval → verify → persist', async () => {
    const s = await setup();
    const { promise, phases } = await run(s);
    const bundle = await promise;

    expect(phases.map((p) => p.phase)).toEqual([
      'registering',
      'awaiting-approval',
      'finalizing',
      'done',
    ]);
    const waiting = phases.find((p) => p.phase === 'awaiting-approval') as Extract<
      PairingPhase,
      { phase: 'awaiting-approval' }
    >;
    expect(waiting.shortCode).toMatch(/^\d{3} \d{3}$/);

    // Everything was stored together, including the pinned owner and a usable content key.
    const cfg = await s.db.getConfig();
    expect(cfg).toMatchObject({
      relayOrigin: ORIGIN,
      installationId: s.w.installationId,
      role: 'phone',
      label: 'Test phone',
    });
    expect(cfg!.ownerCert.signing_pub).toBe(s.w.owner.signingPub);
    expect((await s.db.certs()).map((c) => c.device_id).sort()).toEqual(
      [s.w.owner.id, cfg!.deviceId].sort(),
    );
    expect(bundle.keys.signingPrivate.extractable).toBe(false);
    expect(bundle.keys.exchangePrivate.extractable).toBe(false);
    expect(bundle.epoch.key.extractable).toBe(false);

    const [epoch] = await s.db.epochKeys();
    const env = await encryptEnvelope({
      epochKey: s.w.epoch,
      installationId: s.w.installationId,
      questionId: 'question_aaaa',
      recordId: 'record_aaaa',
      recordType: 'question',
      revision: 0,
      senderDeviceId: s.w.owner.id,
      purpose: 'question-content',
      plaintext: { hi: 1 },
    });
    expect(
      await decryptEnvelope(
        env,
        new Map([[epoch!.epoch, { epoch: epoch!.epoch, key: epoch!.key }]]),
      ),
    ).toEqual({ hi: 1 });
    expect(s.calls[0]).toBe('POST /api/v1/pairing/candidates');
  });

  it('survives a transient network error while polling', async () => {
    const s = await setup({ flaky: true });
    const { promise } = await run(s, {}, 3);
    await expect(promise).resolves.toBeTruthy();
  });

  it('refuses an invite for another relay without any network call', async () => {
    const s = await setup();
    expect(() =>
      checkInvite({ ...s.invite, o: 'https://evil.example' }, ORIGIN, Date.now()),
    ).toThrow(/different relay/);
    const { promise } = await run(s, { invite: { ...s.invite, o: 'https://evil.example' } });
    await expect(promise).rejects.toBeInstanceOf(PairingError);
    expect(s.calls).toHaveLength(0);
  });

  it('refuses an expired invite', async () => {
    const s = await setup();
    const { promise } = await run(s, { invite: { ...s.invite, e: Date.now() - 1 } });
    await expect(promise).rejects.toThrow(/expired/);
    expect(s.calls).toHaveLength(0);
  });

  it('stops if the relay presents a different owner than the QR code pinned', async () => {
    const s = await setup({ mitmOwnerCert: true });
    const { promise } = await run(s);
    await expect(promise).rejects.toThrow(/does not match your QR code/);
    expect(await s.db.getConfig()).toBeUndefined();
  });

  it('stops if the relay swaps in an attacker key under the real owner’s ids', async () => {
    const s = await setup({ mitmSameIds: true });
    const { promise } = await run(s);
    await expect(promise).rejects.toThrow(/does not match your QR code/);
    expect(await s.db.getConfig()).toBeUndefined();
  });

  it('stops if the confirmation code is not the one both sides compute', async () => {
    const s = await setup({ wrongCode: true });
    const { promise } = await run(s);
    await expect(promise).rejects.toThrow(/confirmation code/);
    expect(await s.db.getConfig()).toBeUndefined();
  });

  it('stops if the device certificate was not signed by the pinned owner key', async () => {
    const s = await setup({ badCertSigner: true });
    const { promise } = await run(s);
    await expect(promise).rejects.toThrow(/not signed by your computer/);
    expect(await s.db.getConfig()).toBeUndefined();
    expect(await s.db.epochKeys()).toHaveLength(0);
  });

  it('reports a decline', async () => {
    const s = await setup({ reject: true });
    const { promise, phases } = await run(s);
    await expect(promise).rejects.toThrow(/declined/);
    expect(phases.at(-1)).toMatchObject({ phase: 'error' });
  });

  it('can be cancelled while waiting', async () => {
    const s = await setup();
    const ctl = new AbortController();
    const { promise } = await run(s, { signal: ctl.signal, sleep: async () => ctl.abort() });
    await expect(promise).rejects.toThrow(/cancelled/);
    expect(await s.db.getConfig()).toBeUndefined();
  });

  it('times out if nobody approves', async () => {
    const s = await setup();
    let t = Date.now();
    const { promise } = await run(s, { now: () => t, sleep: async () => void (t += 120_000) }, 999);
    await expect(promise).rejects.toThrow(/timed out/);
  });
});

describe('invite validation', () => {
  it('rejects versions and roles it does not understand', async () => {
    const s = await setup();
    expect(() => checkInvite({ ...s.invite, v: 2 as 1 }, ORIGIN, Date.now())).toThrow(
      /newer version/,
    );
    expect(() =>
      checkInvite({ ...s.invite, r: 'owner-desktop' as 'phone' }, ORIGIN, Date.now()),
    ).toThrow(/role/);
    expect(() => checkInvite(s.invite, `${ORIGIN}/`, Date.now())).not.toThrow();
    void (null as unknown as World);
  });
});
