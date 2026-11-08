import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getBalance } from '../../db/billing.js';
import { pool } from '../../db/pool.js';
import { listProviders } from '../../providers/registry.js';
import type { VideoProvider } from '../../providers/types.js';
import { keyHint, removeUserGeminiKey, userGeminiKey } from '../../providers/user-keys.js';
import { userProviders } from '../../services/videos.js';
import { config } from '../../config.js';

const page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => {
    const user = req.user!;
    const [balance, gemini] = await Promise.all([getBalance(user.id), userGeminiKey(user.id)]);
    return { id: user.id, email: user.email, balance, geminiKey: gemini ? { hint: keyHint(gemini) } : null };
  });

  /** Disconnects the user's own Gemini key. Their running videos stop at the next segment. */
  app.delete('/me/gemini-key', async (req) => {
    return { removed: await removeUserGeminiKey(req.user!.id) };
  });

  /**
   * Usage summary for the usage panel. Google doesn't let an API key read its remaining credit or quota,
   * so this reports what was generated *on this site*: with the user's own Gemini key, and in tokens.
   * "today" starts at midnight Pacific, when Gemini API daily quotas reset.
   */
  app.get('/me/usage', async (req) => {
    const userId = req.user!.id;
    const [windows, tokens, quota, balance, gemini] = await Promise.all([
      pool.query<{ name: string; since: Date; videos: number; clips: number; seconds: number; rejected: number }>(
        `WITH b AS (SELECT date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles' AS today)
         SELECT w.name, w.since, vids.n AS videos, segs.clips, segs.seconds, segs.rejected
         FROM b, LATERAL (VALUES ('today', b.today), ('last30Days', now() - interval '30 days'), ('allTime', '-infinity'::timestamptz)) w(name, since)
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS n FROM videos v WHERE v.user_id = $1 AND v.own_key AND v.created_at >= w.since
         ) vids
         CROSS JOIN LATERAL (
           SELECT count(*) FILTER (WHERE s.status = 'completed')::int AS clips,
                  COALESCE(sum(COALESCE(s.actual_duration_s, s.duration_seconds)) FILTER (WHERE s.status = 'completed'), 0)::float AS seconds,
                  COALESCE(sum(s.provider_failures), 0)::int AS rejected
           FROM segments s JOIN videos v ON v.id = s.video_id
           WHERE v.user_id = $1 AND v.own_key AND s.updated_at >= w.since
         ) segs`,
        [userId],
      ),
      pool.query<{ today: number; last30Days: number }>(
        `SELECT COALESCE(-sum(amount) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'), 0)::int AS today,
                COALESCE(-sum(amount) FILTER (WHERE created_at >= now() - interval '30 days'), 0)::int AS "last30Days"
         FROM token_transactions WHERE user_id = $1 AND kind IN ('reserve', 'refund')`,
        [userId],
      ),
      // Most recent quota / rate-limit rejection from Google in the last 24 hours.
      pool.query<{ at: Date; error: string }>(
        `SELECT s.updated_at AS at, s.error FROM segments s JOIN videos v ON v.id = s.video_id
         WHERE v.user_id = $1 AND v.own_key AND s.updated_at >= now() - interval '24 hours'
           AND s.error ~* '(HTTP 429|RESOURCE_EXHAUSTED|quota|rate limit)'
         ORDER BY s.updated_at DESC LIMIT 1`,
        [userId],
      ),
      getBalance(userId),
      userGeminiKey(userId),
    ]);
    const nextReset = await pool.query<{ at: Date }>(
      `SELECT (date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') + interval '1 day') AT TIME ZONE 'America/Los_Angeles' AS at`,
    );
    const ownKey = Object.fromEntries(
      windows.rows.map((w) => [w.name, { videos: w.videos, clips: w.clips, seconds: Math.round(w.seconds), rejected: w.rejected }]),
    );
    return {
      geminiKey: gemini ? { hint: keyHint(gemini) } : null,
      ownKey,
      quotaResetsAt: nextReset.rows[0]!.at,
      lastQuotaError: quota.rows[0] ? { at: quota.rows[0].at, message: quota.rows[0].error.slice(0, 300) } : null,
      tokens: { balance, spentToday: tokens.rows[0]!.today, spentLast30Days: tokens.rows[0]!.last30Days },
    };
  });

  /** Token ledger, newest first. Paginate with ?before=<id of the last row>. */
  app.get('/me/transactions', async (req) => {
    const q = page.parse(req.query);
    const r = await pool.query(
      `SELECT id, kind, amount, balance_after AS "balanceAfter", video_id AS "videoId", segment_id AS "segmentId",
              note, created_at AS "createdAt"
       FROM token_transactions
       WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2)
       ORDER BY id DESC LIMIT $3`,
      [req.user!.id, q.before ?? null, q.limit],
    );
    return { transactions: r.rows };
  });

  /** Providers this user can use: the server's, with "gemini" replaced by their own key if they added one. */
  app.get('/providers', async (req) => {
    const { ownGemini } = await userProviders(req.user!.id);
    const describe = (p: VideoProvider, ownKey: boolean) => ({
      id: p.id,
      ownKey,
      defaultModel: p.defaultModel,
      tokensPerSecond: p.tokensPerSecond,
      ...p.capabilities,
    });
    const list = listProviders().filter((p) => !(ownGemini && p.id === 'gemini')).map((p) => describe(p, false));
    if (ownGemini) list.unshift(describe(ownGemini, true));
    return { defaultProvider: ownGemini ? 'gemini' : config.DEFAULT_PROVIDER, providers: list };
  });
}
