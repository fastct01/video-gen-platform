import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export const SEGMENT_QUEUE = 'video-segments';
export const FINALIZE_QUEUE = 'video-finalize';

/** BullMQ workers need maxRetriesPerRequest=null on their connection. */
export function redisConnection(): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

const connection = redisConnection();

export const segmentQueue = new Queue<{ segmentId: string }>(SEGMENT_QUEUE, {
  connection,
  defaultJobOptions: {
    // Transient errors (network, 429, 5xx) are retried with exponential backoff: 10s, 20s, 40s...
    attempts: 6,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
    removeOnFail: { age: 30 * 24 * 3600 },
  },
});

export const finalizeQueue = new Queue<{ videoId: string }>(FINALIZE_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: { age: 7 * 24 * 3600 },
    removeOnFail: { age: 30 * 24 * 3600 },
  },
});

// Job ids make enqueueing idempotent: the same segment / video can't be queued twice.
export const enqueueSegment = (segmentId: string) =>
  segmentQueue.add('segment', { segmentId }, { jobId: `seg-${segmentId}` });

export const enqueueFinalize = (videoId: string) =>
  finalizeQueue.add('finalize', { videoId }, { jobId: `final-${videoId}` });

export async function closeQueues(): Promise<void> {
  await Promise.all([segmentQueue.close(), finalizeQueue.close()]);
  connection.disconnect();
}
