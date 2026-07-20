# Production Deployment Guide (Stage 2.8)

This guide is the operator's reference for running the Telegram Media
Downloader Engine in production. It assumes the Stage 2.8 production
hardening is in place (queue recovery, background worker, health checks,
metrics, structured logging).

## System requirements

- Ubuntu 22.04+ (or any Linux with Node 20)
- Node.js 20+
- FFmpeg in `PATH`
- yt-dlp in `PATH`
- A C/C++ toolchain and Python 3 for the native `better-sqlite3` build
  (`sudo apt install -y build-essential python3`)
- Telegram bot token, a storage channel id, and an admin user id
- SQLite WAL works on a regular filesystem; no special storage required
- Optional: a Telegram Drive Bridge API base URL + key

## First-time setup

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3 ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

git clone <this-repo> /opt/media-downloader
cd /opt/media-downloader
npm install
npm run build
cp .env.example .env
# edit .env (see below)
```

### `.env` for production

```env
# Required
BOT_TOKEN=...
CHANNEL_ID=-100...
ADMIN_ID=...

# Recommended
LOG_LEVEL=info
TMP_DIR=/var/lib/media-downloader/tmp
DATABASE_PATH=/var/lib/media-downloader/data/media-engine.db
MAX_CONCURRENT_DOWNLOADS=2

# Drive Bridge API (Stage 3 link) — optional but recommended
DRIVE_API_BASE_URL=https://drive.example.com
DRIVE_API_KEY=...
DRIVE_API_TIMEOUT_MS=10000

# Queue reliability
QUEUE_RECOVERY_ENABLED=true
QUEUE_MAX_RETRIES=3
QUEUE_RETRY_BASE_DELAY_MS=2000
QUEUE_DEAD_LETTER_ENABLED=true
QUEUE_PROCESSING_TIMEOUT_MS=1800000

# Worker
WORKER_ENABLED=true
WORKER_TICK_MS=1000
WORKER_GRACEFUL_SHUTDOWN_MS=15000

# Health & monitoring
HEALTH_CHECK_ENABLED=true
HEALTH_CHECK_TIMEOUT_MS=8000
HEALTH_CHECK_FAIL_ON_DRIVE_ERROR=false
METRICS_FLUSH_INTERVAL_MS=15000

# Optional — local Bot API server for >50MB uploads
TELEGRAM_API_ROOT=http://127.0.0.1:8081
MAX_TELEGRAM_UPLOAD_MB=2000
```

> `DRIVE_API_BASE_URL` and `DRIVE_API_KEY` are both optional. If either is
> absent, the `/health` check reports `drive_api: ok (not configured
> (skipped))` and the bot starts normally. The Bridge API contract is
> unchanged; this stage only adds the `/api/v1/integration/health` probe.

## systemd unit

```ini
# /etc/systemd/system/media-downloader.service
[Unit]
Description=Telegram Media Downloader Engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=media-downloader
WorkingDirectory=/opt/media-downloader
EnvironmentFile=/opt/media-downloader/.env
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal

# Graceful shutdown — let the worker drain in-flight jobs
TimeoutStopSec=30s

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now media-downloader
sudo journalctl -u media-downloader -f
```

## Startup health check

On boot the bot runs `HealthCheck.runStartup()` and logs a single report
covering:

1. **database** — SQLite `SELECT 1` (required)
2. **telegram_bot** — `bot.api.getMe()` (required)
3. **telegram_api** — local Bot API server reachability when
   `TELEGRAM_API_ROOT` is set (required)
4. **drive_api** — `/api/v1/integration/health` when
   `DRIVE_API_BASE_URL` + `DRIVE_API_KEY` are set (optional; fails startup
   only when `HEALTH_CHECK_FAIL_ON_DRIVE_ERROR=true`)

Each component is logged with its status (`ok` / `degraded` / `down`),
duration, and a short detail line. The bot starts even if a non-required
component is down; the queue worker still drains pending jobs.

## Day-to-day operations

### Check the queue

```bash
# As admin, in Telegram:
/queue
# in-memory: pending=0 active=1 concurrency=2
# persistent: pending=3 processing=1 dead=2
# worker active=1
```

### Check metrics

```bash
/metrics
# Metrics:
#   success:     124
#   failed:      3
#   retry:       7
#   dead:        2
#   enqueued:    136
#   cache_hits:  41
#   uploads:     83
# Queue:
#   pending:     3
#   processing:  1
#   dead_letter: 2
# Processing: p50=18324ms p95=41209ms max=98231ms n=100
# Last sync:  2026-07-19T03:41:38.771Z
```

### Health

```bash
/health
# status: ok
# ✅ database: sqlite SELECT 1 ok (1ms)
# ✅ telegram_bot: @mybot (id=123456) (52ms)
# ✅ telegram_api: default Telegram Bot API (0ms)
# ✅ drive_api: ok v3.2.1 (148ms)
```

### Dead letters

```bash
/dead
# dead letters:
# a1b2c3d4 | https://youtube.com/watch?v=... | attempts=4 | TIMEOUT | slow
# e5f6g7h8 | https://tiktok.com/@user/video/... | attempts=4 | NETWORK_FAILURE | ...
#
# /reply <id> to retry, /drop <id> to remove.

/retry a1b2c3d4
# re-queued a1b2c3d4 (max_attempts=4)

/drop e5f6g7h8
# dropped e5f6g7h8
```

## Logs

Logs are JSON (pino) in production (`NODE_ENV=production`) and pretty in
development. Every long-running operation emits structured fields:

- `queueId` — the durable job id (8-char token)
- `requestId` — same as `queueId` for downloads
- `ownerId` — the Telegram user id that owns the job
- `processingDurationMs` — wall-clock time of the operation
- `fileUniqueId` — added after the upload step

Secrets are redacted by pino's `redact` config:
`token`, `apiKey`, `authorization`, `cookie`, `password`, `secret`. Use
`sanitizeForLog()` when attaching unknown-typed payloads to logs.

## Performance notes

- **Duplicate sync.** The pipeline dedupes per media + quality via the
  composite `cache_key` (`canonical_url::quality`). Re-requests for the
  same media + quality copy the cached message instead of re-downloading.
- **Memory.** The worker keeps a 100-sample ring buffer for processing
  time percentiles. Progress callbacks are released after the job
  finalises. Live progress messages are throttled to
  `PROGRESS_EDIT_INTERVAL_MS` (default 2.5 s).
- **Non-blocking upload.** The worker submits jobs to the in-memory
  `DownloadQueue` which caps concurrency at
  `MAX_CONCURRENT_DOWNLOADS`. The grammY update handler returns
  immediately after `enqueue()`; the worker drains the queue in the
  background.
- **SQLite.** WAL mode + `synchronous=NORMAL`. The DB is the only
  persistent state besides the temp workspace; back it up with
  `sqlite3 data/media-engine.db ".backup '/backup/media-engine.db'"`.

## Upgrades

1. `git pull`
2. `npm install` (rebuild native modules if Node version changed)
3. `npm run build`
4. `sudo systemctl restart media-downloader`
5. Watch `journalctl -u media-downloader -f` for the startup health report.

Migrations are idempotent and run on every boot. The
`migrateQueueProcessingStuck` migration resets any `processing` rows left
behind by a previous crash to `pending` so the worker picks them back up.

## Troubleshooting

See [`RECOVERY_GUIDE.md`](./RECOVERY_GUIDE.md) for the operator runbook.
