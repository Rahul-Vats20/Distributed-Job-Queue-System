'use strict';

const amqp = require('amqplib');
const { QUEUES, EXCHANGES, PRIORITY_MAP } = require('../constants');

class RabbitMQService {
  constructor() {
    this.connection = null;
    this.channel = null;
    this._connected = false;
  }

  isConnected() { return this._connected; }

  async connect() {
    this.connection = await amqp.connect(process.env.RABBITMQ_URL);
    this.channel = await this.connection.createChannel();
    this._connected = true;

    this.connection.on('close', () => {
      this._connected = false;
      console.error('RabbitMQ connection closed, reconnecting...');
      setTimeout(() => this.connect(), 5000);
    });

    this.connection.on('error', (err) => {
      console.error('RabbitMQ connection error:', err);
    });

    await this._setupTopology();
  }

  async _setupTopology() {
    const ch = this.channel;

    // Dead-letter exchange
    await ch.assertExchange(EXCHANGES.DEAD_LETTER, 'direct', { durable: true });

    // Retry exchange (delayed messages via TTL + DLX trick)
    await ch.assertExchange(EXCHANGES.RETRY, 'direct', { durable: true });

    // Main jobs exchange
    await ch.assertExchange(EXCHANGES.JOBS, 'direct', { durable: true });

    // Dead letter queue
    await ch.assertQueue('dead-letter-queue', {
      durable: true,
      arguments: { 'x-queue-type': 'classic' },
    });
    await ch.bindQueue('dead-letter-queue', EXCHANGES.DEAD_LETTER, 'dead');

    // Per-queue setup
    for (const [, queueName] of Object.entries(QUEUES)) {
      // Retry queue for this queue (messages stay here until TTL, then go back to main queue)
      const retryQueue = `${queueName}.retry`;
      await ch.assertQueue(retryQueue, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': EXCHANGES.JOBS,
          'x-dead-letter-routing-key': queueName,
        },
      });
      await ch.bindQueue(retryQueue, EXCHANGES.RETRY, queueName);

      // Main work queue with priority support
      await ch.assertQueue(queueName, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': EXCHANGES.DEAD_LETTER,
          'x-dead-letter-routing-key': 'dead',
          'x-max-priority': 10,
          'x-queue-type': 'classic',
        },
      });
      await ch.bindQueue(queueName, EXCHANGES.JOBS, queueName);
    }
  }

  /**
   * Publish a job to the main queue
   */
  async publishJob(queueName, job) {
    const priority = PRIORITY_MAP[job.priority] || 5;
    const msg = Buffer.from(JSON.stringify(job));

    this.channel.publish(EXCHANGES.JOBS, queueName, msg, {
      persistent: true,
      priority,
      contentType: 'application/json',
      messageId: job.id,
      timestamp: Date.now(),
      headers: {
        'x-job-name': job.name,
        'x-retry-count': job.retry_count || 0,
      },
    });
  }

  /**
   * Publish a job to the retry queue with a delay
   */
  async publishRetry(queueName, job, delayMs) {
    const msg = Buffer.from(JSON.stringify(job));

    // Use a per-message TTL on the retry queue
    const retryQueue = `${queueName}.retry`;
    await this.channel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': EXCHANGES.JOBS,
        'x-dead-letter-routing-key': queueName,
      },
    });

    this.channel.publish(EXCHANGES.RETRY, queueName, msg, {
      persistent: true,
      expiration: String(delayMs),
      contentType: 'application/json',
      messageId: job.id,
      headers: {
        'x-job-name': job.name,
        'x-retry-count': job.retry_count || 0,
        'x-retry-delay-ms': delayMs,
      },
    });
  }

  /**
   * Move a job to the dead-letter queue
   */
  async publishDeadLetter(job) {
    const msg = Buffer.from(JSON.stringify(job));
    this.channel.publish(EXCHANGES.DEAD_LETTER, 'dead', msg, {
      persistent: true,
      contentType: 'application/json',
      messageId: job.id,
    });
  }

  /**
   * Consume messages from a queue
   */
  async consume(queueName, handler, options = {}) {
    const ch = this.channel;
    await ch.prefetch(options.prefetch || 5);

    await ch.consume(queueName, async (msg) => {
      if (!msg) return;
      try {
        const job = JSON.parse(msg.content.toString());
        await handler(job, msg);
        ch.ack(msg);
      } catch (err) {
        // Nack without requeue — let our retry logic handle it
        ch.nack(msg, false, false);
      }
    }, { noAck: false });
  }

  async getQueueInfo(queueName) {
    try {
      return await this.channel.checkQueue(queueName);
    } catch {
      return { messageCount: 0, consumerCount: 0 };
    }
  }

  async close() {
    this._connected = false;
    if (this.channel) await this.channel.close();
    if (this.connection) await this.connection.close();
  }
}

module.exports = new RabbitMQService();
