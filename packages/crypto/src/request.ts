import {
  AUTH_SCHEME,
  PROTOCOL_VERSION,
  formatAuthHeader,
  normalizeQuery,
  requestSigningString,
  type ParsedAuthHeader,
} from '@daintreehq/decisions-protocol';
import { bytesToBase64Url } from '@daintreehq/decisions-protocol';
import { signString, verifyString } from './sign.js';
import { randomBytes, sha256Hex } from './util.js';

export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SignRequestInput {
  method: string;
  path: string;
  /** raw query string without "?"; will be normalised */
  query?: string;
  body?: Uint8Array | string | null;
  installationId: string;
  deviceId: string;
  signingKey: CryptoKey;
  now?: number;
}

export async function signRequest(
  i: SignRequestInput,
): Promise<{ authorization: string; bodySha256: string }> {
  const bodySha256 = i.body == null || i.body === '' ? EMPTY_BODY_SHA256 : await sha256Hex(i.body);
  const ts = i.now ?? Date.now();
  const nonce = bytesToBase64Url(randomBytes(16));
  const signature = await signString(
    i.signingKey,
    requestSigningString({
      method: i.method,
      path: i.path,
      query: normalizeQuery(i.query ?? ''),
      bodySha256,
      installationId: i.installationId,
      deviceId: i.deviceId,
      ts,
      nonce,
    }),
  );
  const h: ParsedAuthHeader = {
    v: PROTOCOL_VERSION,
    installationId: i.installationId,
    deviceId: i.deviceId,
    ts,
    nonce,
    signature,
  };
  return { authorization: formatAuthHeader(h), bodySha256 };
}

export async function verifyRequestSignature(args: {
  header: ParsedAuthHeader;
  method: string;
  path: string;
  query: string;
  bodySha256: string;
  devicePublicKey: CryptoKey;
}): Promise<boolean> {
  return verifyString(
    args.devicePublicKey,
    requestSigningString({
      method: args.method,
      path: args.path,
      query: normalizeQuery(args.query),
      bodySha256: args.bodySha256,
      installationId: args.header.installationId,
      deviceId: args.header.deviceId,
      ts: args.header.ts,
      nonce: args.header.nonce,
    }),
    args.header.signature,
  );
}

export { AUTH_SCHEME };
