# Telegram Media Downloader Engine

A modular, plugin-based media download engine for Telegram, built to become the media ingestion module of a larger Telegram Drive ecosystem.

Built with TypeScript, Node.js, grammY, yt-dlp, FFmpeg, SQLite (via an abstract repository), and Pino.

> This README is kept deliberately honest. Where a feature is partial by design, it says so. Detailed module docs live in [`docs/`](./docs).

## Architecture at a glance

Four layers, each isolated:

1. **Provider plugins** ([`docs/PROVIDER_PLUGINS.md`](./docs/PROVIDER_PLUGINS.md)) - thin, self-registering descriptors. A provider only declares identity, URL matching, and capabilities. It never calls yt-dlp, ffmpeg, or Telegram. Adding one is a new folder under `src/providers/` and nothing else.
2. **Universal Download Engine** ([`docs/DOWNLOAD_ENGINE.md`](./docs/DOWNLOAD_ENGINE.md)) - the single core engine every provider uses. Owns validation, metadata, format normalization, download, merge, ffmpeg, thumbnails, progress stages, temp files, retries, and checksums. `YtDlpClient` is the only place that shells out to yt-dlp.
3. **Telegram Storage Engine** ([`docs/STORAGE_ENGINE.md`](./docs/STORAGE_ENGINE.md)) - the reusable storage service. Owns upload method selection, retry, FloodWait backoff, cache lookup, thumbnails, metadata persistence, and delivery. Providers never touch Telegram.
4. **Bot layer** ([`docs/BOT_LAYER.md`](./docs/BOT_LAYER.md)) - the user-facing adapter: keyboards, live progress message, queue, and cancellation.

## Supported providers

Only **YouTube** is implemented as a finished reference provider today (youtube.com, www, m, music, and youtu.be). The plugin system is built for Facebook, Instagram, TikTok, X, Threads, Reddit, Pinterest, Vimeo, and SoundCloud, but those provider plugins are not implemented yet. The README will not pretend otherwise.

## Feature status (audited)

| Feature | Status |
| --- | --- |
| Receive media URL | Working |
| Provider auto-detection | Working (priority-based registry) |
| Resolution selection | Working (real quality ladder, only existing qualities) |
| Audio selection | Working (formats the source actually exposes; no MP3 transcoding) |
| yt-dlp execution | Working (`YtDlpClient` via `ProcessRunner`) |
| Progress message | Partial: stage transitions edit in place; live download percentage is not wired (engine emits stages, not ratios) |
| Download retry | Working (`withRetry`, configurable attempts) |
| Upload to storage channel | Working |
| File ID cache | Working (SQLite `media_records`) |
| Duplicate detection | Working (composite key: normalized URL + format id) |
| Queue | Working (`DownloadQueue` + `JobManager`) |
| Cancel | Partial: cooperative (stops at next checkpoint); does not kill an in-flight yt-dlp/ffmpeg process |
| FloodWait handling | Working (429 `retry_after` backoff + throttled progress edits) |
| Large files | Partial: guarded, not chunked. Files over the 50 MB bot limit are rejected with a clear message |
| Metadata storage | Working (all fields incl. checksum) |

### Known partials, explained

- **Live progress percentage.** `ProgressTracker` supports ratios, but `YtDlpClient` does not yet parse yt-dlp stdout, so users see stage names, not a ticking percent. Wiring this touches the download engine.
- **Hard cancellation.** Cancellation is cooperative via a token checked at stage boundaries and before upload. True mid-stream abort needs an `AbortSignal` in the engine contract.
- **Files > 50 MB.** The stock Telegram Bot API caps uploads at 50 MB. Larger files require a self-hosted Bot API server. The limit lives in `src/bot/limits.ts`.

## Requirements

- Ubuntu 22.04+
- Node.js 20+
- FFmpeg in PATH
- yt-dlp in PATH
- A C/C++ toolchain and Python 3 for the native `better-sqlite3` build (`sudo apt install -y build-essential python3`)
- Telegram bot token, a storage channel id, and an admin user id

## Ubuntu VPS setup

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3 ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

## Install, test, build, run

```bash
npm install
npm test        # vitest unit tests (pure logic; no network/yt-dlp needed)
npm run build   # tsc -> dist/
npm start       # node dist/main.js
```

Note: the app discovers providers from the compiled `dist/providers`, so run `npm run build` before `npm start`. Unit tests run against `src` and cover format normalization, provider validation, semver compatibility, keyboards, and YouTube provider metadata/detection. They do not exercise live yt-dlp downloads.

## Configuration

Copy `.env.example` to `.env` and set:

```env
BOT_TOKEN=
CHANNEL_ID=
ADMIN_ID=
LOG_LEVEL=info
TMP_DIR=/tmp/media-downloader
DATABASE_PATH=./data/media-engine.db
MAX_CONCURRENT_DOWNLOADS=2
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=15
DOWNLOAD_TIMEOUT_MS=900000
UPLOAD_TIMEOUT_MS=900000
PROVIDER_TIMEOUT_MS=120000
DOWNLOAD_RETRY_ATTEMPTS=3
UPLOAD_RETRY_ATTEMPTS=3
RETRY_BASE_DELAY_MS=1000
YT_DLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
```

## Project structure

```text
src/
  bot/           grammY bot layer: keyboards, progress, jobs, cancellation
  providers/     provider plugins (youtube implemented) + shared base
  core/          registry, loader, validator, matcher, pipeline, inspector
  downloader/    universal download engine + yt-dlp/ffmpeg clients
  telegram/      storage engine: upload, message, cache, thumbnails, sender
  storage/       database + repositories
  queue/         concurrency queue
  config/        env + provider config
  logger/        pino logger
  types/         shared contracts
  main.ts        entrypoint
tests/           vitest unit tests
docs/            per-module documentation
```

## Admin commands

- `/stats` cache, uploads, cache hits, errors
- `/queue` pending and active jobs
- `/providers` loaded and failed providers with versions
- `/health` runtime check
- `/cancel` cancel your running downloads

## Troubleshooting

- **`better-sqlite3` fails to install:** install `build-essential` and `python3`, then reinstall.
- **yt-dlp/ffmpeg not found:** verify `which yt-dlp` and `which ffmpeg`, or set `YT_DLP_PATH` / `FFMPEG_PATH`.
- **Uploads fail:** the bot must be an admin of the storage channel and `CHANNEL_ID` must be correct.
- **Provider not detected after adding a folder:** rebuild so it lands in `dist/providers`.
