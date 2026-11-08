import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'bullmq';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { updateVideo } from '../db/repo.js';
import { errMsg } from '../lib/util.js';
import { listProviders } from '../providers/registry.js';
import { startProviderSettingsSync } from '../providers/settings.js';
import {
  closeQueues,
  enqueueFinalize,
  enqueueSegment,
  FINALIZE_QUEUE,
  finalizeQueue,
  redisConnection,
  SEGMENT_QUEUE,
  segmentQueue,
} from '../queue/queues.js';
import { advance, giveUpSegment } from './control.js';
import { processFinalize } from './finalize.js';
import { processSegment } from './segment.js';

await mkdir(path.resolve(config.TMP_DIR), { recursive: true });
const stopSettingsSync = await startProviderSettingsSync();

const segmentWorker = new Worker(SEGMENT_QUEUE, processSegment, {
  connection: redisConnection(),
  concurrency: config.SEGMENT_WORKER_CONCURRENCY,
  // Synchronous providers hold the job for minutes; the lock is renewed while the process is alive.
  lockDuration: 60_000,
  maxStalledCount: 3,
});

const finalizeWorker = new Worker(FINALIZE_QUEUE, processFinalize, {
  connection: redisConnection(),
  concurrency: config.FINALIZE_WORKER_CONCURRENCY,
  lockDuration: 120_000,
});

const isLastAttempt = (job: { attemptsMade: number; opts: { attempts?: number } }) => job.attemptsMade >= (job.opts.attempts ?? 1);

segmentWorker.on('failed', (job, err) => {
  if (!job) return;
  console.warn(`[segment ${job.data.segmentId}] attempt ${job.attemptsMade} failed: ${errMsg(err)}`);
  if (isLastAttempt(job)) {
    giveUpSegment(job.data.segmentId, errMsg(err)).catch((e) => console.error('giveUpSegment failed', e));
  }
});

finalizeWorker.on('failed', (job, err) => {
  if (!job) return;
  console.warn(`[video ${job.data.videoId}] finalize attempt ${job.attemptsMade} failed: ${errMsg(err)}`);
  if (isLastAttempt(job)) {
    updateVideo(job.data.videoId, { status: 'failed', error: `stitching failed: ${errMsg(err)}`, completed_at: new Date() }).catch(
      (e) => console.error('marking video failed', e),
    );
  }
});

for (const w of [segmentWorker, finalizeWorker]) w.on('error', (err) => console.error(`[${w.name}] worker error`, err));

/**
 * Safety net for crashes between a DB write and the matching queue write (or a lost `failed` event).
 * Every action is idempotent, so running it while jobs are active is harmless.
 */
async function reconcile(): Promise<void> {
  const rows = await pool.query<{ id: string; stop_reason: string | null; seg_id: string | null; idx: number | null; seg_status: string | null }>(
    `SELECT v.id, v.stop_reason, s.id AS seg_id, s.idx, s.status AS seg_status
     FROM videos v
     LEFT JOIN LATERAL (SELECT id, idx, status FROM segments WHERE video_id = v.id ORDER BY idx DESC LIMIT 1) s ON true
     WHERE v.status IN ('queued', 'generating', 'stitching') AND v.created_at < now() - interval '1 minute'`,
  );
  for (const v of rows.rows) {
    try {
      const segBusy = v.seg_status && ['pending', 'reserved', 'submitted'].includes(v.seg_status);
      if (segBusy) {
        const job = await segmentQueue.getJob(`seg-${v.seg_id}`);
        const state = job ? await job.getState() : 'missing';
        if (state === 'failed') await giveUpSegment(v.seg_id!, job?.failedReason || 'job failed');
        else if (state === 'missing' || state === 'completed' || state === 'unknown') {
          await job?.remove();
          await enqueueSegment(v.seg_id!);
        }
      } else if (v.stop_reason) {
        const job = await finalizeQueue.getJob(`final-${v.id}`);
        const state = job ? await job.getState() : 'missing';
        if (state === 'failed') {
          await updateVideo(v.id, { status: 'failed', error: `stitching failed: ${job?.failedReason ?? ''}`, completed_at: new Date() });
        } else if (state === 'missing' || state === 'completed' || state === 'unknown') {
          await job?.remove();
          await enqueueFinalize(v.id);
        }
      } else if (v.seg_status === 'completed') {
        await advance(v.id, v.idx!);
      }
    } catch (err) {
      console.error(`[reconcile] video ${v.id}:`, errMsg(err));
    }
  }
}

const runReconcile = () => reconcile().catch((err) => console.error('[reconcile]', errMsg(err)));
await runReconcile();
const reconcileTimer = setInterval(runReconcile, 60_000);

console.log(
  `worker started: providers=[${listProviders().map((p) => p.id).join(', ') || 'none'}] ` +
    `segment concurrency=${config.SEGMENT_WORKER_CONCURRENCY} finalize concurrency=${config.FINALIZE_WORKER_CONCURRENCY}`,
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: waiting for active jobs to finish...`);
  clearInterval(reconcileTimer);
  stopSettingsSync();
  await Promise.all([segmentWorker.close(), finalizeWorker.close()]);
  await closeQueues();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
