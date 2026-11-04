import { describe, expect, it } from 'vitest';
import {
  EventData,
  HumanAnswerContentV1,
  MessageContentV1,
  MessageDeliveryInfo,
  MessageRecord,
  MessageView,
  PaneSnapshotContentV1,
  PaneSnapshotRecord,
  PhoneImageReference,
  SnapshotRefresh,
  imagesMatchRecord,
  snapshotFreshness,
  threadAwaitsHuman,
} from '../src/index.js';
import * as fixtures from '../src/fixtures.js';

const {
  ANSWER_IMAGE_FIXTURE,
  FIXTURE_NOW,
  MESSAGE_IMAGE_FIXTURE,
  SHARING_OFF_FIXTURE,
  SNAPSHOT_FIXTURE,
  STALE_SNAPSHOT_FIXTURE,
  THREAD_FIXTURE,
} = fixtures;
const SIG = 's'.repeat(86);
const DIGEST = 'a'.repeat(64);
const NOW = Date.parse(FIXTURE_NOW);

describe('shared fixtures', () => {
  it('phone image references are valid', () => {
    expect(PhoneImageReference.safeParse(ANSWER_IMAGE_FIXTURE).success).toBe(true);
    expect(PhoneImageReference.safeParse(MESSAGE_IMAGE_FIXTURE).success).toBe(true);
  });

  it('the thread runs in both directions with ordered, valid messages', () => {
    const t = THREAD_FIXTURE;
    expect(HumanAnswerContentV1.safeParse(t.answer.content).success).toBe(true);
    expect(imagesMatchRecord(t.answer.attachment_ids, t.answer.content.images)).toBe(true);
    expect(new Set(t.messages.map((m) => m.record.side))).toEqual(new Set(['human', 'agent']));
    expect(t.messages.map((m) => m.message_seq)).toEqual([1, 2, 3]);
    for (const m of t.messages) {
      const record = MessageRecord.parse({ ...m.record, envelope_digest: DIGEST, signature: SIG });
      expect(record.question_id).toBe(t.question_id);
      expect(MessageContentV1.parse(m.content).side).toBe(record.side);
      expect(
        imagesMatchRecord(record.attachment_ids, 'images' in m.content ? m.content.images : []),
      ).toBe(true);
      if (m.delivery) expect(MessageDeliveryInfo.safeParse(m.delivery).success).toBe(true);
      // agent messages come from the publishing desktop, human ones from the phone
      expect(record.signer_device_id).toBe(
        record.side === 'agent' ? t.desktop_device_id : t.phone_device_id,
      );
      expect(m.event_seq).toBeGreaterThan(t.answer_event_seq);
    }
    expect(
      threadAwaitsHuman({
        status: t.status,
        messages: t.messages.map((m) => ({ ...m.record, event_seq: m.event_seq })),
        lastHumanActionSeq: t.answer_event_seq,
      }),
    ).toBe(false);
  });

  it('fit the view and event shapes the relay will serve, once signed and encrypted', () => {
    const m = THREAD_FIXTURE.messages[1]!;
    const record = { ...m.record, envelope_digest: DIGEST, signature: SIG };
    const envelope = {
      crypto_version: 1,
      suite: 'P256-ECDH-HKDF-SHA256-A256GCM-ECDSA-P256',
      key_epoch: 1,
      record_id: m.record.message_id,
      purpose: 'message-content',
      nonce: 'AAECAwQFBgcICQoL',
      ciphertext: 'c'.repeat(64),
      aad: {
        installation_id: m.record.installation_id,
        question_id: m.record.question_id,
        record_type: 'thread.message',
        revision: 0,
        sender_device_id: m.record.signer_device_id,
      },
    };
    const entry = { message_seq: m.message_seq, committed_at: m.committed_at, record, envelope };
    expect(
      MessageView.safeParse({ ...entry, event_seq: m.event_seq, delivery: m.delivery }).success,
    ).toBe(true);
    expect(
      EventData.messagePosted.safeParse({ ...entry, target_host_id: THREAD_FIXTURE.target_host_id })
        .success,
    ).toBe(true);
  });

  it('snapshots are fresh, stale by age, stale by a timed-out refresh, and off', () => {
    const label = (s: {
      record: { observed_at: string; sharing: 'on' | 'off' };
      refresh: unknown;
    }) =>
      snapshotFreshness({
        now: NOW,
        status: THREAD_FIXTURE.status,
        snapshot: s.record,
        refresh: s.refresh as { deadline_at: string } | null,
      });
    for (const s of [
      SNAPSHOT_FIXTURE,
      STALE_SNAPSHOT_FIXTURE.aged,
      STALE_SNAPSHOT_FIXTURE.refreshTimedOut,
    ]) {
      expect(
        PaneSnapshotRecord.safeParse({ ...s.record, envelope_digest: DIGEST, signature: SIG })
          .success,
      ).toBe(true);
      const c = PaneSnapshotContentV1.parse(s.content);
      expect(c.observed_at).toBe(s.record.observed_at);
      if (s.refresh) expect(SnapshotRefresh.safeParse(s.refresh).success).toBe(true);
    }
    expect(label(SNAPSHOT_FIXTURE)).toBe('fresh');
    expect(label(STALE_SNAPSHOT_FIXTURE.aged)).toBe('stale');
    expect(label(STALE_SNAPSHOT_FIXTURE.refreshTimedOut)).toBe('stale');
    expect(
      PaneSnapshotRecord.safeParse({
        ...SHARING_OFF_FIXTURE,
        envelope_digest: null,
        signature: SIG,
      }).success,
    ).toBe(true);
    expect(label({ record: SHARING_OFF_FIXTURE, refresh: null })).toBe('off');
  });

  it('hold no signatures or ciphertext that could pass for trusted ones', () => {
    const text = JSON.stringify([
      THREAD_FIXTURE,
      SNAPSHOT_FIXTURE,
      STALE_SNAPSHOT_FIXTURE,
      SHARING_OFF_FIXTURE,
      fixtures.FIXTURE_IDS,
    ]);
    expect(text).not.toContain('"signature"');
    expect(text).not.toContain('"ciphertext"');
  });
});
