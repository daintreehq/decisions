import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import {
  exportPublicKey,
  generateDeviceKeys,
  newId,
  signPairingPop,
  signRequest,
} from '@daintreehq/decisions-crypto';
import {
  DecisionsBridge,
  FileKeyStore,
  MemoryLocalStore,
  RelayClient,
  approveCandidate,
  claimRelay,
  createPairingInvite,
  localShortCode,
  type LocateResult,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { CLAIM_SECRET, findChromium, startRelay, until, type RunningRelay } from './harness.js';

/**
 * Live dictation against the real providers: real Grok speech-to-text through the Worker's voice socket, and the
 * real Anthropic and OpenAI cleanups, end to end through the real PWA in Chromium with a fake microphone.
 *   DECISIONS_LIVE_VOICE=1 pnpm --filter @daintreehq/decisions-e2e test live-voice
 * Skipped unless that is set. Needs `pnpm build`, macOS `say`/`afconvert` (or DECISIONS_LIVE_VOICE_WAV, a 16 kHz
 * mono PCM16 WAV), and XAI_API_KEY, ANTHROPIC_API_KEY and OPENAI_API_KEY in the repository's `.dev.vars`, which
 * `wrangler dev` reads. Costs a few cents per run.
 */
const LIVE = process.env.DECISIONS_LIVE_VOICE === '1';
const chromiumPath = findChromium();
const PORT = 8797;

const SPOKEN =
  'Um, yeah, so the second one, I think. The durable object, because, uh, we need strong consistency for the rate limits.';

const QUESTION = {
  question: 'Which store should the rate limiter use?',
  context: 'The limiter counts requests per API key and resets every minute.',
  options: [
    { id: 'kv', label: 'Workers KV', description: 'Eventually consistent, cheap reads' },
    { id: 'do', label: 'Durable Object', description: 'Strongly consistent, one writer per key' },
  ],
};

/** Messy transcripts as Grok writes them, each answering a realistic question. */
const SAMPLES: {
  name: string;
  body: Record<string, unknown>;
}[] = [
  {
    name: 'short answer to a choice',
    body: {
      raw_transcript: 'yeah the second one',
      question: QUESTION.question,
      context: QUESTION.context,
      options: QUESTION.options.map(({ label, description }) => ({ label, description })),
    },
  },
  {
    name: 'rambling choice with a self-correction',
    body: {
      raw_transcript:
        "so I think we should go with the, the durable object one because, you know, we need strong consistency for the the session counts. No wait, for the rate limits. Okay yeah that's it.",
      question: QUESTION.question,
      options: QUESTION.options.map(({ label, description }) => ({ label, description })),
    },
  },
  {
    name: 'refusal with an instruction',
    body: {
      raw_transcript:
        "no don't delete them, um, just move them into a folder called archive and then regenerate the… the migrations",
      question:
        'Should I delete the old migration files in db/migrations before regenerating them?',
      options: [{ label: 'Approve' }, { label: 'Reject' }],
    },
  },
  {
    name: 'free text with technical words',
    body: {
      raw_transcript:
        'yes split it into like 4 shards and make sure the end to end ones run on their own shard and use the work tree setup from type script config',
      question:
        'The test suite takes 14 minutes on CI. Do you want me to split it into shards with the vitest shard flag?',
    },
  },
  {
    name: 'continuing a typed sentence',
    body: {
      raw_transcript: 'only after you run the type check and it passes',
      question: 'Can I merge the pull request?',
      options: [{ label: 'Approve' }, { label: 'Reject' }],
      preceding_text: 'Approve, but',
    },
  },
];

class Sink implements TerminalSink {
  async locate(o: QuestionOrigin): Promise<LocateResult> {
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
  async inject(_t: TerminalTarget, _text: string, _id: string) {
    return { outcome: 'delivered' as const, proof: 'live' };
  }
  async hasMarker() {
    return false;
  }
  async resume() {
    return null;
  }
}

/** A 16 kHz mono PCM16 WAV of the spoken answer, and its raw samples. */
function speech(dir: string): { wav: string; pcm: Uint8Array } {
  let wav = process.env.DECISIONS_LIVE_VOICE_WAV;
  if (!wav) {
    const aiff = join(dir, 'answer.aiff');
    wav = join(dir, 'answer.wav');
    execFileSync('say', ['-r', '185', '-o', aiff, SPOKEN]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  }
  const buf = readFileSync(wav);
  // Walk the RIFF chunks to the PCM data; afconvert puts a FLLR chunk before it.
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') return { wav, pcm: new Uint8Array(buf.subarray(at + 8, at + 8 + size)) };
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in the WAV');
}

/** A phone paired from Node, to sign the voice requests the PWA would send. */
async function pairNodePhone(origin: string, client: RelayClient) {
  const invite = await createPairingInvite(client, 'phone');
  const keys = await generateDeviceKeys(false);
  const deviceId = newId();
  const signingPub = await exportPublicKey(keys.signing.publicKey);
  const exchangePub = await exportPublicKey(keys.exchange.publicKey);
  const res = await fetch(`${origin}/api/v1/pairing/candidates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      pairing_id: invite.pairingId,
      secret: invite.payload.s,
      device_id: deviceId,
      label: 'Live voice phone',
      signing_pub: signingPub,
      exchange_pub: exchangePub,
      pop: await signPairingPop(keys.signing.privateKey, {
        pairingId: invite.pairingId,
        deviceId,
        exchangePub,
        signingPub,
      }),
    }),
  });
  if (res.status !== 201) throw new Error(`candidate failed: ${res.status} ${await res.text()}`);
  const cand = await until(
    async () =>
      (await client.pendingPairings()).pending.find((p) => p.pairing_id === invite.pairingId),
    20_000,
    'pending pairing',
  );
  expect(await localShortCode(cand)).toBe(cand.short_code);
  await approveCandidate(client, cand);
  return async (path: string, body: unknown) => {
    const text = JSON.stringify(body);
    const { authorization } = await signRequest({
      method: 'POST',
      path: `/api/v1${path}`,
      query: '',
      body: text,
      installationId: client.identity.config.installationId,
      deviceId,
      signingKey: keys.signing.privateKey,
    });
    return fetch(`${origin}/api/v1${path}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: text,
    });
  };
}

describe.skipIf(!LIVE)('live dictation: real Grok, Anthropic and OpenAI through the Worker', () => {
  let relay: RunningRelay;
  let client: RelayClient;
  let bridge: DecisionsBridge;
  let post: Awaited<ReturnType<typeof pairNodePhone>>;
  let audio: { wav: string; pcm: Uint8Array };
  let browser: Browser | undefined;

  beforeAll(async () => {
    audio = speech(mkdtempSync(join(tmpdir(), 'decisions-live-voice-')));
    relay = await startRelay(PORT);
    const info = (await (await fetch(`${relay.origin}/api/v1/info`)).json()) as {
      voice: Record<string, boolean>;
    };
    expect(info.voice, 'XAI_API_KEY, ANTHROPIC_API_KEY and OPENAI_API_KEY in .dev.vars').toEqual({
      xai: true,
      anthropic: true,
      openai: true,
    });
    const { identity } = await claimRelay({
      origin: relay.origin,
      claimSecret: CLAIM_SECRET,
      label: 'Live Mac',
      store: new FileKeyStore(mkdtempSync(join(tmpdir(), 'decisions-live-home-'))),
    });
    client = new RelayClient({ identity });
    bridge = new DecisionsBridge({
      identity,
      store: new MemoryLocalStore(),
      sink: new Sink(),
      client,
      pumpIntervalMs: 0,
    });
    await bridge.start();
    post = await pairNodePhone(relay.origin, client);
  });

  afterAll(async () => {
    await browser?.close();
    await bridge?.stop?.();
    await relay?.stop();
  });

  for (const provider of ['anthropic', 'openai'] as const) {
    it(`cleans up messy answers with ${provider}, reading the question as context`, async () => {
      for (const s of SAMPLES) {
        const started = performance.now();
        const res = await post('/voice/correct', {
          protocol_version: PROTOCOL_VERSION,
          provider,
          consent: true,
          transcriber: 'xai',
          language: 'en',
          asked_at: new Date(Date.now() - 90_000).toISOString(),
          ...s.body,
        });
        const ms = Math.round(performance.now() - started);
        const out = (await res.json()) as {
          result?: { corrected_text: string; uncertain_spans: unknown[]; warnings: string[] };
          model?: string;
          error?: unknown;
        };
        console.log(
          `[${provider} ${out.model ?? '-'} ${ms} ms] ${s.name}\n  heard:   ${String(s.body.raw_transcript)}\n  cleaned: ${out.result?.corrected_text ?? JSON.stringify(out)}` +
            (out.result?.uncertain_spans.length
              ? `\n  unsure:  ${JSON.stringify(out.result.uncertain_spans)}`
              : '') +
            (out.result?.warnings.length ? `\n  warnings: ${out.result.warnings.join(', ')}` : ''),
        );
        expect(res.status, s.name).toBe(200);
        expect(out.result!.corrected_text.length).toBeGreaterThan(0);
      }
    });
  }

  it('transcribes real speech with Grok through the voice socket, then cleans it up', async () => {
    const ses = await post('/voice/session', {
      protocol_version: PROTOCOL_VERSION,
      provider: 'xai',
      consent: true,
      keyterms: ['Durable Object', 'Workers KV', 'rate limiter'],
      language: 'en',
    });
    expect(ses.status).toBe(200);
    const { ticket, ws_path } = (await ses.json()) as { ticket: string; ws_path: string };
    const started = performance.now();
    const ws = new WebSocket(
      `${relay.origin.replace(/^http/, 'ws')}${ws_path}?ticket=${encodeURIComponent(ticket)}`,
    );
    ws.binaryType = 'arraybuffer';
    let readyMs = 0;
    const partials: string[] = [];
    const events: string[] = [];
    const done = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no transcript.done')), 60_000);
      ws.onmessage = async (ev) => {
        const m = JSON.parse(String(ev.data)) as {
          type: string;
          text?: string;
          is_final?: boolean;
          speech_final?: boolean;
        };
        if (m.type === 'transcript.partial' && m.is_final)
          events.push(`${m.speech_final ? 'speech_final' : 'final'}: ${m.text}`);
        if (m.type === 'transcript.created') {
          readyMs = Math.round(performance.now() - started);
          // Real time: 100 ms of 16 kHz PCM16 every 100 ms, then a second of silence and audio.done.
          for (let i = 0; i < audio.pcm.length; i += 3200) {
            ws.send(audio.pcm.slice(i, i + 3200));
            await new Promise((r) => setTimeout(r, 100));
          }
          for (let i = 0; i < 10; i++) ws.send(new Uint8Array(3200));
          ws.send(JSON.stringify({ type: 'audio.done' }));
        } else if (m.type === 'transcript.partial' && m.is_final) partials.push(m.text ?? '');
        else if (m.type === 'transcript.done') {
          clearTimeout(timer);
          resolve(m.text ?? '');
        } else if (m.type === 'error') reject(new Error(`provider error: ${m.text ?? ''}`));
      };
      ws.onerror = () => reject(new Error('socket error'));
    });
    // xAI's transcript.done can carry no text; the phone then joins the finals it collected, as here.
    const raw = (await done).trim() || partials.join(' ').trim();
    ws.close();
    console.log(
      `[grok] ready after ${readyMs} ms\n  ${events.join('\n  ')}\n  spoken: ${SPOKEN}\n  heard:  ${raw}`,
    );
    expect(raw.toLowerCase()).toContain('durable');

    for (const provider of ['anthropic', 'openai'] as const) {
      const t0 = performance.now();
      const res = await post('/voice/correct', {
        protocol_version: PROTOCOL_VERSION,
        provider,
        consent: true,
        raw_transcript: raw,
        transcriber: 'xai',
        language: 'en',
        ...QUESTION,
      });
      const out = (await res.json()) as { result: { corrected_text: string }; model: string };
      console.log(
        `[${provider} ${out.model} ${Math.round(performance.now() - t0)} ms] cleaned: ${out.result.corrected_text}`,
      );
      expect(res.status).toBe(200);
    }
  });

  it.skipIf(!chromiumPath)(
    'dictates an answer in the real PWA with a fake microphone, and goes back to what was said',
    async () => {
      browser = await chromium.launch({
        executablePath: chromiumPath!,
        headless: true,
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          `--use-file-for-fake-audio-capture=${audio.wav}%noloop`,
          '--autoplay-policy=no-user-gesture-required',
        ],
      });
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'allow',
        permissions: ['microphone'],
        locale: 'en-GB',
      });
      const page: Page = await context.newPage();
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(e.message));
      const corrections: { status: number; body: string; ms: number }[] = [];
      const sentAt = new Map<string, number>();
      page.on('request', (r) => {
        if (r.url().endsWith('/api/v1/voice/correct')) sentAt.set(r.url(), performance.now());
      });
      page.on('response', async (r) => {
        if (!r.url().endsWith('/api/v1/voice/correct')) return;
        corrections.push({
          status: r.status(),
          body: await r.text(),
          ms: Math.round(performance.now() - (sentAt.get(r.url()) ?? performance.now())),
        });
      });

      const invite = await createPairingInvite(client, 'phone');
      await page.goto(invite.url);
      await page.getByRole('button', { name: 'Pair this phone' }).click();
      await page.getByText('Confirm this code on your computer').waitFor({ timeout: 20_000 });
      const cand = await until(
        async () =>
          (await client.pendingPairings()).pending.find((p) => p.pairing_id === invite.pairingId),
        20_000,
        'pending pairing',
      );
      await approveCandidate(client, cand);
      await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });

      await page.goto(`${relay.origin}/settings`);
      // Ticking it opens the disclosure; dictation turns on only from the dialog.
      await page.getByLabel('Allow dictation').click();
      await page.getByRole('button', { name: 'I understand, turn on dictation' }).click();
      try {
        await page.getByLabel('Clean-up').waitFor({ timeout: 10_000 });
      } catch (e) {
        const shot = join(tmpdir(), 'decisions-live-voice-settings.png');
        await page.screenshot({ path: shot, fullPage: true });
        throw new Error(`dictation settings never appeared (screenshot: ${shot})`, { cause: e });
      }

      for (const [cleanup, label] of [
        ['anthropic', 'Claude Haiku'],
        ['openai', 'OpenAI'],
      ] as const) {
        await page.goto(`${relay.origin}/settings`);
        await page.getByLabel('Clean-up').selectOption({ label });
        await bridge.registerQuestion({
          origin: {
            host_id: 'host_live0001',
            pane_id: `pane-${cleanup}`,
            terminal_generation: 1,
            ownership_principal: 'principal-live',
            agent_incarnation: 'inc-live',
            agent_kind: 'claude-code',
            agent_session_id: `sess-${cleanup}`,
            project_id: 'proj',
            project_label: 'edge-api',
            worktree_id: 'wt',
            worktree_root: '/tmp/live',
            workflow_gate_id: null,
          } as never,
          input: {
            question: `${QUESTION.question} (${cleanup})`,
            context: QUESTION.context,
            kind: 'mixed',
            options: QUESTION.options,
          } as never,
        });
        await bridge.pump();
        await page.goto(`${relay.origin}/`);
        await page.getByText(`(${cleanup})`).first().click({ timeout: 30_000 });
        await page.locator('article.detail').waitFor({ timeout: 30_000 });

        const box = page.locator('textarea').first();
        await box.fill('');
        await page.getByRole('button', { name: 'Dictate' }).click();
        await page.getByRole('button', { name: 'Tap to finish' }).waitFor({ timeout: 20_000 });
        // The fake microphone plays the clip once from when capture starts; let it finish and settle.
        const seconds = audio.pcm.length / 32000;
        await page.waitForTimeout(Math.ceil(seconds * 1000) + 1500);
        await page.getByRole('button', { name: 'Tap to finish' }).click();
        const status = page.getByRole('status');
        await until(
          async () => {
            const t = (await status.allInnerTexts()).join(' ');
            return /Cleaned up|nothing to change|kept exactly|edited the text/.test(t) ? t : null;
          },
          60_000,
          'the clean-up to finish',
        );
        const message = (await status.allInnerTexts()).join(' ');
        const cleaned = await box.inputValue();
        const back = page.getByRole('button', { name: 'Use what I said' });
        const canGoBack = await back.isVisible();
        let heard = cleaned;
        if (canGoBack) {
          await back.click();
          heard = await box.inputValue();
        }
        const last = corrections.at(-1);
        console.log(
          `[pwa ${cleanup}${last ? ` ${last.ms} ms` : ''}] ${message}\n  heard:   ${heard}\n  cleaned: ${cleaned}`,
        );
        expect(message).toMatch(/Cleaned up/);
        expect(last?.status).toBe(200);
        expect(cleaned.toLowerCase()).toContain('durable');
        expect(canGoBack).toBe(true);
        expect(heard).not.toBe(cleaned);
        expect(heard.toLowerCase()).toContain('durable');
      }
      expect(problems).toEqual([]);
    },
  );
});
