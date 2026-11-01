/** Wire protocol major version. Unknown majors fail closed with `upgrade_required`. */
export const PROTOCOL_VERSION = 1 as const;
/** Minimum protocol version this implementation still understands. */
export const MIN_PROTOCOL_VERSION = 1 as const;
export const CRYPTO_VERSION = 1 as const;
export const CONTENT_VERSION = 1 as const;
/** The only crypto suite in v1. No silent mixed suites. */
export const CRYPTO_SUITE = 'P256-ECDH-HKDF-SHA256-A256GCM-ECDSA-P256' as const;
export const API_PREFIX = '/api/v1' as const;
