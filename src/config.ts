import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  // On Render, RENDER_EXTERNAL_URL (e.g. https://video-studio.onrender.com) is set automatically.
  PUBLIC_BASE_URL: z.string().url().default(process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000'),
  /** Set to true behind a reverse proxy / load balancer (Render, Fly, nginx) so client IPs and https are seen correctly. */
  TRUST_PROXY: bool.default(false),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ADMIN_TOKEN: z.string().min(12),
  URL_SIGNING_SECRET: z.string().min(12),
  /** Encrypts users' provider API keys at rest. Falls back to URL_SIGNING_SECRET. Changing it means users re-enter their keys. */
  ENCRYPTION_KEY: z.string().min(16).optional().transform((v) => v || undefined),

  DEFAULT_PROVIDER: z.string().default('gemini'),
  GEMINI_API_KEY: z.string().optional().transform((v) => v || undefined),
  GEMINI_MODEL: z.string().default('gemini-omni-1.2-flash'),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com'),
  GEMINI_TOKENS_PER_SECOND: z.coerce.number().int().min(0).default(10),
  GEMINI_REQUEST_TIMEOUT_MS: z.coerce.number().int().default(15 * 60_000),
  /** Tokens granted once to the admin's UI account (created the first time you sign in to the UI with ADMIN_TOKEN). */
  LOCAL_USER_INITIAL_TOKENS: z.coerce.number().int().min(0).default(1000),
  MOCK_PROVIDER_ENABLED: bool.default(false),
  MOCK_TOKENS_PER_SECOND: z.coerce.number().int().min(0).default(1),
  MOCK_DELAY_MS: z.coerce.number().int().min(0).default(1500),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),

  DEFAULT_SEGMENT_SECONDS: z.coerce.number().int().min(1).default(8),
  MAX_SEGMENTS_PER_VIDEO: z.coerce.number().int().min(1).default(120),
  MAX_ACTIVE_VIDEOS_PER_USER: z.coerce.number().int().min(1).default(3),
  SEGMENT_PROVIDER_RETRIES: z.coerce.number().int().min(0).default(2),
  PROVIDER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
  PROVIDER_JOB_TIMEOUT_MS: z.coerce.number().int().default(30 * 60_000),
  STITCH_CROSSFADE_SECONDS: z.coerce.number().min(0).max(2).default(0.15),
  STITCH_FPS: z.coerce.number().int().min(1).max(120).default(24),
  CONTINUATION_PREFIX: z.string().default(''),

  SEGMENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  FINALIZE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(1),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./data/storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  TMP_DIR: z.string().default('./data/tmp'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
