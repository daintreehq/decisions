import { describe, expect, it } from 'vitest';
import {
  ApiError,
  applyAction,
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalize,
  enforceRequirement,
  formatAuthHeader,
  isPersonDecline,
  normalizeQuery,
  parseAuthHeader,
  provenanceForAction,
  provenanceForSigner,
  roleMaySign,
  signingString,
} from '../src/index.js';

describe('base64url', () => {
  it('round-trips every length', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      expect(base64UrlToBytes(bytesToBase64Url(b))).toEqual(b);
    }
  });
  it('matches known vectors', () => {
    expect(bytesToBase64Url(new TextEncoder().encode('Man'))).toBe('TWFu');
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });
  it('rejects bad input', () => {
    expect(() => base64UrlToBytes('a+b')).toThrow();
    expect(() => base64UrlToBytes('abcde')).toThrow();
  });
});

describe('JCS canonicalization (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units and drops undefined', () => {
    expect(
      canonicalize({ b: 1, a: [true, null, 'x'], c: undefined, é: 2, z: { y: 1, x: 2 } }),
    ).toBe('{"a":[true,null,"x"],"b":1,"z":{"x":2,"y":1},"é":2}');
  });
  it('serialises numbers like ECMAScript', () => {
    expect(canonicalize([1, 1.5, -0, 1e21, 0.000001])).toBe('[1,1.5,0,1e+21,0.000001]');
  });
  it('escapes strings per JSON', () => {
    expect(canonicalize('a"\n ')).toBe(JSON.stringify('a"\n '));
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalize(NaN)).toThrow();
  });
  it('signingString omits only the signature', () => {
    expect(signingString({ b: 1, a: 2, signature: 'zzz' })).toBe('{"a":2,"b":1}');
  });
});

describe('auth header', () => {
  const h = {
    v: 1,
    installationId: 'inst_aaaaaaaa',
    deviceId: 'dev_bbbbbbbb',
    ts: 1_700_000_000_000,
    nonce: 'n'.repeat(22),
    signature: 's'.repeat(86),
  };
  it('round-trips', () => {
    expect(parseAuthHeader(formatAuthHeader(h))).toEqual(h);
  });
  it('rejects malformed', () => {
    expect(parseAuthHeader('Bearer x')).toBeNull();
    expect(parseAuthHeader('Decisions-Sig v=1')).toBeNull();
    expect(parseAuthHeader(null)).toBeNull();
  });
  it('normalises query order', () => {
    expect(normalizeQuery('b=2&a=1')).toBe('a=1&b=2');
  });
});

describe('requirement enforcement (invariant I4)', () => {
  it('never downgrades a workflow level', () => {
    expect(enforceRequirement({ workflowMin: 'human-required', requested: 'proxy-ok' })).toBe(
      'human-required',
    );
    expect(enforceRequirement({ workflowMin: 'proxy-first', requested: 'proxy-ok' })).toBe(
      'proxy-first',
    );
  });
  it('can be made stricter by the caller', () => {
    expect(enforceRequirement({ workflowMin: 'proxy-ok', requested: 'human-required' })).toBe(
      'human-required',
    );
  });
  it('defaults to human-required without a policy or allowlist', () => {
    expect(enforceRequirement({ requested: 'proxy-ok' })).toBe('human-required');
    expect(enforceRequirement({})).toBe('human-required');
    expect(enforceRequirement({ requested: 'proxy-first', proxyAllowlisted: true })).toBe(
      'proxy-first',
    );
  });
});

describe('state machine', () => {
  const open = {
    status: 'open',
    revision: 0,
    requirement: 'human-required',
    proxyAbstained: false,
  } as const;
  it('first human answer wins; stale gets conflict', () => {
    const t = applyAction(open, 'answer', 'phone', 0);
    expect(t).toMatchObject({ status: 'human-answered', revision: 1, deliverable: true });
    const answered = { ...open, status: 'human-answered', revision: 1 } as const;
    expect(() => applyAction(answered, 'answer', 'tablet', 0)).toThrowError(ApiError);
    try {
      applyAction(answered, 'answer', 'tablet', 0);
    } catch (e) {
      expect((e as ApiError).code).toBe('revision_conflict');
    }
  });
  it('proxy can never answer human-required', () => {
    expect(() => applyAction(open, 'proxy-answer', 'owner-desktop', 0)).toThrow(/never answer/);
    expect(() => applyAction(open, 'proxy-abstain', 'owner-desktop', 0)).toThrow();
  });
  it('phones cannot proxy, and a Host can never answer as the person', () => {
    const p = { ...open, requirement: 'proxy-ok' } as const;
    expect(() => applyAction(p, 'proxy-answer', 'phone', 0)).toThrow(/may not/);
    expect(() => applyAction(p, 'answer', 'desktop-host', 0)).toThrow(/may not/);
    expect(() => applyAction(open, 'answer', 'desktop-host', 0)).toThrow(/may not/);
  });
  it('the owner desktop answers for the person at every requirement, and does nothing else a human does', () => {
    for (const requirement of ['human-required', 'proxy-ok', 'proxy-first'] as const) {
      expect(applyAction({ ...open, requirement }, 'answer', 'owner-desktop', 0)).toMatchObject({
        status: 'human-answered',
        revision: 1,
        deliverable: true,
        eventType: 'decision.answer.committed',
      });
    }
    // First answer wins for the owner desktop as for a phone.
    const answered = { ...open, status: 'human-answered', revision: 1 } as const;
    expect(() => applyAction(answered, 'answer', 'owner-desktop', 1)).toThrow(/changed/);
    const cancelled = { ...open, status: 'cancelled' } as const;
    expect(() => applyAction(cancelled, 'answer', 'owner-desktop', 0)).toThrow(/cannot answer/);
    const expired = { ...open, status: 'expired' } as const;
    expect(() => applyAction(expired, 'answer', 'owner-desktop', 0)).toThrow(/expired/);
    const proxied = {
      status: 'proxy-answered',
      revision: 1,
      requirement: 'proxy-ok',
      proxyAbstained: false,
    } as const;
    for (const action of ['override', 'confirm-proxy'] as const) {
      expect(() => applyAction(proxied, action, 'owner-desktop', 1)).toThrow(/may not/);
      expect(() => applyAction(proxied, action, 'desktop-host', 1)).toThrow(/may not/);
    }
  });
  it('provenance follows the signer: human, human-desktop or proxy', () => {
    expect(provenanceForSigner('answer', 'phone')).toBe('human');
    expect(provenanceForSigner('answer', 'tablet')).toBe('human');
    expect(provenanceForSigner('answer', 'owner-desktop')).toBe('human-desktop');
    expect(provenanceForSigner('override', 'phone')).toBe('human');
    expect(provenanceForSigner('confirm-proxy', 'tablet')).toBe('human');
    expect(provenanceForSigner('proxy-answer', 'owner-desktop')).toBe('proxy');
    expect(provenanceForSigner('proxy-answer', 'desktop-host')).toBe('proxy');
    expect(provenanceForSigner('cancel', 'desktop-host')).toBe('none');
    for (const [action, role] of [
      ['answer', 'desktop-host'],
      ['override', 'owner-desktop'],
      ['confirm-proxy', 'owner-desktop'],
      ['proxy-answer', 'phone'],
      ['reopen', 'desktop-host'],
    ] as const) {
      expect(() => provenanceForSigner(action, role), `${action} by ${role}`).toThrow(/may not/);
    }
    // The role-blind mapping clients verify phone answers with is unchanged.
    expect(provenanceForAction('answer')).toBe('human');
  });
  it('proxy-answered can be overridden or confirmed, then rev increments', () => {
    const p = {
      status: 'proxy-answered',
      revision: 1,
      requirement: 'proxy-ok',
      proxyAbstained: false,
    } as const;
    expect(applyAction(p, 'override', 'phone', 1)).toMatchObject({
      revision: 2,
      deliverable: true,
    });
    expect(applyAction(p, 'confirm-proxy', 'phone', 1)).toMatchObject({
      revision: 2,
      deliverable: false,
    });
    expect(() => applyAction(p, 'answer', 'phone', 1)).toThrow();
  });
  it('cancel cannot remove a committed human answer; reopen only from cancelled/expired', () => {
    const a = { ...open, status: 'human-answered', revision: 1 } as const;
    expect(() => applyAction(a, 'cancel', 'owner-desktop', 1)).toThrow();
    const c = { ...open, status: 'expired' } as const;
    expect(applyAction(c, 'reopen', 'owner-desktop', 0)).toMatchObject({
      status: 'open',
      revision: 1,
    });
    expect(() => applyAction(c, 'reopen', 'desktop-host', 0)).toThrow(/may not/);
  });
  it('a phone or tablet declines an open question with a cancel', () => {
    for (const requirement of ['human-required', 'proxy-ok', 'proxy-first'] as const) {
      for (const role of ['phone', 'tablet'] as const) {
        expect(applyAction({ ...open, requirement }, 'cancel', role, 0)).toEqual({
          status: 'cancelled',
          revision: 0,
          proxyAbstained: false,
          deliverable: false,
          noop: false,
          eventType: 'decision.cancelled',
        });
      }
    }
    expect(isPersonDecline('cancel', 'phone')).toBe(true);
    expect(isPersonDecline('cancel', 'tablet')).toBe(true);
    expect(isPersonDecline('cancel', 'owner-desktop')).toBe(false);
    expect(isPersonDecline('answer', 'phone')).toBe(false);
    expect(roleMaySign('cancel', 'phone')).toBe(true);
    expect(roleMaySign('reopen', 'phone')).toBe(false);
    expect(provenanceForAction('cancel')).toBe('none');
  });
  it('a person declines only an open question, at the revision they saw', () => {
    const conflict = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as ApiError).code;
      }
      return null;
    };
    expect(conflict(() => applyAction({ ...open, revision: 2 }, 'cancel', 'phone', 1))).toBe(
      'revision_conflict',
    );
    const proxied = { ...open, status: 'proxy-answered', revision: 1 } as const;
    expect(conflict(() => applyAction(proxied, 'cancel', 'phone', 1))).toBe('invalid_state');
    // The desktop still withdraws a proxy-answered question.
    expect(applyAction(proxied, 'cancel', 'owner-desktop', 1).status).toBe('cancelled');
    for (const status of ['human-answered', 'expired'] as const) {
      expect(conflict(() => applyAction({ ...open, status }, 'cancel', 'tablet', 0))).toBe(
        'invalid_state',
      );
    }
    // A retry after the question closed is a no-op, as for a desktop.
    expect(applyAction({ ...open, status: 'cancelled' }, 'cancel', 'phone', 0).noop).toBe(true);
    // Declining never answers, and a declined question cannot be answered.
    expect(
      conflict(() => applyAction({ ...open, status: 'cancelled' }, 'answer', 'phone', 0)),
    ).toBe('invalid_state');
  });
  it('the owner desktop declines with a signed decline flag; its plain cancel stays a withdrawal', () => {
    for (const requirement of ['human-required', 'proxy-ok', 'proxy-first'] as const) {
      expect(applyAction({ ...open, requirement }, 'cancel', 'owner-desktop', 0, true)).toEqual({
        status: 'cancelled',
        revision: 0,
        proxyAbstained: false,
        deliverable: false,
        noop: false,
        eventType: 'decision.cancelled',
      });
    }
    expect(isPersonDecline('cancel', 'owner-desktop', true)).toBe(true);
    expect(isPersonDecline('cancel', 'owner-desktop')).toBe(false);
    expect(isPersonDecline('cancel', 'desktop-host')).toBe(false);
    expect(isPersonDecline('reopen', 'owner-desktop', true)).toBe(false);
    // A phone or tablet declines by its role; the flag changes nothing for its classification.
    expect(isPersonDecline('cancel', 'phone')).toBe(true);
    expect(roleMaySign('cancel', 'owner-desktop', true)).toBe(true);
    expect(roleMaySign('cancel', 'owner-desktop')).toBe(true);
    expect(provenanceForSigner('cancel', 'owner-desktop')).toBe('none');
  });
  it('only the owner desktop signs a decline flag, and only on a cancel', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as ApiError).code;
      }
      return null;
    };
    // A Host never declines for the person: it withdraws, or it is refused.
    expect(roleMaySign('cancel', 'desktop-host', true)).toBe(false);
    expect(code(() => applyAction(open, 'cancel', 'desktop-host', 0, true))).toBe('forbidden');
    expect(applyAction(open, 'cancel', 'desktop-host', 0).status).toBe('cancelled');
    // A phone or tablet declines by its role alone, so the flag has one meaning: the owner desktop's decline.
    for (const role of ['phone', 'tablet'] as const) {
      expect(roleMaySign('cancel', role, true)).toBe(false);
      expect(code(() => applyAction(open, 'cancel', role, 0, true))).toBe('forbidden');
    }
    // The flag widens nothing else: the owner desktop gains no other human-only action.
    for (const action of [
      'answer',
      'override',
      'confirm-proxy',
      'proxy-answer',
      'reopen',
    ] as const) {
      expect(roleMaySign(action, 'owner-desktop', true), action).toBe(false);
    }
    expect(roleMaySign('override', 'owner-desktop')).toBe(false);
    expect(roleMaySign('confirm-proxy', 'owner-desktop')).toBe(false);
  });
  it('an owner-desktop decline follows the person: open only, at the revision seen, first close wins', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as ApiError).code;
      }
      return null;
    };
    const decline = (state: Parameters<typeof applyAction>[0], expected: number) =>
      applyAction(state, 'cancel', 'owner-desktop', expected, true);
    expect(code(() => decline({ ...open, revision: 2 }, 1))).toBe('revision_conflict');
    const proxied = {
      ...open,
      requirement: 'proxy-ok',
      status: 'proxy-answered',
      revision: 1,
    } as const;
    expect(code(() => decline(proxied, 1))).toBe('invalid_state');
    // Its plain cancel still withdraws a proxy-answered question.
    expect(applyAction(proxied, 'cancel', 'owner-desktop', 1).status).toBe('cancelled');
    for (const status of ['human-answered', 'expired'] as const) {
      expect(code(() => decline({ ...open, status }, 0))).toBe('invalid_state');
    }
    // A closed question stays closed by whoever closed it: a decline after a withdrawal, or a withdrawal after a
    // decline, is a no-op that relabels nothing.
    const cancelled = { ...open, status: 'cancelled' } as const;
    expect(decline(cancelled, 0).noop).toBe(true);
    expect(applyAction(cancelled, 'cancel', 'owner-desktop', 0).noop).toBe(true);
  });
});

import {
  ActionRecord,
  DecisionContentV1,
  HumanAnswerContentV1,
  SignedAction,
  PublicKeyB64,
  SigB64,
} from '../src/index.js';

describe('hardening from review', () => {
  it('rejects non-canonical base64url (trailing bits)', () => {
    expect(() => base64UrlToBytes('AB')).toThrow(/non-canonical/);
    expect(() => base64UrlToBytes('AAB')).toThrow(/non-canonical/);
    expect(base64UrlToBytes('AA')).toEqual(new Uint8Array([0]));
  });
  it('canonicalize rejects ambiguous inputs', () => {
    expect(() => canonicalize(new Array(1))).toThrow(/sparse/);
    expect(() => canonicalize({ d: new Date(0) })).toThrow(/non-plain/);
    expect(() => canonicalize('\uDEAD')).toThrow(/surrogate/);
    expect(() =>
      canonicalize({
        get x() {
          return 1;
        },
      }),
    ).toThrow(/accessor/);
    expect(canonicalize('😀')).toBe('"\u{1F600}"');
  });
  it('rejects duplicate query keys', () => {
    expect(() => normalizeQuery('after=1&after=9')).toThrow(/duplicate/);
  });
  it('cancel and abstain are revision-checked; cancel retry is a no-op', () => {
    const p = {
      status: 'proxy-answered',
      revision: 1,
      requirement: 'proxy-ok',
      proxyAbstained: false,
    } as const;
    expect(() => applyAction(p, 'cancel', 'owner-desktop', 0)).toThrow();
    const o = {
      status: 'open',
      revision: 1,
      requirement: 'proxy-first',
      proxyAbstained: false,
    } as const;
    expect(() => applyAction(o, 'proxy-abstain', 'owner-desktop', 0)).toThrow();
    const c = {
      status: 'cancelled',
      revision: 0,
      requirement: 'proxy-ok',
      proxyAbstained: false,
    } as const;
    expect(applyAction(c, 'cancel', 'owner-desktop', 0).noop).toBe(true);
  });
  const base = {
    v: 1,
    type: 'action',
    installation_id: 'inst_aaaaaaaa',
    question_id: 'q_aaaaaaaa',
    action_id: 'act_aaaaaaaa',
    expected_revision: 0,
    created_at: '2026-11-01T09:00:00.000Z',
    envelope_digest: null,
    confirms_action_id: null,
    expires_at: null,
    signer_device_id: 'dev_aaaaaaaa',
    signature: 's'.repeat(86),
  };
  it('decline is literal true on a cancel, and absent everywhere else', () => {
    const cancel = { ...base, action: 'cancel' };
    const parsed = ActionRecord.parse({ ...cancel, decline: true });
    expect(parsed.decline).toBe(true);
    // Absent stays absent, so a record signed without it canonicalises exactly as before.
    expect('decline' in ActionRecord.parse(cancel)).toBe(false);
    expect(signingString(ActionRecord.parse(cancel))).toBe(signingString(cancel));
    expect(signingString(parsed)).toContain('"decline":true');
    for (const decline of [false, null, 'true', 1]) {
      expect(ActionRecord.safeParse({ ...cancel, decline }).success, String(decline)).toBe(false);
    }
    expect(ActionRecord.safeParse({ ...base, action: 'reopen', decline: true }).success).toBe(
      false,
    );
    expect(
      ActionRecord.safeParse({
        ...base,
        action: 'answer',
        envelope_digest: 'a'.repeat(64),
        decline: true,
      }).success,
    ).toBe(false);
  });
  it('answer actions need an envelope; confirm needs a target', () => {
    expect(ActionRecord.safeParse({ ...base, action: 'answer' }).success).toBe(false);
    expect(ActionRecord.safeParse({ ...base, action: 'cancel' }).success).toBe(true);
    expect(ActionRecord.safeParse({ ...base, action: 'confirm-proxy' }).success).toBe(false);
    expect(
      SignedAction.safeParse({
        record: { ...base, action: 'cancel', envelope_digest: 'a'.repeat(64) },
        envelope: null,
      }).success,
    ).toBe(false);
  });
  it('enforces byte limits and exact key/signature sizes', () => {
    expect(
      DecisionContentV1.safeParse({ question: 'q', context: 'x'.repeat(40_000) }).success,
    ).toBe(false);
    expect(HumanAnswerContentV1.safeParse({ text: 'x'.repeat(20_000) }).success).toBe(false);
    expect(PublicKeyB64.safeParse('A'.repeat(81)).success).toBe(false);
    expect(PublicKeyB64.safeParse('A'.repeat(87)).success).toBe(true);
    expect(SigB64.safeParse('').success).toBe(false);
  });
});
