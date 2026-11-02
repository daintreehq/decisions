import { chmod, readFile, writeFile } from 'node:fs/promises';
import { PROTOCOL_VERSION, type InfoResponse } from '@daintreehq/decisions-protocol';
import {
  RelayClient,
  RelayError,
  exportDecisions,
  exportRecoveryKit,
  importDecisions,
  importRecoveryKit,
  verifiedDevices,
  verifyRecoveryKit,
  loadIdentity,
} from '@daintreehq/decisions-client';
import {
  encryptAttachment,
  importEpochKey,
  newId,
  generateEpochKeyBytes,
  type RecoveryBundleFile,
} from '@daintreehq/decisions-crypto';
import {
  CliError,
  keyStoreFor,
  openRuntime,
  print,
  secretFromEnvOrPrompt,
  type Ctx,
  type GlobalOptions,
} from '../runtime.js';

export async function status(ctx: Ctx, g: GlobalOptions): Promise<void> {
  const rt = await openRuntime(ctx, g);
  try {
    const qs = await rt.store.listQuestions();
    const count = (s: string) => qs.filter((q) => q.local_status === s).length;
    const outbox = await rt.store.dueOutbox(Number.MAX_SAFE_INTEGER, 1000);
    let relay: { reachable: boolean; info?: InfoResponse; error?: string } = { reachable: false };
    try {
      relay = { reachable: true, info: await rt.client.info() };
    } catch (e) {
      relay = { reachable: false, error: (e as Error).message };
    }
    const data = {
      relay: rt.identity.config.relayOrigin,
      installation_id: rt.identity.config.installationId,
      device_id: rt.identity.config.deviceId,
      key_epoch: rt.identity.currentEpoch,
      reachable: relay.reachable,
      protocol: relay.info ? `${relay.info.protocol_min}-${relay.info.protocol_max}` : null,
      cursor: await rt.store.getCursor(),
      questions: {
        total: qs.length,
        queued: count('queued'),
        open: count('open'),
        proxy_answered: count('proxy-answered'),
        answered: count('human-answered'),
        cancelled: count('cancelled'),
        expired: count('expired'),
        publish_failed: count('publish-failed'),
      },
      needs_attention: qs
        .filter(
          (q) =>
            q.delivery_status === 'needs-attention' || q.delivery_status === 'delivery-uncertain',
        )
        .map((q) => ({
          question_id: q.question_id,
          alias: q.alias,
          status: q.delivery_status,
          error: q.error_code,
        })),
      unsent: outbox.length,
    };
    print(
      ctx,
      [
        `Relay          ${data.relay} (${data.reachable ? 'reachable' : `unreachable: ${relay.error}`})`,
        `Installation   ${data.installation_id}`,
        `This device    ${data.device_id}   key epoch ${data.key_epoch}`,
        `Event cursor   ${data.cursor}`,
        `Questions      ${data.questions.total} total · ${data.questions.queued} queued · ${data.questions.open} open · ${data.questions.proxy_answered} proxy-answered · ${data.questions.answered} answered`,
        `Unsent         ${data.unsent} item(s) waiting to publish`,
        ...data.needs_attention.map(
          (n) =>
            `! q-${n.alias} ${n.status} (${n.error ?? 'unknown'}): answer saved but not typed into the agent`,
        ),
      ].join('\n'),
      data,
    );
  } finally {
    await rt.store.close();
  }
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
}

/** End-to-end health check of a deployment. Never prints secrets. */
export async function doctor(ctx: Ctx, g: GlobalOptions, o: { url?: string }): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, warn = false) =>
    checks.push({ name, ok, detail, warn });
  let origin = o.url?.replace(/\/$/, '');
  let identity: Awaited<ReturnType<typeof loadIdentity>> | null = null;
  try {
    identity = await loadIdentity(keyStoreFor(ctx, g.passphraseEnv));
    origin ??= identity.config.relayOrigin;
  } catch {
    /* not set up yet: only unauthenticated checks run */
  }
  if (!origin) throw new CliError('pass --url <relay origin> (or run `decisions setup` first)');

  try {
    const t0 = ctx.now();
    const res = await ctx.fetch(`${origin}/health`);
    const body = (await res.json()) as { ok?: boolean };
    add('health', res.ok && body.ok === true, `HTTP ${res.status}`);
    const date = res.headers.get('date');
    if (date) {
      const skew = Math.abs(Date.parse(date) - (t0 + (ctx.now() - t0) / 2));
      add(
        'clock skew',
        skew < 30_000,
        `${Math.round(skew / 1000)} s`,
        skew >= 30_000 && skew < 120_000,
      );
    }
  } catch (e) {
    add('health', false, (e as Error).message);
  }

  let info: InfoResponse | null = null;
  try {
    const res = await ctx.fetch(`${origin}/api/v1/info`);
    info = (await res.json()) as InfoResponse;
    add(
      'protocol',
      info.protocol_min <= PROTOCOL_VERSION && PROTOCOL_VERSION <= info.protocol_max,
      `relay speaks ${info.protocol_min}–${info.protocol_max}, client ${PROTOCOL_VERSION}; worker ${info.worker_version}`,
    );
    add(
      'claimed',
      info.claimed,
      info.claimed
        ? 'owner installation claimed'
        : info.claim_configured
          ? 'not claimed yet: run `decisions setup`'
          : 'CLAIM_SECRET is not configured on the Worker',
      !info.claimed,
    );
    add(
      'voice providers',
      true,
      `xai ${info.voice.xai ? 'on' : 'off'} · anthropic ${info.voice.anthropic ? 'on' : 'off'} · openai ${info.voice.openai ? 'on' : 'off'} (optional)`,
    );
  } catch (e) {
    add('protocol', false, (e as Error).message);
  }

  if (identity && info?.claimed && identity.config.relayOrigin === origin) {
    const client = new RelayClient({ identity, fetch: ctx.fetch, maxRetries: 1 });
    try {
      const list = await verifiedDevices(client);
      add('signed request', true, `${list.filter((d) => !d.revoked_at).length} active device(s)`);
    } catch (e) {
      add(
        'signed request',
        false,
        e instanceof RelayError ? `${e.code}: ${e.message}` : (e as Error).message,
      );
    }
    try {
      const t = await client.socketTicket();
      const url =
        origin.replace(/^http/, 'ws') + `${t.ws_path}?ticket=${encodeURIComponent(t.ticket)}`;
      const ok = await new Promise<boolean>((resolve) => {
        const WS = ctx.webSocket
          ? null
          : (globalThis as { WebSocket?: new (u: string) => WebSocket }).WebSocket;
        const ws = ctx.webSocket ? ctx.webSocket(url) : new WS!(url);
        const timer = setTimeout(() => (ws.close(), resolve(false)), 8000);
        (ws as WebSocket).onmessage = (ev: MessageEvent) => {
          try {
            if ((JSON.parse(String(ev.data)) as { t?: string }).t === 'hello') {
              clearTimeout(timer);
              ws.close(1000);
              resolve(true);
            }
          } catch {
            /* ignore non-JSON frames */
          }
        };
        (ws as WebSocket).onerror = () => (clearTimeout(timer), resolve(false));
      });
      add(
        'websocket',
        ok,
        ok ? 'upgrade + hello received' : 'could not open the hibernatable socket',
      );
    } catch (e) {
      add('websocket', false, (e as Error).message);
    }
    try {
      const epoch = await importEpochKey(generateEpochKeyBytes(), 1, false);
      const questionId = newId();
      const attachmentId = newId();
      const data = new Uint8Array(64).map((_, i) => (i * 7) & 255);
      const enc = await encryptAttachment(
        epoch,
        { installationId: identity.config.installationId, questionId, attachmentId, keyEpoch: 1 },
        data,
      );
      const sha = enc.sha256Ciphertext;
      const r = await client.reserveAttachment({
        idempotency_key: newId(),
        question_id: questionId,
        ciphertext_bytes: enc.ciphertext.length,
        sha256_ciphertext: sha,
        attachment_id: attachmentId,
      });
      await client.uploadAttachment(r.upload_path, enc.ciphertext, sha);
      await client.completeAttachment(attachmentId);
      const back = await client.downloadAttachment(attachmentId);
      const same =
        back.length === enc.ciphertext.length && back.every((b, i) => b === enc.ciphertext[i]);
      add(
        'R2 round trip',
        same,
        same
          ? 'encrypted test object stored and read back (the relay purges the unused reservation)'
          : 'downloaded bytes differ',
      );
    } catch (e) {
      add(
        'R2 round trip',
        false,
        e instanceof RelayError ? `${e.code}: ${e.message}` : (e as Error).message,
      );
    }
    try {
      const p = await client.pushConfig();
      add('push (VAPID)', p.vapid_public_key.length === 87, 'VAPID public key present');
    } catch (e) {
      add('push (VAPID)', false, (e as Error).message);
    }
  } else if (!identity) {
    add('local identity', false, 'not set up on this machine (authenticated checks skipped)', true);
  }

  const failed = checks.filter((c) => !c.ok && !c.warn);
  print(
    ctx,
    checks
      .map((c) => `${c.ok ? '✓' : c.warn ? '!' : '✗'} ${c.name.padEnd(16)} ${c.detail}`)
      .join('\n') +
      (failed.length ? `\n\n${failed.length} check(s) failed.` : '\n\nAll checks passed.'),
    { ok: failed.length === 0, checks },
  );
  if (failed.length) throw new CliError('doctor found problems', 1);
}

export async function exportCmd(
  ctx: Ctx,
  g: GlobalOptions,
  o: { out?: string; plaintext?: boolean },
): Promise<void> {
  const rt = await openRuntime(ctx, g);
  try {
    const devices = (await verifiedDevices(rt.client).catch(() => [])).map((d) => ({
      device_id: d.device_id,
      role: d.role,
      label: d.label,
      signing_pub: d.cert.signing_pub,
      exchange_pub: d.cert.exchange_pub,
      revoked_at: d.revoked_at,
    }));
    if (o.plaintext)
      ctx.err(
        'warning: writing an UNENCRYPTED export. Anyone with the file can read your decisions.',
      );
    const passphrase = o.plaintext
      ? undefined
      : await secretFromEnvOrPrompt(
          ctx,
          'DECISIONS_EXPORT_PASSPHRASE',
          'Export passphrase (min 12 chars): ',
          true,
        );
    const res = await exportDecisions({
      store: rt.store,
      identity: rt.identity,
      devices,
      ...(o.plaintext ? { plaintext: true } : { passphrase: passphrase! }),
      now: new Date(ctx.now()),
    });
    const path = o.out ?? res.fileName;
    await writeFile(path, res.encrypted ? JSON.stringify(res.data) : res.data, { mode: 0o600 });
    print(ctx, `✓ Wrote ${path} (${res.encrypted ? 'encrypted' : 'PLAINTEXT'})`, {
      ok: true,
      path,
      encrypted: res.encrypted,
    });
  } finally {
    await rt.store.close();
  }
}

export async function importCmd(ctx: Ctx, g: GlobalOptions, file: string): Promise<void> {
  const rt = await openRuntime(ctx, g);
  try {
    const raw = await readFile(file);
    const head = raw.subarray(0, 2).toString('latin1');
    let r;
    if (head === 'PK')
      r = await importDecisions({ zip: new Uint8Array(raw) }, rt.store, rt.identity);
    else {
      const passphrase = await secretFromEnvOrPrompt(
        ctx,
        'DECISIONS_EXPORT_PASSPHRASE',
        'Export passphrase: ',
      );
      r = await importDecisions(
        { encrypted: JSON.parse(raw.toString('utf8')) as RecoveryBundleFile, passphrase },
        rt.store,
        rt.identity,
      );
    }
    print(
      ctx,
      `✓ Imported ${r.imported} decision(s), skipped ${r.skipped}. Imported records are history only and are never typed into a terminal.`,
      { ok: true, ...r },
    );
  } catch (e) {
    throw e instanceof CliError ? e : new CliError((e as Error).message);
  } finally {
    await rt.store.close();
  }
}

export async function recoveryExport(
  ctx: Ctx,
  g: GlobalOptions,
  o: { out: string },
): Promise<void> {
  const store = keyStoreFor(ctx, g.passphraseEnv);
  const passphrase = await secretFromEnvOrPrompt(
    ctx,
    'DECISIONS_RECOVERY_PASSPHRASE',
    'Recovery passphrase (min 12 chars, store it somewhere safe): ',
    true,
  );
  const kit = await exportRecoveryKit(store, passphrase).catch((e) => {
    throw new CliError((e as Error).message);
  });
  await writeFile(o.out, JSON.stringify(kit), { mode: 0o600 });
  // `mode` only applies to a new file: an existing one keeps its permissions unless tightened here.
  await chmod(o.out, 0o600);
  print(
    ctx,
    `✓ Wrote ${o.out}.\n  Keep the file AND the passphrase somewhere safe, separately. If all copies of your keys are lost, the data on Cloudflare cannot be decrypted.`,
    { ok: true, path: o.out },
  );
}

export async function recoveryVerify(ctx: Ctx, file: string): Promise<void> {
  const kit = JSON.parse(await readFile(file, 'utf8')) as RecoveryBundleFile;
  const passphrase = await secretFromEnvOrPrompt(
    ctx,
    'DECISIONS_RECOVERY_PASSPHRASE',
    'Recovery passphrase: ',
  );
  try {
    const v = await verifyRecoveryKit(kit, passphrase);
    print(
      ctx,
      `✓ Recovery kit is valid (installation ${v.installationId}, key epochs ${v.epochs.join(', ')}). Nothing was installed.`,
      v,
    );
  } catch (e) {
    throw new CliError(`recovery kit check failed: ${(e as Error).message}`);
  }
}

export async function recoveryImport(
  ctx: Ctx,
  g: GlobalOptions,
  file: string,
  o: { overwrite?: boolean },
): Promise<void> {
  const kit = JSON.parse(await readFile(file, 'utf8')) as RecoveryBundleFile;
  const passphrase = await secretFromEnvOrPrompt(
    ctx,
    'DECISIONS_RECOVERY_PASSPHRASE',
    'Recovery passphrase: ',
  );
  try {
    const id = await importRecoveryKit(
      keyStoreFor(ctx, g.passphraseEnv),
      kit,
      passphrase,
      o.overwrite ? { overwrite: true } : {},
    );
    print(
      ctx,
      `✓ Restored identity for ${id.config.relayOrigin}. Re-pair phones only if they were revoked; existing pairings keep working.`,
      { ok: true, installation_id: id.config.installationId },
    );
  } catch (e) {
    throw new CliError((e as Error).message);
  }
}

export async function deleteData(
  ctx: Ctx,
  g: GlobalOptions,
  o: { scope: 'questions' | 'everything'; yes?: boolean },
): Promise<void> {
  const rt = await openRuntime(ctx, g);
  try {
    if (!o.yes) {
      const a = await ctx.prompt(
        `This permanently deletes ${o.scope === 'everything' ? 'ALL relay data including paired devices' : 'all questions, answers and attachments'} on the relay. Type DELETE to confirm: `,
      );
      if (a !== 'DELETE') throw new CliError('cancelled');
    }
    await rt.client.deleteData(o.scope);
    print(
      ctx,
      `✓ Deleted relay data (${o.scope}). Local history on this machine is unchanged; it is not deleted by this command.`,
      { ok: true, scope: o.scope },
    );
  } finally {
    await rt.store.close();
  }
}
