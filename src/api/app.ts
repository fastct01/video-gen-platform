import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { sha256 } from '../lib/util.js';
import { ApiError } from '../services/videos.js';
import { adminRoutes } from './routes/admin.js';
import { fileRoutes } from './routes/files.js';
import { meRoutes } from './routes/me.js';
import { uiRoutes } from './routes/ui.js';
import { videoRoutes } from './routes/videos.js';

export interface AuthUser {
  id: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true, bodyLimit: 1024 * 1024 });
  app.decorateRequest('user', null);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
          details: err.issues,
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'internal server error' } });
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  await app.register(uiRoutes);
  await app.register(fileRoutes);
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(
    async (v1) => {
      v1.addHook('onRequest', requireUser);
      await v1.register(meRoutes);
      await v1.register(videoRoutes);
    },
    { prefix: '/v1' },
  );
  return app;
}

/** `Authorization: Bearer vk_...` -> request.user */
async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const key = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!key) return reply.code(401).send({ error: { code: 'unauthorized', message: 'missing Authorization: Bearer <api key>' } });
  const r = await pool.query<AuthUser>(`SELECT id, email FROM users WHERE api_key_hash = $1`, [sha256(key)]);
  if (!r.rows[0]) return reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid api key' } });
  req.user = r.rows[0];
}

/** `X-Admin-Token: <ADMIN_TOKEN>` */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
  const expected = Buffer.from(config.ADMIN_TOKEN);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid admin token' } });
  }
}
