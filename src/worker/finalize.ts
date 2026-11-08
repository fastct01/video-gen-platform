import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { getVideo, listSegments, updateVideo } from '../db/repo.js';
import { probe, stitch } from '../media/ffmpeg.js';
import { keys, storage } from '../storage/index.js';
import { isTerminalSegment, isTerminalVideo } from './control.js';

export type FinalizeJob = Job<{ videoId: string }>;

const STOP_MESSAGES: Record<string, string> = {
  insufficient_balance: 'not enough tokens to generate the first segment',
  segment_failed: 'the first segment could not be generated',
  canceled: 'canceled before any segment was generated',
};

/**
 * Stitches every delivered segment into the final video.
 * Runs once the segment chain has stopped (target reached, out of tokens, canceled, failure, max segments).
 * A video that stopped early still gets a final file made of the segments that were paid for.
 */
export async function processFinalize(job: FinalizeJob): Promise<void> {
  const video = await getVideo(job.data.videoId);
  if (!video || isTerminalVideo(video.status)) return;

  const segments = await listSegments(video.id);
  const inFlight = segments.find((s) => !isTerminalSegment(s.status));
  if (inFlight) throw new Error(`segment ${inFlight.idx} is still ${inFlight.status}; retrying finalize later`);

  // The chain stops at the first undelivered segment, so delivered segments are a contiguous prefix.
  const done = segments.filter((s) => s.status === 'completed' && s.output_key);

  if (done.length === 0) {
    const reason = video.stop_reason ?? 'segment_failed';
    await pool.query(
      `UPDATE videos SET status = $2, error = COALESCE(error, $3), completed_at = now(), updated_at = now() WHERE id = $1`,
      [video.id, reason === 'canceled' ? 'canceled' : 'failed', STOP_MESSAGES[reason] ?? 'no segments were generated'],
    );
    return;
  }

  await updateVideo(video.id, { status: 'stitching' });
  const dir = path.resolve(config.TMP_DIR, `final-${video.id}`);
  await mkdir(dir, { recursive: true });
  try {
    const inputs = [];
    for (const s of done) {
      const p = path.join(dir, `${String(s.idx).padStart(4, '0')}.mp4`);
      await storage.getToFile(s.output_key!, p);
      inputs.push({ path: p, durationS: Number(s.actual_duration_s ?? s.duration_seconds), hasAudio: Boolean(s.has_audio) });
    }
    await job.updateProgress(10);

    // Output geometry follows the first clip; later clips are scaled/padded to match.
    const first = await probe(inputs[0]!.path);
    const out = path.join(dir, 'final.mp4');
    await stitch(inputs, out, {
      width: first.width - (first.width % 2),
      height: first.height - (first.height % 2),
      fps: config.STITCH_FPS,
      crossfadeS: config.STITCH_CROSSFADE_SECONDS,
    });
    await job.updateProgress(80);

    const actual = await probe(out);
    const finalKey = keys.final(video.id);
    await storage.putFile(finalKey, out, 'video/mp4');
    await updateVideo(video.id, {
      status: 'completed',
      final_key: finalKey,
      final_duration_s: actual.durationS,
      completed_at: new Date(),
    });
    console.log(`[video ${video.id}] completed: ${done.length} segments, ${actual.durationS.toFixed(1)}s (${video.stop_reason})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
