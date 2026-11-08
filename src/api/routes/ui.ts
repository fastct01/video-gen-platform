import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { creditTokens, getBalance } from '../../db/billing.js';
import { pool } from '../../db/pool.js';
import { errMsg, newApiKey, sha256 } from '../../lib/util.js';
import { listProviders, setGeminiKey } from '../../providers/registry.js';
import { GEMINI_KEY_SETTING, setSetting } from '../../providers/settings.js';
import { ApiError } from '../../services/videos.js';

// Resolves to <project>/public/index.html from both src/api/routes (tsx) and dist/api/routes (built).
const INDEX_HTML = new URL('../../../public/index.html', import.meta.url);

/** The account the browser UI uses when it's connected with a provider key or the admin token. */
const LOCAL_USER_EMAIL = 'you@localhost.local';

const connectBody = z.object({ key: z.string().trim().min(1, 'paste a key').max(1000) });

interface User {
  id: string;
  email: string;
}

/** Serves the browser UI and lets it connect with whatever key the user has. */
export async function uiRoutes(app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    // Read on every request so edits to the page show up without restarting the server.
    const html = await readFile(INDEX_HTML, 'utf8');
    return reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());

  /**
   * Takes any key and works out what it is:
   *   1. a Video Studio user key (vk_...)  -> use it as is
   *   2. the ADMIN_TOKEN                   -> sign in as the local user
   *   3. a Gemini API key (checked live with Google) -> saved for every process, sign in as the local user
   * Returns the user API key the browser should send as `Authorization: Bearer` (null = keep the current one).
   * Only accepted from this machine, because it can save provider keys and mint a user key.
   */
  app.post('/ui/connect', async (req) => {
    if (!isLoopback(req.ip)) throw new ApiError(403, 'forbidden', 'keys can only be connected from the machine running the server');
    const { key } = connectBody.parse(req.body);
    if (!/^[\x21-\x7e]+$/.test(key)) {
      throw new ApiError(400, 'invalid_key', 'that key contains spaces or unusual characters — copy it again without extra text');
    }
    const current = await userFromAuthHeader(req);

    const owner = await userByKey(key);
    if (owner) return result('user', 'Video Studio key', key, owner);

    if (safeEqual(key, config.ADMIN_TOKEN)) {
      const s = await session(current);
      return result('admin', 'Admin token', s.apiKey, s.user);
    }

    const looksGemini = /^AIza[\w-]{30,}$/.test(key);
    const check = await verifyGeminiKey(key);
    if (check.ok) {
      await setSetting(GEMINI_KEY_SETTING, key);
      setGeminiKey(key); // this process now; workers pick it up from app_settings within a few seconds
      const s = await session(current);
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
  return {
    kind,
    label,
    apiKey,
    email: user.email,
    balance: await getBalance(user.id),
    providers: listProviders().map((p) => p.id),
  };
}

/** Keeps the signed-in user if there is one; otherwise signs in as the local user (issuing it a fresh key). */
async function session(current: User | null): Promise<{ apiKey: string | null; user: User }> {
  if (current) return { apiKey: null, user: current };
  const apiKey = newApiKey();
  const r = await pool.query<User>(
    `INSERT INTO users (email, api_key_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, updated_at = now()
     RETURNING id, email`,
    [LOCAL_USER_EMAIL, sha256(apiKey)],
  );
  const user = r.rows[0]!;
  if (config.LOCAL_USER_INITIAL_TOKENS > 0) {
    // Idempotent per reference: the grant happens once, when the local user is first created.
    await creditTokens({ userId: user.id, amount: config.LOCAL_USER_INITIAL_TOKENS, reference: `local-user-${user.id}`, note: 'local UI starting balance' });
  }
  return { apiKey, user };
}

async function userByKey(key: string): Promise<User | null> {
  const r = await pool.query<User>(`SELECT id, email FROM users WHERE api_key_hash = $1`, [sha256(key)]);
  return r.rows[0] ?? null;
}

async function userFromAuthHeader(req: FastifyRequest): Promise<User | null> {
  const key = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  return key ? userByKey(key) : null;
}

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

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
