-- ============================================================
-- Job Queue System - Database Schema
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Job Status Enum ─────────────────────────────────────────
CREATE TYPE job_status AS ENUM (
  'pending',
  'queued',
  'processing',
  'completed',
  'failed',
  'retrying',
  'dead'
);

-- ─── Job Priority Enum ───────────────────────────────────────
CREATE TYPE job_priority AS ENUM (
  'low',
  'normal',
  'high',
  'critical'
);

-- ─── Jobs Table ──────────────────────────────────────────────
CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  queue           VARCHAR(100) NOT NULL DEFAULT 'default',
  priority        job_priority NOT NULL DEFAULT 'normal',
  status          job_status NOT NULL DEFAULT 'pending',

  -- Payload
  payload         JSONB NOT NULL DEFAULT '{}',
  result          JSONB,
  error           TEXT,
  error_stack     TEXT,

  -- Retry config
  max_retries     INTEGER NOT NULL DEFAULT 3,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  retry_delay_ms  INTEGER NOT NULL DEFAULT 5000,  -- base delay
  retry_strategy  VARCHAR(20) NOT NULL DEFAULT 'exponential', -- linear | exponential | fixed

  -- Scheduling
  scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,

  -- Worker info
  worker_id       VARCHAR(100),
  worker_host     VARCHAR(255),

  -- Metadata
  tags            TEXT[] DEFAULT '{}',
  metadata        JSONB NOT NULL DEFAULT '{}',
  timeout_ms      INTEGER NOT NULL DEFAULT 30000,

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Dead Letter Queue ───────────────────────────────────────
CREATE TABLE dead_letter_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  original_job_id UUID NOT NULL,
  name            VARCHAR(255) NOT NULL,
  queue           VARCHAR(100) NOT NULL,
  payload         JSONB NOT NULL,
  final_error     TEXT NOT NULL,
  error_history   JSONB NOT NULL DEFAULT '[]',
  retry_count     INTEGER NOT NULL DEFAULT 0,
  moved_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed        BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     VARCHAR(100),
  requeued        BOOLEAN NOT NULL DEFAULT FALSE,
  requeued_at     TIMESTAMPTZ
);

-- ─── Job Events (audit log) ──────────────────────────────────
CREATE TABLE job_events (
  id          BIGSERIAL PRIMARY KEY,
  job_id      UUID NOT NULL,
  event_type  VARCHAR(50) NOT NULL,  -- created, queued, started, completed, failed, retried, dead
  worker_id   VARCHAR(100),
  message     TEXT,
  data        JSONB DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Queue Stats (materialized for dashboard) ────────────────
CREATE TABLE queue_stats (
  id              BIGSERIAL PRIMARY KEY,
  queue_name      VARCHAR(100) NOT NULL,
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pending_count   INTEGER NOT NULL DEFAULT 0,
  queued_count    INTEGER NOT NULL DEFAULT 0,
  processing_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  dead_count      INTEGER NOT NULL DEFAULT 0,
  avg_duration_ms FLOAT,
  throughput_per_min FLOAT
);

-- ─── Indexes ─────────────────────────────────────────────────
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_queue ON jobs(queue);
CREATE INDEX idx_jobs_priority ON jobs(priority);
CREATE INDEX idx_jobs_scheduled_at ON jobs(scheduled_at);
CREATE INDEX idx_jobs_status_queue ON jobs(status, queue);
CREATE INDEX idx_jobs_status_priority ON jobs(status, priority DESC);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX idx_jobs_tags ON jobs USING GIN(tags);
CREATE INDEX idx_jobs_payload ON jobs USING GIN(payload);

CREATE INDEX idx_job_events_job_id ON job_events(job_id);
CREATE INDEX idx_job_events_occurred_at ON job_events(occurred_at DESC);

CREATE INDEX idx_dlq_original_job_id ON dead_letter_jobs(original_job_id);
CREATE INDEX idx_dlq_moved_at ON dead_letter_jobs(moved_at DESC);
CREATE INDEX idx_dlq_reviewed ON dead_letter_jobs(reviewed);

CREATE INDEX idx_queue_stats_queue_name ON queue_stats(queue_name, snapshot_at DESC);

-- ─── Auto-update updated_at ──────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Seed initial queue stats ────────────────────────────────
INSERT INTO queue_stats (queue_name, pending_count) VALUES
  ('default', 0),
  ('email', 0),
  ('image-processing', 0),
  ('reports', 0),
  ('notifications', 0);

-- ─── Views ───────────────────────────────────────────────────
CREATE VIEW v_job_summary AS
SELECT
  queue,
  status,
  COUNT(*) as count,
  AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000) FILTER (WHERE status = 'completed') AS avg_duration_ms,
  MAX(created_at) as last_job_at
FROM jobs
GROUP BY queue, status;

CREATE VIEW v_worker_stats AS
SELECT
  worker_id,
  worker_host,
  COUNT(*) FILTER (WHERE status = 'processing') AS active_jobs,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed_jobs,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs,
  AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000) FILTER (WHERE status = 'completed') AS avg_duration_ms
FROM jobs
WHERE worker_id IS NOT NULL
GROUP BY worker_id, worker_host;
