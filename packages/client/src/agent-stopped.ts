import {
  AgentStoppedPushResponse,
  InfoResponse,
  knownFeatures,
} from '@daintreehq/decisions-protocol';
import type { BridgeContext } from './context.js';
import { RelayError } from './errors.js';

/*
 * Agent-stopped pushes (docs/protocol.md section 11, `agent-stopped-push-v1`): the host app on the owner desktop asks
 * the relay to tell the person's phone that some agent stopped. The request names nothing (which agent, where, how
 * many or why all stay on the computer), and when to ask is the host's call. Each request is sent at most once and
 * never retried, whatever its outcome: a retry would turn a dropped stop into a late alert. Nothing is stored.
 */

export const AGENT_STOPPED_PUSH_FEATURE = 'agent-stopped-push-v1' as const;

/**
 * What came of one request. The relay's own outcomes (`AgentStoppedPushResponse`): `sent`, `failed`, `quiet-hours`,
 * `rate-limited`, `no-subscription`. And the library's: `unsupported` when the relay does not advertise
 * `agent-stopped-push-v1` (nothing was sent) or lists it without the route, and `dropped` when the request was not
 * sent or got no outcome: the relay could not be reached or refused it, its reply did not parse, or the bridge
 * stopped first. Every outcome is final; a push may still have gone out for a `dropped` whose reply was lost.
 */
export type AgentStoppedPushOutcome =
  AgentStoppedPushResponse['outcome'] | 'unsupported' | 'dropped';
export interface AgentStoppedPushResult {
  outcome: AgentStoppedPushOutcome;
}

/** A feature check or request that has not answered by then is dropped. */
const REQUEST_TIMEOUT_MS = 15_000;
/** How long a relay found without the feature is believed before `GET /info` is asked again. */
const RECHECK_MS = 10 * 60_000;

/** Asks the relay for agent-stopped pushes, only while it advertises them. */
export class AgentStoppedPusher {
  /** When the relay was last found without the feature (`ctx.now()`), or null. */
  private unsupportedAt: number | null = null;
  /** The feature check in flight, shared by requests made meanwhile. */
  private checking: Promise<boolean> | null = null;

  constructor(private readonly ctx: BridgeContext) {}

  /**
   * Ask for one push, unless the relay does not advertise the feature. `live` is checked just before sending: a
   * bridge that stopped while the relay was asked sends nothing. Never throws.
   */
  async request(live: () => boolean): Promise<AgentStoppedPushResult> {
    let supported: boolean;
    try {
      supported = await this.supported();
    } catch {
      return { outcome: 'dropped' };
    }
    if (!supported) return { outcome: 'unsupported' };
    if (!live()) return { outcome: 'dropped' };
    let reply: unknown;
    try {
      reply = await this.ctx.client.postAgentStoppedPush(REQUEST_TIMEOUT_MS);
    } catch (e) {
      // A relay that lists the feature without the route is left alone, as one that does not list it.
      if (e instanceof RelayError && e.status === 404) {
        this.unsupportedAt = this.ctx.now();
        return { outcome: 'unsupported' };
      }
      return { outcome: 'dropped' };
    }
    const parsed = AgentStoppedPushResponse.safeParse(reply);
    return { outcome: parsed.success ? parsed.data.outcome : 'dropped' };
  }

  /**
   * Whether the relay advertises `agent-stopped-push-v1` in `GET /info`, asked afresh for each request, so a relay
   * that stops listing it is not asked again. A relay found without it is believed for `RECHECK_MS` (less if the
   * clock moves back), so an upgraded one is picked up. A relay whose `/info` does not parse, or answers with a client
   * error, advertises nothing; a network failure or 5xx throws, and the request is dropped.
   */
  private supported(): Promise<boolean> {
    const at = this.unsupportedAt;
    if (at !== null) {
      const age = this.ctx.now() - at;
      if (age >= 0 && age < RECHECK_MS) return Promise.resolve(false);
    }
    this.checking ??= this.check().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async check(): Promise<boolean> {
    let value: boolean;
    try {
      const info = InfoResponse.safeParse(await this.ctx.client.info(REQUEST_TIMEOUT_MS));
      value = info.success && knownFeatures(info.data.features).has(AGENT_STOPPED_PUSH_FEATURE);
    } catch (e) {
      if (!(e instanceof RelayError) || e.retryable) throw e;
      value = false;
    }
    this.unsupportedAt = value ? null : this.ctx.now();
    return value;
  }
}
