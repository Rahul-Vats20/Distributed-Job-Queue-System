'use strict';

const { v4: uuidv4 } = require('uuid');
const { JOB_STATUS, JOB_EVENTS, REDIS_KEYS } = require('../constants');

class JobService {
  constructor(db, redis, mq) {
    this.db = db;
    this.redis = redis;
    this.mq = mq;
  }

  /**
   * Create and immediately enqueue a job
   */
  async createJob(jobData) {
    const {
      name,
      queue = 'default',
      priority = 'normal',
      payload = {},
      maxRetries = 3,
      retryDelayMs = 5000,
      retryStrategy = 'exponential',
      scheduledAt = new Date(),
      tags = [],
      metadata = {},
      timeoutMs = 30000,
    } = jobData;

    const id = uuidv4();

    const { rows } = await this.db.query(
      `INSERT INTO jobs (
        id, name, queue, priority, status, payload,
        max_retries, retry_delay_ms, retry_strategy,
        scheduled_at, tags, metadata, timeout_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        id, name, queue, priority, JOB_STATUS.PENDING,
        JSON.stringify(payload), maxRetries, retryDelayMs,
        retryStrategy, scheduledAt, tags,
        JSON.stringify(metadata), timeoutMs,
      ]
    );

    const job = rows[0];

    // Log creation event
    await this._logEvent(job.id, JOB_EVENTS.CREATED, null, `Job "${name}" created`);

    // Enqueue immediately if scheduled for now or past
    if (new Date(scheduledAt) <= new Date()) {
      await this._enqueue(job);
    }

    // Publish real-time update via Redis pub/sub
    await this._publishUpdate(job);

    return job;
  }

  /**
   * Get job by ID
   */
  async getJob(jobId) {
    const { rows } = await this.db.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
    return rows[0] || null;
  }

  /**
   * List jobs with filters and pagination
   */
  async listJobs({ queue, status, priority, tags, limit = 20, offset = 0, sortBy = 'created_at', sortDir = 'desc' }) {
    let where = [];
    let params = [];
    let i = 1;

    if (queue) { where.push(`queue = $${i++}`); params.push(queue); }
    if (status) { where.push(`status = $${i++}`); params.push(status); }
    if (priority) { where.push(`priority = $${i++}`); params.push(priority); }
    if (tags && tags.length > 0) { where.push(`tags && $${i++}`); params.push(tags); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const allowedSorts = ['created_at', 'updated_at', 'scheduled_at', 'priority', 'status'];
    const safeSort = allowedSorts.includes(sortBy) ? sortBy : 'created_at';
    const safeDir = sortDir === 'asc' ? 'ASC' : 'DESC';

    const { rows } = await this.db.query(
      `SELECT * FROM jobs ${whereClause}
       ORDER BY ${safeSort} ${safeDir}
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, limit, offset]
    );

    const { rows: countRows } = await this.db.query(
      `SELECT COUNT(*) FROM jobs ${whereClause}`,
      params
    );

    return {
      jobs: rows,
      total: parseInt(countRows[0].count),
      limit,
      offset,
    };
  }

  /**
   * Cancel a pending/queued job
   */
  async cancelJob(jobId) {
    const job = await this.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (!['pending', 'queued'].includes(job.status)) {
      throw new Error(`Cannot cancel job in status: ${job.status}`);
    }

    const { rows } = await this.db.query(
      `UPDATE jobs SET status = 'failed', error = 'Cancelled by user',
       failed_at = NOW() WHERE id = $1 RETURNING *`,
      [jobId]
    );

    await this._logEvent(jobId, JOB_EVENTS.FAILED, null, 'Job cancelled by user');
    await this._publishUpdate(rows[0]);
    return rows[0];
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId) {
    const job = await this.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (!['failed', 'dead'].includes(job.status)) {
      throw new Error(`Cannot retry job in status: ${job.status}`);
    }

    const { rows } = await this.db.query(
      `UPDATE jobs SET status = 'pending', retry_count = 0,
       error = NULL, error_stack = NULL, failed_at = NULL
       WHERE id = $1 RETURNING *`,
      [jobId]
    );

    await this._enqueue(rows[0]);
    await this._logEvent(jobId, JOB_EVENTS.REQUEUED, null, 'Job manually retried');
    await this._publishUpdate(rows[0]);
    return rows[0];
  }

  /**
   * Get job events (audit trail)
   */
  async getJobEvents(jobId) {
    const { rows } = await this.db.query(
      'SELECT * FROM job_events WHERE job_id = $1 ORDER BY occurred_at ASC',
      [jobId]
    );
    return rows;
  }

  /**
   * Get job progress from Redis
   */
  async getJobProgress(jobId) {
    const data = await this.redis.get(REDIS_KEYS.JOB_PROGRESS(jobId));
    return data ? JSON.parse(data) : null;
  }

  // ─── Private helpers ─────────────────────────────────────────

  async _enqueue(job) {
    await this.db.query(
      `UPDATE jobs SET status = $1 WHERE id = $2`,
      [JOB_STATUS.QUEUED, job.id]
    );
    await this.mq.publishJob(job.queue, job);
    await this._logEvent(job.id, JOB_EVENTS.QUEUED, null, `Job queued to "${job.queue}"`);
  }

  async _logEvent(jobId, eventType, workerId, message, data = {}) {
    await this.db.query(
      `INSERT INTO job_events (job_id, event_type, worker_id, message, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, eventType, workerId, message, JSON.stringify(data)]
    );
  }

  async _publishUpdate(job) {
    await this.redis.publish('job:updates', JSON.stringify({
      type: 'job:update',
      job: {
        id: job.id,
        name: job.name,
        queue: job.queue,
        status: job.status,
        priority: job.priority,
        retry_count: job.retry_count,
        updated_at: job.updated_at,
      },
    }));
  }
}

module.exports = JobService;
