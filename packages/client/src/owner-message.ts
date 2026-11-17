import type { ProtocolFeature } from '@daintreehq/decisions-protocol';

/*
 * The person's follow-up written on the owner desktop (protocol section 16): a host app (Daintree) signs it with the
 * owner desktop's key as the person's thread message and publishes it through the outbox. It goes to the owner's own
 * questions and a Remote Host's alike, so nothing here needs a local question row.
 */

/**
 * The feature a desktop declares to take the person's follow-up signed by the owner desktop, and a relay advertises to
 * commit one (docs/protocol.md sections 16 and 19). The relay commits one only on a question whose desktop declared it.
 */
export const OWNER_MESSAGE_FEATURE: ProtocolFeature = 'owner-desktop-messages-v1';
