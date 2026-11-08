import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { sha256 } from '../lib/util.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

/** Authorization: Bearer vk_... (user API key). */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!m) return reply.code(401).send({ error: 'missing bearer token' });
  const r = await pool.query<{ id: string }>(`SELECT id FROM users WHERE api_key_hash = $1`, [sha256(m[1]!)]);
  if (!r.rows[0]) return reply.code(401).send({ error: 'invalid api key' });
  req.userId = r.rows[0].id;
}

/** x-admin-token: <ADMIN_TOKEN> */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
  const expected = Buffer.from(config.ADMIN_TOKEN);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return reply.code(401).send({ error: 'invalid admin token' });
  }
}
