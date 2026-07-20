# Queue Architecture (Stage 2.8)

The downloader has a two-layer queue: an **in-memory concurrency limiter**
(`DownloadQueue`) and a **persistent durability layer**
(`QueueJobRepository` + `QueueWorker`). Together they provide concurrency
control without losing jobs on restart.

```
                                   ┌─────────────────────────────────────────┐
   bot callbacks                   │                                         │
   ─────────────────────────────►  │  QueueWorker.enqueue()                  │
                                   │    • writes pending row to queue_jobs    │
                                   │    • increments queue_enqueued counter  │
                                   │    • attaches live progress callbacks    │
                                   │                                         │
                                   └─────────────────────────────────────────┘
                                                          │
                                                          ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                          SQLite (queue_jobs)                          │
   │  status: pending | processing | dead                                  │
   │  next_attempt_at, locked_until, attempts, max_attempts, last_error_*  │
   └──────────────────────────────────────────────────────────────────────┘
                                                          │
                                                          ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                            QueueWorker.loop                            │
   │  every WORKER_TICK_MS:                                                │
   │    1. read queue stats + persistent counts                             │
   │    2. update MetricsCollector gauges                                   │
   │    3. if in-memory queue has capacity: claimNext() one due pending row │
   │    4. dispatch the claim to DownloadQueue for concurrency control       │
   │    5. runJob(): pipeline.execute() -> markCompleted / markPending /     │
   │                 markDead                                              │
   └──────────────────────────────────────────────────────────────────────┘
```

## Two layers and why

| Layer | Owner | Purpose | Lossy? |
| --- | --- | --- | --- |
| `DownloadQueue` (in-memory) | `src/queue/DownloadQueue.ts` | Concurrency cap, cancellation of queued jobs, fast FIFO | Yes — gone on restart |
| `QueueJobRepository` (persistent) | `src/storage/QueueJobRepository.ts` | Durability across restarts, retry schedule, dead-letter archive | No — SQLite WAL |
| `QueueWorker` (background loop) | `src/core/QueueWorker.ts` | Drives the persistent layer, retry/dead-letter decisions, metrics | Loop only |

The in-memory queue exists because the bot needs a fast, lock-free
concurrency limiter (it does not consult SQLite on every callback). The
persistent layer exists because in-memory state is lost on restart, and
Stage 2.8 requires that pending jobs survive a crash.

## Job lifecycle

```
   enqueue()  ──►  pending  ──claimNext──►  processing  ──runJob──►  completed (row deleted)
                       │                        │
                       │                        └──► retryable error, attempts < max
                       │                                  → markPending(next_attempt_at = now + backoff)
                       │                                  → attempts += 1
                       │
                       └──► permanent error / cancelled / attempts == max
                                → markDead()
                                → row in queue_jobs becomes 'dead'
                                → row in dead_letter created
                                → queue_failed + queue_dead counters bumped
```

- `next_attempt_at` controls when a pending job becomes claimable again.
  Defaults to `NULL` (immediately claimable); set to `now + backoff` after a
  retryable failure.
- `locked_until` is a soft lock. Set when a job is claimed; if the worker
  dies mid-flight the next startup resets `processing` rows to `pending`
  via `migrateQueueProcessingStuck()` in `Database.ts`.
- `attempts` is the number of times the job has been retried. The first
  execution is `attempts=0`; it is incremented *before* scheduling the
  retry, not after success.

## Retry policy

`isRetryableCode(code)` decides whether a job is retried at all:

| Category | Codes | Retry? |
| --- | --- | --- |
| `validation` | `INVALID_URL`, `UNSUPPORTED_FORMAT`, `VALIDATION_ERROR`, `TOO_LARGE` | No |
| `permanent` | `PRIVATE_MEDIA`, `DELETED_MEDIA`, `UNAVAILABLE_MEDIA`, `AGE_RESTRICTED`, `GEO_RESTRICTED`, `LIVE_STREAM`, `NOT_FOUND`, `CANCELLED` | No |
| `network` | `NETWORK_FAILURE`, `TIMEOUT` | Yes |
| `telegram` | `UPLOAD_FAILED`, `RATE_LIMITED` | Yes |
| `retryable` | `DOWNLOAD_FAILED`, `MERGE_FAILED`, `DISK_FULL` | Yes |

When a job is retryable, the worker schedules it back to `pending` with an
exponential backoff: `base * 2^attempt` (capped at 5 minutes), plus up to
250 ms of jitter. The base delay is `QUEUE_RETRY_BASE_DELAY_MS` (default
2000 ms). The budget is `QUEUE_MAX_RETRIES + 1` attempts (the initial run
plus `QUEUE_MAX_RETRIES` retries).

`categorize(error)` performs the same classification for non-`AppError`
thrown values (raw `Error` with messages like `ECONNRESET`, `429
retry_after`, `SQLITE_CONSTRAINT`, etc.).

## Dead-letter queue

When a job exhausts its retry budget, fails with a permanent error, or is
cancelled, the worker calls `markDead(id, error)`. This transactionally:

1. Updates the `queue_jobs` row to `status='dead'` and stores the last
   error code, message, and category.
2. Inserts a copy into `dead_letter` for inspection.

Operators can list, retry, or drop dead letters via the admin commands:

```
/dead                  — last 10 dead letters
/retry <id>            — re-queue a dead letter (resets attempts to 0)
/drop <id>             — drop a dead letter permanently
```

`requeueFromDeadLetter` uses `INSERT ... ON CONFLICT(id) DO UPDATE` so the
row in `queue_jobs` is reactivated rather than duplicated.

## Graceful shutdown

`QueueWorker.stop()`:

1. Sets `running = false` so the loop exits at the next tick.
2. Waits up to `WORKER_GRACEFUL_SHUTDOWN_MS` (default 15 s) for in-flight
   jobs to finish.
3. Calls `DownloadQueue.shutdown()` which drains the in-memory queue.

`main.ts` wires this to `SIGINT`, `SIGTERM`, and `uncaughtException`. If a
job is mid-flight when the deadline hits, it stays in `processing` in the
DB; the next startup's `migrateQueueProcessingStuck()` resets it to
`pending` so the worker picks it back up.

## Metrics

`MetricsCollector` keeps both persistent counters (in `runtime_counters`)
and in-memory gauges. The worker updates the gauges every tick:

| Metric | Source | Type |
| --- | --- | --- |
| `queue_enqueued` | `enqueue()` | persistent counter |
| `queue_success` | `runJob()` success | persistent counter |
| `queue_failed` | `runJob()` dead-letter | persistent counter |
| `queue_retry` | `runJob()` retry scheduled | persistent counter |
| `queue_dead` | `runJob()` dead-letter | persistent counter |
| `cache_hits` | `MediaPipeline` | persistent counter |
| `uploads` | `MediaPipeline` | persistent counter |
| queue depth (pending/processing/dead) | worker tick | in-memory gauge |
| processing time percentiles | `runJob()` | in-memory ring buffer (100 samples) |
| last sync time | `runJob()` success | in-memory timestamp |

`/metrics` renders all of these. Persistent counters survive restarts;
in-memory gauges reset to zero on every boot.

## Logging context

Every `runJob` invocation creates a child logger via `loggerFor({...})`
with `queueId`, `requestId`, `ownerId`, and emits `processingDurationMs`
on completion. The bot layer attaches `fileUniqueId` after the upload step
(not persisted — it lives only in the live progress callback).

`pino`'s `redact` config strips `token`, `apiKey`, `authorization`,
`cookie`, `password`, and `secret` keys from every log record.
`sanitizeForLog()` does the same for arbitrary payloads attached to logs
from callers that do not use the child-logger pattern.
