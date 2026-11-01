import type { ModelPrompt } from '../prompt.js';
import { abortError, type DecisionModelAdapter } from './types.js';

export interface FakeAdapterOptions {
  id?: string;
  modelId?: string;
  delayMs?: number;
  responder: (prompt: ModelPrompt, call: number) => string | Promise<string>;
}

/** Deterministic adapter for tests and dry runs. Honors AbortSignal. */
export class FakeAdapter implements DecisionModelAdapter {
  readonly id: string;
  readonly modelId: string;
  readonly calls: ModelPrompt[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private readonly opts: FakeAdapterOptions;

  constructor(opts: FakeAdapterOptions) {
    this.opts = opts;
    this.id = opts.id ?? 'fake';
    this.modelId = opts.modelId ?? 'fake-model';
  }

  async suggest(prompt: ModelPrompt, signal?: AbortSignal): Promise<string> {
    this.calls.push(prompt);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (signal?.aborted) throw abortError();
      if (this.opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, this.opts.delayMs);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(abortError());
            },
            { once: true },
          );
        });
      }
      return await this.opts.responder(prompt, this.calls.length);
    } finally {
      this.inFlight--;
    }
  }
}
