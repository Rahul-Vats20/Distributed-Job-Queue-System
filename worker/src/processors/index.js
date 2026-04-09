'use strict';

/**
 * Job processors map: jobName => async function(job, ctx)
 * ctx = { reportProgress, logger }
 * Return value is stored as job.result
 */

const { sleep } = require('../constants');

// ─── Email Processor ─────────────────────────────────────────
async function sendEmail(job, { reportProgress, logger }) {
  const { to, subject, body, template } = job.payload;
  await reportProgress(10, 'Connecting to mail server...');
  await sleep(300 + Math.random() * 200);

  await reportProgress(40, 'Rendering template...');
  await sleep(200);

  await reportProgress(70, 'Sending email...');
  await sleep(400 + Math.random() * 300);

  // Simulate occasional failures
  if (Math.random() < 0.1) throw new Error('SMTP connection refused');

  await reportProgress(100, 'Email sent!');
  logger.info({ to, subject }, 'Email sent');
  return { messageId: `msg_${Date.now()}`, to, subject, sentAt: new Date().toISOString() };
}

// ─── Image Processing ─────────────────────────────────────────
async function processImage(job, { reportProgress }) {
  const { imageUrl, operations = [] } = job.payload;
  await reportProgress(5, 'Fetching image...');
  await sleep(500 + Math.random() * 500);

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    await reportProgress(Math.round(10 + (80 * i) / operations.length), `Applying ${op}...`);
    await sleep(600 + Math.random() * 400);
  }

  if (Math.random() < 0.05) throw new Error('Unsupported image format');

  await reportProgress(100, 'Image processed');
  return { outputUrl: `https://cdn.example.com/processed/${Date.now()}.jpg`, operations };
}

// ─── Report Generation ───────────────────────────────────────
async function generateReport(job, { reportProgress }) {
  const { reportType, dateRange, filters } = job.payload;
  await reportProgress(10, 'Querying database...');
  await sleep(1000 + Math.random() * 1000);

  await reportProgress(40, 'Aggregating data...');
  await sleep(800);

  await reportProgress(70, 'Rendering PDF...');
  await sleep(600 + Math.random() * 400);

  await reportProgress(90, 'Uploading to storage...');
  await sleep(300);

  if (Math.random() < 0.08) throw new Error('Report generation timeout — query too large');

  await reportProgress(100, 'Report ready');
  return {
    reportId: `rpt_${Date.now()}`,
    downloadUrl: `https://reports.example.com/${Date.now()}.pdf`,
    rowCount: Math.floor(Math.random() * 50000),
    generatedAt: new Date().toISOString(),
  };
}

// ─── Notification ────────────────────────────────────────────
async function sendNotification(job, { reportProgress }) {
  const { userId, channel, message } = job.payload;
  await reportProgress(20, `Sending ${channel} notification...`);
  await sleep(200 + Math.random() * 300);
  if (Math.random() < 0.05) throw new Error('Push service unavailable');
  await reportProgress(100, 'Notification delivered');
  return { userId, channel, deliveredAt: new Date().toISOString() };
}

// ─── Data Sync ───────────────────────────────────────────────
async function syncData(job, { reportProgress }) {
  const { source, destination, batchSize = 100 } = job.payload;
  const totalBatches = Math.floor(Math.random() * 10) + 3;

  for (let i = 0; i < totalBatches; i++) {
    await reportProgress(Math.round((i / totalBatches) * 100), `Syncing batch ${i + 1}/${totalBatches}...`);
    await sleep(300 + Math.random() * 200);
    if (Math.random() < 0.03) throw new Error('Source API rate limited');
  }

  return { source, destination, totalRecords: totalBatches * batchSize, syncedAt: new Date().toISOString() };
}

// ─── Default (unknown job type) ──────────────────────────────
async function defaultProcessor(job, { reportProgress, logger }) {
  logger.warn({ jobName: job.name }, 'No specific processor found, running generic processor');
  await reportProgress(50, 'Processing...');
  await sleep(500 + Math.random() * 1000);
  if (Math.random() < 0.15) throw new Error(`Unknown processor error for job: ${job.name}`);
  await reportProgress(100, 'Done');
  return { processed: true, jobName: job.name };
}

module.exports = {
  'send-email': sendEmail,
  'process-image': processImage,
  'generate-report': generateReport,
  'send-notification': sendNotification,
  'sync-data': syncData,
  'default': defaultProcessor,
};
