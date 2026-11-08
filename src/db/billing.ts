import type pg from 'pg';
import { pool, withTx } from './pool.js';

/**
 * All balance changes go through these functions. Guarantees:
 *  - The conditional UPDATE (`token_balance >= amount`) takes a row lock on the user, so concurrent
 *    reservations from several videos of the same user serialize and can never overdraw.
 *  - Every change writes a ledger row with a unique idempotency key in the SAME transaction, so a
 *    retried job can never double-charge or double-refund.
 */

export type ReserveResult =
  | { ok: true; balance: number | null; alreadyReserved: boolean }
  | { ok: false; reason: 'insufficient_balance'; balance: number };

class InsufficientBalance extends Error {}

export async function reserveSegmentTokens(args: {
  userId: string;
  videoId: string;
  segmentId: string;
  amount: number;
}): Promise<ReserveResult> {
  const { userId, videoId, segmentId, amount } = args;
  try {
    return await withTx(async (c) => {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO token_transactions (user_id, video_id, segment_id, kind, amount, idempotency_key, note)
         VALUES ($1, $2, $3, 'reserve', $4, $5, 'segment generation')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [userId, videoId, segmentId, -amount, `reserve-${segmentId}`],
      );
      if (ins.rowCount === 0) {
        // A previous attempt already reserved. Make sure the segment reflects that and move on.
        await c.query(`UPDATE segments SET status = 'reserved', updated_at = now() WHERE id = $1 AND status = 'pending'`, [segmentId]);
        return { ok: true as const, balance: null, alreadyReserved: true };
      }

      const upd = await c.query<{ token_balance: number }>(
        `UPDATE users SET token_balance = token_balance - $2, updated_at = now()
         WHERE id = $1 AND token_balance >= $2
         RETURNING token_balance`,
        [userId, amount],
      );
      if (upd.rowCount === 0) throw new InsufficientBalance();
      const balance = upd.rows[0]!.token_balance;

      await c.query(`UPDATE token_transactions SET balance_after = $2 WHERE id = $1`, [ins.rows[0]!.id, balance]);
      await c.query(
        `UPDATE segments SET status = 'reserved', tokens_reserved = $2, updated_at = now() WHERE id = $1`,
        [segmentId, amount],
      );
      return { ok: true as const, balance, alreadyReserved: false };
    });
  } catch (err) {
    if (err instanceof InsufficientBalance) {
      return { ok: false, reason: 'insufficient_balance', balance: await getBalance(userId) };
    }
    throw err;
  }
}

/**
 * Refunds whatever was reserved for a segment (no-op if nothing was reserved or it was already
 * refunded) and moves the segment to its terminal status in the same transaction.
 */
export async function refundSegment(args: {
  segmentId: string;
  finalStatus: 'failed' | 'canceled';
  error?: string;
}): Promise<{ refunded: number }> {
  return withTx(async (c) => {
    const refunded = await refundInTx(c, args.segmentId);
    await c.query(
      `UPDATE segments SET status = $2, error = COALESCE($3, error), updated_at = now() WHERE id = $1`,
      [args.segmentId, args.finalStatus, args.error ?? null],
    );
    return { refunded };
  });
}

async function refundInTx(c: pg.PoolClient, segmentId: string): Promise<number> {
  const ins = await c.query<{ id: string; user_id: string; amount: number }>(
    `INSERT INTO token_transactions (user_id, video_id, segment_id, kind, amount, idempotency_key, note)
     SELECT r.user_id, r.video_id, r.segment_id, 'refund', -r.amount, $2, 'segment not delivered'
     FROM token_transactions r
     WHERE r.idempotency_key = $1
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, user_id, amount`,
    [`reserve-${segmentId}`, `refund-${segmentId}`],
  );
  const row = ins.rows[0];
  if (!row || row.amount === 0) return 0;
  const upd = await c.query<{ token_balance: number }>(
    `UPDATE users SET token_balance = token_balance + $2, updated_at = now() WHERE id = $1 RETURNING token_balance`,
    [row.user_id, row.amount],
  );
  await c.query(`UPDATE token_transactions SET balance_after = $2 WHERE id = $1`, [row.id, upd.rows[0]!.token_balance]);
  return row.amount;
}

/** Adds purchased tokens. Pass the payment provider's id as `reference` to make webhooks idempotent. */
export async function creditTokens(args: {
  userId: string;
  amount: number;
  reference: string;
  note?: string;
}): Promise<{ balance: number; duplicate: boolean }> {
  return withTx(async (c) => {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO token_transactions (user_id, kind, amount, idempotency_key, note)
       VALUES ($1, 'credit', $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [args.userId, args.amount, `credit-${args.reference}`, args.note ?? null],
    );
    if (ins.rowCount === 0) {
      const b = await c.query<{ token_balance: number }>(`SELECT token_balance FROM users WHERE id = $1`, [args.userId]);
      return { balance: b.rows[0]?.token_balance ?? 0, duplicate: true };
    }
    const upd = await c.query<{ token_balance: number }>(
      `UPDATE users SET token_balance = token_balance + $2, updated_at = now() WHERE id = $1 RETURNING token_balance`,
      [args.userId, args.amount],
    );
    if (upd.rowCount === 0) throw new Error('user not found');
    await c.query(`UPDATE token_transactions SET balance_after = $2 WHERE id = $1`, [ins.rows[0]!.id, upd.rows[0]!.token_balance]);
    return { balance: upd.rows[0]!.token_balance, duplicate: false };
  });
}

export async function getBalance(userId: string): Promise<number> {
  const r = await pool.query<{ token_balance: number }>(`SELECT token_balance FROM users WHERE id = $1`, [userId]);
  return r.rows[0]?.token_balance ?? 0;
}

/** Net tokens a video has consumed (reservations minus refunds). */
export async function tokensSpentOnVideo(videoId: string): Promise<number> {
  const r = await pool.query<{ spent: number }>(
    `SELECT COALESCE(-SUM(amount), 0)::bigint AS spent FROM token_transactions WHERE video_id = $1 AND kind IN ('reserve', 'refund')`,
    [videoId],
  );
  return r.rows[0]!.spent;
}
