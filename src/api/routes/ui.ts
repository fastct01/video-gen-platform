import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { creditTokens, getBalance } from '../../db/billing.js';
import { pool, withTx } from '../../db/pool.js';
import { deriveLoginKey } from '../../lib/crypto.js';
import { errMsg, newApiKey, sha256 } from '../../lib/util.js';
import { keyHint, setUserGeminiKey, userGeminiKey } from '../../providers/user-keys.js';
import { ApiError } from '../../services/videos.js';

// Resolves to <project>/public/index.html from both src/api/routes (tsx) and dist/api/routes (built).
const INDEX_HTML = new URL('../../../public/index.html', import.meta.url);

/** The admin's own UI account, used when someone signs in to the UI with ADMIN_TOKEN. */
const ADMIN_UI_EMAIL = 'you@localhost.local';

const connectBody = z.object({ key: z.string().trim().min(1, 'paste a key').max(1000) });

interface User {
  id: string;
  email: string;
}

/** Serves the browser UI and signs people in with whatever key they have. */
export async function uiRoutes(app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    // Read on every request so edits to the page show up without restarting the server.
    const html = await readFile(INDEX_HTML, 'utf8');
    return reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());

  /**
   * Takes any key and works out what it is:
   *   1. a Video Studio user key (vk_...)  -> signs in to that account
   *   2. the ADMIN_TOKEN                   -> signs in to the admin's UI account
   *   3. a Gemini API key (checked live with Google) -> signs in to the account that owns that key, creating it
   *      on first use. If you're already signed in, the key is attached to your current account instead.
   *      The key is stored encrypted and only ever used for that account's videos.
   * Returns the user API key the browser should send as `Authorization: Bearer` (null = keep the current one).
   */
  app.post('/ui/connect', async (req) => {
    if (!connectLimiter.allow(req.ip)) {
      throw new ApiError(429, 'rate_limited', 'too many attempts — wait a few minutes and try again');
    }
    const { key } = connectBody.parse(req.body);
    if (!/^[\x21-\x7e]+$/.test(key)) {
      throw new ApiError(400, 'invalid_key', 'that key contains spaces or unusual characters — copy it again without extra text');
    }
    const current = await userFromAuthHeader(req);

    const owner = await userByKey(key);
    if (owner) return result('user', 'Video Studio key', key, owner);

    if (safeEqual(key, config.ADMIN_TOKEN)) {
      const s = current ? { apiKey: null, user: current } : await adminSession();
      return result('admin', 'Admin token', s.apiKey, s.user);
    }

    const looksGemini = /^AIza[\w-]{30,}$/.test(key);
    const check = await verifyGeminiKey(key);
    if (check.ok) {
      const s = await geminiSession(key, current);
      return result('gemini', 'Gemini API key', s.apiKey, s.user);
    }
    // Never log the key itself, only what Google said about it.
    req.log.warn({ googleStatus: check.status, googleReason: check.reason, googleMessage: check.raw }, 'gemini key check failed');
    if (check.unreachable) {
      throw new ApiError(502, 'verify_failed', `couldn't check the key with Google: ${check.message}`);
    }
    // A plain "not valid" on something that doesn't look like a Google key means it just isn't one of ours or Google's.
    if (!looksGemini && check.reason === 'API_KEY_INVALID') {
      throw new ApiError(
        400,
        'unrecognized_key',
        "couldn't recognize this key — it isn't a Video Studio key or the admin token, and Google didn't accept it as a Gemini API key",
      );
    }
    throw new ApiError(400, 'gemini_key_rejected', check.message, { googleStatus: check.status, reason: check.reason });
  });
}

async function result(kind: 'user' | 'admin' | 'gemini', label: string, apiKey: string | null, user: User) {
  const [balance, gemini] = await Promise.all([getBalance(user.id), userGeminiKey(user.id)]);
  return { kind, label, apiKey, email: user.email, balance, geminiKey: gemini ? { hint: keyHint(gemini) } : null };
}

/** Signs in to the admin's UI account, issuing it a fresh key. */
async function adminSession(): Promise<{ apiKey: string; user: User }> {
  const apiKey = newApiKey();
  const r = await pool.query<User>(
    `INSERT INTO users (email, api_key_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, updated_at = now()
     RETURNING id, email`,
    [ADMIN_UI_EMAIL, sha256(apiKey)],
  );
  const user = r.rows[0]!;
  if (config.LOCAL_USER_INITIAL_TOKENS > 0) {
    // Idempotent per reference: the grant happens once, when the account is first created.
    await creditTokens({ userId: user.id, amount: config.LOCAL_USER_INITIAL_TOKENS, reference: `local-user-${user.id}`, note: 'admin UI starting balance' });
  }
  return { apiKey, user };
}

/**
 * Signs in with a verified Gemini key. The key identifies the account (by its hash), so the same key on
 * another device opens the same account. Login key = deriveLoginKey(geminiKey), so it's the same everywhere.
 */
async function geminiSession(geminiKey: string, current: User | null): Promise<{ apiKey: string | null; user: User }> {
  return withTx(async (c) => {
    const found = await c.query<User>(`SELECT id, email FROM users WHERE gemini_key_hash = $1 FOR UPDATE`, [sha256(geminiKey)]);
    const existing = found.rows[0];

    if (existing && current?.id === existing.id) {
      await setUserGeminiKey(existing.id, geminiKey, c); // re-encrypt (e.g. after ENCRYPTION_KEY changed)
      return { apiKey: null, user: existing };
    }
    if (!existing && current) {
      await setUserGeminiKey(current.id, geminiKey, c); // attach to the signed-in account
      return { apiKey: null, user: current };
    }

    const apiKey = deriveLoginKey(geminiKey);
    let user = existing;
    if (user) {
      await c.query(`UPDATE users SET api_key_hash = $2, updated_at = now() WHERE id = $1`, [user.id, sha256(apiKey)]);
    } else {
      const r = await c.query<User>(
        `INSERT INTO users (email, api_key_hash) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, updated_at = now()
         RETURNING id, email`,
        [`gemini-${sha256(geminiKey).slice(0, 12)}@users.local`, sha256(apiKey)],
      );
      user = r.rows[0]!;
    }
    await setUserGeminiKey(user.id, geminiKey, c);
    return { apiKey, user };
  });
}

async function userByKey(key: string): Promise<User | null> {
  const r = await pool.query<User>(`SELECT id, email FROM users WHERE api_key_hash = $1`, [sha256(key)]);
  return r.rows[0] ?? null;
}

async function userFromAuthHeader(req: FastifyRequest): Promise<User | null> {
  const key = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  return key ? userByKey(key) : null;
}

/** Fixed-window limiter: stops the sign-in endpoint being used to guess keys or as a free Gemini-key checker. */
const connectLimiter = (() => {
  const WINDOW_MS = 10 * 60_000;
  const MAX = 20;
  const hits = new Map<string, { n: number; reset: number }>();
  return {
    allow(ip: string): boolean {
      const now = Date.now();
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      const h = hits.get(ip);
      if (!h || h.reset < now) {
        hits.set(ip, { n: 1, reset: now + WINDOW_MS });
        return true;
      }
      return ++h.n <= MAX;
    },
  };
})();

type GeminiCheck =
  | { ok: true }
  | { ok: false; unreachable: boolean; message: string; status?: number; reason?: string; raw?: string };

/** Lists models with the key: 200 = valid, 400/401/403 = rejected (explained), anything else = couldn't tell. */
async function verifyGeminiKey(key: string): Promise<GeminiCheck> {
  let res: Response;
  try {
    res = await fetch(`${config.GEMINI_BASE_URL}/v1beta/models?pageSize=1`, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, unreachable: true, message: errMsg(err) };
  }
  if (res.ok) return { ok: true };
  const body = await res.text().catch(() => '');
  const g = parseGoogleError(body);
  const raw = g.message || body.slice(0, 300) || `HTTP ${res.status}`;
  if (![400, 401, 403].includes(res.status)) {
    return { ok: false, unreachable: true, message: `Google answered HTTP ${res.status}: ${raw}`, status: res.status, raw };
  }
  return { ok: false, unreachable: false, message: explainGeminiKeyError(res.status, g, raw), status: res.status, reason: g.reason, raw };
}

interface GoogleError {
  message?: string;
  status?: string;
  reason?: string;
  metadata: Record<string, string>;
}

/** Google errors: { error: { code, message, status, details: [{ '@type': '...ErrorInfo', reason, metadata }] } } */
function parseGoogleError(body: string): GoogleError {
  try {
    const e = JSON.parse(body)?.error ?? {};
    const info = (e.details ?? []).find((d: { reason?: string }) => d?.reason) ?? {};
    return { message: e.message, status: e.status, reason: info.reason, metadata: info.metadata ?? {} };
  } catch {
    return { metadata: {} };
  }
}

const AI_STUDIO_KEYS = 'https://aistudio.google.com/apikey';

/** Turns Google's reason code into what's wrong with the key and how to fix it. */
function explainGeminiKeyError(httpStatus: number, g: GoogleError, raw: string): string {
  const project = (g.metadata.consumer ?? g.metadata.containerInfo ?? '').replace(/^projects\//, '');
  const enableUrl = `https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com${project ? `?project=${project}` : ''}`;
  const credsUrl = `https://console.cloud.google.com/apis/credentials${project ? `?project=${project}` : ''}`;
  const tag = g.reason ? ` [${g.reason}]` : '';

  if (/location is not supported/i.test(raw)) {
    return `Google says the Gemini API isn't available in your region, so this key can't be used from here${tag}.`;
  }
  switch (g.reason) {
    case 'API_KEY_INVALID':
      return `Google says this key isn't valid. Copy it again, or create a new one at ${AI_STUDIO_KEYS}${tag}.`;
    case 'SERVICE_DISABLED':
      return `The key is real, but the Gemini API ("Generative Language API") is turned off in its Google Cloud project${project ? ` (${project})` : ''}. Enable it at ${enableUrl}, wait a minute, then connect again${tag}.`;
    case 'API_KEY_SERVICE_BLOCKED':
      return `The key is real, but it's restricted to other Google APIs. Edit the key at ${credsUrl} and add "Generative Language API" under API restrictions, or create a key at ${AI_STUDIO_KEYS}${tag}.`;
    case 'API_KEY_HTTP_REFERRER_BLOCKED':
      return `The key only works from certain websites, so a server can't use it. Edit the key at ${credsUrl} and set Application restrictions to None (or this machine's IP)${tag}.`;
    case 'API_KEY_IP_ADDRESS_BLOCKED':
      return `The key only works from certain IP addresses, and this machine's isn't one of them. Edit the key at ${credsUrl}${tag}.`;
    case 'API_KEY_ANDROID_APP_BLOCKED':
    case 'API_KEY_IOS_APP_BLOCKED':
      return `The key is locked to a mobile app, so a server can't use it. Edit the key at ${credsUrl} or create one at ${AI_STUDIO_KEYS}${tag}.`;
    case 'CONSUMER_SUSPENDED':
    case 'PROJECT_DENIED':
    case 'BILLING_DISABLED':
      return `Google blocked the key's Cloud project${project ? ` (${project})` : ''}: ${raw}${tag}`;
  }
  if (httpStatus === 403) {
    return (
      `Google recognized the key but won't let it use the Gemini API ("${raw}"${tag}). ` +
      `This usually means the key was made in Google Cloud for another API or project. ` +
      `Easiest fix: create a key at ${AI_STUDIO_KEYS} and paste that.`
    );
  }
  return `Google didn't accept this key: ${raw}${tag}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
