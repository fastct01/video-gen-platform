import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { creditTokens } from '../../db/billing.js';
import { pool, withTx } from '../../db/pool.js';
import { newApiKey, sha256 } from '../../lib/util.js';
import { ApiError } from '../../services/videos.js';
import { requireAdmin } from '../app.js';

const createUser = z.object({ email: z.email(), initialTokens: z.number().int().min(0).default(0) });
const credit = z.object({
  amount: z.number().int().positive(),
  /** Payment id (e.g. Stripe checkout session). Re-sending the same reference is a no-op. */
  reference: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
});
const userId = z.object({ id: z.uuid() });

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAdmin);

  /** Creates a user and returns its API key. The key is shown once; only its hash is stored. */
  app.post('/users', async (req, reply) => {
    const body = createUser.parse(req.body);
    const apiKey = newApiKey();
    const user = await withTx(async (c) => {
      const r = await c.query<{ id: string; email: string }>(
        `INSERT INTO users (email, api_key_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id, email`,
        [body.email.toLowerCase(), sha256(apiKey)],
      );
      if (!r.rows[0]) throw new ApiError(409, 'email_taken', 'a user with this email already exists');
      return r.rows[0];
    });
    let balance = 0;
    if (body.initialTokens > 0) {
      balance = (await creditTokens({ userId: user.id, amount: body.initialTokens, reference: `signup-${user.id}`, note: 'initial grant' })).balance;
    }
    return reply.code(201).send({ ...user, apiKey, balance });
  });

  /** Issues a new API key, invalidating the old one. */
  app.post('/users/:id/rotate-key', async (req) => {
    const { id } = userId.parse(req.params);
    const apiKey = newApiKey();
    const r = await pool.query(`UPDATE users SET api_key_hash = $2, updated_at = now() WHERE id = $1`, [id, sha256(apiKey)]);
    if (r.rowCount === 0) throw new ApiError(404, 'not_found', 'user not found');
    return { id, apiKey };
  });

  app.get('/users/:id', async (req) => {
    const { id } = userId.parse(req.params);
    const r = await pool.query(`SELECT id, email, token_balance AS balance, created_at FROM users WHERE id = $1`, [id]);
    if (!r.rows[0]) throw new ApiError(404, 'not_found', 'user not found');
    return r.rows[0];
  });

  /** Adds tokens (call this from your payment webhook). Idempotent per `reference`. */
  app.post('/users/:id/credits', async (req) => {
    const { id } = userId.parse(req.params);
    const body = credit.parse(req.body);
    const exists = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [id]);
    if (exists.rowCount === 0) throw new ApiError(404, 'not_found', 'user not found');
    return creditTokens({ userId: id, amount: body.amount, reference: body.reference, note: body.note });
  });

  /** Ledger consistency check: SUM(ledger) must equal every user's balance. */
  app.get('/ledger/check', async () => {
    const r = await pool.query<{ id: string; email: string; balance: number; ledger: number }>(
      `SELECT u.id, u.email, u.token_balance AS balance, COALESCE(SUM(t.amount), 0)::bigint AS ledger
       FROM users u LEFT JOIN token_transactions t ON t.user_id = u.id
       GROUP BY u.id HAVING u.token_balance <> COALESCE(SUM(t.amount), 0)`,
    );
    return { ok: r.rows.length === 0, mismatches: r.rows };
  });
}
