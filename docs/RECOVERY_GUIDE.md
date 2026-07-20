# Recovery Guide (Stage 2.8)

The recovery guide is the operator runbook for when something goes wrong.
It assumes the Stage 2.8 production hardening (durable queue, worker,
dead-letter, health checks, metrics) is in place.

## Restart behaviour

When the bot restarts:

1. `DatabaseConnection.migrate()` runs all schema migrations.
2. `migrateQueueProcessingStuck()` resets every `queue_jobs` row in
   `processing` back to `pending` (the previous process died mid-flight).
3. `QueueWorker.recoverPending()` counts pending jobs and logs them.
4. `HealthCheck.runStartup()` probes database, Telegram, and Drive API.
5. `QueueWorker.start()` begins the background loop; pending jobs are
   claimed as concurrency becomes available.

So: **a restart never loses a pending job.** In-flight jobs at the moment
of the crash are retried from the top of the pipeline. The user's original
"Queued..." message is not re-edited (its message id was not persisted),
but the final media still gets delivered to the user's chat via
`telegramStorage.copy(chatId, messageId)`.

## Scenario: bot crashed mid-download

Symptom: the bot restarts and the user did not get their media.

1. Check `/queue` for `pending` rows belonging to that user.
2. Wait one worker tick (`WORKER_TICK_MS`, default 1 s). The worker claims
   the job and re-runs the pipeline.
3. If the job fails again with the same error, it retries up to
   `QUEUE_MAX_RETRIES + 1` times. After that it lands in the dead-letter
   queue.
4. Inspect with `/dead`, then `/retry <id>` to give it another chance or
   `/drop <id>` to discard it.

## Scenario: Telegram API is rate-limiting (429)

`UPLOAD_FAILED` and `RATE_LIMITED` are categorised as `telegram` and
are retried with exponential backoff. The worker bumps `queue_retry` and
schedules the job's `next_attempt_at` to `now + backoff` (capped at 5
minutes). No operator action required unless the rate limit persists for
more than a few minutes — in that case, lower
`MAX_CONCURRENT_DOWNLOADS` and restart.

## Scenario: Drive Bridge API is down

The `/health` check reports `drive_api: down`. The bot continues to run
because the Drive API is optional for the downloader (it's the Stage 3
link). Pending downloads still complete; only the `/health` command shows
the degraded state.

If `HEALTH_CHECK_FAIL_ON_DRIVE_ERROR=true` was set, the bot still starts
(the health check logs the failure but does not throw). Operators should
leave this flag at `false` unless the Drive API is a hard dependency in
their deployment.

## Scenario: SQLite is locked or corrupted

The worker categorises `database is locked` and `SQLITE_CONSTRAINT` as
`database` errors. The job is retried once; if it fails again it goes to
the dead-letter queue.

For a corrupted DB:

1. Stop the bot: `sudo systemctl stop media-downloader`.
2. Back up the WAL and the DB:
   `cp /var/lib/media-downloader/data/media-engine.db* /backup/`.
3. Run `sqlite3 media-engine.db ".recover" > recovered.sql` and rebuild
   a clean DB from the dump.
4. Replace the DB file and restart.

## Scenario: disk is full

`DISK_FULL` is categorised as `retryable` and retried. If the disk stays
full, the job eventually lands in the dead-letter queue. The worker
itself does not monitor disk space; use a host-level monitor
(Loki, Prometheus, `df` cron) and alert when `TMP_DIR` or
`DATABASE_PATH` filesystem usage exceeds 80%.

`TempFileManager.recoverOrphans()` runs on every boot and removes
workspace directories older than 6 hours, so a full disk from a crash
will be cleaned up on the next start.

## Scenario: yt-dlp or ffmpeg not in PATH

The first download after a restart fails with `DOWNLOAD_FAILED`. The
worker retries up to `QUEUE_MAX_RETRIES + 1` times, then dead-letters
the job. `/dead` shows the error; `/retry <id>` after fixing PATH
re-runs the job.

## Scenario: worker is stuck

Symptom: `/queue` shows `pending > 0` and `processing = 0` but nothing is
being claimed.

1. Check `journalctl -u media-downloader` for `queue tick` log lines.
   They fire every 15 ticks (15 s by default). If they stopped, the
   worker loop died.
2. Check `worker.activeCount()` via `/queue`. If it is 0 but the
   in-memory queue reports `active > 0`, the in-memory DownloadQueue is
   wedged. A restart clears it; pending jobs are picked back up from
   the DB.
3. Restart: `sudo systemctl restart media-downloader`. The
   `migrateQueueProcessingStuck` migration resets any `processing` rows
   left behind.

## Scenario: too many dead letters

Dead-letter rows accumulate. The worker prunes rows older than 30 days
in `clearCompleted()` (call this from a cron or manually). For ad-hoc
cleanup:

```bash
sqlite3 /var/lib/media-downloader/data/media-engine.db \
  "DELETE FROM dead_letter WHERE created_at < datetime('now', '-30 day');"
```

## Scenario: want to cancel a queued job

Users can press the inline `✖ Cancel download` button. Operators can
also cancel a pending job directly:

```bash
sqlite3 /var/lib/media-downloader/data/media-engine.db \
  "UPDATE queue_jobs SET status='dead', last_error_code='CANCELLED', last_error_message='manual operator cancel' WHERE id='<jobId>' AND status='pending';"
```

The worker will not claim a `dead` job. Active jobs cannot be cancelled
this way; they must finish or fail. The cooperative cancellation token
is checked at the next pipeline checkpoint (before the upload step).

## Recovery checklist

- [ ] `journalctl -u media-downloader` shows `startup health ok` (or
  `degraded` / `down` with the failing component).
- [ ] `/queue` reports `pending` consistent with `worker.activeCount()`.
- [ ] `/metrics` `success` counter is increasing over time.
- [ ] `/dead` is empty (or the entries are known and being handled).
- [ ] Disk space on `TMP_DIR` and `DATABASE_PATH` filesystem is below 80%.
- [ ] `yt-dlp --version` and `ffmpeg -version` succeed on the host.
