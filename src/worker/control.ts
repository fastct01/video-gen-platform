import { refundSegment } from '../db/billing.js';
import {
  ensureSegment,
  getSegment,
  getVideo,
  plannedSegmentSeconds,
  promptForSegment,
  setStopReason,
  type StopReason,
} from '../db/repo.js';
import { providerCapabilities } from '../providers/registry.js';
import { enqueueFinalize, enqueueSegment } from '../queue/queues.js';

const TERMINAL_SEGMENT = new Set(['completed', 'skipped', 'failed', 'canceled']);
export const isTerminalSegment = (status: string) => TERMINAL_SEGMENT.has(status);

const TERMINAL_VIDEO = new Set(['completed', 'failed', 'canceled']);
export const isTerminalVideo = (status: string) => TERMINAL_VIDEO.has(status);

/** Records why the video stops (first reason wins) and hands it to the finalize queue. */
export async function stopVideo(videoId: string, reason: StopReason, error?: string): Promise<void> {
  await setStopReason(videoId, reason, error);
  await enqueueFinalize(videoId);
}

/**
 * Called after segment `completedIdx` is stored. Either schedules the next segment or stops the video.
 * Idempotent: safe to call more than once for the same segment (ensureSegment + job ids dedupe).
 */
export async function advance(videoId: string, completedIdx: number): Promise<void> {
  const video = await getVideo(videoId);
  if (!video || isTerminalVideo(video.status) || video.stop_reason) {
    if (video?.stop_reason && !isTerminalVideo(video.status)) await enqueueFinalize(videoId);
    return;
  }
  if (video.cancel_requested) return stopVideo(videoId, 'canceled');

  const nextIdx = completedIdx + 1;
  const minSeconds = providerCapabilities(video.provider)?.minSeconds ?? 1;
  const seconds = plannedSegmentSeconds(video, nextIdx, minSeconds);
  if (seconds == null) {
    const targetReached =
      video.mode === 'duration' && video.target_seconds != null && nextIdx * video.segment_seconds >= video.target_seconds;
    return stopVideo(videoId, targetReached ? 'target_reached' : 'max_segments');
  }

  const next = await ensureSegment(videoId, nextIdx, seconds, promptForSegment(video, nextIdx));
  await enqueueSegment(next.id);
}

/**
 * Gives up on a segment: refunds its reservation, marks it failed and stops the video.
 * Segments that were already delivered are kept, so the user still gets the partial video.
 */
export async function giveUpSegment(segmentId: string, error: string): Promise<void> {
  const seg = await getSegment(segmentId);
  if (!seg || isTerminalSegment(seg.status)) return;
  await refundSegment({ segmentId, finalStatus: 'failed', error });
  await stopVideo(seg.video_id, 'segment_failed', `segment ${seg.idx} failed: ${error}`);
}
