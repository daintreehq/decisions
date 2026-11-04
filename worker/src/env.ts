import type { DecisionRoom } from './decision-room.js';

export interface Env {
  DECISION_ROOM: DurableObjectNamespace<DecisionRoom>;
  ATTACHMENTS: R2Bucket;
  ASSETS: Fetcher;
  /** One-time setup secret (Deploy-button prompt). Unusable once the relay is claimed. */
  CLAIM_SECRET?: string;
  XAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Dictation cleanup models, Daintree desktop's defaults: claude-haiku-5-5 (or claude-sonnet-5-5) and gpt-6.1-terra. */
  ANTHROPIC_CORRECTION_MODEL: string;
  OPENAI_CORRECTION_MODEL: string;
  /** VAPID `sub` (mailto: or https:). Empty means the relay's own https origin, recorded when it was claimed. */
  PUSH_SUBJECT: string;
  /** Comma-separated extra push-service host suffixes (self-hosted push gateways). */
  PUSH_ENDPOINT_ALLOW?: string;
  /** Soft monthly cap on proxied dictation minutes (default 600). */
  VOICE_MONTHLY_MINUTES?: string;
}

export const WORKER_VERSION = '0.4.0';
