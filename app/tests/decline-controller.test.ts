// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATOR_MISSING_FEATURE,
  type DeviceInfo,
  type DevicesResponse,
} from '@daintreehq/decisions-protocol';
import { AppController } from '../src/app/controller.js';
import { RelayError } from '../src/data/relay.js';
import { DeclineUnsupportedError } from '../src/domain/answer.js';
import { QuestionStore, type QuestionView } from '../src/domain/model.js';
import { makeWorld, questionEvent } from './helpers.js';

/** The controller's private seams, reached the way its own code reaches them. */
type Inside = {
  patch(p: { devices: DevicesResponse | null }): void;
  keys: unknown;
  relay: unknown;
  snap: { config: unknown };
  refreshDevices(): Promise<void>;
  resume(): void;
};
const inside = (c: AppController) => c as unknown as Inside;

const device = (id: string, o: { features?: string[]; revoked?: boolean } = {}): DeviceInfo =>
  ({
    device_id: id,
    role: 'owner-desktop',
    label: 'Mac',
    revoked_at: o.revoked ? new Date().toISOString() : null,
    ...(o.features ? { features: o.features } : {}),
  }) as unknown as DeviceInfo;

async function openQuestion(): Promise<{
  w: Awaited<ReturnType<typeof makeWorld>>;
  view: QuestionView;
}> {
  const w = await makeWorld();
  const s = new QuestionStore({
    installationId: w.installationId,
    trust: w.trust,
    epochKeys: () => w.epochs,
  });
  const q = await questionEvent(w);
  await s.ingest(q);
  return { w, view: s.get(q.question_id!)! };
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

describe('dismissing a question (docs/protocol.md section 6.1)', () => {
  it('is offered only where the desktop that asked files declines', async () => {
    const { view } = await openQuestion();
    const c = new AppController('https://relay.example');
    const asker = view.originatingDeviceId;
    const withDevices = (devices: DeviceInfo[]) =>
      inside(c).patch({ devices: { devices } as DevicesResponse });

    // Until the device list is read, nothing says the desktop takes a decline.
    expect(c.declinesFor(view)).toBe(false);
    // A desktop that predates declines would keep the question open: no Dismiss.
    withDevices([device(asker)]);
    expect(c.declinesFor(view)).toBe(false);
    withDevices([device(asker, { features: ['thread-messages-v1', 'owner-desktop-answers-v1'] })]);
    expect(c.declinesFor(view)).toBe(false);
    // Another desktop's declaration never counts.
    withDevices([device(asker), device('dev_other00001', { features: ['person-declines-v1'] })]);
    expect(c.declinesFor(view)).toBe(false);
    withDevices([device(asker, { features: ['person-declines-v1'] })]);
    expect(c.declinesFor(view)).toBe(true);
    // A revoked or unknown desktop is sent nothing, so its leftover question can always be let go.
    withDevices([device(asker, { revoked: true })]);
    expect(c.declinesFor(view)).toBe(true);
    withDevices([]);
    expect(c.declinesFor(view)).toBe(true);
  });

  it('reads the device list again when the app comes back, so an upgraded desktop is offered Dismiss', () => {
    const c = new AppController('https://relay.example');
    const refresh = vi.fn(async () => undefined);
    inside(c).refreshDevices = refresh;
    // Not paired yet: there is no relay to ask.
    inside(c).resume();
    expect(refresh).not.toHaveBeenCalled();
    inside(c).relay = {};
    inside(c).resume();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("says plainly when the relay refuses because the asking desktop can't take one", async () => {
    const { w, view } = await openQuestion();
    const c = new AppController('https://relay.example');
    const refresh = vi.fn(async () => undefined);
    inside(c).refreshDevices = refresh;
    inside(c).keys = { signingPrivate: w.phone.keys.signing.privateKey };
    inside(c).snap.config = { installationId: w.installationId, deviceId: w.phone.id };
    const refusal = new RelayError(
      'invalid_state',
      409,
      "the question's desktop does not accept declines",
      {
        reason: CREATOR_MISSING_FEATURE,
        required_feature: 'person-declines-v1',
      },
    );
    inside(c).relay = { jsonRaw: vi.fn(async () => Promise.reject(refusal)) };
    await expect(c.declineQuestion(view, 0)).rejects.toBeInstanceOf(DeclineUnsupportedError);
    expect(refresh).toHaveBeenCalled();

    // Any other failure is passed on as it was.
    const offline = new RelayError('network_error', 0, 'offline');
    inside(c).relay = { jsonRaw: vi.fn(async () => Promise.reject(offline)) };
    await expect(c.declineQuestion(view, 0)).rejects.toBe(offline);
  });
});
