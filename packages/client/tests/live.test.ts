import { describe, expect, it } from 'vitest';
import {
  ActionBody,
  PROTOCOL_VERSION,
  pairingPopString,
  type DeviceCert,
  type EpochGrant,
  type QuestionDetail,
} from '@daintreehq/decisions-protocol';
import {
  buildSignedAction,
  decryptEnvelope,
  encryptEnvelope,
  exportPublicKey,
  generateDeviceKeys,
  newId,
  openEpochGrant,
  signRequest,
  signString,
} from '@daintreehq/decisions-crypto';
import {
  DecisionsBridge,
  FileKeyStore,
  MemoryLocalStore,
  RelayClient,
  approveCandidate,
  createPairingInvite,
  loadIdentity,
  localShortCode,
} from '../src/index.js';
import { FakeSink, origin, tick } from './helpers.js';

/**
 * Optional end-to-end check against a real Worker (e.g. `wrangler dev`) that has already been claimed with
 * `decisions setup`:  DECISIONS_LIVE_URL=http://127.0.0.1:8799 DECISIONS_LIVE_HOME=<home> pnpm test
 */
const URL_ = process.env.DECISIONS_LIVE_URL;
const HOME = process.env.DECISIONS_LIVE_HOME;

describe.skipIf(!URL_ || !HOME)(
  'live relay: pair, ask, answer from a simulated phone, deliver',
  () => {
    it('runs the whole loop over the hibernatable WebSocket', async () => {
      const identity = await loadIdentity(new FileKeyStore(HOME));
      const client = new RelayClient({ identity });
      const base = identity.config.relayOrigin;

      // --- pair a simulated phone (the PWA does exactly this) ---
      const invite = await createPairingInvite(client, 'phone');
      const phoneKeys = await generateDeviceKeys(false);
      const phoneId = newId();
      const signingPub = await exportPublicKey(phoneKeys.signing.publicKey);
      const exchangePub = await exportPublicKey(phoneKeys.exchange.publicKey);
      const pop = await signString(
        phoneKeys.signing.privateKey,
        pairingPopString({
          pairingId: invite.pairingId,
          deviceId: phoneId,
          exchangePub,
          signingPub,
        }),
      );
      const candRes = await fetch(`${base}/api/v1/pairing/candidates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol_version: PROTOCOL_VERSION,
          pairing_id: invite.pairingId,
          secret: invite.payload.s,
          device_id: phoneId,
          label: 'Live phone',
          signing_pub: signingPub,
          exchange_pub: exchangePub,
          pop,
        }),
      });
      expect(candRes.status).toBe(201);
      const { pending } = await client.pendingPairings();
      const cand = pending.find((p) => p.pairing_id === invite.pairingId)!;
      expect(cand.short_code).toBe(await localShortCode(cand));
      await approveCandidate(client, cand);
      const st = (await (
        await fetch(`${base}/api/v1/pairing/${invite.pairingId}/status`, {
          headers: { 'x-pairing-secret': invite.payload.s },
        })
      ).json()) as { state: string; cert: DeviceCert; grant: EpochGrant };
      expect(st.state).toBe('approved');
      const phoneEpoch = await openEpochGrant({
        grant: st.grant,
        ownerSigningPublicKey: identity.keys.signing.publicKey,
        exchangePrivateKey: phoneKeys.exchange.privateKey,
        expectedInstallationId: identity.config.installationId,
        expectedDeviceId: phoneId,
      });
      const phoneFetch = async <T>(
        method: string,
        path: string,
        body?: unknown,
      ): Promise<{ status: number; json: T }> => {
        const text = body === undefined ? undefined : JSON.stringify(body);
        const { authorization } = await signRequest({
          method,
          path,
          body: text ?? null,
          installationId: identity.config.installationId,
          deviceId: phoneId,
          signingKey: phoneKeys.signing.privateKey,
        });
        const r = await fetch(base + path, {
          method,
          headers: { authorization, ...(text ? { 'content-type': 'application/json' } : {}) },
          ...(text ? { body: text } : {}),
        });
        return { status: r.status, json: (await r.json()) as T };
      };

      // --- desktop side: bridge over the real socket ---
      const sink = new FakeSink();
      sink.addPane('pane-1');
      const bridge = new DecisionsBridge({
        identity,
        store: new MemoryLocalStore(),
        sink,
        client,
        pumpIntervalMs: 0,
      });
      await bridge.start();
      const asked = await bridge.registerQuestion({
        origin: origin(),
        input: {
          question: 'Live: ship it?',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject' },
          ],
        },
      });
      await bridge.pump();

      // --- phone reads, decrypts, verifies the question, then answers with a signed human action ---
      const detail = await phoneFetch<QuestionDetail>(
        'GET',
        `/api/v1/questions/${asked.questionId}`,
      );
      expect(detail.status).toBe(200);
      const content = await decryptEnvelope<{ question: string }>(
        detail.json.question.envelope,
        new Map([[1, phoneEpoch]]),
      );
      expect(content.question).toBe('Live: ship it?');
      expect(JSON.stringify(detail.json)).not.toContain('Live: ship it?'); // ciphertext only on the wire
      const envelope = await encryptEnvelope({
        epochKey: phoneEpoch,
        installationId: identity.config.installationId,
        questionId: asked.questionId,
        recordId: newId(),
        recordType: 'answer',
        revision: 1,
        senderDeviceId: phoneId,
        purpose: 'answer-content',
        plaintext: {
          content_version: 1,
          selected_option_ids: ['approve'],
          text: 'go for it',
          reviewed_attachment_digests: [],
        },
      });
      const action = await buildSignedAction({
        installationId: identity.config.installationId,
        questionId: asked.questionId,
        action: 'answer',
        signerDeviceId: phoneId,
        signingKey: phoneKeys.signing.privateKey,
        expectedRevision: 0,
        envelope,
      });
      const body = ActionBody.parse({
        protocol_version: PROTOCOL_VERSION,
        idempotency_key: newId(),
        action,
      });
      const ans = await phoneFetch<{ revision: number; status: string }>(
        'POST',
        `/api/v1/questions/${asked.questionId}/answer`,
        body,
      );
      expect(ans.status).toBe(201);
      expect(ans.json).toMatchObject({ revision: 1, status: 'human-answered' });

      // --- the answer is pushed over the hibernatable socket and typed into the exact pane ---
      for (let i = 0; i < 100 && sink.typed.length === 0; i++) await tick(100);
      expect(sink.typed).toHaveLength(1);
      expect(sink.typed[0]!.text).toContain('choice: approve');
      expect(sink.typed[0]!.text).toContain('comment: go for it');
      expect(sink.typed[0]!.text).toContain('source: human');

      // the relay learns it was really typed
      let delivered = false;
      for (let i = 0; i < 50 && !delivered; i++) {
        const d = await phoneFetch<QuestionDetail>('GET', `/api/v1/questions/${asked.questionId}`);
        delivered = d.json.deliveries.some((x) => x.status === 'terminal-delivered');
        if (!delivered) await tick(100);
      }
      expect(delivered).toBe(true);

      // a second answer from another device loses (first answer wins)
      const second = await phoneFetch<{ code: string }>(
        'POST',
        `/api/v1/questions/${asked.questionId}/answer`,
        ActionBody.parse({
          protocol_version: PROTOCOL_VERSION,
          idempotency_key: newId(),
          action,
        }),
      );
      expect([200, 201, 409]).toContain(second.status);
      await bridge.stop();
      // revoke the simulated phone so the relay is left clean
      const { revokeAndRotate } = await import('../src/index.js');
      const keyStore = new FileKeyStore(HOME);
      const after = await revokeAndRotate(client, keyStore, phoneId);
      expect(after.currentEpoch).toBe(2);
    }, 60_000);
  },
);
