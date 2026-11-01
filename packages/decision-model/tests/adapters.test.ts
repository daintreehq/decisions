import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicAdapter, OpenAIAdapter } from '../src/adapters/api.js';
import { CommandAdapter, commandPresets } from '../src/adapters/command.js';
import {
  AdapterError,
  AdapterTimeoutError,
  ConsentRequiredError,
  TransientAdapterError,
} from '../src/adapters/types.js';
import { MODEL_OUTPUT_JSON_SCHEMA, type ModelPrompt } from '../src/prompt.js';

const prompt: ModelPrompt = {
  system: 'SYS',
  user: 'USER DATA',
  schema: MODEL_OUTPUT_JSON_SCHEMA,
  version: 'v',
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dm-cmd-'));
  const w = (n: string, src: string): string => {
    const p = join(dir, n);
    writeFileSync(p, src);
    return p;
  };
  w(
    'echo.mjs',
    `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write(JSON.stringify({len:d.length,hasSys:d.includes('SYS'),secret:process.env.SECRET_TOKEN??null,pane:process.env.DAINTREE_MCP_TOKEN??null,allowed:process.env.MY_ALLOWED??null,arg:process.argv[2]??null}))})`,
  );
  w(
    'sleep.mjs',
    `import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,grandchild:g.pid}));
process.stdin.resume();setInterval(()=>{},1000);`,
  );
  w('flood.mjs', `process.stdout.write('x'.repeat(2_000_000));setTimeout(()=>{},5000)`);
  w('fail.mjs', `process.stderr.write('boom happened');process.exit(3)`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const node = (
  script: string,
  extra: string[] = [],
  o: Partial<ConstructorParameters<typeof CommandAdapter>[0]> = {},
): CommandAdapter =>
  new CommandAdapter({ command: process.execPath, args: [join(dir, script), ...extra], ...o });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
};

describe('CommandAdapter', () => {
  it('writes the prompt to stdin and returns stdout, without a shell', async () => {
    const out = JSON.parse(await node('echo.mjs', ['{{model}}'], { model: 'm1' }).suggest(prompt));
    expect(out.hasSys).toBe(true);
    expect(out.len).toBeGreaterThan(10);
    expect(out.arg).toBe('m1');
    const meta = node('echo.mjs', ['$(touch /tmp/should-not-exist); echo hi']);
    expect(JSON.parse(await meta.suggest(prompt)).arg).toBe(
      '$(touch /tmp/should-not-exist); echo hi',
    );
    expect(existsSync('/tmp/should-not-exist')).toBe(false);
  });

  it('scrubs the environment to an allowlist', async () => {
    process.env.SECRET_TOKEN = 'leak-me';
    process.env.DAINTREE_MCP_TOKEN = 'pane-token';
    process.env.MY_ALLOWED = 'yes';
    try {
      const blocked = JSON.parse(await node('echo.mjs').suggest(prompt));
      expect(blocked.secret).toBeNull();
      expect(blocked.pane).toBeNull();
      expect(blocked.allowed).toBeNull();
      const allowed = JSON.parse(
        await node('echo.mjs', [], { envAllow: ['MY_ALLOWED'] }).suggest(prompt),
      );
      expect(allowed.allowed).toBe('yes');
      expect(allowed.secret).toBeNull();
      expect(allowed.pane).toBeNull();
    } finally {
      delete process.env.SECRET_TOKEN;
      delete process.env.DAINTREE_MCP_TOKEN;
      delete process.env.MY_ALLOWED;
    }
  });

  it('kills the whole process group on timeout', async () => {
    const pidFile = join(dir, 'pids-timeout.json');
    await expect(
      node('sleep.mjs', [pidFile], { timeoutMs: 400 }).suggest(prompt),
    ).rejects.toBeInstanceOf(AdapterTimeoutError);
    expect(await until(() => existsSync(pidFile))).toBe(true);
    const { pid, grandchild } = JSON.parse(readFileSync(pidFile, 'utf8'));
    expect(await until(() => !alive(pid) && !alive(grandchild))).toBe(true);
  });

  it('kills the process group on abort', async () => {
    const pidFile = join(dir, 'pids-abort.json');
    const ac = new AbortController();
    const p = node('sleep.mjs', [pidFile], { timeoutMs: 10_000 }).suggest(prompt, ac.signal);
    expect(await until(() => existsSync(pidFile))).toBe(true);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const { pid, grandchild } = JSON.parse(readFileSync(pidFile, 'utf8'));
    expect(await until(() => !alive(pid) && !alive(grandchild))).toBe(true);
    const pre = new AbortController();
    pre.abort();
    await expect(node('echo.mjs').suggest(prompt, pre.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('caps output size', async () => {
    await expect(node('flood.mjs', [], { maxOutputBytes: 10_000 }).suggest(prompt)).rejects.toThrow(
      /more than 10000 bytes/,
    );
  });

  it('reports non-zero exits without echoing much stderr, and missing binaries', async () => {
    await expect(node('fail.mjs').suggest(prompt)).rejects.toThrow(
      /exited with code 3: boom happened/,
    );
    const missing = new CommandAdapter({ command: join(dir, 'no-such-binary') });
    await expect(missing.suggest(prompt)).rejects.toBeInstanceOf(AdapterError);
  });

  it('ships overridable example presets', () => {
    expect(commandPresets.claude().id).toBe('command:claude');
    expect(commandPresets.codex({ command: 'my-codex' }).id).toBe('command:codex');
    expect(commandPresets.gemini().id).toBe('command:gemini');
  });
});

function fakeFetch(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, init: init! });
    return new Response(JSON.stringify(body), { status });
  };
  return { f, seen };
}

describe('AnthropicAdapter', () => {
  const decision = { action: 'abstain', selected_option_ids: [] };
  it('refuses to send anything without consent', async () => {
    const { f, seen } = fakeFetch(200, {});
    const a = new AnthropicAdapter({ apiKey: 'k', consentToSendHistory: false, fetch: f });
    await expect(a.suggest(prompt)).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(seen).toHaveLength(0);
  });
  it('uses the Messages API with forced tool use', async () => {
    const { f, seen } = fakeFetch(200, {
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', name: 'return_decision', input: decision },
      ],
    });
    const a = new AnthropicAdapter({ apiKey: 'sekret', consentToSendHistory: true, fetch: f });
    expect(a.modelId).toBe('claude-haiku-5-5');
    expect(JSON.parse(await a.suggest(prompt))).toEqual(decision);
    const req = seen[0]!;
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    const h = req.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sekret');
    expect(h['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(req.init.body as string);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'return_decision' });
    expect(body.tools[0].input_schema).toEqual(MODEL_OUTPUT_JSON_SCHEMA);
    expect(body.system).toBe('SYS');
  });
  it('classifies HTTP failures and never leaks response bodies', async () => {
    const mk = (s: number) =>
      new AnthropicAdapter({
        apiKey: 'k',
        consentToSendHistory: true,
        fetch: fakeFetch(s, { error: 'PROMPT ECHO secret text' }).f,
      });
    await expect(mk(429).suggest(prompt)).rejects.toBeInstanceOf(TransientAdapterError);
    await expect(mk(503).suggest(prompt)).rejects.toBeInstanceOf(TransientAdapterError);
    const err = await mk(400)
      .suggest(prompt)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(err).not.toBeInstanceOf(TransientAdapterError);
    expect((err as Error).message).not.toContain('PROMPT ECHO');
  });
  it('rejects replies without a structured decision and treats network errors as transient', async () => {
    const none = new AnthropicAdapter({
      apiKey: 'k',
      consentToSendHistory: true,
      fetch: fakeFetch(200, { content: [{ type: 'text', text: 'hi' }] }).f,
    });
    await expect(none.suggest(prompt)).rejects.toThrow(/no structured decision/);
    const down = new AnthropicAdapter({
      apiKey: 'k',
      consentToSendHistory: true,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(down.suggest(prompt)).rejects.toBeInstanceOf(TransientAdapterError);
  });
  it('times out', async () => {
    const slow = new AnthropicAdapter({
      apiKey: 'k',
      consentToSendHistory: true,
      timeoutMs: 30,
      fetch: (_u, init) =>
        new Promise((_r, rej) =>
          init!.signal!.addEventListener('abort', () => rej(new Error('x'))),
        ),
    });
    await expect(slow.suggest(prompt)).rejects.toBeInstanceOf(AdapterTimeoutError);
  });
});

describe('OpenAIAdapter', () => {
  it('requires a model and consent, and sends a strict json_schema format', async () => {
    expect(() => new OpenAIAdapter({ apiKey: 'k', consentToSendHistory: true } as never)).toThrow(
      /explicit model/,
    );
    const { f, seen } = fakeFetch(200, {
      choices: [{ message: { content: '{"action":"abstain"}' } }],
    });
    const a = new OpenAIAdapter({
      apiKey: 'k',
      model: 'some-model',
      consentToSendHistory: true,
      fetch: f,
    });
    expect(await a.suggest(prompt)).toBe('{"action":"abstain"}');
    const req = seen[0]!;
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect((req.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const body = JSON.parse(req.init.body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.model).toBe('some-model');
    const noConsent = new OpenAIAdapter({
      apiKey: 'k',
      model: 'm',
      consentToSendHistory: false,
      fetch: f,
    });
    await expect(noConsent.suggest(prompt)).rejects.toBeInstanceOf(ConsentRequiredError);
    const empty = new OpenAIAdapter({
      apiKey: 'k',
      model: 'm',
      consentToSendHistory: true,
      fetch: fakeFetch(200, { choices: [] }).f,
    });
    await expect(empty.suggest(prompt)).rejects.toThrow(/no content/);
  });
});
