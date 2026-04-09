// ============================================================
// Shared constants, types and utilities
// ============================================================

/** Queue names */
const QUEUES = {
  DEFAULT: 'default',
  EMAIL: 'email',
  IMAGE_PROCESSING: 'image-processing',
  REPORTS: 'reports',
  NOTIFICATIONS: 'notifications',
};

/** RabbitMQ exchange and routing keys */
const EXCHANGES = {
  JOBS: 'jobs.direct',
  DEAD_LETTER: 'jobs.dead-letter',
  RETRY: 'jobs.retry',
};

/** Job priorities (mapped to RabbitMQ priority 0-10) */
const PRIORITY_MAP = {
  low: 1,
  normal: 5,
  high: 8,
  critical: 10,
};

/** Job statuses */
const JOB_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RETRYING: 'retrying',
  DEAD: 'dead',
};

/** Event types for the audit log */
const JOB_EVENTS = {
  CREATED: 'created',
  QUEUED: 'queued',
  STARTED: 'started',
  PROGRESS: 'progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RETRIED: 'retried',
  DEAD: 'dead',
  REQUEUED: 'requeued',
  TIMEOUT: 'timeout',
};

/** Redis key patterns */
const REDIS_KEYS = {
  JOB_LOCK: (jobId) => `job:lock:${jobId}`,
  JOB_PROGRESS: (jobId) => `job:progress:${jobId}`,
  WORKER_HEARTBEAT: (workerId) => `worker:heartbeat:${workerId}`,
  WORKER_STATS: (workerId) => `worker:stats:${workerId}`,
  QUEUE_STATS: (queue) => `queue:stats:${queue}`,
  RATE_LIMIT: (queue) => `rate:${queue}`,
};

/** Calculate retry delay with exponential backoff + jitter */
function calculateRetryDelay(retryCount, baseDelayMs = 5000, strategy = 'exponential') {
  let delay;
  switch (strategy) {
    case 'linear':
      delay = baseDelayMs * (retryCount + 1);
      break;
    case 'fixed':
      delay = baseDelayMs;
      break;
    case 'exponential':
    default:
      delay = baseDelayMs * Math.pow(2, retryCount);
      break;
  }
  // Add ±20% jitter to avoid thundering herd
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  return Math.min(delay + jitter, 10 * 60 * 1000); // cap at 10 minutes
}

/** Generate a worker ID */
function generateWorkerId() {
  const hostname = require('os').hostname();
  const pid = process.pid;
  const rand = Math.random().toString(36).slice(2, 6);
  return `worker-${hostname}-${pid}-${rand}`;
}

/** Sleep helper */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Safe JSON parse */
function safeJsonParse(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = {
  QUEUES,
  EXCHANGES,
  PRIORITY_MAP,
  JOB_STATUS,
  JOB_EVENTS,
  REDIS_KEYS,
  calculateRetryDelay,
  generateWorkerId,
  sleep,
  safeJsonParse,
};
