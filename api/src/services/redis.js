'use strict';

const Redis = require('ioredis');

class RedisClient {
  constructor() {
    this.client = null;
    this.subscriber = null;
  }

  async connect() {
    const opts = {
      retryStrategy: (times) => Math.min(times * 200, 5000),
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      lazyConnect: true,
    };

    this.client = new Redis(process.env.REDIS_URL, opts);
    this.subscriber = new Redis(process.env.REDIS_URL, opts);

    await this.client.connect();
    await this.subscriber.connect();
  }

  async ping() { return this.client.ping(); }
  async get(key) { return this.client.get(key); }
  async set(key, value, ...args) { return this.client.set(key, value, ...args); }
  async del(...keys) { return this.client.del(...keys); }
  async exists(...keys) { return this.client.exists(...keys); }
  async expire(key, seconds) { return this.client.expire(key, seconds); }
  async incr(key) { return this.client.incr(key); }
  async hset(key, ...args) { return this.client.hset(key, ...args); }
  async hget(key, field) { return this.client.hget(key, field); }
  async hgetall(key) { return this.client.hgetall(key); }
  async publish(channel, message) { return this.client.publish(channel, message); }
  async subscribe(channel, handler) {
    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (ch, msg) => {
      if (ch === channel) handler(msg);
    });
  }

  async setNX(key, value, ttlMs) {
    return this.client.set(key, value, 'PX', ttlMs, 'NX');
  }

  async quit() {
    if (this.client) await this.client.quit();
    if (this.subscriber) await this.subscriber.quit();
  }
}

module.exports = new RedisClient();
