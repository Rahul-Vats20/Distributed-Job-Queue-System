# ⚡ Distributed Job Queue System

A production-grade distributed background job processing system built with Node.js, RabbitMQ, Redis, and PostgreSQL — fully Dockerized and ready to scale.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           NGINX (Port 80)                           │
│                    Reverse Proxy + Load Balancer                    │
└──────────────┬──────────────────────────────┬───────────────────────┘
               │                              │
       ┌───────▼──────┐               ┌───────▼──────┐
       │   REST API   │               │  Dashboard   │
       │  Port 3000   │               │   Port 3001  │
       │  (Express)   │               │  (Static UI) │
       └──────┬───────┘               └──────────────┘
              │
    ┌─────────┼─────────────────────────────┐
    │         │                             │
┌───▼────┐ ┌──▼──────┐              ┌───────▼──────┐
│Postgres│ │  Redis  │              │  RabbitMQ    │
│  :5432 │ │  :6379  │              │  :5672/15672 │
│ Jobs   │ │ Locks   │              │  Exchanges   │
│ Events │ │Progress │              │  Queues      │
│  DLQ   │ │Pub/Sub  │              │  DLQ         │
└────────┘ └─────────┘              └──────┬───────┘
                                           │
                         ┌─────────────────┼─────────────────┐
                         │                 │                 │
                  ┌──────▼───┐      ┌──────▼───┐      ┌──────▼───┐
                  │ Worker 1 │      │ Worker 2 │      │ Worker 3 │
                  │(5 threads│      │(5 threads│      │(5 threads│
                  └──────────┘      └──────────┘      └──────────┘
```

## Queue Topology (RabbitMQ)

```
jobs.direct exchange
    └── [queue-name]  ──► Workers
                              │
                    ┌─────────┴──────────┐
                    │ success            │ failure (nack)
                    ▼                    ▼
              PostgreSQL         Retry Logic
               (completed)            │
                               ┌──────┴──────┐
                               │ retries left?│
                          yes ◄┤             ├► no
                          │    └─────────────┘   │
                          ▼                       ▼
                  jobs.retry exchange      jobs.dead-letter exchange
                  (TTL delay queue)        └── dead-letter-queue
                          │                       │
                          └──► back to main        └──► dead_letter_jobs
                               queue after              (PostgreSQL)
                               delay expires
```

## Features

| Feature | Implementation |
|---------|---------------|
| **Job Submission** | REST API — POST /api/jobs |
| **Priority Queues** | RabbitMQ x-max-priority (0-10) |
| **Retry Mechanism** | Exponential/linear/fixed backoff |
| **Retry Delay** | Per-message TTL on retry exchange |
| **Dead Letter Queue** | RabbitMQ DLX + PostgreSQL table |
| **Job Status Tracking** | PostgreSQL + Redis pub/sub |
| **Real-time Updates** | WebSocket (ws library) |
| **Distributed Locks** | Redis SET NX (prevent duplicate processing) |
| **Worker Heartbeats** | Redis keys with TTL |
| **Job Timeouts** | Promise.race() with configurable timeout |
| **Progress Reporting** | Redis + WebSocket |
| **Audit Trail** | job_events table in PostgreSQL |
| **Bulk Submission** | POST /api/jobs/bulk (up to 100) |
| **Horizontal Scaling** | Docker Compose replicas: 3 |
| **Graceful Shutdown** | SIGTERM drain → wait for active jobs |

---

## Quick Start

### Prerequisites
- Docker Desktop (or Docker Engine + Compose)

### 1. Start everything
```bash
git clone <repo>
cd job-queue-system
docker compose up --build
```

### 2. Access services
| Service | URL |
|---------|-----|
| **Dashboard** | http://localhost (or http://localhost:3001) |
| **REST API** | http://localhost:3000 |
| **RabbitMQ UI** | http://localhost:15672 (jobuser/jobpassword) |
| **API Health** | http://localhost:3000/health |

### 3. Scale workers
```bash
docker compose up --scale worker=5
```

---

## REST API Reference

### Submit a Job
```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "send-email",
    "queue": "email",
    "priority": "high",
    "maxRetries": 3,
    "retryStrategy": "exponential",
    "retryDelayMs": 5000,
    "timeoutMs": 30000,
    "payload": {
      "to": "user@example.com",
      "subject": "Welcome!",
      "body": "Thanks for signing up."
    },
    "tags": ["onboarding", "transactional"]
  }'
```

### Get Job Status
```bash
curl http://localhost:3000/api/jobs/<job-id>
```

### Get Job Progress (live)
```bash
curl http://localhost:3000/api/jobs/<job-id>/progress
```

### Get Job Audit Events
```bash
curl http://localhost:3000/api/jobs/<job-id>/events
```

### List Jobs (with filters)
```bash
curl "http://localhost:3000/api/jobs?status=failed&queue=email&limit=20&offset=0"
```

### Retry a Failed Job
```bash
curl -X POST http://localhost:3000/api/jobs/<job-id>/retry
```

### Cancel a Queued Job
```bash
curl -X POST http://localhost:3000/api/jobs/<job-id>/cancel
```

### Bulk Submit
```bash
curl -X POST http://localhost:3000/api/jobs/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "jobs": [
      {"name": "send-email", "queue": "email", "payload": {"to": "a@b.com"}},
      {"name": "send-email", "queue": "email", "payload": {"to": "c@d.com"}}
    ]
  }'
```

### Queue Stats
```bash
curl http://localhost:3000/api/stats
curl http://localhost:3000/api/queues
```

### Dead Letter Queue
```bash
# List DLQ
curl http://localhost:3000/api/dead-letter

# Requeue a dead job
curl -X POST http://localhost:3000/api/dead-letter/<id>/requeue

# Delete from DLQ
curl -X DELETE http://localhost:3000/api/dead-letter/<id>
```

---

## Job Processors

Available job types and their expected payloads:

### `send-email` → queue: `email`
```json
{ "to": "user@example.com", "subject": "...", "body": "..." }
```

### `process-image` → queue: `image-processing`
```json
{ "imageUrl": "https://...", "operations": ["resize", "crop", "compress"] }
```

### `generate-report` → queue: `reports`
```json
{ "reportType": "sales", "dateRange": {"from": "2024-01-01", "to": "2024-12-31"} }
```

### `send-notification` → queue: `notifications`
```json
{ "userId": "usr_123", "channel": "push", "message": "Your order shipped!" }
```

### `sync-data` → queue: `default`
```json
{ "source": "salesforce", "destination": "warehouse", "batchSize": 500 }
```

---

## Adding a Custom Processor

Edit `worker/src/processors/index.js`:

```javascript
module.exports['my-custom-job'] = async function(job, { reportProgress, logger }) {
  await reportProgress(10, 'Starting...');
  
  // Do your work here
  const result = await doSomething(job.payload);
  
  await reportProgress(100, 'Done!');
  return result; // saved to jobs.result in PostgreSQL
};
```

Then submit a job with `"name": "my-custom-job"`.

---

## WebSocket Real-time Events

Connect to `ws://localhost:3000/ws` to receive live events:

```javascript
const ws = new WebSocket('ws://localhost:3000/ws');
ws.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  // event.type: job:update | job:progress | job:retry | job:dead | worker:heartbeat
};
```

---

## Configuration

All configuration is via environment variables in `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | postgres://... | PostgreSQL connection |
| `REDIS_URL` | redis://redis:6379 | Redis connection |
| `RABBITMQ_URL` | amqp://... | RabbitMQ connection |
| `WORKER_CONCURRENCY` | 5 | Jobs per worker |
| `LOG_LEVEL` | info | Pino log level |

---

## Concepts Demonstrated

### Asynchronous Processing
Jobs are submitted via HTTP and processed asynchronously. The API returns immediately with a job ID; the client can poll `/jobs/:id` or subscribe via WebSocket.

### Distributed Workers
Multiple worker containers consume from the same RabbitMQ queues using competing consumers. `prefetch(5)` ensures no single worker is overwhelmed.

### Fault Tolerance
- **Retry with backoff**: Failed jobs retry with exponential delay + jitter
- **Distributed locks**: Redis `SET NX` prevents two workers from processing the same job
- **Dead-letter queue**: After `maxRetries` exhausted, jobs move to DLQ for manual review
- **Graceful shutdown**: Workers drain on SIGTERM, completing active jobs before exiting
- **Job timeouts**: `Promise.race()` kills hanging jobs after `timeoutMs`
- **Heartbeats**: Workers publish to Redis every 10s; stale workers are detectable

### Queue Patterns
- **Priority queues**: RabbitMQ `x-max-priority` header routes critical jobs first
- **Delayed retry**: Per-message TTL on a buffer exchange auto-routes expired messages back
- **Dead-letter exchange**: RabbitMQ nacked messages route to DLX automatically
