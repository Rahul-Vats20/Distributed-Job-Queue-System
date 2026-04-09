'use strict';

const pino = require('pino');
const { Pool } = require('pg');
const Redis = require('ioredis');
const amqp = require('amqplib');
const os = require('os');
const { QUEUES, EXCHANGES, JOB_STATUS, JOB_EVENTS, REDIS_KEYS, calculateRetryDelay, generateWorkerId, sleep } = require('./constants');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const WORKER_ID = generateWorkerId();
const WORKER_HOST = os.hostname();
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY) || 5;

let db, redis, mqConn, mqChannel;
let activeJobs = 0;
let isShuttingDown = false;

async function setupTopology(ch) {
  // Dead-letter exchange
  await ch.assertExchange(EXCHANGES.DEAD_LETTER, 'direct', { durable: true });
  // Retry exchange
  await ch.assertExchange(EXCHANGES.RETRY, 'direct', { durable: true });
  // Main jobs exchange
  await ch.assertExchange(EXCHANGES.JOBS, 'direct', { durable: true });

  // Dead letter queue
  await ch.assertQueue('dead-letter-queue', { durable: true });
  await ch.bindQueue('dead-letter-queue', EXCHANGES.DEAD_LETTER, 'dead');

  for (const queueName of Object.values(QUEUES)) {
    // Retry queue
    const retryQueue = `${queueName}.retry`;
    await ch.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': EXCHANGES.JOBS,
        'x-dead-letter-routing-key': queueName,
      },
    });
    await ch.bindQueue(retryQueue, EXCHANGES.RETRY, queueName);

    // Main work queue
    await ch.assertQueue(queueName, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': EXCHANGES.DEAD_LETTER,
        'x-dead-letter-routing-key': 'dead',
        'x-max-priority': 10,
      },
    });
    await ch.bindQueue(queueName, EXCHANGES.JOBS, queueName);
  }

  logger.info('RabbitMQ topology ready');
}

async function connectAll() {
  db = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, retryStrategy: (t) => Math.min(t * 200, 5000) });
  await redis.connect();

  mqConn = await amqp.connect(process.env.RABBITMQ_URL);
  mqChannel = await mqConn.createChannel();
  await mqChannel.prefetch(CONCURRENCY);

  // Assert all exchanges and queues before consuming
  await setupTopology(mqChannel);

  mqConn.on('close', () => { if (!isShuttingDown) setTimeout(() => reconnect(), 5000); });
  logger.info({ workerId: WORKER_ID, host: WORKER_HOST }, 'Worker connected to all services');
}

async function reconnect() {
  logger.warn('RabbitMQ disconnected, reconnecting...');
  try { await connectAll(); await startConsuming(); } catch(e) { setTimeout(reconnect, 5000); }
}

function startHeartbeat() {
  setInterval(async () => {
    const data = JSON.stringify({
      id: WORKER_ID, host: WORKER_HOST, pid: process.pid,
      activeJobs, maxConcurrency: CONCURRENCY,
      uptime: process.uptime(),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      status: isShuttingDown ? 'draining' : 'active',
      updatedAt: new Date().toISOString(),
    });
    await redis.set(REDIS_KEYS.WORKER_HEARTBEAT(WORKER_ID), data, 'EX', 30);
    await redis.publish('worker:updates', JSON.stringify({ type: 'worker:heartbeat', workerId: WORKER_ID }));
  }, 10000);
}

const processors = require('./processors');

async function processJob(job) {
  const startTime = Date.now();
  activeJobs++;

  logger.info({ jobId: job.id, name: job.name, queue: job.queue }, 'Processing job');

  const lockKey = REDIS_KEYS.JOB_LOCK(job.id);
  const lockAcquired = await redis.set(lockKey, WORKER_ID, 'EX', Math.ceil((job.timeout_ms || 30000) / 1000) + 10, 'NX');
  if (!lockAcquired) {
    logger.warn({ jobId: job.id }, 'Could not acquire lock');
    activeJobs--;
    return;
  }

  await db.query(
    `UPDATE jobs SET status=$1, started_at=NOW(), worker_id=$2, worker_host=$3 WHERE id=$4`,
    [JOB_STATUS.PROCESSING, WORKER_ID, WORKER_HOST, job.id]
  );
  await logEvent(job.id, JOB_EVENTS.STARTED, `Started by ${WORKER_ID}`);

  const reportProgress = async (percentage, message) => {
    await redis.set(REDIS_KEYS.JOB_PROGRESS(job.id), JSON.stringify({ percentage, message, updatedAt: new Date().toISOString() }), 'EX', 3600);
    await redis.publish('job:updates', JSON.stringify({ type: 'job:progress', jobId: job.id, percentage, message }));
  };

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Job timed out after ${job.timeout_ms}ms`)), job.timeout_ms || 30000);
  });

  try {
    const processor = processors[job.name] || processors['default'];
    const result = await Promise.race([processor(job, { reportProgress, logger }), timeoutPromise]);
    clearTimeout(timeoutId);

    const durationMs = Date.now() - startTime;
    await db.query(
      `UPDATE jobs SET status=$1, result=$2, completed_at=NOW() WHERE id=$3`,
      [JOB_STATUS.COMPLETED, JSON.stringify(result || {}), job.id]
    );
    await logEvent(job.id, JOB_EVENTS.COMPLETED, `Completed in ${durationMs}ms`);
    await redis.del(REDIS_KEYS.JOB_PROGRESS(job.id));
    await redis.publish('job:updates', JSON.stringify({ type: 'job:update', job: { id: job.id, status: 'completed' } }));
    logger.info({ jobId: job.id, durationMs }, 'Job completed');

  } catch (err) {
    clearTimeout(timeoutId);
    const retryCount = (job.retry_count || 0) + 1;
    logger.error({ jobId: job.id, err: err.message, retryCount }, 'Job failed');

    if (retryCount <= (job.max_retries || 3)) {
      const delayMs = calculateRetryDelay(retryCount - 1, job.retry_delay_ms || 5000, job.retry_strategy || 'exponential');
      const updatedJob = { ...job, retry_count: retryCount };

      await db.query(
        `UPDATE jobs SET status=$1, retry_count=$2, error=$3 WHERE id=$4`,
        [JOB_STATUS.RETRYING, retryCount, err.message, job.id]
      );
      await logEvent(job.id, JOB_EVENTS.RETRIED, `Retry ${retryCount}/${job.max_retries} in ${delayMs}ms`);

      const retryMsg = Buffer.from(JSON.stringify(updatedJob));
      mqChannel.publish(EXCHANGES.RETRY, job.queue, retryMsg, {
        persistent: true,
        expiration: String(Math.round(delayMs)),
      });
      await redis.publish('job:updates', JSON.stringify({ type: 'job:update', job: { id: job.id, status: 'retrying' } }));

    } else {
      await db.query(
        `UPDATE jobs SET status=$1, error=$2, error_stack=$3, failed_at=NOW() WHERE id=$4`,
        [JOB_STATUS.DEAD, err.message, err.stack, job.id]
      );
      await db.query(
        `INSERT INTO dead_letter_jobs (original_job_id, name, queue, payload, final_error, retry_count)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [job.id, job.name, job.queue, JSON.stringify(job.payload), err.message, retryCount - 1]
      );
      await logEvent(job.id, JOB_EVENTS.DEAD, `Exhausted ${job.max_retries} retries`);
      await redis.publish('job:updates', JSON.stringify({ type: 'job:update', job: { id: job.id, status: 'dead' } }));
    }
  } finally {
    await redis.del(lockKey);
    activeJobs--;
  }
}

async function logEvent(jobId, eventType, message) {
  await db.query(
    `INSERT INTO job_events (job_id, event_type, worker_id, message) VALUES ($1,$2,$3,$4)`,
    [jobId, eventType, WORKER_ID, message]
  );
}

async function startConsuming() {
  for (const queueName of Object.values(QUEUES)) {
    await mqChannel.consume(queueName, async (msg) => {
      if (!msg || isShuttingDown) return;
      try {
        const job = JSON.parse(msg.content.toString());
        await processJob(job);
        mqChannel.ack(msg);
      } catch (err) {
        logger.error({ err: err.message }, 'Unhandled error');
        mqChannel.nack(msg, false, false);
      }
    }, { noAck: false });
    logger.info({ queue: queueName }, 'Consuming queue');
  }
}

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down...');
  isShuttingDown = true;
  const deadline = Date.now() + 30000;
  while (activeJobs > 0 && Date.now() < deadline) {
    logger.info({ activeJobs }, 'Waiting for active jobs...');
    await sleep(1000);
  }
  await redis.del(REDIS_KEYS.WORKER_HEARTBEAT(WORKER_ID));
  if (mqChannel) await mqChannel.close();
  if (mqConn) await mqConn.close();
  await redis.quit();
  await db.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => { logger.error({ err }, 'Uncaught exception'); });
process.on('unhandledRejection', (err) => { logger.error({ err }, 'Unhandled rejection'); });

(async () => {
  await connectAll();
  startHeartbeat();
  await startConsuming();
  logger.info({ workerId: WORKER_ID, concurrency: CONCURRENCY }, 'Worker ready');
})();
