import { pool, type Db } from './pool.js';

export type VideoStatus = 'queued' | 'generating' | 'stitching' | 'completed' | 'failed' | 'canceled';
export type StopReason = 'target_reached' | 'insufficient_balance' | 'max_segments' | 'canceled' | 'segment_failed';
export type SegmentStatus = 'pending' | 'reserved' | 'submitted' | 'completed' | 'skipped' | 'failed' | 'canceled';

export interface VideoRow {
  id: string;
  user_id: string;
  status: VideoStatus;
  mode: 'duration' | 'until_balance';
  prompt: string;
  segment_prompts: string[] | null;
  provider: string;
  model: string | null;
  aspect_ratio: string;
  resolution: string;
  segment_seconds: number;
  target_seconds: number | null;
  max_segments: number;
  tokens_per_second: number;
  own_key: boolean;
  cancel_requested: boolean;
  stop_reason: StopReason | null;
  final_key: string | null;
  final_duration_s: number | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface SegmentRow {
  id: string;
  video_id: string;
  idx: number;
  status: SegmentStatus;
  duration_seconds: number;
  tokens_reserved: number;
  prompt: string;
  provider_job_id: string | null;
  provider_failures: number;
  output_key: string | null;
  last_frame_key: string | null;
  actual_duration_s: number | null;
  has_audio: boolean | null;
  error: string | null;
  submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function getVideo(id: string, db: Db = pool): Promise<VideoRow | null> {
  const r = await db.query<VideoRow>(`SELECT * FROM videos WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function getSegment(id: string, db: Db = pool): Promise<SegmentRow | null> {
  const r = await db.query<SegmentRow>(`SELECT * FROM segments WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function getSegmentByIdx(videoId: string, idx: number, db: Db = pool): Promise<SegmentRow | null> {
  const r = await db.query<SegmentRow>(`SELECT * FROM segments WHERE video_id = $1 AND idx = $2`, [videoId, idx]);
  return r.rows[0] ?? null;
}

export async function listSegments(videoId: string, db: Db = pool): Promise<SegmentRow[]> {
  const r = await db.query<SegmentRow>(`SELECT * FROM segments WHERE video_id = $1 ORDER BY idx`, [videoId]);
  return r.rows;
}

export async function updateSegment(id: string, patch: Partial<SegmentRow>, db: Db = pool): Promise<void> {
  const keys = Object.keys(patch) as (keyof SegmentRow)[];
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await db.query(`UPDATE segments SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
}

export async function updateVideo(id: string, patch: Partial<VideoRow>, db: Db = pool): Promise<void> {
  const keys = Object.keys(patch) as (keyof VideoRow)[];
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await db.query(`UPDATE videos SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
}

/** Sets stop_reason only if none was recorded yet (the first reason to stop wins). */
export async function setStopReason(videoId: string, reason: StopReason, error?: string): Promise<void> {
  await pool.query(
    `UPDATE videos SET stop_reason = COALESCE(stop_reason, $2::stop_reason), error = COALESCE(error, $3), updated_at = now() WHERE id = $1`,
    [videoId, reason, error ?? null],
  );
}

/** Prompt for segment idx: storyboard entry if given (cycling), else the base prompt. */
export function promptForSegment(video: Pick<VideoRow, 'prompt' | 'segment_prompts'>, idx: number): string {
  const list = video.segment_prompts;
  if (list && list.length > 0) return list[idx % list.length]!;
  return video.prompt;
}

/**
 * How many seconds segment idx should be, or null if the video is already long enough.
 * In duration mode the last segment is shortened to hit the target (respecting the provider minimum).
 */
export function plannedSegmentSeconds(
  video: Pick<VideoRow, 'mode' | 'segment_seconds' | 'target_seconds' | 'max_segments'>,
  idx: number,
  providerMinSeconds: number,
): number | null {
  if (idx >= video.max_segments) return null;
  if (video.mode === 'until_balance' || video.target_seconds == null) return video.segment_seconds;
  const remaining = video.target_seconds - idx * video.segment_seconds;
  if (remaining <= 0) return null;
  return Math.max(providerMinSeconds, Math.min(video.segment_seconds, remaining));
}

/** Inserts segment idx if it does not exist yet; returns it either way. */
export async function ensureSegment(
  videoId: string,
  idx: number,
  durationSeconds: number,
  prompt: string,
  db: Db = pool,
): Promise<SegmentRow> {
  await db.query(
    `INSERT INTO segments (video_id, idx, duration_seconds, prompt) VALUES ($1, $2, $3, $4)
     ON CONFLICT (video_id, idx) DO NOTHING`,
    [videoId, idx, durationSeconds, prompt],
  );
  return (await getSegmentByIdx(videoId, idx, db))!;
}
