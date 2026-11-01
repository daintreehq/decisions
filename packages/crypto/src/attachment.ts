import {
  attachmentAadString,
  attachmentKeyInfo,
  base64UrlToBytes,
  bytesToBase64Url,
  utf8ToBytes,
} from '@daintree/decisions-protocol';
import { deriveAesKey, type EpochKey } from './envelope.js';
import { buf, randomBytes, sha256Hex, subtle } from './util.js';

export interface AttachmentBinding {
  installationId: string;
  questionId: string;
  attachmentId: string;
  keyEpoch: number;
}

export interface EncryptedAttachment {
  /** AES-GCM ciphertext+tag: exactly the bytes stored in R2. */
  ciphertext: Uint8Array;
  /** b64url 96-bit nonce; goes inside the encrypted attachment descriptor, not in R2. */
  nonce: string;
  sha256Plaintext: string;
  sha256Ciphertext: string;
}

/** Single-shot AES-GCM (bounded by the 20 MiB product limit; WebCrypto has no streaming AEAD). */
export async function encryptAttachment(
  epochKey: EpochKey,
  binding: AttachmentBinding,
  plaintext: Uint8Array,
): Promise<EncryptedAttachment> {
  const key = await deriveAesKey(epochKey.key, attachmentKeyInfo(binding), ['encrypt']);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(
    await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: buf(nonce),
        additionalData: buf(utf8ToBytes(attachmentAadString(binding))),
      },
      key,
      buf(plaintext),
    ),
  );
  return {
    ciphertext: ct,
    nonce: bytesToBase64Url(nonce),
    sha256Plaintext: await sha256Hex(plaintext),
    sha256Ciphertext: await sha256Hex(ct),
  };
}

export async function decryptAttachment(
  epochKey: EpochKey,
  binding: AttachmentBinding,
  nonceB64: string,
  ciphertext: Uint8Array,
  expectedPlaintextSha256?: string,
): Promise<Uint8Array> {
  const key = await deriveAesKey(epochKey.key, attachmentKeyInfo(binding), ['decrypt']);
  let pt: Uint8Array;
  try {
    pt = new Uint8Array(
      await subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: buf(base64UrlToBytes(nonceB64)),
          additionalData: buf(utf8ToBytes(attachmentAadString(binding))),
        },
        key,
        buf(ciphertext),
      ),
    );
  } catch {
    throw new Error('attachment decryption failed');
  }
  if (expectedPlaintextSha256 && (await sha256Hex(pt)) !== expectedPlaintextSha256) {
    throw new Error('attachment digest mismatch');
  }
  return pt;
}

/** Magic-byte sniff of the decrypted bytes; the relay cannot validate plaintext types. */
export function sniffImageMime(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length > 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'image/webp';
  return null;
}
