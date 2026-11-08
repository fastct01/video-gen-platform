import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getBalance } from '../../db/billing.js';
import { pool } from '../../db/pool.js';
import { listProviders } from '../../providers/registry.js';
import { config } from '../../config.js';

const page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => {
    const user = req.user!;
    return { id: user.id, email: user.email, balance: await getBalance(user.id) };
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

  app.get('/providers', async () => ({
    defaultProvider: config.DEFAULT_PROVIDER,
    providers: listProviders().map((p) => ({
      id: p.id,
      defaultModel: p.defaultModel,
      tokensPerSecond: p.tokensPerSecond,
      ...p.capabilities,
    })),
  }));
}
