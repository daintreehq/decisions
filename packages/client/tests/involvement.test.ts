import { describe, expect, it } from 'vitest';
import { buildSignedInvolvement } from '@daintreehq/decisions-crypto';
import type { InvolvementMode, InvolvementRecord } from '@daintreehq/decisions-protocol';
import {
  DecisionsBridge,
  INVOLVEMENT_META,
  PolicyRegistry,
  revokedKey,
  type InvolvementView,
} from '../src/index.js';
import { FakeSink, makePhone, setupBridge, tick, type Phone } from './helpers.js';

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
  return { ...env, clock, sign, serve, reads, view, refusals, start };
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

  it('refuses a tampered record, one signed by a desktop, an unknown device or for another installation', async () => {
    const s = await setup();
    const stranger = await makePhone(s.identity); // certified but never listed by the relay
    const desktop = await makePhone(s.identity, 'desktop-host');
    s.relay.devices.push(desktop.cert);
    const bad: InvolvementRecord[] = [
      { ...(await s.sign()), consult_count: 5 },
      await s.sign({ by: desktop }),
      await s.sign({ by: stranger }),
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
        'set-by-non-human-device',
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
