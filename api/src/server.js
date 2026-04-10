'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const pino = require('pino');
const path = require('path');

const db = require('./services/database');
const redisClient = require('./services/redis');
const rabbitMQ = require('./services/rabbitmq');
const jobRoutes = require('./routes/jobs');
const queueRoutes = require('./routes/queues');
const workerRoutes = require('./routes/workers');
const statsRoutes = require('./routes/stats');
const deadLetterRoutes = require('./routes/deadletter');
const { errorHandler } = require('./middleware/errorHandler');
const { setupWebSocket } = require('./services/websocket');
const maintenanceRoutes = require('./routes/maintenance');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
const server = http.createServer(app);

// ─── Security & Middleware ────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      "script-src-attr": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "connect-src": ["'self'", "ws:", "wss:"],
    },
  },
}));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));

// Serve static dashboard files
app.use(express.static(path.join(__dirname, '../../dashboard')));

// Rate limiting
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  standardHeaders: true,
  message: { error: 'Too many requests, please slow down.' },
}));

// Attach shared services to request
app.use((req, _res, next) => {
  req.db = db;
  req.redis = redisClient;
  req.mq = rabbitMQ;
  req.logger = logger;
  next();
});

// ─── Routes ──────────────────────────────────────────────────
app.use('/api/jobs', jobRoutes);
app.use('/api/queues', queueRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/dead-letter', deadLetterRoutes);
app.use('/api/maintenance', maintenanceRoutes);

// Health check
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    await redisClient.ping();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: { postgres: 'up', redis: 'up', rabbitmq: rabbitMQ.isConnected() ? 'up' : 'down' },
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../dashboard/index.html'));
});

// ─── WebSocket for real-time updates ─────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
const { subscribeToRedis } = setupWebSocket(wss, redisClient, logger);

// ─── Error Handler ───────────────────────────────────────────
app.use(errorHandler);

// ─── Boot ────────────────────────────────────────────────────
async function start() {
  try {
    await db.connect();
    logger.info('PostgreSQL connected');

    await redisClient.connect();
    logger.info('Redis connected');
    subscribeToRedis();

    await rabbitMQ.connect();
    logger.info('RabbitMQ connected');

    const port = process.env.PORT || 3000;
    server.listen(port, () => {
      logger.info({ port }, 'API server listening');
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start API server');
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down...');
  server.close(async () => {
    await rabbitMQ.close();
    await redisClient.quit();
    await db.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();

module.exports = { app, server };
