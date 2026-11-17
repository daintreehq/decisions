import { describe, expect, it } from 'vitest';
import { buildSignedInvolvement, verifyObject } from '@daintreehq/decisions-crypto';
import type { InvolvementMode, InvolvementRecord } from '@daintreehq/decisions-protocol';
import {
  DecisionsBridge,
  INVOLVEMENT_META,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  revokedKey,
  type InvolvementView,
  type SetInvolvementInput,
} from '../src/index.js';
import { FakeSink, makeHost, makePhone, setupBridge, tick, type Phone } from './helpers.js';

/*
 * The desktop's copy of the person's involvement preference (docs/protocol.md section 20): verified against the
 * pinned device directory, never rolled back, read at start, on reconnect and on each hint, and worked out at
 * every read so a temporary mode ends without anything being written.
 */

const T0 = Date.parse('2026-11-17T09:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function setup() {
  const clock = { t: T0 };
  const env = await setupBridge({ now: () => clock.t });
  const sign = (
    o: {
      revision?: number;
      normal?: InvolvementMode;
      consult?: number;
      override?: { mode: InvolvementMode; until: string } | null;
      by?: Phone;
      installationId?: string;
    } = {},
  ): Promise<InvolvementRecord> => {
    const by = o.by ?? env.phone;
    return buildSignedInvolvement({
      installationId: o.installationId ?? env.identity.config.installationId,
      signerDeviceId: by.deviceId,
      signingKey: by.keys.signing.privateKey,
      revision: o.revision ?? 1,
      normalMode: o.normal ?? 'recommend',
      consultCount: o.consult ?? 3,
      override: o.override ?? null,
      createdAt: iso(clock.t),
    });
  };
  /** The owner desktop running the bridge, as a signer. */
  const owner: Phone = {
    deviceId: env.identity.config.deviceId,
    keys: env.identity.keys,
    cert: env.relay.ownerCert(),
  };
  const serve = (preference: InvolvementRecord | null) => {
    env.relay.involvement = { preference, received_at: preference ? iso(clock.t) : null };
  };
  const reads = () => env.relay.calls.filter((c) => c.path === '/api/v1/involvement').length;
  const view = () => env.bridge.getInvolvement();
  const refusals = async () =>
    (await env.store.listAudit(100))
      .filter((e) => e.event === 'involvement.refused')
      .map((e) => e.result);
  /** Starts without a socket and waits for the first read. */
  const start = async () => {
    await env.bridge.start({ socket: false });
    await env.bridge.involvement.refresh();
  };
  return { ...env, clock, owner, sign, serve, reads, view, refusals, start };
}

const available = (v: InvolvementView) => {
  if (v.status !== 'available') throw new Error(`unavailable: ${v.reason}`);
  return v;
};

describe('reading the preference', () => {
  it('is not-synced before the first read, not-set when nobody has set one', async () => {
    const s = await setup();
    expect(await s.view()).toEqual({
      status: 'unavailable',
      reason: 'not-synced',
      lastSyncedAt: null,
      stale: true,
    });
    await s.start();
    expect(await s.view()).toEqual({
      status: 'unavailable',
      reason: 'not-set',
      lastSyncedAt: iso(T0),
      stale: false,
    });
    await s.bridge.stop();
  });

  it('verifies the phone’s record and reports the preference in force', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 4, normal: 'recommend', consult: 2 }));
    await s.start();
    expect(await s.view()).toEqual({
      status: 'available',
      mode: 'recommend',
      normalMode: 'recommend',
      consultCount: 2,
      revision: 4,
      overrideActive: false,
      until: null,
      setAt: iso(T0),
      lastSyncedAt: iso(T0),
      stale: false,
    });
    await s.bridge.stop();
  });

  it('a temporary mode ends at its time with the same revision, and nothing is read or written for it', async () => {
    const s = await setup();
    const until = iso(T0 + HOUR);
    s.serve(await s.sign({ normal: 'recommend', override: { mode: 'involve-early', until } }));
    await s.start();
    const during = available(await s.view());
    expect(during).toMatchObject({ mode: 'involve-early', overrideActive: true, until });
    const reads = s.reads();
    const stored = await s.store.getMeta(INVOLVEMENT_META);

    s.clock.t = T0 + HOUR - 1;
    expect(available(await s.view()).mode).toBe('involve-early');
    s.clock.t = T0 + HOUR;
    const after = available(await s.view());
    expect(after).toMatchObject({ mode: 'recommend', overrideActive: false, until: null });
    expect(after.revision).toBe(during.revision);
    expect(s.reads()).toBe(reads);
    expect(await s.store.getMeta(INVOLVEMENT_META)).toBe(stored);
    await s.bridge.stop();
  });

  it('picks up a change on the relay’s hint, outside the question path', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 1, normal: 'recommend' }));
    await s.start();
    s.serve(await s.sign({ revision: 2, normal: 'involve-early' }));
    s.relay.push('involvement.updated', null, null, { revision: 2 });
    await s.bridge.catchUp();
    await s.bridge.involvement.refresh();
    expect(available(await s.view())).toMatchObject({ mode: 'involve-early', revision: 2 });
    await s.bridge.stop();
  });

  it('a hint during a read brings one more read, so the change it announced is not missed', async () => {
    const s = await setup();
    await s.start();
    let release!: () => void;
    s.relay.holdInvolvement = new Promise<void>((r) => (release = r));
    s.serve(await s.sign({ revision: 1 }));
    const pending = s.bridge.involvement.refresh();
    await tick(5);
    s.serve(await s.sign({ revision: 2, normal: 'involve-early' }));
    s.bridge.involvement.hint();
    s.relay.holdInvolvement = null;
    release();
    await pending;
    expect(available(await s.view())).toMatchObject({ revision: 2, stale: false });
    await s.bridge.stop();
  });

  it('a skipped revision is fine: the relay keeps only the latest', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 2 }));
    await s.start();
    s.serve(await s.sign({ revision: 7, normal: 'involve-early' }));
    await s.bridge.involvement.refresh();
    expect(available(await s.view()).revision).toBe(7);
    await s.bridge.stop();
  });

  it('survives a restart, stale until the relay confirms it again', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 3 }));
    await s.start();
    await s.bridge.stop();
    const again = new DecisionsBridge({
      identity: s.identity,
      store: s.store,
      sink: new FakeSink(),
      client: s.client,
      policy: new PolicyRegistry(),
      pumpIntervalMs: 0,
      now: () => s.clock.t,
    });
    expect(available(await again.getInvolvement())).toMatchObject({ revision: 3, stale: true });
    await again.start({ socket: false });
    await again.involvement.refresh();
    expect(available(await again.getInvolvement())).toMatchObject({ revision: 3, stale: false });
    await again.stop();
  });
});

describe('what the desktop refuses', () => {
  it('never rolls back to an older revision, and keeps the newer one', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 2, normal: 'involve-early' }));
    await s.start();
    s.serve(await s.sign({ revision: 1, normal: 'recommend' }));
    s.clock.t += 60_000;
    await s.bridge.involvement.refresh();
    expect(available(await s.view())).toMatchObject({
      revision: 2,
      mode: 'involve-early',
      lastSyncedAt: iso(T0),
      stale: true,
    });
    expect(await s.refusals()).toContain('rollback');
    await s.bridge.stop();
  });

  it('refuses a different record at the same revision, and a relay withholding the one it verified', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 2, normal: 'involve-early' }));
    await s.start();
    s.serve(await s.sign({ revision: 2, normal: 'recommend' }));
    await s.bridge.involvement.refresh();
    expect(available(await s.view()).mode).toBe('involve-early');
    s.serve(null);
    await s.bridge.involvement.refresh();
    expect(available(await s.view())).toMatchObject({ mode: 'involve-early', stale: true });
    expect(await s.refusals()).toEqual(expect.arrayContaining(['equivocation', 'withheld']));
    await s.bridge.stop();
  });

  it('refuses a tampered record, one signed by a desktop-host, an unknown device or a second owner, or for another installation', async () => {
    const s = await setup();
    const stranger = await makePhone(s.identity); // certified but never listed by the relay
    const desktop = await makePhone(s.identity, 'desktop-host');
    s.relay.devices.push(desktop.cert);
    // Certified as an owner desktop by the real owner, but not the pinned one: the directory drops it.
    const secondOwner = await makePhone(s.identity, 'owner-desktop');
    s.relay.devices.push(secondOwner.cert);
    const bad: InvolvementRecord[] = [
      { ...(await s.sign()), consult_count: 5 },
      await s.sign({ by: desktop }),
      await s.sign({ by: stranger }),
      await s.sign({ by: secondOwner }),
      await s.sign({ installationId: 'another_installation' }),
    ];
    await s.start();
    for (const r of bad) {
      s.serve(r);
      await s.bridge.involvement.refresh();
      expect(await s.view()).toMatchObject({ status: 'unavailable', stale: true });
    }
    expect(await s.refusals()).toEqual(
      expect.arrayContaining([
        'bad-signature',
        'set-by-disallowed-device',
        'unknown-signer',
        'wrong-installation',
      ]),
    );
    await s.bridge.stop();
  });

  it('a removed phone’s preference steers nothing, until another phone sets a newer one', async () => {
    const s = await setup();
    const tablet = await makePhone(s.identity, 'tablet');
    s.relay.devices.push(tablet.cert);
    s.serve(await s.sign({ revision: 3 }));
    await s.start();
    expect((await s.view()).status).toBe('available');

    // Seen in the ledger: unavailable at once, before any read.
    await s.store.setMeta(revokedKey(s.phone.deviceId), '99');
    expect(await s.view()).toMatchObject({ status: 'unavailable', reason: 'signer-revoked' });

    // Seen in the directory on the next read: still unavailable, and its revision still bars older records.
    s.relay.revokedAt.set(s.phone.deviceId, iso(T0));
    s.bridge.verifier.invalidate();
    await s.bridge.involvement.refresh();
    expect(await s.view()).toMatchObject({ status: 'unavailable', reason: 'signer-revoked' });
    s.serve(await s.sign({ revision: 2, by: tablet }));
    await s.bridge.involvement.refresh();
    expect((await s.view()).status).toBe('unavailable');

    s.serve(await s.sign({ revision: 4, by: tablet, normal: 'involve-early' }));
    await s.bridge.involvement.refresh();
    expect(available(await s.view())).toMatchObject({ revision: 4, mode: 'involve-early' });
    await s.bridge.stop();
  });
});

describe('what a hostile relay cannot do', () => {
  it('a signer removed in the directory is caught on an unchanged record, without a ledger event', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 3 }));
    await s.start();
    expect((await s.view()).status).toBe('available');
    s.relay.revokedAt.set(s.phone.deviceId, iso(T0));
    s.bridge.verifier.invalidate();
    await s.bridge.involvement.refresh(); // the same record again
    expect(await s.view()).toMatchObject({ status: 'unavailable', reason: 'signer-revoked' });
    await s.bridge.stop();
  });

  it('pretending to be an old relay does not let it swap the record at the same revision', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 2, normal: 'involve-early' }));
    await s.start();
    s.relay.involvement = null; // 404, like a relay from before the feature
    await s.bridge.involvement.refresh();
    expect(await s.view()).toMatchObject({ status: 'unavailable', reason: 'unsupported' });
    s.serve(await s.sign({ revision: 2, normal: 'recommend' }));
    await s.bridge.involvement.refresh();
    expect(await s.view()).toMatchObject({ status: 'unavailable', reason: 'unsupported' });
    expect(await s.refusals()).toContain('equivocation');
    // The record it really holds comes back as it was.
    s.serve(JSON.parse((await s.store.getMeta(INVOLVEMENT_META))!).record);
    await s.bridge.involvement.refresh();
    expect(available(await s.view())).toMatchObject({ revision: 2, mode: 'involve-early' });
    await s.bridge.stop();
  });

  it('a record that cannot even be canonicalised is refused and leaves the copy stale', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 1 }));
    await s.start();
    expect((await s.view()).stale).toBe(false);
    s.serve({ ...(await s.sign({ revision: 2 })), note: '\ud800' } as InvolvementRecord);
    const errors: Error[] = [];
    s.bridge.on('error', (e) => errors.push(e));
    await s.bridge.involvement.refresh();
    expect(available(await s.view())).toMatchObject({ revision: 1, stale: true });
    expect(await s.refusals()).toContain('unverifiable');
    expect(errors).toEqual([]);
    await s.bridge.stop();
  });

  it('a read that began before the socket dropped does not call the copy fresh', async () => {
    const s = await setup();
    await s.start();
    let release!: () => void;
    s.relay.holdInvolvement = new Promise<void>((r) => (release = r));
    s.serve(await s.sign({ revision: 1 }));
    const pending = s.bridge.involvement.refresh();
    await tick(5);
    s.bridge.involvement.socketState('backoff');
    s.relay.holdInvolvement = null;
    release();
    await pending;
    expect(available(await s.view())).toMatchObject({ revision: 1, stale: true });
    // Live again: it reads again, even though nothing marked it as needing to.
    s.bridge.involvement.socketState('live');
    await s.bridge.involvement.refresh();
    expect((await s.view()).stale).toBe(false);
    await s.bridge.stop();
  });
});

describe('when the relay cannot say', () => {
  it('a relay from before involvement preferences is unsupported', async () => {
    const s = await setup();
    s.relay.involvement = null;
    await s.start();
    expect(await s.view()).toMatchObject({ status: 'unavailable', reason: 'unsupported' });
    await s.bridge.stop();
  });

  it('an outage keeps the verified copy, marked stale, and the pump reads again later', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 1 }));
    await s.start();
    s.serve(await s.sign({ revision: 2, normal: 'involve-early' }));
    s.relay.down = 1;
    s.clock.t += 60_000;
    await s.bridge.involvement.refresh();
    expect(available(await s.view())).toMatchObject({
      revision: 1,
      stale: true,
      lastSyncedAt: iso(T0),
    });
    const reads = s.reads();
    s.bridge.involvement.retryIfDue(); // too soon
    await tick(5);
    expect(s.reads()).toBe(reads);
    s.clock.t += 15_000;
    await s.bridge.pump();
    await s.bridge.involvement.refresh();
    expect(available(await s.view())).toMatchObject({ revision: 2, stale: false });
    await s.bridge.stop();
  });

  it('a dropped socket makes the copy stale and a live one reads it again', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 1 }));
    await s.start();
    s.bridge.involvement.socketState('backoff');
    expect((await s.view()).stale).toBe(true);
    const reads = s.reads();
    s.bridge.involvement.socketState('live');
    await s.bridge.involvement.refresh();
    expect(s.reads()).toBeGreaterThan(reads);
    expect((await s.view()).stale).toBe(false);
    await s.bridge.stop();
  });

  it('a read still in flight when the bridge stops writes nothing', async () => {
    const s = await setup();
    await s.start();
    let release!: () => void;
    s.relay.holdInvolvement = new Promise<void>((r) => (release = r));
    s.serve(await s.sign({ revision: 1 }));
    const pending = s.bridge.involvement.refresh();
    await tick(5);
    await s.bridge.stop();
    release();
    await pending;
    expect(await s.view()).toMatchObject({ status: 'unavailable', reason: 'not-set' });
  });

  it('a removed desktop reports device-revoked', async () => {
    const s = await setup();
    s.serve(await s.sign());
    await s.start();
    s.relay.push('device.revoked', null, null, {
      device_id: s.identity.config.deviceId,
      key_epoch: 2,
    });
    await s.bridge.catchUp();
    expect(await s.view()).toMatchObject({ status: 'unavailable', reason: 'device-revoked' });
  });
});

/** A started bridge on an enrolled Host of the same owner and relay. */
async function hostBridge(s: Awaited<ReturnType<typeof setup>>) {
  const host = await makeHost(s.identity, s.relay);
  const bridge = new DecisionsBridge({
    identity: host.identity,
    keyStore: host.keyStore,
    store: new MemoryLocalStore(),
    sink: new FakeSink(),
    client: new RelayClient({
      identity: host.identity,
      fetch: s.relay.fetch,
      sleep: async () => {},
      maxRetries: 0,
    }),
    policy: new PolicyRegistry(),
    pumpIntervalMs: 0,
    now: () => s.clock.t,
  });
  await bridge.start({ socket: false });
  await bridge.involvement.refresh();
  return bridge;
}

const preferenceOf = async (b: DecisionsBridge) => {
  const p = await b.getInvolvementPreference();
  if (p.status !== 'available') throw new Error(`unavailable: ${p.reason}`);
  return p;
};

describe('a preference the owner desktop set', () => {
  it('is verified and reported to agents exactly as a phone’s; only the host read says where it was set', async () => {
    const byPhone = await setup();
    byPhone.serve(await byPhone.sign({ revision: 4, normal: 'recommend', consult: 2 }));
    await byPhone.start();
    const byOwner = await setup();
    byOwner.serve(
      await byOwner.sign({ revision: 4, normal: 'recommend', consult: 2, by: byOwner.owner }),
    );
    await byOwner.start();
    const expected: InvolvementView = {
      status: 'available',
      mode: 'recommend',
      normalMode: 'recommend',
      consultCount: 2,
      revision: 4,
      overrideActive: false,
      until: null,
      setAt: iso(T0),
      lastSyncedAt: iso(T0),
      stale: false,
    };
    expect(await byOwner.view()).toEqual(expected);
    expect(await byPhone.view()).toEqual(expected);
    expect(await byOwner.refusals()).toEqual([]);
    expect(await byOwner.bridge.getInvolvementPreference()).toEqual({
      status: 'available',
      normalMode: 'recommend',
      consultCount: 2,
      override: null,
      mode: 'recommend',
      overrideActive: false,
      revision: 4,
      setOn: 'computer',
      setAt: iso(T0),
      lastSyncedAt: iso(T0),
      stale: false,
    });
    expect((await preferenceOf(byPhone.bridge)).setOn).toBe('phone');
    await byOwner.bridge.stop();
    await byPhone.bridge.stop();
  });

  it('is verified on an enrolled Host against the pinned owner', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 2, normal: 'involve-early', by: s.owner }));
    const bridge = await hostBridge(s);
    expect(await bridge.getInvolvement()).toMatchObject({
      status: 'available',
      mode: 'involve-early',
      revision: 2,
      stale: false,
    });
    expect((await preferenceOf(bridge)).setOn).toBe('computer');
    await bridge.stop();
  });

  it('cannot be rolled back, swapped at its revision or withheld', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 3, normal: 'involve-early', by: s.owner }));
    await s.start();
    expect(available(await s.view()).revision).toBe(3);
    for (const r of [
      await s.sign({ revision: 2, normal: 'recommend', by: s.owner }),
      await s.sign({ revision: 3, normal: 'recommend' }),
      null,
    ]) {
      s.serve(r);
      await s.bridge.involvement.refresh();
      expect(available(await s.view())).toMatchObject({
        revision: 3,
        mode: 'involve-early',
        stale: true,
      });
      expect((await preferenceOf(s.bridge)).setOn).toBe('computer');
    }
    expect(await s.refusals()).toEqual(['rollback', 'equivocation', 'withheld']);
    await s.bridge.stop();
  });

  it('a copy kept before the owner desktop could set it reads as set on a phone', async () => {
    const s = await setup();
    const r = await s.sign({ revision: 5 });
    await s.store.setMeta(
      INVOLVEMENT_META,
      JSON.stringify({ record: r, high_water: 5, synced_at: T0 }),
    );
    expect(await s.bridge.getInvolvementPreference()).toMatchObject({
      status: 'available',
      revision: 5,
      setOn: 'phone',
      stale: true,
    });
  });
});

describe('setting it on the owner desktop', () => {
  const choice = (expectedRevision: number, over: Partial<SetInvolvementInput> = {}) =>
    ({
      expectedRevision,
      normalMode: 'involve-early',
      consultCount: 2,
      override: null,
      ...over,
    }) satisfies SetInvolvementInput;

  it('signs the record with the owner’s key and agents read it at once, never below it', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 1 }));
    await s.start();
    const until = iso(T0 + HOUR);
    const result = await s.bridge.setInvolvementPreference(
      choice(1, {
        normalMode: 'recommend',
        consultCount: 4,
        override: { mode: 'involve-early', until },
      }),
    );
    expect(result).toEqual({ status: 'saved', revision: 2 });

    expect(s.relay.involvementPuts).toHaveLength(1);
    const sent = s.relay.involvementPuts[0]!.preference;
    expect(sent).toMatchObject({
      installation_id: s.identity.config.installationId,
      signer_device_id: s.identity.config.deviceId,
      revision: 2,
      normal_mode: 'recommend',
      consult_count: 4,
      override: { mode: 'involve-early', until },
      created_at: iso(T0),
    });
    expect(await verifyObject(s.identity.keys.signing.publicKey, sent)).toBe(true);

    // The copy has it before any read: the relay's next answer only confirms it.
    expect(await s.bridge.getInvolvementPreference()).toMatchObject({
      status: 'available',
      normalMode: 'recommend',
      consultCount: 4,
      override: { mode: 'involve-early', until },
      mode: 'involve-early',
      overrideActive: true,
      revision: 2,
      setOn: 'computer',
      setAt: iso(T0),
    });
    expect(available(await s.view())).toMatchObject({ mode: 'involve-early', until, revision: 2 });

    // A relay serving the older record again is a rollback.
    s.serve(await s.sign({ revision: 1 }));
    await s.bridge.involvement.refresh();
    expect(available(await s.view()).revision).toBe(2);
    expect(await s.refusals()).toContain('rollback');
    await s.bridge.stop();
  });

  it('a Host reads the owner’s save on the relay’s word, verified against the pinned owner', async () => {
    const s = await setup();
    await s.start();
    expect(await s.bridge.setInvolvementPreference(choice(0))).toEqual({
      status: 'saved',
      revision: 1,
    });
    const host = await hostBridge(s);
    expect(await preferenceOf(host)).toMatchObject({
      normalMode: 'involve-early',
      consultCount: 2,
      revision: 1,
      setOn: 'computer',
    });
    await host.stop();
    await s.bridge.stop();
  });

  it('a phone’s save made meanwhile comes back as a conflict, and is never overwritten', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 1, normal: 'involve-early' }));
    await s.start();
    // The person reviewed revision 1 here; a phone saves revision 2 before they press save.
    const phoneSave = await s.sign({ revision: 2, normal: 'recommend', consult: 6 });
    s.serve(phoneSave);
    const result = await s.bridge.setInvolvementPreference(choice(1, { consultCount: 1 }));
    expect(result).toEqual({ status: 'conflict', latestRevision: 2 });
    expect(s.relay.involvement?.preference).toEqual(phoneSave);
    // The copy has been read again, so the UI can show what the phone set.
    expect(await s.bridge.getInvolvementPreference()).toMatchObject({
      status: 'available',
      normalMode: 'recommend',
      consultCount: 6,
      revision: 2,
      setOn: 'phone',
    });
    // Saving again over what the person has now seen goes through.
    expect(await s.bridge.setInvolvementPreference(choice(2, { consultCount: 1 }))).toEqual({
      status: 'saved',
      revision: 3,
    });
    await s.bridge.stop();
  });

  it('a Host is refused before anything is signed or sent', async () => {
    const s = await setup();
    const host = await hostBridge(s);
    await expect(host.setInvolvementPreference(choice(0))).rejects.toMatchObject({
      name: 'BridgeError',
      code: 'forbidden',
    });
    // The relay client refuses it too, before signing a request.
    const record = await s.sign({ revision: 1 });
    await expect(host.ctx.client.putInvolvement('idem_host_00001', record)).rejects.toMatchObject({
      name: 'RelayError',
      code: 'forbidden',
    });
    expect(s.relay.calls.filter((c) => c.method === 'PUT')).toEqual([]);
    await host.stop();
  });

  it('refuses a revoked or stopped bridge and input the relay would refuse, sending nothing', async () => {
    const s = await setup();
    await expect(s.bridge.setInvolvementPreference(choice(0))).rejects.toMatchObject({
      code: 'invalid_state',
    });
    await s.start();
    const bad: unknown[] = [
      choice(0, { consultCount: 0 }),
      choice(0, { consultCount: 9 }),
      choice(-1),
      choice(0, { override: { mode: 'recommend', until: iso(T0) } }),
      choice(0, { override: { mode: 'recommend', until: iso(T0 + 30 * 24 * HOUR + 1) } }),
      choice(0, { override: { mode: 'recommend', until: '2026-11-17T10:00:00Z' } }),
      { ...choice(0), signer_device_id: 'someone_else' },
    ];
    for (const input of bad) {
      await expect(
        s.bridge.setInvolvementPreference(input as SetInvolvementInput),
      ).rejects.toMatchObject({ code: 'validation_error' });
    }
    // Exactly thirty days is the longest a temporary mode may last.
    expect(
      await s.bridge.setInvolvementPreference(
        choice(0, { override: { mode: 'recommend', until: iso(T0 + 30 * 24 * HOUR) } }),
      ),
    ).toEqual({ status: 'saved', revision: 1 });
    expect(s.relay.involvementPuts).toHaveLength(1);

    s.relay.push('device.revoked', null, null, {
      device_id: s.identity.config.deviceId,
      key_epoch: 2,
    });
    await s.bridge.catchUp();
    await expect(s.bridge.setInvolvementPreference(choice(1))).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(s.relay.involvementPuts).toHaveLength(1);
  });

  it('a lost reply is unconfirmed, and the copy picks the save up when the relay answers', async () => {
    const s = await setup();
    await s.start();
    s.relay.dropInvolvementReply = 1;
    const result = await s.bridge.setInvolvementPreference(choice(0));
    expect(result).toMatchObject({ status: 'unconfirmed' });
    await s.bridge.involvement.refresh();
    expect(await s.bridge.getInvolvementPreference()).toMatchObject({
      status: 'available',
      revision: 1,
      setOn: 'computer',
      stale: false,
    });
    await s.bridge.stop();
  });

  it('a relay that does not take preferences, or refuses one, says so', async () => {
    const s = await setup();
    await s.start();
    s.relay.rejectInvolvement.push({ status: 400, code: 'validation_error' });
    expect(await s.bridge.setInvolvementPreference(choice(0))).toEqual({
      status: 'refused',
      code: 'validation_error',
      message: 'no',
    });
    s.relay.involvement = null;
    expect(await s.bridge.setInvolvementPreference(choice(0))).toEqual({
      status: 'unsupported',
    });
    await s.bridge.stop();
  });

  it('a read that began before the save cannot take the copy back below it', async () => {
    const s = await setup();
    s.serve(await s.sign({ revision: 1 }));
    await s.start();
    let release!: () => void;
    s.relay.holdInvolvement = new Promise<void>((r) => (release = r));
    const pending = s.bridge.involvement.refresh(); // the relay answers revision 1, then holds the reply
    await tick();
    s.relay.holdInvolvement = null;
    expect(await s.bridge.setInvolvementPreference(choice(1))).toEqual({
      status: 'saved',
      revision: 2,
    });
    release();
    await pending;
    expect(available(await s.view())).toMatchObject({ revision: 2, stale: false });
    expect(await s.refusals()).toEqual([]);
    await s.bridge.stop();
  });
});
