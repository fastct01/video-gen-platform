import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DelayedError, type Job } from 'bullmq';
import { config } from '../config.js';
import { refundSegment, reserveSegmentTokens } from '../db/billing.js';
import { pool } from '../db/pool.js';
import { getSegment, getSegmentByIdx, getVideo, updateSegment, type SegmentRow, type VideoRow } from '../db/repo.js';
import { saveVideoOutput } from '../lib/http.js';
import { errMsg } from '../lib/util.js';
import { extractLastFrame, FfmpegError, probe } from '../media/ffmpeg.js';
import { getProvider } from '../providers/registry.js';
import { ownGeminiProvider } from '../providers/user-keys.js';
import { ProviderError, type GenerateRequest, type VideoOutput, type VideoProvider } from '../providers/types.js';
import { keys, storage } from '../storage/index.js';
import { advance, giveUpSegment, isTerminalSegment, isTerminalVideo, stopVideo } from './control.js';

export type SegmentJob = Job<{ segmentId: string }>;

/**
 * One job = one segment. State machine (persisted in `segments.status`, so any step can crash and resume):
 *
 *   pending --reserve tokens--> reserved --generate--> completed --> advance() (next segment or finalize)
 *      |                           |   \--async provider--> submitted --poll--> completed
 *      |                           \--rejected N times / fatal--> failed (refunded)
 *      \--balance too low--> skipped (nothing debited) --> finalize
 *
 * Transient errors (network, 429, 5xx, storage) are thrown so BullMQ retries with backoff.
 * When the last attempt fails, the worker's `failed` handler calls giveUpSegment().
 */
export async function processSegment(job: SegmentJob, token?: string): Promise<void> {
  let seg = await getSegment(job.data.segmentId);
  if (!seg) return;
  let video = await getVideo(seg.video_id);
  if (!video) return;

  if (seg.status === 'completed') return advance(video.id, seg.idx); // crashed right after storing it
  if (isTerminalSegment(seg.status)) return;

  if (video.cancel_requested || isTerminalVideo(video.status)) {
    await refundSegment({ segmentId: seg.id, finalStatus: 'canceled' });
    if (!isTerminalVideo(video.status)) await stopVideo(video.id, 'canceled');
    return;
  }

  // own_key videos run on the owner's key, looked up per segment so removing the key stops the video.
  const provider = video.own_key ? await ownGeminiProvider(video.user_id) : getProvider(video.provider);
  if (!provider) {
    return giveUpSegment(
      seg.id,
      video.own_key ? 'your Gemini key was removed — connect it again to make more videos' : `provider "${video.provider}" is not configured on this worker`,
    );
  }

  if (seg.status === 'pending') {
    const amount = seg.duration_seconds * video.tokens_per_second;
    const r = await reserveSegmentTokens({ userId: video.user_id, videoId: video.id, segmentId: seg.id, amount });
    if (!r.ok) {
      await updateSegment(seg.id, { status: 'skipped', error: `needs ${amount} tokens, balance is ${r.balance}` });
      return stopVideo(video.id, 'insufficient_balance');
    }
    seg = (await getSegment(seg.id))!;
  }
  if (video.status === 'queued') {
    await pool.query(`UPDATE videos SET status = 'generating', updated_at = now() WHERE id = $1 AND status = 'queued'`, [video.id]);
    video = { ...video, status: 'generating' };
  }

  for (;;) {
    const output = await obtainOutput(job, token, seg, video, provider);
    if (!output) return; // gave up (already refunded and stopped)
    const delivered = await deliver(seg, output);
    if (delivered === true) break;
    // The provider returned something we can't use (corrupt / empty clip): count it as a rejection.
    if (!(await recordRejection(seg.id, delivered))) return;
    await updateSegment(seg.id, { status: 'reserved', provider_job_id: null, submitted_at: null });
    seg = (await getSegment(seg.id))!;
  }
  await advance(video.id, seg.idx);
}

/** Runs the provider until it yields a clip. Returns null if the segment was given up. */
async function obtainOutput(
  job: SegmentJob,
  token: string | undefined,
  seg: SegmentRow,
  video: VideoRow,
  provider: VideoProvider,
): Promise<VideoOutput | null> {
  if (seg.status === 'submitted' && seg.provider_job_id) {
    const polled = await pollOnce(job, token, seg, provider);
    if (polled === 'gave_up') return null;
    if (polled !== 'regenerate') return polled;
    // The async job failed; fall through and generate a fresh one.
  }

  const req = await buildRequest(seg, video, provider);
  for (;;) {
    try {
      const res = await provider.generate(req);
      if (res.state === 'completed') return res.output;
      await updateSegment(seg.id, { status: 'submitted', provider_job_id: res.jobId, submitted_at: new Date() });
      await delay(job, token);
    } catch (err) {
      if (!(err instanceof ProviderError) || err.retryable) throw err; // transient: BullMQ backoff
      if (err.fatal) {
        await giveUpSegment(seg.id, err.message);
        return null;
      }
      if (!(await recordRejection(seg.id, err.message))) return null;
      // Rejected (e.g. safety filter); try again right away, the provider output is non-deterministic.
    }
  }
}

/** Polls an async provider job: returns the output, asks for a fresh generation, or reschedules itself. */
async function pollOnce(
  job: SegmentJob,
  token: string | undefined,
  seg: SegmentRow,
  provider: VideoProvider,
): Promise<VideoOutput | 'regenerate' | 'gave_up'> {
  if (!provider.poll) throw new ProviderError(`provider ${provider.id} returned a job id but has no poll()`, false, true);
  const r = await provider.poll(seg.provider_job_id!);
  if (r.state === 'completed') return r.output;

  const elapsed = Date.now() - (seg.submitted_at?.getTime() ?? Date.now());
  if (r.state === 'pending' && elapsed < config.PROVIDER_JOB_TIMEOUT_MS) return delay(job, token);

  const reason = r.state === 'failed' ? r.reason : `provider job timed out after ${Math.round(elapsed / 1000)}s`;
  await updateSegment(seg.id, { status: 'reserved', provider_job_id: null, submitted_at: null });
  if (r.state === 'failed' && r.retryable) throw new ProviderError(reason, true);
  return (await recordRejection(seg.id, reason)) ? 'regenerate' : 'gave_up';
}

/** Re-queues the job for the next poll without consuming a retry attempt. */
async function delay(job: SegmentJob, token: string | undefined): Promise<never> {
  await job.moveToDelayed(Date.now() + config.PROVIDER_POLL_INTERVAL_MS, token);
  throw new DelayedError();
}

/** Increments the rejection counter. Returns false (and gives up) once the limit is exceeded. */
async function recordRejection(segmentId: string, reason: string): Promise<boolean> {
  const r = await pool.query<{ provider_failures: number }>(
    `UPDATE segments SET provider_failures = provider_failures + 1, error = $2, updated_at = now() WHERE id = $1 RETURNING provider_failures`,
    [segmentId, reason.slice(0, 1000)],
  );
  const failures = r.rows[0]?.provider_failures ?? Infinity;
  if (failures > config.SEGMENT_PROVIDER_RETRIES) {
    await giveUpSegment(segmentId, `rejected ${failures} times, last: ${reason}`);
    return false;
  }
  console.warn(`[segment ${segmentId}] provider rejection ${failures}/${config.SEGMENT_PROVIDER_RETRIES + 1}: ${reason}`);
  return true;
}

async function buildRequest(seg: SegmentRow, video: VideoRow, provider: VideoProvider): Promise<GenerateRequest> {
  const req: GenerateRequest = {
    prompt: seg.prompt,
    durationSeconds: Math.min(Math.max(seg.duration_seconds, provider.capabilities.minSeconds), provider.capabilities.maxSeconds),
    aspectRatio: video.aspect_ratio as GenerateRequest['aspectRatio'],
    resolution: video.resolution,
    model: video.model ?? undefined,
    requestId: seg.id,
  };
  if (seg.idx > 0 && provider.capabilities.imageToVideo) {
    const prev = await getSegmentByIdx(video.id, seg.idx - 1);
    if (prev?.last_frame_key) {
      req.firstFrame = { data: await storage.readBuffer(prev.last_frame_key), mimeType: 'image/jpeg' };
      if (config.CONTINUATION_PREFIX) req.prompt = `${config.CONTINUATION_PREFIX}\n\n${seg.prompt}`;
    }
  }
  return req;
}

/** Downloads, validates and stores the clip plus its last frame. Returns true, or a reason it's unusable. */
async function deliver(seg: SegmentRow, output: VideoOutput): Promise<true | string> {
  const dir = path.resolve(config.TMP_DIR, `seg-${seg.id}`);
  await mkdir(dir, { recursive: true });
  try {
    const clip = path.join(dir, 'clip.mp4');
    await saveVideoOutput(output, clip);
    if (output.kind === 'file') await rm(output.path, { force: true });

    let info;
    try {
      info = await probe(clip);
    } catch (err) {
      if (err instanceof FfmpegError) return `invalid clip: ${errMsg(err)}`;
      throw err;
    }
    const frame = path.join(dir, 'last.jpg');
    await extractLastFrame(clip, frame);

    const outputKey = keys.segment(seg.video_id, seg.idx);
    const frameKey = keys.lastFrame(seg.video_id, seg.idx);
    await storage.putFile(outputKey, clip, 'video/mp4');
    await storage.putFile(frameKey, frame, 'image/jpeg');
    await updateSegment(seg.id, {
      status: 'completed',
      output_key: outputKey,
      last_frame_key: frameKey,
      actual_duration_s: info.durationS,
      has_audio: info.hasAudio,
      error: null,
    });
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
