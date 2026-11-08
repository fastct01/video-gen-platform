import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';

// One 256-bit key for encrypting secrets at rest. Changing ENCRYPTION_KEY (or URL_SIGNING_SECRET when
// ENCRYPTION_KEY is unset) makes stored provider keys unreadable; users then simply paste them again.
const key = createHash('sha256').update(`video-studio:enc:${config.ENCRYPTION_KEY ?? config.URL_SIGNING_SECRET}`).digest();

/** AES-256-GCM. Output: "v1:" + base64(iv | tag | ciphertext). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

/** Returns null if the value can't be decrypted (wrong key, tampered or unknown format). */
export function decryptSecret(stored: string): string | null {
  if (!stored.startsWith('v1:')) return null;
  try {
    const raw = Buffer.from(stored.slice(3), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * The Video Studio key for an account that signs in with a provider key. Deterministic, so pasting the
 * same Gemini key on another device signs into the same account with the same key.
 */
export function deriveLoginKey(providerKey: string): string {
  return `vk_${createHmac('sha256', key).update(`login:${providerKey}`).digest('base64url')}`;
}
