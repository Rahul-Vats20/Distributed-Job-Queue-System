'use strict';

const router = require('express').Router();
const { body, query, param, validationResult } = require('express-validator');
const JobService = require('../services/jobService');

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

// Lazy-init job service per request (uses req services)
const getJobService = (req) => new JobService(req.db, req.redis, req.mq);

// ─── POST /api/jobs ───────────────────────────────────────────
router.post('/',
  body('name').notEmpty().isString().withMessage('Job name is required'),
  body('queue').optional().isIn(['default', 'email', 'image-processing', 'reports', 'notifications']),
  body('priority').optional().isIn(['low', 'normal', 'high', 'critical']),
  body('payload').optional().isObject(),
  body('maxRetries').optional().isInt({ min: 0, max: 10 }),
  body('retryDelayMs').optional().isInt({ min: 100, max: 300000 }),
  body('retryStrategy').optional().isIn(['fixed', 'linear', 'exponential']),
  body('timeoutMs').optional().isInt({ min: 1000, max: 600000 }),
  body('tags').optional().isArray(),
  body('scheduledAt').optional().isISO8601(),
  validate,
  async (req, res, next) => {
    try {
      const job = await getJobService(req).createJob(req.body);
      res.status(201).json({ success: true, job });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/jobs ────────────────────────────────────────────
router.get('/',
  query('queue').optional().isString(),
  query('status').optional().isIn(['pending', 'queued', 'processing', 'completed', 'failed', 'retrying', 'dead']),
  query('priority').optional().isIn(['low', 'normal', 'high', 'critical']),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('offset').optional().isInt({ min: 0 }),
  query('sortBy').optional().isIn(['created_at', 'updated_at', 'scheduled_at', 'priority']),
  query('sortDir').optional().isIn(['asc', 'desc']),
  validate,
  async (req, res, next) => {
    try {
      const result = await getJobService(req).listJobs({
        queue: req.query.queue,
        status: req.query.status,
        priority: req.query.priority,
        tags: req.query.tags ? req.query.tags.split(',') : undefined,
        limit: req.query.limit ? parseInt(req.query.limit) : 20,
        offset: req.query.offset ? parseInt(req.query.offset) : 0,
        sortBy: req.query.sortBy,
        sortDir: req.query.sortDir,
      });
      res.json(result);
    } catch (err) { next(err); }
  }
);

// ─── GET /api/jobs/:id ────────────────────────────────────────
router.get('/:id',
  param('id').isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const job = await getJobService(req).getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      res.json({ job });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/jobs/:id/events ─────────────────────────────────
router.get('/:id/events',
  param('id').isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const events = await getJobService(req).getJobEvents(req.params.id);
      res.json({ events });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/jobs/:id/progress ───────────────────────────────
router.get('/:id/progress',
  param('id').isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const progress = await getJobService(req).getJobProgress(req.params.id);
      res.json({ progress: progress || { percentage: 0, message: 'Waiting' } });
    } catch (err) { next(err); }
  }
);

// ─── POST /api/jobs/:id/cancel ────────────────────────────────
router.post('/:id/cancel',
  param('id').isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const job = await getJobService(req).cancelJob(req.params.id);
      res.json({ success: true, job });
    } catch (err) { next(err); }
  }
);

// ─── POST /api/jobs/:id/retry ─────────────────────────────────
router.post('/:id/retry',
  param('id').isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const job = await getJobService(req).retryJob(req.params.id);
      res.json({ success: true, job });
    } catch (err) { next(err); }
  }
);

// ─── POST /api/jobs/bulk ──────────────────────────────────────
router.post('/bulk',
  body('jobs').isArray({ min: 1, max: 100 }),
  validate,
  async (req, res, next) => {
    try {
      const service = getJobService(req);
      const results = await Promise.allSettled(
        req.body.jobs.map((j) => service.createJob(j))
      );

      const created = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      const failed = results.filter(r => r.status === 'rejected').map((r, i) => ({
        index: i,
        error: r.reason?.message,
      }));

      res.status(207).json({
        success: true,
        created: created.length,
        failed: failed.length,
        jobs: created,
        errors: failed,
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
