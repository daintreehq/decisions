/**
 * One side of the compatibility check (compat-check.mjs). It is copied into a scratch project that has one version of
 * the published packages installed and run there as a child process, so every import below resolves to that
 * project's node_modules, never to the workspace. The orchestrator sends `{ id, op, args }` over IPC and gets back
 * `{ id, ok: true, value }` or `{ id, ok: false, error }`.
 *
 * It holds the desktop side the way a host app uses the library (a `DecisionsBridge` with a recording sink, on the
 * identity a CLI home holds), one-off owner operations, and a simulated phone that pairs, reads, answers and declines
 * with signed requests, as the phone app does. Only APIs both the released and the current packages have are used.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as client from '@daintreehq/decisions-client';
import * as crypto from '@daintreehq/decisions-crypto';
import * as protocol from '@daintreehq/decisions-protocol';
import { SqliteLocalStore } from '@daintreehq/decisions-client/sqlite';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(250);
  }
}

const loadIdentity = (home) => client.loadIdentity(new client.FileKeyStore(home));

/** The origin a host app gives each question: one pane per name. */
const originOf = (pane) => ({
  host_id: 'host_compat01',
  pane_id: pane,
  terminal_generation: 1,
  ownership_principal: `principal-${pane}`,
  agent_incarnation: `inc-${pane}`,
  agent_kind: 'claude-code',
  agent_session_id: `sess-${pane}`,
  project_id: 'compat',
  worktree_id: 'wt',
  worktree_root: '/tmp/compat-check',
  workflow_gate_id: null,
});

/** Records what the bridge would type into each pane, and confirms every write. */
class RecordingSink {
  typed = [];
  async locate(o) {
    return {
      state: 'alive',
      target: {
        hostId: o.host_id,
        paneId: o.pane_id,
        terminalGeneration: o.terminal_generation,
        ownershipPrincipal: o.ownership_principal,
        agentIncarnation: o.agent_incarnation,
        agentSessionId: o.agent_session_id,
        worktreeId: o.worktree_id,
      },
    };
  }
  async isIdle() {
    return true;
  }
  async inject(t, text, injectionId) {
    this.typed.push({ pane: t.paneId, text, injectionId: injectionId ?? null });
    return { outcome: 'delivered', proof: 'compat-check' };
  }
  async hasMarker(t, id) {
    return this.typed.some((x) => x.pane === t.paneId && x.text.includes(`injection_id: ${id}`));
  }
  async resume() {
    return null;
  }
}

/** A `fetch` that passes everything through and keeps every response the relay refused. */
function recordingFetch(refused) {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (!res.ok) {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const body = await res
        .clone()
        .text()
        .catch(() => '');
      refused.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        status: res.status,
        body: body.slice(0, 300),
      });
    }
    return res;
  };
}

/** The features the phone app declares, each only once the relay advertises it (app/src/app/controller.ts). */
const PHONE_FEATURES = [
  'pane-snapshots-v1',
  'thread-messages-v1',
  'phone-images-v1',
  'involvement-v1',
  'advisory-deadlines-v1',
];

/** A paired phone, built on this side's crypto and protocol, signing every request as the phone app does. */
class Phone {
  constructor(origin, installationId, label) {
    this.origin = origin;
    this.installationId = installationId;
    this.label = label;
  }

  async request(method, path, body, query = '') {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const { authorization } = await crypto.signRequest({
      method,
      path,
      query,
      body: text ?? null,
      installationId: this.installationId,
      deviceId: this.id,
      signingKey: this.keys.signing.privateKey,
    });
    const res = await fetch(this.origin + path + (query ? `?${query}` : ''), {
      method,
      headers: { authorization, ...(text ? { 'content-type': 'application/json' } : {}) },
      ...(text ? { body: text } : {}),
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      /* reported through `raw` */
    }
    return { status: res.status, json, raw: raw.slice(0, 500) };
  }

  async candidate({ pairingId, secret }) {
    this.keys = await crypto.generateDeviceKeys(false);
    this.id = crypto.newId();
    const signingPub = await crypto.exportPublicKey(this.keys.signing.publicKey);
    const exchangePub = await crypto.exportPublicKey(this.keys.exchange.publicKey);
    const pop = await crypto.signString(
      this.keys.signing.privateKey,
      protocol.pairingPopString({ pairingId, deviceId: this.id, exchangePub, signingPub }),
    );
    const res = await fetch(`${this.origin}/api/v1/pairing/candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol_version: protocol.PROTOCOL_VERSION,
        pairing_id: pairingId,
        secret,
        device_id: this.id,
        label: this.label,
        signing_pub: signingPub,
        exchange_pub: exchangePub,
        pop,
      }),
    });
    if (res.status !== 201) throw new Error(`pairing candidate: ${res.status} ${await res.text()}`);
    this.pairing = { pairingId, secret };
    return { deviceId: this.id };
  }

  async finish({ ownerSigningPub }) {
    const { pairingId, secret } = this.pairing;
    const st = await until(
      async () => {
        const r = await fetch(`${this.origin}/api/v1/pairing/${pairingId}/status`, {
          headers: { 'x-pairing-secret': secret },
        });
        const j = await r.json();
        return j.state === 'approved' ? j : null;
      },
      20_000,
      'the pairing to be approved',
    );
    const ownerKey = await crypto.importSigningPublicKey(ownerSigningPub);
    const epoch = await crypto.openEpochGrant({
      grant: st.grant,
      ownerSigningPublicKey: ownerKey,
      exchangePrivateKey: this.keys.exchange.privateKey,
      expectedInstallationId: this.installationId,
      expectedDeviceId: this.id,
    });
    this.epochs = new Map([[epoch.epoch, epoch]]);
    // Declare what the phone app would on this relay, as its socket ticket does.
    const info = await (await fetch(`${this.origin}/api/v1/info`)).json();
    const served = new Set(info.features ?? []);
    const features = PHONE_FEATURES.filter((f) => served.has(f)).sort();
    const ticket = await this.request('POST', '/api/v1/socket-ticket', {
      protocol_version: protocol.PROTOCOL_VERSION,
      ...(features.length ? { features } : {}),
    });
    if (ticket.status !== 200 && ticket.status !== 201)
      throw new Error(`phone socket ticket: ${ticket.status} ${ticket.raw}`);
    return { deviceId: this.id, features };
  }

  /** The question as the phone reads it, decrypted, once the relay has it (and `until` holds, when given). */
  async question(questionId, want = {}, timeoutMs = 30_000) {
    let last = null;
    const found = await until(
      async () => {
        const r = await this.request('GET', `/api/v1/questions/${questionId}`);
        last = r;
        if (r.status !== 200) return null;
        if (want.status && r.json.status !== want.status) return null;
        if (want.revision !== undefined && r.json.revision !== want.revision) return null;
        return r.json;
      },
      timeoutMs,
      `question ${questionId} on the phone (${JSON.stringify(want)}); last: ${last?.status} ${last?.json?.status ?? ''}`,
    ).catch((e) => {
      throw new Error(`${e.message}; last read: ${last?.status} ${last?.raw ?? ''}`);
    });
    const content = await crypto.decryptEnvelope(found.question.envelope, this.epochs);
    return {
      status: found.status,
      revision: found.revision,
      expires_at: found.expires_at ?? null,
      reply_mode: found.question.envelope.aad.reply_mode ?? null,
      originating_device_id: found.question.record.originating_device_id,
      content,
    };
  }

  async answer({ questionId, revision, option, text }) {
    const envelope = await crypto.encryptEnvelope({
      epochKey: [...this.epochs.values()].sort((a, b) => b.epoch - a.epoch)[0],
      installationId: this.installationId,
      questionId,
      recordId: crypto.newId(),
      recordType: 'answer',
      revision: revision + 1,
      senderDeviceId: this.id,
      purpose: 'answer-content',
      plaintext: {
        content_version: 1,
        selected_option_ids: option ? [option] : [],
        text,
        reviewed_attachment_digests: [],
      },
    });
    const action = await crypto.buildSignedAction({
      installationId: this.installationId,
      questionId,
      action: 'answer',
      signerDeviceId: this.id,
      signingKey: this.keys.signing.privateKey,
      expectedRevision: revision,
      envelope,
    });
    return this.request('POST', `/api/v1/questions/${questionId}/answer`, {
      protocol_version: protocol.PROTOCOL_VERSION,
      idempotency_key: crypto.newId(),
      action,
    });
  }

  /**
   * The person's decline (docs/protocol.md section 6.1): a phone's signed `cancel`. The relay commits one only once
   * the publishing desktop has declared `person-declines-v1` on its socket ticket, so wait for that first.
   */
  async decline({ questionId, revision, publisher }) {
    await until(
      async () => {
        const r = await this.request('GET', '/api/v1/devices');
        const d = r.json?.devices?.find((x) => x.device_id === publisher);
        return d?.features?.includes('person-declines-v1');
      },
      30_000,
      `device ${publisher} to declare person-declines-v1`,
    );
    const action = await crypto.buildSignedAction({
      installationId: this.installationId,
      questionId,
      action: 'cancel',
      signerDeviceId: this.id,
      signingKey: this.keys.signing.privateKey,
      expectedRevision: revision,
      envelope: null,
    });
    return this.request('POST', `/api/v1/questions/${questionId}/cancel`, {
      protocol_version: protocol.PROTOCOL_VERSION,
      idempotency_key: crypto.newId(),
      action,
    });
  }
}

const bridges = new Map();
const phones = new Map();
const errorOf = (e) => ({
  name: e?.name ?? 'Error',
  code: e?.code ?? null,
  message: String(e?.message ?? e),
});

const ops = {
  /** Where each package resolved from, and its version: proof of which side this is. */
  versions() {
    const out = {};
    for (const name of ['decisions-client', 'decisions-crypto', 'decisions-protocol']) {
      const dir = join(process.cwd(), 'node_modules/@daintreehq', name);
      out[name] = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    }
    out.resolved = import.meta.resolve('@daintreehq/decisions-client');
    return out;
  },

  async ownerInvite({ home }) {
    const identity = await loadIdentity(home);
    const invite = await client.createPairingInvite(new client.RelayClient({ identity }), 'phone');
    return {
      pairingId: invite.pairingId,
      secret: invite.payload.s,
      origin: identity.config.relayOrigin,
      installationId: identity.config.installationId,
      ownerSigningPub: identity.owner.signingPub,
    };
  },

  async ownerApprove({ home, pairingId }) {
    const identity = await loadIdentity(home);
    const rc = new client.RelayClient({ identity });
    const cand = await until(
      async () => (await rc.pendingPairings()).pending.find((p) => p.pairing_id === pairingId),
      20_000,
      'the pending pairing',
    );
    if (cand.short_code !== (await client.localShortCode(cand)))
      throw new Error('the pairing short code does not match');
    await client.approveCandidate(rc, cand);
    return { approved: true };
  },

  /** A signed `reopen` by the owner desktop (docs/protocol.md section 21): revision r to r+1 with a new deadline. */
  async ownerReopen({ home, questionId, expectedRevision, expiresAt }) {
    const identity = await loadIdentity(home);
    const rc = new client.RelayClient({ identity });
    const signed = await crypto.buildSignedAction({
      installationId: identity.config.installationId,
      questionId,
      action: 'reopen',
      signerDeviceId: identity.config.deviceId,
      signingKey: identity.keys.signing.privateKey,
      expectedRevision,
      envelope: null,
      expiresAt,
    });
    return rc.postAction('reopen', questionId, crypto.newId(), signed);
  },

  async ownerQuestions({ home }) {
    const identity = await loadIdentity(home);
    const list = await new client.RelayClient({ identity }).listQuestions({ limit: 100 });
    return list.questions.map((q) => q.question_id);
  },

  /**
   * How this side's own protocol schemas read the ledger and the question details: every `decision.created` of the
   * named questions as `EventData.created` parses it, and each detail as `QuestionDetail` does, paging the events as
   * this side's `RelayClient` does (which parses each page) with the features `declare` names.
   */
  async readLedger({ home, features, questionIds }) {
    const identity = await loadIdentity(home);
    const rc = new client.RelayClient({ identity });
    const want = new Set(questionIds);
    const seen = {};
    let after = 0;
    let highWater = 0;
    for (;;) {
      const page = await rc.events(after, 100, features);
      for (const ev of page.events) {
        if (ev.event_type !== 'decision.created' || !want.has(ev.question_id)) continue;
        const r = protocol.EventData.created.safeParse(ev.data);
        seen[ev.question_id] = {
          seq: ev.seq,
          created: r.success,
          createdIssue: r.success ? null : (r.error.issues[0]?.path ?? []).join('.'),
        };
      }
      highWater = page.high_water_seq;
      after = page.next_after;
      if (!page.has_more) break;
    }
    const out = {};
    for (const id of questionIds) {
      const detail = protocol.QuestionDetail.safeParse(await rc.getQuestion(id));
      out[id] = {
        inLedger: id in seen,
        ...(seen[id] ?? {}),
        detail: detail.success,
        detailIssue: detail.success ? null : (detail.error.issues[0]?.path ?? []).join('.'),
      };
    }
    return { questions: out, highWater };
  },

  async bridgeStart({ name, home, store, pane, advisory = false, auditDir, socket = true }) {
    const identity = await loadIdentity(home);
    const local =
      store === 'sqlite'
        ? new SqliteLocalStore(join(home, 'decisions.db'))
        : new client.MemoryLocalStore();
    const sink = new RecordingSink();
    const refused = [];
    const errors = [];
    const delivered = [];
    const auditPath = join(auditDir, `${name}.jsonl`);
    const bridge = new client.DecisionsBridge({
      identity,
      store: local,
      sink,
      fetch: recordingFetch(refused),
      auditPath,
      ...(advisory
        ? {
            advisoryDeadlines: true,
            policy: new client.PolicyRegistry({ advisoryQuestions: true }),
          }
        : {}),
    });
    bridge.on('error', (e) => errors.push(String(e?.message ?? e)));
    bridge.on('delivered', (id) => delivered.push(id));
    await bridge.start({ socket });
    bridges.set(name, { bridge, store: local, sink, refused, errors, delivered, auditPath, pane });
    return { deviceId: identity.config.deviceId, features: [...(bridge.features ?? [])] };
  },

  /** `registerQuestion` as a host app calls it; a refusal is returned, not thrown. */
  async bridgeAsk({ name, input, awaitAdvisorySupport = false }) {
    const b = bridges.get(name);
    try {
      const r = await b.bridge.registerQuestion({
        origin: originOf(b.pane),
        input,
        ...(awaitAdvisorySupport ? { awaitAdvisorySupport: true } : {}),
      });
      await b.bridge.pump();
      return { asked: r };
    } catch (e) {
      return { refused: errorOf(e) };
    }
  },

  async bridgePump({ name }) {
    await bridges.get(name).bridge.pump();
    return true;
  },

  async bridgeView({ name, questionId }) {
    return JSON.parse(JSON.stringify(await bridges.get(name).bridge.getDecision(questionId)));
  },

  async bridgeState({ name }) {
    const b = bridges.get(name);
    let audit = [];
    try {
      audit = readFileSync(b.auditPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      /* no audit yet */
    }
    return {
      typed: b.sink.typed,
      refused: b.refused,
      errors: b.errors,
      delivered: b.delivered,
      cursor: await b.store.getCursor(),
      audit,
    };
  },

  async bridgeAgentStopped({ name }) {
    return bridges.get(name).bridge.requestAgentStoppedPush();
  },

  async bridgeStop({ name }) {
    const b = bridges.get(name);
    if (!b) return false;
    bridges.delete(name);
    await b.bridge.stop();
    await b.store.close?.();
    return true;
  },

  async phoneCandidate({ name, origin, installationId, pairingId, secret }) {
    const phone = new Phone(origin, installationId, `Compat ${name}`);
    phones.set(name, phone);
    return phone.candidate({ pairingId, secret });
  },
  phoneFinish: ({ name, ownerSigningPub }) => phones.get(name).finish({ ownerSigningPub }),
  phoneQuestion: ({ name, questionId, want, timeoutMs }) =>
    phones.get(name).question(questionId, want, timeoutMs),
  phoneAnswer: ({ name, ...a }) => phones.get(name).answer(a),
  phoneDecline: ({ name, ...a }) => phones.get(name).decline(a),
};

process.on('message', async ({ id, op, args }) => {
  try {
    if (!(op in ops)) throw new Error(`unknown op ${op}`);
    const value = await ops[op](args ?? {});
    process.send({ id, ok: true, value: value === undefined ? null : value });
  } catch (e) {
    process.send({ id, ok: false, error: { ...errorOf(e), stack: e?.stack ?? null } });
  }
});

process.on('disconnect', async () => {
  for (const name of [...bridges.keys()]) await ops.bridgeStop({ name }).catch(() => undefined);
  process.exit(0);
});
