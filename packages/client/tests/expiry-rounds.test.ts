import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '@daintreehq/decisions-protocol';
import { origin, setupBridge } from './helpers.js';

const MIN = 60_000;

/** A bridge on a clock the test moves, with one published question. */
async function asked(input: Record<string, unknown> = {}) {
  let now = Date.now();
  const env = await setupBridge({ now: () => now });
  const r = await env.bridge.registerQuestion({
    origin: origin(),
    input: { question: 'Ship it?', ...input },
  });
  await env.bridge.pump();
  const desktop = { deviceId: env.identity.config.deviceId, keys: env.identity.keys };
  return {
    ...env,
    qid: r.questionId,
    desktop,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    iso(ms: number) {
      return new Date(now + ms).toISOString();
    },
  };
}

describe('a reopen carries its signed deadline into the stored row', () => {
  it('a reopen to never clears the earlier deadline in storage and get_decision', async () => {
    const e = await asked();
    const first = (await e.store.getQuestion(e.qid))!.expires_at;
    expect(first).toBe(new Date(e.now + DEFAULTS.questionExpiryMs).toISOString());
    await e.relay.plainActionEvent({ questionId: e.qid, signer: e.desktop, action: 'cancel' });
    await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: null,
    });
    await e.bridge.catchUp();
    expect((await e.store.getQuestion(e.qid))!.expires_at).toBeNull();
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'open',
      revision: 1,
      expiresAt: null,
    });
  });

  it('a reopen to a later time stores that time', async () => {
    const e = await asked();
    const later = e.iso(30 * MIN);
    await e.relay.plainActionEvent({ questionId: e.qid, signer: e.desktop, action: 'cancel' });
    await e.relay.plainActionEvent({
      questionId: e.qid,
      signer: e.desktop,
      action: 'reopen',
      expiresAt: later,
    });
    await e.bridge.catchUp();
    expect(await e.bridge.getDecision(e.qid)).toMatchObject({
      status: 'open',
      revision: 1,
      expiresAt: later,
    });
  });
});
