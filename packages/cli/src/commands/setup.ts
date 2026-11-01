import QRCode from 'qrcode';
import {
  RelayError,
  approveCandidate,
  claimRelay,
  createPairingInvite,
  localShortCode,
  revokeAndRotate,
  rotateEpoch,
  verifiedDevices,
  normalizeOrigin,
  importIdentity,
} from '@daintree/decisions-client';
import {
  CliError,
  keyStoreFor,
  openRuntime,
  print,
  type Ctx,
  type GlobalOptions,
} from '../runtime.js';

export async function setup(
  ctx: Ctx,
  g: GlobalOptions,
  o: { url: string; claimSecret?: string; label?: string },
): Promise<void> {
  const secret = o.claimSecret ?? ctx.env.DECISIONS_CLAIM_SECRET;
  if (!secret)
    throw new CliError('missing claim secret: pass --claim-secret or set DECISIONS_CLAIM_SECRET');
  const keyStore = keyStoreFor(ctx, g.passphraseEnv);
  let origin: string;
  try {
    origin = normalizeOrigin(o.url);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  const { identity, claim } = await claimRelay({
    origin,
    claimSecret: secret,
    label: o.label ?? 'Daintree',
    store: keyStore,
    fetch: ctx.fetch,
  });
  print(
    ctx,
    [
      `✓ Claimed ${origin}`,
      `  installation  ${identity.config.installationId}`,
      `  this device   ${identity.config.deviceId} (${identity.config.label})`,
      `  keys stored   ${ctx.home}`,
      '',
      'Next:',
      '  1. Back up your keys now:   decisions recovery export --out decisions-recovery.json',
      '     If every copy of these keys is lost, the encrypted data on Cloudflare cannot be recovered.',
      '  2. Pair your phone:          decisions pair',
      '  3. Start listening:          decisions listen   (or `decisions mcp` to also serve the HTTP MCP)',
    ].join('\n'),
    {
      ok: true,
      relay: origin,
      installation_id: identity.config.installationId,
      device_id: identity.config.deviceId,
      vapid_public_key: claim.vapid_public_key,
    },
  );
}

export async function pair(
  ctx: Ctx,
  g: GlobalOptions,
  o: { role: 'phone' | 'tablet'; pollMs?: number },
): Promise<void> {
  const rt = await openRuntime(ctx, g);
  try {
    const invite = await createPairingInvite(rt.client, o.role, ctx.now());
    const qr = await QRCode.toString(invite.url, { type: 'terminal', small: true });
    if (ctx.json) {
      ctx.out(
        JSON.stringify({
          url: invite.url,
          pairing_id: invite.pairingId,
          expires_at: new Date(invite.expiresAt).toISOString(),
        }),
      );
    } else {
      ctx.out('Scan this QR code with your phone camera, or open the link on the phone:\n');
      ctx.out(qr);
      ctx.out(invite.url + '\n');
      ctx.out(
        'On iPhone/iPad: open it in Safari, tap Share → Add to Home Screen, then open the app from the Home Screen to finish pairing (push notifications only work from there).',
      );
      ctx.out(
        `Waiting for the phone… (expires in ${Math.round((invite.expiresAt - ctx.now()) / 60000)} min)\n`,
      );
    }
    const poll = o.pollMs ?? 2000;
    while (ctx.now() < invite.expiresAt) {
      const { pending } = await rt.client.pendingPairings();
      const cand = pending.find((p) => p.pairing_id === invite.pairingId);
      if (cand) {
        // Recompute the code locally: never trust the relay to show the same value on both screens.
        const mine = await localShortCode(cand);
        if (mine !== cand.short_code) {
          await rt.client.rejectPairing(cand.pairing_id);
          throw new CliError(
            'the relay reported a different confirmation code than the one computed locally; pairing rejected',
          );
        }
        ctx.out(`A device wants to pair: "${cand.label}" (${cand.role})`);
        ctx.out(`Confirmation code: ${mine}`);
        const a = (
          await ctx.prompt('Does your phone show exactly this code? [y/N] ')
        ).toLowerCase();
        if (a === 'y' || a === 'yes') {
          await approveCandidate(rt.client, cand);
          ctx.out(
            `✓ Paired "${cand.label}". It can now answer questions. Revoke it any time with: decisions revoke ${cand.device_id}`,
          );
          return;
        }
        await rt.client.rejectPairing(cand.pairing_id);
        throw new CliError('pairing rejected: the codes did not match');
      }
      await new Promise((r) => setTimeout(r, poll));
    }
    throw new CliError(
      'the invitation expired before a phone connected; run `decisions pair` again',
    );
  } finally {
    await rt.store.close();
  }
}

export async function devices(ctx: Ctx, g: GlobalOptions): Promise<void> {
  const rt = await openRuntime(ctx, g);
  try {
    const list = await verifiedDevices(rt.client);
    const lines = list.map(
      (d) =>
        `${d.device_id}  ${d.role.padEnd(13)} ${d.label.padEnd(24)} ${d.revoked_at ? `revoked ${d.revoked_at}` : 'active'}${d.push_enabled ? '  push' : ''}${d.device_id === rt.identity.config.deviceId ? '  (this device)' : ''}`,
    );
    print(ctx, lines.length ? lines.join('\n') : 'No devices.', {
      devices: list.map((d) => ({
        device_id: d.device_id,
        role: d.role,
        label: d.label,
        revoked_at: d.revoked_at,
        push_enabled: d.push_enabled,
      })),
    });
  } finally {
    await rt.store.close();
  }
}

export async function revoke(
  ctx: Ctx,
  g: GlobalOptions,
  deviceId: string,
  o: { yes?: boolean },
): Promise<void> {
  const rt = await openRuntime(ctx, g);
  try {
    if (!o.yes) {
      const a = (
        await ctx.prompt(
          `Revoke device ${deviceId}? It loses access immediately and the content key is rotated. [y/N] `,
        )
      ).toLowerCase();
      if (a !== 'y' && a !== 'yes') throw new CliError('cancelled');
    }
    const next = await revokeAndRotate(rt.client, rt.keyStore, deviceId);
    print(
      ctx,
      `✓ Revoked ${deviceId}. Content key rotated to epoch ${next.currentEpoch}.\n  Note: anything that device already downloaded cannot be recalled; existing history stays under the old key.`,
      { ok: true, key_epoch: next.currentEpoch },
    );
  } finally {
    await rt.store.close();
  }
}

export async function rotate(ctx: Ctx, g: GlobalOptions): Promise<void> {
  const rt = await openRuntime(ctx, g);
  try {
    const next = await rotateEpoch(rt.client, rt.keyStore);
    print(ctx, `✓ Content key rotated to epoch ${next.currentEpoch}.`, {
      ok: true,
      key_epoch: next.currentEpoch,
    });
  } finally {
    await rt.store.close();
  }
}

export { RelayError, importIdentity };
