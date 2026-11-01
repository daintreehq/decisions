import type { ModelPrompt } from '../prompt.js';
import {
  AdapterError,
  AdapterTimeoutError,
  ConsentRequiredError,
  TransientAdapterError,
  abortError,
  type DecisionModelAdapter,
} from './types.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ApiBase {
  apiKey: string;
  /** Required: API adapters send questions and history excerpts to a third party. */
  consentToSendHistory: boolean;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

async function post(
  f: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  if (signal?.aborted) throw abortError();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (res.status === 429 || res.status >= 500)
      throw new TransientAdapterError(`provider returned HTTP ${res.status}`);
    // Never surface the response body: error payloads may echo prompt content.
    if (!res.ok) throw new AdapterError(`provider returned HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new AdapterTimeoutError();
    throw new TransientAdapterError(`network error calling provider: ${(e as Error).name}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface AnthropicAdapterOptions extends ApiBase {
  maxTokens?: number;
}

/** Anthropic Messages API with forced tool use so the reply is always a JSON object matching the schema. */
export class AnthropicAdapter implements DecisionModelAdapter {
  readonly id: string;
  readonly modelId: string;
  private readonly o: AnthropicAdapterOptions;

  constructor(opts: AnthropicAdapterOptions) {
    this.o = opts;
    this.modelId = opts.model ?? 'claude-haiku-5-5';
    this.id = `anthropic:${this.modelId}`;
  }

  async suggest(prompt: ModelPrompt, signal?: AbortSignal): Promise<string> {
    if (this.o.consentToSendHistory !== true) throw new ConsentRequiredError();
    const json = (await post(
      this.o.fetch ?? fetch,
      `${this.o.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
      { 'x-api-key': this.o.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: this.modelId,
        max_tokens: this.o.maxTokens ?? 1024,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        tools: [
          {
            name: 'return_decision',
            description: 'Return the predicted decision as structured JSON.',
            input_schema: prompt.schema,
          },
        ],
        tool_choice: { type: 'tool', name: 'return_decision' },
      },
      this.o.timeoutMs ?? 60_000,
      signal,
    )) as { content?: { type: string; name?: string; input?: unknown }[] };
    const block = json.content?.find((c) => c.type === 'tool_use' && c.name === 'return_decision');
    if (!block || typeof block.input !== 'object' || block.input === null) {
      throw new AdapterError('provider reply contained no structured decision');
    }
    return JSON.stringify(block.input);
  }
}

export interface OpenAIAdapterOptions extends ApiBase {
  /** Required: pick a current model from your OpenAI account; no default is assumed. */
  model: string;
}

/** OpenAI chat completions with a strict json_schema response format. */
export class OpenAIAdapter implements DecisionModelAdapter {
  readonly id: string;
  readonly modelId: string;
  private readonly o: OpenAIAdapterOptions;

  constructor(opts: OpenAIAdapterOptions) {
    if (!opts.model) throw new Error('OpenAIAdapter requires an explicit model');
    this.o = opts;
    this.modelId = opts.model;
    this.id = `openai:${opts.model}`;
  }

  async suggest(prompt: ModelPrompt, signal?: AbortSignal): Promise<string> {
    if (this.o.consentToSendHistory !== true) throw new ConsentRequiredError();
    const json = (await post(
      this.o.fetch ?? fetch,
      `${this.o.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`,
      { authorization: `Bearer ${this.o.apiKey}` },
      {
        model: this.modelId,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'decision', strict: true, schema: prompt.schema },
        },
      },
      this.o.timeoutMs ?? 60_000,
      signal,
    )) as { choices?: { message?: { content?: string | null; refusal?: string | null } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content)
      throw new AdapterError('provider reply contained no content');
    return content;
  }
}
