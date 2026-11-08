import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { sha256 } from '../lib/util.js';
import { pool, type Db } from '../db/pool.js';
import { geminiWithKey } from './registry.js';
import type { VideoProvider } from './types.js';

/** The user's own Gemini key, or null if they haven't added one (or it can no longer be decrypted). */
export async function userGeminiKey(userId: string, db: Db = pool): Promise<string | null> {
  const r = await db.query<{ gemini_key_enc: string | null }>(`SELECT gemini_key_enc FROM users WHERE id = $1`, [userId]);
  const enc = r.rows[0]?.gemini_key_enc;
  return enc ? decryptSecret(enc) : null;
}

/** Gemini provider backed by the user's own key, if they have one. */
export async function ownGeminiProvider(userId: string, db: Db = pool): Promise<VideoProvider | null> {
  const key = await userGeminiKey(userId, db);
  return key ? geminiWithKey(key) : null;
}

export async function setUserGeminiKey(userId: string, key: string, db: Db = pool): Promise<void> {
  await db.query(`UPDATE users SET gemini_key_hash = $2, gemini_key_enc = $3, updated_at = now() WHERE id = $1`, [
    userId,
    sha256(key),
    encryptSecret(key),
  ]);
}

export async function removeUserGeminiKey(userId: string, db: Db = pool): Promise<boolean> {
  const r = await db.query(
    `UPDATE users SET gemini_key_hash = NULL, gemini_key_enc = NULL, updated_at = now() WHERE id = $1 AND gemini_key_enc IS NOT NULL`,
    [userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** "…AbC1" so people can tell which key is connected without it ever being shown in full. */
export function keyHint(key: string): string {
  return `…${key.slice(-4)}`;
}
