import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { errMsg } from '../lib/util.js';
import { setGeminiKey } from './registry.js';

export const GEMINI_KEY_SETTING = 'gemini_api_key';

export async function getSetting(name: string): Promise<string | undefined> {
  const r = await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE name = $1`, [name]);
  return r.rows[0]?.value;
}

export async function setSetting(name: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (name, value) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [name, value],
  );
}

/** Applies settings saved from the UI to this process's provider registry. A key saved in the UI wins over .env. */
export async function syncProviderSettings(): Promise<void> {
  setGeminiKey((await getSetting(GEMINI_KEY_SETTING)) ?? config.GEMINI_API_KEY);
}

/** Syncs now, then every intervalMs, so keys entered in the UI reach every API and worker process. */
export async function startProviderSettingsSync(intervalMs = 3000): Promise<() => void> {
  let warned = false;
  const run = () =>
    syncProviderSettings().then(
      () => (warned = false),
      (err) => {
        if (!warned) console.error('[settings] could not load app_settings (run `npm run migrate`?):', errMsg(err));
        warned = true;
      },
    );
  await run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
