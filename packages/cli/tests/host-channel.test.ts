import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  openHostChannel,
  parsePrefill,
  type HostResult,
} from '../src/host-channel.js';

const dir = mkdtempSync(join(tmpdir(), 'decisions-host-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const socketPath = () =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\decisions-host-test-${process.pid}-${n++}`
    : join(dir, `h${n++}.sock`);

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/**
 * A host that answers the CLI's hello with `onHello`, acknowledges a result with `ack`, and records
 * every message it gets.
 */
async function host(
  onHello: (sock: Socket, hello: Record<string, unknown>) => void,
  ack = '{"v":1,"type":"received"}\n',
) {
  const path = socketPath();
  const got: Record<string, unknown>[] = [];
  let sockRef: Socket | null = null;
  const server = createServer((sock) => {
    sockRef = sock;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
        buf = buf.slice(i + 1);
        got.push(msg);
        if (msg.type === 'hello') onHello(sock, msg);
        if (msg.type === 'result' && sock.writable) sock.write(ack);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, r));
  return { path, got, sock: () => sockRef };
}

const prefillLine = (answers: unknown) => JSON.stringify({ v: 1, type: 'prefill', answers }) + '\n';

const RESULT: HostResult = {
  status: 'completed',
  url: 'https://r.someone.workers.dev',
  claimSecret: 'c'.repeat(64),
  claimState: 'unclaimed',
};

describe('the host channel', () => {
  it('says hello, takes the prefill, and hands over the result once the host confirms it', async () => {
    const answers = {
      name: 'daintree-decisions-1a2b',
      transcription: { provider: 'xai' },
      cleanup: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      keys: { xai: ' xai-key ', anthropic: 'sk-ant-key', openai: '' },
    };
    const h = await host((sock) => {
      // Delivered in pieces, split inside a multi-byte character, as a stream may.
      const bytes = Buffer.from(prefillLine({ ...answers, bucket: 'bücket' }));
      const mid = bytes.indexOf(Buffer.from('ü')) + 1;
      sock.write(bytes.subarray(0, mid));
      setTimeout(() => sock.write(bytes.subarray(mid)), 5);
    });
    const ch = await openHostChannel(h.path, { cliVersion: '9.9.9' });
    expect(h.got[0]).toEqual({ v: 1, type: 'hello', cli: '9.9.9', versions: [1] });
    expect(ch.prefill).toEqual({
      name: 'daintree-decisions-1a2b',
      bucket: 'bücket',
      transcription: { provider: 'xai' },
      cleanup: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      keys: { xai: 'xai-key', anthropic: 'sk-ant-key' },
    });
    expect(ch.isOpen()).toBe(true);
    expect(await ch.sendResult(RESULT)).toBe(true);
    expect(h.got[1]).toEqual({
      v: 1,
      type: 'result',
      status: 'completed',
      url: RESULT.url,
      claim_secret: RESULT.claimSecret,
      claim_state: 'unclaimed',
    });
    expect(ch.isOpen()).toBe(false);
    // Once sent, nothing more goes out.
    expect(await ch.sendResult(RESULT)).toBe(false);
  });

  it('accepts an empty prefill', async () => {
    const h = await host((sock) => sock.write('{"v":1,"type":"prefill"}\n'));
    const ch = await openHostChannel(h.path, { cliVersion: '1.0.0' });
    expect(ch.prefill).toEqual({ keys: {} });
    ch.close();
  });

  it('answers a prefill it cannot accept with a failed result that never repeats a value', async () => {
    const h = await host((sock) =>
      sock.write(prefillLine({ transcription: { provider: 'deepgram' }, keys: { xai: 'k1' } })),
    );
    await expect(openHostChannel(h.path, { cliVersion: '1.0.0' })).rejects.toThrow(
      /invalid prefill: transcription.provider must be one of xai, openai/,
    );
    const r = h.got.find((m) => m.type === 'result')!;
    expect(r).toEqual({
      v: 1,
      type: 'result',
      status: 'failed',
      url: null,
      claim_secret: null,
      claim_state: 'unknown',
      error: expect.stringMatching(/transcription.provider must be one of/),
    });
    expect(JSON.stringify(r)).not.toContain('deepgram');
    expect(JSON.stringify(r)).not.toContain('k1');
  });

  it('refuses a contract version it does not speak, and says which it speaks', async () => {
    const h = await host((sock) => sock.write('{"v":2,"type":"prefill","answers":{}}\n'));
    await expect(openHostChannel(h.path, { cliVersion: '1.0.0' })).rejects.toThrow(
      /contract version 2; this CLI speaks 1/,
    );
    expect(h.got.find((m) => m.type === 'result')).toMatchObject({ status: 'failed' });
  });

  it('never repeats a malformed version, which could hold anything', async () => {
    const h = await host((sock) =>
      sock.write('{"v":{"key":"sk-hidden"},"type":"prefill","answers":{}}\n'),
    );
    const e = (await openHostChannel(h.path, { cliVersion: '1.0.0' }).catch((x) => x)) as Error;
    expect(e.message).toMatch(/contract version \(not a number\)/);
    expect(e.message + JSON.stringify(h.got)).not.toContain('sk-hidden');
  });

  it('fails clearly when nothing listens at the path', async () => {
    await expect(
      openHostChannel(join(dir, 'nobody.sock'), { cliVersion: '1.0.0' }),
    ).rejects.toThrow(/could not connect to the host app/);
  });

  it('gives up when the host never sends its prefill', async () => {
    const h = await host(() => {});
    await expect(
      openHostChannel(h.path, { cliVersion: '1.0.0', openTimeoutMs: 100 }),
    ).rejects.toThrow(/did not send its prefill in time/);
  });

  it('refuses a message over the size limit before parsing it, terminated or not', async () => {
    expect(MAX_MESSAGE_BYTES).toBe(64 * 1024);
    const big = 'x'.repeat(MAX_MESSAGE_BYTES + 10);
    for (const line of [`"${big}"\n`, `"${big}`]) {
      const h = await host((sock) => sock.write(line));
      await expect(openHostChannel(h.path, { cliVersion: '1.0.0' })).rejects.toThrow(/too long/);
    }
  });

  it('refuses a message that is not JSON', async () => {
    const h = await host((sock) => sock.write('{nope\n'));
    await expect(openHostChannel(h.path, { cliVersion: '1.0.0' })).rejects.toThrow(/not JSON/);
  });

  it('reports a result the host never confirms as not delivered', async () => {
    const path = socketPath();
    const server = createServer((sock) => {
      sock.on('error', () => {});
      sock.once('data', () => sock.write(prefillLine({})));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, r));
    const ch = await openHostChannel(path, { cliVersion: '1.0.0', resultTimeoutMs: 100 });
    expect(await ch.sendResult(RESULT)).toBe(false);
  });

  it.each([
    ['a receipt for another version', '{"v":2,"type":"received"}\n'],
    ['a receipt with no version', '{"type":"received"}\n'],
    ['some other message', '{"v":1,"type":"prefill"}\n'],
    ['something that is not JSON', 'ok\n'],
  ])('does not take %s as the receipt', async (_what, ack) => {
    const h = await host((sock) => sock.write(prefillLine({})), ack);
    const ch = await openHostChannel(h.path, { cliVersion: '1.0.0' });
    expect(await ch.sendResult(RESULT)).toBe(false);
    expect(h.got.map((m) => m.type)).toEqual(['hello', 'result']);
  });

  it('notices when the host closes the connection or speaks out of turn', async () => {
    const h = await host((sock) => sock.write(prefillLine({})));
    const ch = await openHostChannel(h.path, { cliVersion: '1.0.0' });
    // A receipt sent early is not a receipt for a result sent later.
    h.sock()!.write('{"v":1,"type":"received"}\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(ch.isOpen()).toBe(false);
    expect(await ch.sendResult(RESULT)).toBe(false);

    const h2 = await host((sock) => sock.write(prefillLine({})));
    const ch2 = await openHostChannel(h2.path, { cliVersion: '1.0.0' });
    h2.sock()!.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(ch2.isOpen()).toBe(false);
  });
});

describe('prefill validation', () => {
  it('takes every documented field', () => {
    expect(
      parsePrefill({
        name: 'n',
        bucket: 'b',
        account_id: 'a'.repeat(32),
        transcription: null,
        cleanup: null,
        keys: { openai: 'sk' },
      }),
    ).toEqual({
      name: 'n',
      bucket: 'b',
      accountId: 'a'.repeat(32),
      transcription: null,
      cleanup: null,
      keys: { openai: 'sk' },
    });
  });

  it.each([
    [{ surprise: true }, /unknown field surprise/],
    [{ keys: { deepgram: 'k' } }, /unknown field keys.deepgram/],
    [{ transcription: { provider: 'xai', model: 'x' } }, /unknown field transcription.model/],
    [{ cleanup: { provider: 'anthropic' } }, /cleanup.model is required/],
    [{ cleanup: { provider: 'gemini', model: 'm' } }, /cleanup.provider must be one of/],
    [{ keys: { xai: 'line\nbreak' } }, /keys.xai must be a single-line string/],
    [{ keys: { xai: 'k'.repeat(2000) } }, /keys.xai must be a single-line string/],
    [{ name: 5 }, /name must be a single-line string/],
    [['a'], /answers must be an object/],
  ])('refuses %j', (answers, re) => {
    expect(() => parsePrefill(answers)).toThrow(re);
  });

  it('never puts a value in its error', () => {
    const bad = { keys: { anthropic: 'sk-ant-secret\u0007' } };
    expect(() => parsePrefill(bad)).toThrow(/keys.anthropic must be a single-line string/);
    let message = '';
    try {
      parsePrefill(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('sk-ant-secret');
  });
});
