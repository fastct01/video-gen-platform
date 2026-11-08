import { z } from 'zod';
import { config } from '../config.js';
import { withTx } from '../db/pool.js';
import { plannedSegmentSeconds, promptForSegment, type SegmentRow, type VideoRow } from '../db/repo.js';
import { defaultProviderId, getProvider } from '../providers/registry.js';
import { ownGeminiProvider } from '../providers/user-keys.js';
import type { VideoProvider } from '../providers/types.js';
import { storage } from '../storage/index.js';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const prompt = z.string().trim().min(1).max(4000);

export const createVideoSchema = z
  .object({
    prompt,
    /** Storyboard: segment i uses segmentPrompts[i % length]. */
    segmentPrompts: z.array(prompt).min(1).max(500).optional(),
    provider: z.string().optional(),
    model: z.string().max(200).optional(),
    aspectRatio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
    resolution: z.string().optional(),
    segmentSeconds: z.number().int().positive().optional(),
    /** duration: stop at targetSeconds. until_balance: keep going until tokens (or maxSegments) run out. */
    mode: z.enum(['duration', 'until_balance']).default('duration'),
    targetSeconds: z.number().int().positive().max(24 * 3600).optional(),
    maxSegments: z.number().int().positive().optional(),
    /** Reject up front (402) if the balance can't cover the whole estimate, instead of stopping partway. */
    requireFullBalance: z.boolean().default(false),
  })
  .refine((b) => b.mode !== 'duration' || b.targetSeconds != null, {
    message: 'targetSeconds is required when mode is "duration"',
    path: ['targetSeconds'],
  });

export type CreateVideoInput = z.infer<typeof createVideoSchema>;

export interface VideoPlan {
  provider: VideoProvider;
  /** Generated with the user's own provider key (0 tokens; the provider bills the key's owner). */
  ownKey: boolean;
  model: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
  resolution: string;
  segmentSeconds: number;
  targetSeconds: number | null;
  maxSegments: number;
  tokensPerSecond: number;
  /** Segment durations that would be generated with unlimited balance. */
  segmentDurations: number[];
  estimatedTokens: number;
  firstSegmentTokens: number;
}

/** Providers that exist only for this user (their own keys). */
export interface UserProviders {
  ownGemini: VideoProvider | null;
}

export async function userProviders(userId: string): Promise<UserProviders> {
  return { ownGemini: await ownGeminiProvider(userId) };
}

/**
 * Validates a request against the provider's capabilities and works out what it will cost.
 * A user's own Gemini key takes precedence over the server's for "gemini" and is the default provider.
 */
export function planVideo(input: CreateVideoInput, balance?: number, user: UserProviders = { ownGemini: null }): VideoPlan {
  const providerId = input.provider ?? (user.ownGemini ? 'gemini' : defaultProviderId());
  const ownKey = providerId === 'gemini' && user.ownGemini != null;
  const provider = ownKey ? user.ownGemini! : providerId ? getProvider(providerId) : undefined;
  if (!provider) {
    throw new ApiError(
      400,
      'unknown_provider',
      providerId === 'gemini'
        ? 'connect your Gemini API key to generate with Gemini'
        : providerId
          ? `provider "${providerId}" is not available`
          : 'no providers are available — connect your Gemini API key',
    );
  }
  const caps = provider.capabilities;

  if (!caps.aspectRatios.includes(input.aspectRatio)) {
    throw new ApiError(400, 'invalid_aspect_ratio', `${provider.id} supports aspect ratios: ${caps.aspectRatios.join(', ')}`);
  }
  const resolution = input.resolution ?? caps.defaultResolution;
  if (!caps.resolutions.includes(resolution)) {
    throw new ApiError(400, 'invalid_resolution', `${provider.id} supports resolutions: ${caps.resolutions.join(', ')}`);
  }
  const segmentSeconds = input.segmentSeconds ?? Math.min(Math.max(config.DEFAULT_SEGMENT_SECONDS, caps.minSeconds), caps.maxSeconds);
  if (segmentSeconds < caps.minSeconds || segmentSeconds > caps.maxSeconds) {
    throw new ApiError(400, 'invalid_segment_seconds', `${provider.id} segments must be ${caps.minSeconds}-${caps.maxSeconds} seconds`);
  }

  const targetSeconds = input.mode === 'duration' ? input.targetSeconds! : null;
  if (targetSeconds != null && targetSeconds < caps.minSeconds) {
    throw new ApiError(400, 'invalid_target_seconds', `targetSeconds must be at least ${caps.minSeconds}`);
  }
  const needed = targetSeconds != null ? Math.ceil(targetSeconds / segmentSeconds) : config.MAX_SEGMENTS_PER_VIDEO;
  const maxSegments = Math.min(input.maxSegments ?? needed, needed, config.MAX_SEGMENTS_PER_VIDEO);
  if (targetSeconds != null && needed > config.MAX_SEGMENTS_PER_VIDEO) {
    throw new ApiError(
      400,
      'too_long',
      `targetSeconds needs ${needed} segments; the limit is ${config.MAX_SEGMENTS_PER_VIDEO} ` +
        `(max ${config.MAX_SEGMENTS_PER_VIDEO * segmentSeconds}s at ${segmentSeconds}s per segment)`,
    );
  }

  const tokensPerSecond = provider.tokensPerSecond;
  const shape = { mode: input.mode, segment_seconds: segmentSeconds, target_seconds: targetSeconds, max_segments: maxSegments };
  const segmentDurations: number[] = [];
  for (let i = 0; ; i++) {
    const s = plannedSegmentSeconds(shape, i, caps.minSeconds);
    if (s == null) break;
    segmentDurations.push(s);
  }

  let estimatedTokens = segmentDurations.reduce((a, b) => a + b, 0) * tokensPerSecond;
  if (input.mode === 'until_balance' && balance != null) {
    // Segments are only generated while the balance covers a whole one.
    const perSegment = segmentSeconds * tokensPerSecond;
    const affordable = perSegment > 0 ? Math.min(maxSegments, Math.floor(balance / perSegment)) : maxSegments;
    estimatedTokens = affordable * perSegment;
  }

  return {
    provider,
    ownKey,
    model: input.model ?? provider.defaultModel,
    aspectRatio: input.aspectRatio,
    resolution,
    segmentSeconds,
    targetSeconds,
    maxSegments,
    tokensPerSecond,
    segmentDurations,
    estimatedTokens,
    firstSegmentTokens: (segmentDurations[0] ?? segmentSeconds) * tokensPerSecond,
  };
}

/**
 * Creates the video and its first segment in one transaction. The user row is locked so the
 * active-video limit can't be raced by parallel requests. Tokens are NOT debited here: each
 * segment reserves its own tokens right before it is generated.
 */
export async function createVideo(
  userId: string,
  input: CreateVideoInput,
  user: UserProviders,
): Promise<{ video: VideoRow; firstSegmentId: string; plan: VideoPlan }> {
  return withTx(async (c) => {
    const u = await c.query<{ token_balance: number }>(`SELECT token_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const balance = u.rows[0]?.token_balance ?? 0;
    const plan = planVideo(input, balance, user);

    const active = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM videos WHERE user_id = $1 AND status IN ('queued', 'generating', 'stitching')`,
      [userId],
    );
    if (active.rows[0]!.n >= config.MAX_ACTIVE_VIDEOS_PER_USER) {
      throw new ApiError(429, 'too_many_active_videos', `at most ${config.MAX_ACTIVE_VIDEOS_PER_USER} videos can be generating at once`);
    }
    if (balance < plan.firstSegmentTokens) {
      throw new ApiError(402, 'insufficient_balance', `the first segment costs ${plan.firstSegmentTokens} tokens; balance is ${balance}`, {
        balance,
        required: plan.firstSegmentTokens,
      });
    }
    if (input.requireFullBalance && balance < plan.estimatedTokens) {
      throw new ApiError(402, 'insufficient_balance', `this video costs about ${plan.estimatedTokens} tokens; balance is ${balance}`, {
        balance,
        required: plan.estimatedTokens,
      });
    }

    const v = await c.query<VideoRow>(
      `INSERT INTO videos (user_id, mode, prompt, segment_prompts, provider, model, aspect_ratio, resolution,
                           segment_seconds, target_seconds, max_segments, tokens_per_second, own_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        userId,
        input.mode,
        input.prompt,
        input.segmentPrompts ? JSON.stringify(input.segmentPrompts) : null,
        plan.provider.id,
        plan.model,
        plan.aspectRatio,
        plan.resolution,
        plan.segmentSeconds,
        plan.targetSeconds,
        plan.maxSegments,
        plan.tokensPerSecond,
        plan.ownKey,
      ],
    );
    const video = v.rows[0]!;
    const s = await c.query<{ id: string }>(
      `INSERT INTO segments (video_id, idx, duration_seconds, prompt) VALUES ($1, 0, $2, $3) RETURNING id`,
      [video.id, plan.segmentDurations[0] ?? plan.segmentSeconds, promptForSegment(video, 0)],
    );
    return { video, firstSegmentId: s.rows[0]!.id, plan };
  });
}

/** Public JSON shape of a video. */
export async function videoDto(video: VideoRow, segments?: SegmentRow[], tokensSpent?: number) {
  const done = segments?.filter((s) => s.status === 'completed') ?? [];
  const plannedSegments =
    video.mode === 'duration' && video.target_seconds != null ? Math.ceil(video.target_seconds / video.segment_seconds) : null;
  return {
    id: video.id,
    status: video.status,
    stopReason: video.stop_reason,
    error: video.error,
    mode: video.mode,
    prompt: video.prompt,
    segmentPrompts: video.segment_prompts,
    provider: video.provider,
    ownKey: video.own_key,
    model: video.model,
    aspectRatio: video.aspect_ratio,
    resolution: video.resolution,
    segmentSeconds: video.segment_seconds,
    targetSeconds: video.target_seconds,
    maxSegments: video.max_segments,
    tokensPerSecond: video.tokens_per_second,
    cancelRequested: video.cancel_requested,
    durationSeconds: video.final_duration_s,
    downloadUrl: video.final_key ? await storage.getUrl(video.final_key, 6 * 3600) : null,
    createdAt: video.created_at,
    completedAt: video.completed_at,
    ...(segments && {
      progress: {
        segmentsCompleted: done.length,
        segmentsPlanned: plannedSegments,
        secondsGenerated: done.reduce((a, s) => a + Number(s.actual_duration_s ?? s.duration_seconds), 0),
      },
      tokensSpent,
      segments: segments.map((s) => ({
        idx: s.idx,
        status: s.status,
        durationSeconds: s.duration_seconds,
        actualDurationSeconds: s.actual_duration_s,
        tokens: s.tokens_reserved,
        prompt: s.prompt,
        attempts: s.provider_failures,
        error: s.error,
      })),
    }),
  };
}
