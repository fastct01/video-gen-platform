import { config } from '../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import type { Storage } from './types.js';

function create(): Storage {
  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
    return new S3Storage(config.S3_BUCKET, {
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
  }
  return new LocalStorage(config.STORAGE_LOCAL_DIR, config.PUBLIC_BASE_URL, config.URL_SIGNING_SECRET);
}

export const storage = create();
export const keys = {
  segment: (videoId: string, idx: number) => `videos/${videoId}/segments/${String(idx).padStart(4, '0')}.mp4`,
  lastFrame: (videoId: string, idx: number) => `videos/${videoId}/frames/${String(idx).padStart(4, '0')}-last.jpg`,
  final: (videoId: string) => `videos/${videoId}/final.mp4`,
};
