CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Users. token_balance is the spendable balance; it can never go negative.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  api_key_hash   text NOT NULL UNIQUE,          -- sha256(api key), the key itself is never stored
  token_balance  bigint NOT NULL DEFAULT 0 CHECK (token_balance >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Videos: one long-form generation request.
-- ---------------------------------------------------------------------------
CREATE TYPE video_status AS ENUM ('queued', 'generating', 'stitching', 'completed', 'failed', 'canceled');
CREATE TYPE video_mode   AS ENUM ('duration', 'until_balance');
CREATE TYPE stop_reason  AS ENUM ('target_reached', 'insufficient_balance', 'max_segments', 'canceled', 'segment_failed');

CREATE TABLE videos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  status             video_status NOT NULL DEFAULT 'queued',
  mode               video_mode NOT NULL,
  prompt             text NOT NULL,
  segment_prompts    jsonb,                     -- optional per-segment prompts (storyboard); cycles if shorter
  provider           text NOT NULL,
  model              text,
  aspect_ratio       text NOT NULL,
  resolution         text NOT NULL,
  segment_seconds    int NOT NULL CHECK (segment_seconds > 0),
  target_seconds     int,                       -- null in until_balance mode
  max_segments       int NOT NULL CHECK (max_segments > 0),
  tokens_per_second  int NOT NULL CHECK (tokens_per_second >= 0),
  cancel_requested   boolean NOT NULL DEFAULT false,
  stop_reason        stop_reason,
  final_key          text,
  final_duration_s   numeric(10, 3),
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
CREATE INDEX videos_user_created_idx ON videos (user_id, created_at DESC);
CREATE INDEX videos_user_active_idx  ON videos (user_id) WHERE status IN ('queued', 'generating', 'stitching');

-- ---------------------------------------------------------------------------
-- Segments: one provider call (~3-10 s clip). Created lazily, one at a time,
-- so a video never has more than one segment in flight.
-- ---------------------------------------------------------------------------
CREATE TYPE segment_status AS ENUM (
  'pending',     -- created, tokens not reserved yet
  'reserved',    -- tokens debited, provider call not finished
  'submitted',   -- async provider accepted the job, polling
  'completed',   -- clip stored
  'skipped',     -- not generated: insufficient balance (nothing was debited)
  'failed',      -- gave up; tokens refunded
  'canceled'     -- user canceled before generation; tokens refunded if they were reserved
);

CREATE TABLE segments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id           uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  idx                int NOT NULL CHECK (idx >= 0),
  status             segment_status NOT NULL DEFAULT 'pending',
  duration_seconds   int NOT NULL CHECK (duration_seconds > 0),
  tokens_reserved    bigint NOT NULL DEFAULT 0,
  prompt             text NOT NULL,
  provider_job_id    text,
  provider_failures  int NOT NULL DEFAULT 0,
  output_key         text,
  last_frame_key     text,
  actual_duration_s  numeric(10, 3),
  has_audio          boolean,
  error              text,
  submitted_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, idx)
);

-- ---------------------------------------------------------------------------
-- Append-only token ledger. Every balance change has exactly one row.
-- idempotency_key makes retries safe: "reserve-<segment>", "refund-<segment>",
-- "credit-<payment id>". SUM(amount) per user == users.token_balance.
-- ---------------------------------------------------------------------------
CREATE TYPE token_tx_kind AS ENUM ('credit', 'reserve', 'refund', 'adjustment');

CREATE TABLE token_transactions (
  id               bigserial PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id),
  video_id         uuid REFERENCES videos(id) ON DELETE SET NULL,
  segment_id       uuid REFERENCES segments(id) ON DELETE SET NULL,
  kind             token_tx_kind NOT NULL,
  amount           bigint NOT NULL,             -- negative = debit, positive = credit
  balance_after    bigint,
  idempotency_key  text NOT NULL UNIQUE,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX token_tx_user_idx  ON token_transactions (user_id, created_at DESC);
CREATE INDEX token_tx_video_idx ON token_transactions (video_id);
