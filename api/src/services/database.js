'use strict';

const { Pool } = require('pg');

class Database {
  constructor() {
    this.pool = null;
  }

  async connect() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5, // Lowered for free tier compatibility
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL error:', err);
    });

    // Test connection
    const client = await this.pool.connect();
    client.release();
  }

  async query(text, params) {
    const start = Date.now();
    const result = await this.pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn({ query: text, duration }, 'Slow query detected');
    }
    return result;
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async end() {
    if (this.pool) await this.pool.end();
  }
}

module.exports = new Database();
