import type { ModelPrompt } from '../prompt.js';

export interface DecisionModelAdapter {
  /** Stable identifier; part of the cache key. */
  readonly id: string;
  /** Reported as `model_id` on outcomes. */
  readonly modelId?: string;
  /** Returns the model's raw text reply (expected to be one JSON object). */
  suggest(prompt: ModelPrompt, signal?: AbortSignal): Promise<string>;
}

export class AdapterError extends Error {
  readonly transient: boolean = false;
  constructor(message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

/** Network blips, HTTP 429/5xx: the only failures the engine retries. */
export class TransientAdapterError extends AdapterError {
  override readonly transient: boolean = true;
  constructor(message: string) {
    super(message);
    this.name = 'TransientAdapterError';
  }
}

export class AdapterTimeoutError extends AdapterError {
  constructor(message = 'model call timed out') {
    super(message);
    this.name = 'AdapterTimeoutError';
  }
}

export class ConsentRequiredError extends AdapterError {
  constructor() {
    super(
      'consentToSendHistory must be true before history or questions are sent to a cloud model',
    );
    this.name = 'ConsentRequiredError';
  }
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
