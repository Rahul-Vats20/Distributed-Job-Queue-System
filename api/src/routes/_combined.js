'use strict';

// ─── Stats Route ─────────────────────────────────────────────
const statsRouter = require('express').Router();

statsRouter.get('/', async (req, res, next) => {
  try {
    const { rows: overview } = await req.db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
        COUNT(*) FILTER (WHERE status = 'queued')     AS queued,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE status = 'completed')  AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')     AS failed,
        COUNT(*) FILTER (WHERE status = 'retrying')   AS retrying,
        COUNT(*) FILTER (WHERE status = 'dead')       AS dead,
        COUNT(*)                                      AS total
      FROM jobs
    `);

    const { rows: byQueue } = await req.db.query(`
      SELECT queue, status, COUNT(*) AS count
      FROM jobs GROUP BY queue, status ORDER BY queue, status
    `);

    const { rows: throughput } = await req.db.query(`
      SELECT
        DATE_TRUNC('minute', completed_at) AS minute,
        COUNT(*) AS completed
      FROM jobs
      WHERE completed_at > NOW() - INTERVAL '1 hour'
        AND status = 'completed'
      GROUP BY 1 ORDER BY 1
    `);

    const { rows: avgDuration } = await req.db.query(`
      SELECT
        queue,
        ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::numeric, 0) AS avg_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::numeric, 0) AS p95_ms
      FROM jobs
      WHERE status = 'completed' AND started_at IS NOT NULL
      GROUP BY queue
    `);

    // RabbitMQ queue depths
    const queueDepths = {};
    const { QUEUES } = require('../constants');
    for (const q of Object.values(QUEUES)) {
      const info = await req.mq.getQueueInfo(q).catch(() => ({ messageCount: 0 }));
      queueDepths[q] = info.messageCount;
    }

    res.json({
      overview: overview[0],
      byQueue,
      throughput,
      avgDuration,
      queueDepths,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ─── Queues Route ─────────────────────────────────────────────
const queuesRouter = require('express').Router();

queuesRouter.get('/', async (req, res, next) => {
  try {
    const { QUEUES } = require('../constants');
    const queues = [];

    for (const q of Object.values(QUEUES)) {
      const { rows } = await req.db.query(
        `SELECT status, COUNT(*) FROM jobs WHERE queue = $1 GROUP BY status`, [q]
      );
      const info = await req.mq.getQueueInfo(q).catch(() => ({ messageCount: 0, consumerCount: 0 }));
      queues.push({
        name: q,
        stats: Object.fromEntries(rows.map(r => [r.status, parseInt(r.count)])),
        depth: info.messageCount,
        consumers: info.consumerCount,
      });
    }

    res.json({ queues });
  } catch (err) { next(err); }
});

queuesRouter.post('/:queue/pause', async (req, res) => {
  // In production this would pause consumers; we simulate it
  res.json({ message: `Queue ${req.params.queue} pause signal sent` });
});

// ─── Workers Route ────────────────────────────────────────────
const workersRouter = require('express').Router();

workersRouter.get('/', async (req, res, next) => {
  try {
    // Get worker heartbeats from Redis
    if (!req.redis?.client) {
      return res.json({ workers: [], stats: [], error: 'Redis not connected' });
    }
    const keys = await req.redis.client.keys('worker:heartbeat:*');
    const workers = [];

    for (const key of keys) {
      const data = await req.redis.get(key);
      if (data) workers.push(JSON.parse(data));
    }

    const { rows: workerStats } = await req.db.query('SELECT * FROM v_worker_stats');

    res.json({ workers, stats: workerStats });
  } catch (err) { next(err); }
});

// ─── Dead Letter Route ────────────────────────────────────────
const dlqRouter = require('express').Router();

dlqRouter.get('/', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    const { rows } = await req.db.query(
      `SELECT * FROM dead_letter_jobs ORDER BY moved_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: count } = await req.db.query('SELECT COUNT(*) FROM dead_letter_jobs');

    res.json({ jobs: rows, total: parseInt(count[0].count), limit, offset });
  } catch (err) { next(err); }
});

dlqRouter.post('/:id/requeue', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      'SELECT * FROM dead_letter_jobs WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'DLQ job not found' });

    const dlqJob = rows[0];

    // Re-insert as a new job
    const JobService = require('../services/jobService');
    const svc = new JobService(req.db, req.redis, req.mq);
    const newJob = await svc.createJob({
      name: dlqJob.name,
      queue: dlqJob.queue,
      payload: dlqJob.payload,
    });

    await req.db.query(
      'UPDATE dead_letter_jobs SET requeued = TRUE, requeued_at = NOW() WHERE id = $1',
      [dlqJob.id]
    );

    res.json({ success: true, newJob });
  } catch (err) { next(err); }
});

dlqRouter.delete('/:id', async (req, res, next) => {
  try {
    await req.db.query('DELETE FROM dead_letter_jobs WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = { statsRouter, queuesRouter, workersRouter, dlqRouter };
