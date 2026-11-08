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
