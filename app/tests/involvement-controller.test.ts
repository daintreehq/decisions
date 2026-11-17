// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InfoResponse, InvolvementRecord } from '@daintreehq/decisions-protocol';
import { AppController } from '../src/app/controller.js';
import { InvolvementStore } from '../src/data/involvement.js';

/** The controller's private seams, reached the way its own code reaches them. */
type Inside = {
  patch(p: { info: InfoResponse | null }): void;
  declaredFeatures(): string[];
  involvement: InvolvementStore | null;
  emitInvolvement(): void;
};
const inside = (c: AppController) => c as unknown as Inside;

const info = (features: string[]): InfoResponse => ({
  name: 'daintree-decisions',
  protocol_min: 1,
  protocol_max: 1,
  worker_version: 'test',
  claimed: true,
  claim_configured: true,
  voice: { xai: false, anthropic: false, openai: false },
  features,
});

const record = {
  v: 1,
  type: 'involvement.preference',
  installation_id: 'inst_00000001',
  revision: 2,
  normal_mode: 'recommend',
  consult_count: 3,
  override: null,
  created_at: new Date().toISOString(),
  signer_device_id: 'phone_000001',
  signature: 's'.repeat(86),
} as InvolvementRecord;

/** A loaded store put where boot puts it, wired to the controller's listeners as boot wires it. */
async function withPreference(c: AppController) {
  const s = new InvolvementStore({
    fetch: async () => ({ preference: record, received_at: new Date().toISOString() }),
    put: async () => ({}),
    verify: async () => ({
      ok: true,
      value: { record, receivedAt: null, setBy: { on: 'phone', computer: null, here: false } },
    }),
    sign: async () => record,
  });
  s.subscribe(() => inside(c).emitInvolvement());
  inside(c).involvement = s;
  await s.load();
  return s;
}

// `init` asks the relay for `GET /info`: offline here, so nothing leaves the test.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('the involvement preference in the controller', () => {
  it('is declared, offered and read only once the relay advertises it', async () => {
    const c = new AppController('https://relay.example');
    inside(c).patch({ info: info(['pane-snapshots-v1']) });
    expect(c.involvementServed()).toBe(false);
    expect(inside(c).declaredFeatures()).not.toContain('involvement-v1');
    await withPreference(c);
    await expect(c.loadInvolvement()).rejects.toThrow(/does not keep/);
    inside(c).patch({ info: info(['pane-snapshots-v1', 'involvement-v1']) });
    expect(c.involvementServed()).toBe(true);
    expect(inside(c).declaredFeatures()).toContain('involvement-v1');
    expect((await c.loadInvolvement()).record).toBe(record);
  });

  it('is forgotten when the device is unpaired, and listeners hear it', async () => {
    const c = new AppController('https://relay.example');
    await c.init();
    inside(c).patch({ info: info(['involvement-v1']) });
    const s = await withPreference(c);
    expect(c.involvementState().record).toBe(record);
    const heard = vi.fn();
    c.onInvolvement(heard);
    await c.wipe();
    expect(heard).toHaveBeenCalled();
    expect(s.get()).toMatchObject({ status: 'idle', record: null });
    expect(c.involvementState()).toMatchObject({ status: 'idle', record: null });
    await expect(c.loadInvolvement()).rejects.toThrow();
  });

  it('is forgotten when the device is revoked', async () => {
    const c = new AppController('https://relay.example');
    const s = await withPreference(c);
    c.lockRevoked();
    expect(s.get()).toMatchObject({ status: 'idle', record: null });
    expect(c.getSnapshot().phase).toBe('revoked');
  });
});
