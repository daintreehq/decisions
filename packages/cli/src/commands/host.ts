import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import {
  FilePendingHostStore,
  acceptHostEnrollment,
  createHostRequest,
  decodeHostRequest,
  enrollHost,
  hostRequestCode,
  ownerFingerprint,
  verifyHostRequest,
} from '@daintreehq/decisions-client';
import {
  CliError,
  keyStoreFor,
  openRuntime,
  print,
  type Ctx,
  type GlobalOptions,
} from '../runtime.js';

function pendingStore(ctx: Ctx, g: GlobalOptions): FilePendingHostStore {
  const pass = g.passphraseEnv ? ctx.env[g.passphraseEnv] : undefined;
  if (g.passphraseEnv && !pass)
    throw new CliError(`environment variable ${g.passphraseEnv} is empty`);
  return new FilePendingHostStore(ctx.home, pass);
}

/** The blob comes from the argument, a file, or standard input (`-` or nothing). */
async function readBlob(
  ctx: Ctx,
  arg: string | undefined,
  file: string | undefined,
): Promise<string> {
  const text =
    file !== undefined
      ? await readFile(file, 'utf8')
      : arg !== undefined && arg !== '-'
        ? arg
        : await ctx.readStdin();
  if (!text.trim())
    throw new CliError('nothing to read: pass it as an argument, with a file, or on stdin');
  return text;
}

const fail = (e: unknown): never => {
  throw e instanceof CliError ? e : new CliError((e as Error).message);
};

/** On the Host: create (or re-print) the enrollment request. */
export async function hostRequest(
  ctx: Ctx,
  g: GlobalOptions,
  o: { label?: string; new?: boolean },
): Promise<void> {
  const r = await createHostRequest({
    pending: pendingStore(ctx, g),
    keyStore: keyStoreFor(ctx, g.passphraseEnv),
    label: o.label ?? hostname(),
    ...(o.new ? { fresh: true } : {}),
    now: ctx.now(),
  }).catch(fail);
  print(
    ctx,
    [
      `Enrollment request for this Host ("${r.parsed.label}", device ${r.parsed.device_id})${r.reused ? ' (same keys as before)' : ''}:`,
      '',
      r.request,
      '',
      `Code: ${r.code}`,
      '',
      'Its private keys stay on this machine. On the owner machine, run:',
      '  decisions host enroll <request>      (or pipe it in: decisions host enroll -)',
      'Check it shows the same code, then bring the response back here:',
      '  decisions host accept <response>',
    ].join('\n'),
    {
      request: r.request,
      device_id: r.parsed.device_id,
      label: r.parsed.label,
      code: r.code,
      reused: r.reused,
    },
  );
}

/** On the owner: check a Host's request, register it with the relay and print the response. */
export async function hostEnroll(
  ctx: Ctx,
  g: GlobalOptions,
  o: { request?: string; requestFile?: string; yes?: boolean },
): Promise<void> {
  const text = await readBlob(ctx, o.request, o.requestFile);
  const req = (() => {
    try {
      return decodeHostRequest(text);
    } catch (e) {
      return fail(e);
    }
  })();
  await verifyHostRequest(req, ctx.now()).catch(fail);
  const code = await hostRequestCode(req);
  const rt = await openRuntime(ctx, g);
  try {
    if (!o.yes) {
      ctx.err(`Host "${req.label}" (device ${req.device_id}) asks to be enrolled.`);
      ctx.err(`Code: ${code}`);
      const a = (await ctx.prompt('Does the Host show exactly this code? [y/N] ')).toLowerCase();
      if (a !== 'y' && a !== 'yes') throw new CliError('cancelled: the Host was not enrolled');
    }
    const out = await enrollHost(rt.client, req, { now: ctx.now() }).catch(fail);
    const fp = await ownerFingerprint(rt.identity.signingPub);
    print(
      ctx,
      [
        `✓ Enrolled "${out.label}" as a desktop-host (device ${out.deviceId}).`,
        '',
        'Give this response to the Host and run there: decisions host accept <response>',
        '',
        out.response,
        '',
        `Owner key fingerprint: ${fp}`,
        `Revoke it any time with: decisions revoke ${out.deviceId}`,
      ].join('\n'),
      {
        ok: true,
        response: out.response,
        device_id: out.deviceId,
        label: out.label,
        code: out.code,
        owner_fingerprint: fp,
      },
    );
  } finally {
    await rt.store.close();
  }
}

/** On the Host: check the owner's response and store it as this machine's identity. */
export async function hostAccept(
  ctx: Ctx,
  g: GlobalOptions,
  o: { response?: string; responseFile?: string; offline?: boolean },
): Promise<void> {
  const text = await readBlob(ctx, o.response, o.responseFile);
  const id = await acceptHostEnrollment({
    response: text,
    pending: pendingStore(ctx, g),
    keyStore: keyStoreFor(ctx, g.passphraseEnv),
    fetch: ctx.fetch,
    ...(o.offline ? { verifyWithRelay: false } : {}),
  }).catch(fail);
  const fp = await ownerFingerprint(id.owner.signingPub);
  print(
    ctx,
    [
      `✓ This machine is now the desktop-host "${id.config.label}" (device ${id.config.deviceId}).`,
      `  relay         ${id.config.relayOrigin}`,
      `  installation  ${id.config.installationId}`,
      `  owner key     ${fp}   (compare with the owner's output)`,
      `  content key   epoch ${id.currentEpoch}`,
      o.offline
        ? '  The relay was not contacted: run `decisions devices` to confirm it lists this Host.'
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    {
      ok: true,
      role: id.role,
      device_id: id.config.deviceId,
      relay: id.config.relayOrigin,
      installation_id: id.config.installationId,
      owner_device_id: id.owner.deviceId,
      owner_fingerprint: fp,
      key_epoch: id.currentEpoch,
    },
  );
}
