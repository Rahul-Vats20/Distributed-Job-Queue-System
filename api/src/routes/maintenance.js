'use strict';

const express = require('express');
const router = express.Router();
const { JOB_STATUS, REDIS_KEYS } = require('../constants');

/**
 * PURGE GHOST WORKERS
 * Removes heartbeat keys from Redis for workers that haven't 
 * been cleared properly.
 */
router.post('/purge-workers', async (req, res, next) => {
  try {
    const keys = await req.redis.keys('worker:heartbeat:*');
    if (keys.length > 0) {
      await req.redis.del(keys);
    }
    res.json({ success: true, purged: keys.length });
  } catch (err) {
    next(err);
  }
});

/**
 * RESET STUCK JOBS
 * Moves jobs from 'processing' or 'queued' back to 'pending' 
 * and then re-enqueues them so they can be picked up by fresh workers.
 */
router.post('/reset-jobs', async (req, res, next) => {
  try {
    const JobService = require('../services/jobService');
    const svc = new JobService(req.db, req.redis, req.mq);

    // 1. Find all jobs that might be orphaned
    const { rows: stuckJobs } = await req.db.query(
      `SELECT * FROM jobs WHERE status IN ('processing', 'queued')`
    );

    // 2. Reset and Re-enqueue
    for (const job of stuckJobs) {
      // Clear progress in Redis
      await req.redis.del(REDIS_KEYS.JOB_PROGRESS(job.id));
      
      // Move to pending then re-enqueue
      await req.db.query(
        `UPDATE jobs SET status = 'pending', worker_id = NULL, started_at = NULL, error = NULL WHERE id = $1`,
        [job.id]
      );
      
      // Re-fetch job data and call private enqueue
      const updatedJob = await svc.getJob(job.id);
      await svc._enqueue(updatedJob);
    }

    res.json({ success: true, resetCount: stuckJobs.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
