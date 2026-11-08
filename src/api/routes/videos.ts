import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getBalance, tokensSpentOnVideo } from '../../db/billing.js';
import { pool } from '../../db/pool.js';
import { getVideo, listSegments, type VideoRow } from '../../db/repo.js';
import { enqueueSegment } from '../../queue/queues.js';
import { ApiError, createVideo, createVideoSchema, planVideo, userProviders, videoDto } from '../../services/videos.js';

const idParam = z.object({ id: z.uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['queued', 'generating', 'stitching', 'completed', 'failed', 'canceled']).optional(),
});

export async function videoRoutes(app: FastifyInstance) {
  /** Price check without creating anything. */
  app.post('/videos/estimate', async (req) => {
    const input = createVideoSchema.parse(req.body);
    const [balance, user] = await Promise.all([getBalance(req.user!.id), userProviders(req.user!.id)]);
    const plan = planVideo(input, balance, user);
    return {
      provider: plan.provider.id,
      ownKey: plan.ownKey,
      model: plan.model,
      segmentSeconds: plan.segmentSeconds,
      segments: input.mode === 'duration' ? plan.segmentDurations.length : null,
      maxSegments: plan.maxSegments,
      tokensPerSecond: plan.tokensPerSecond,
      estimatedTokens: plan.estimatedTokens,
      estimatedSeconds: plan.tokensPerSecond > 0 ? plan.estimatedTokens / plan.tokensPerSecond : null,
      balance,
      affordable: balance >= plan.estimatedTokens,
    };
  });

  app.post('/videos', async (req, reply) => {
    const input = createVideoSchema.parse(req.body);
    const { video, firstSegmentId, plan } = await createVideo(req.user!.id, input, await userProviders(req.user!.id));
    await enqueueSegment(firstSegmentId);
    return reply.code(201).send({ ...(await videoDto(video)), estimatedTokens: plan.estimatedTokens });
  });

  app.get('/videos', async (req) => {
    const q = listQuery.parse(req.query);
    const r = await pool.query<VideoRow>(
      `SELECT * FROM videos WHERE user_id = $1 AND ($2::video_status IS NULL OR status = $2) ORDER BY created_at DESC LIMIT $3`,
      [req.user!.id, q.status ?? null, q.limit],
    );
    return { videos: await Promise.all(r.rows.map((v) => videoDto(v))) };
  });

  app.get('/videos/:id', async (req) => {
    const video = await ownedVideo(req.user!.id, req.params);
    const [segments, spent] = await Promise.all([listSegments(video.id), tokensSpentOnVideo(video.id)]);
    return videoDto(video, segments, spent);
  });

  /**
   * Stops the video after the segment currently being generated (that one is already paid for and is kept).
   * Unstarted segments are refunded and whatever was generated so far is stitched into the final video.
   */
  app.post('/videos/:id/cancel', async (req, reply) => {
    const video = await ownedVideo(req.user!.id, req.params);
    if (['completed', 'failed', 'canceled'].includes(video.status)) {
      throw new ApiError(409, 'not_active', `video is already ${video.status}`);
    }
    await pool.query(`UPDATE videos SET cancel_requested = true, updated_at = now() WHERE id = $1`, [video.id]);
    return reply.code(202).send(await videoDto({ ...video, cancel_requested: true }));
  });
}

async function ownedVideo(userId: string, params: unknown): Promise<VideoRow> {
  const { id } = idParam.parse(params);
  const video = await getVideo(id);
  if (!video || video.user_id !== userId) throw new ApiError(404, 'not_found', 'video not found');
  return video;
}
