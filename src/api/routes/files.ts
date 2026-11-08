import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { storage } from '../../storage/index.js';
import { LocalStorage } from '../../storage/local.js';

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

/**
 * Serves objects of the local storage driver through HMAC-signed, expiring URLs (/files/<key>?exp=&sig=).
 * Supports single HTTP Range requests so browsers can seek in long videos.
 * With the S3 driver, URLs point at S3 directly and this route is not registered.
 */
export async function fileRoutes(app: FastifyInstance) {
  if (!(storage instanceof LocalStorage)) return;
  const local = storage;

  app.get('/files/*', async (req, reply) => {
    const key = decodeURIComponent((req.params as { '*': string })['*']);
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!sig || !local.verify(key, Number(exp), sig)) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'invalid or expired link' } });
    }

    let file: string;
    let size: number;
    try {
      file = local.resolve(key);
      size = (await stat(file)).size;
    } catch {
      return reply.code(404).send({ error: { code: 'not_found', message: 'file not found' } });
    }

    reply.header('content-type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'private, max-age=3600');

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      let start: number;
      let end: number;
      if (range[1]) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(range[2])); // suffix range: last N bytes
        end = size - 1;
      }
      if (start > end || start >= size) {
        return reply.code(416).header('content-range', `bytes */${size}`).send();
      }
      reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
      return reply.send(createReadStream(file, { start, end }));
    }
    reply.header('content-length', size);
    return reply.send(createReadStream(file));
  });
}
