-- Bring-your-own-key: each user can attach their own Gemini API key. Videos made with it are
-- billed by Google to that key, so they cost 0 tokens here (videos.tokens_per_second = 0).
ALTER TABLE users
  ADD COLUMN gemini_key_hash text UNIQUE,   -- sha256(key): finds the account when someone signs in with their key
  ADD COLUMN gemini_key_enc  text;          -- AES-256-GCM ciphertext (src/lib/crypto.ts), never returned by the API

ALTER TABLE videos
  ADD COLUMN own_key boolean NOT NULL DEFAULT false;  -- generated with the owner's key, not the server's

-- Replaced by per-user keys: a single server-wide key pasted in the UI would bill everyone to one person.
DROP TABLE IF EXISTS app_settings;
