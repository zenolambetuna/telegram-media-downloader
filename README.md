# Telegram Media Downloader Engine

Telegram Media Downloader Engine is a production-grade media acquisition and Telegram storage module built for a future Telegram Drive ecosystem.

This is not a toy downloader and not a single-platform bot. It is a reusable engine that Telegram Drive can call as an internal media ingestion service.

## What it does

- Detects provider from incoming URL
- Extracts metadata with yt-dlp
- Shows only actually available formats
- Downloads selected media with retry and timeout protection
- Uploads media to a Telegram Channel as the permanent storage backend
- Stores metadata and checksum in a production-ready database
- Reuses cached Telegram messages when the same media was already ingested
- Cleans temporary files automatically
- Exposes admin visibility for queue, providers, errors, and throughput

## Supported providers

- YouTube
- Facebook
- Instagram
- TikTok
- X (Twitter)
- Threads
- Reddit
- Pinterest
- Vimeo
- SoundCloud

The provider system is isolated by contract. Adding a new provider only requires adding a new provider folder and registering it during composition.

## Architecture goals

This engine is built for long-term reuse inside Telegram Drive.

Key decisions:

- provider logic is isolated from bot logic
- download orchestration is independent from Telegram delivery
- cache lookup is independent from database implementation
- storage is abstracted through repositories and services
- queue and concurrency are centralized
- error handling is typed and structured
- temporary file lifecycle is explicit and enforced

That means Telegram Drive can later call this engine as a reusable module, worker service, or internal API without rewriting provider or download logic.

## Project structure

```text
src/
  bot/              grammY bot composition and middleware
  providers/        provider-specific modules
  telegram/         Telegram upload and delivery services
  storage/          database connection and repositories
  downloader/       yt-dlp orchestration and download engine
  cache/            cache lookup service
  queue/            job queue and concurrency control
  config/           environment parsing and runtime config
  core/             domain services and shared orchestration
  utils/            helpers and infrastructure utilities
  types/            shared types and contracts
  logger/           structured logging
  main.ts           process entrypoint
```

## Runtime requirements

- Ubuntu 22.04 or newer
- Node.js 20 or newer
- FFmpeg installed and available in PATH
- yt-dlp installed and available in PATH
- Telegram bot token
- Telegram storage channel ID
- Admin Telegram user ID

## Ubuntu VPS installation

### 1. Update packages

```bash
sudo apt update && sudo apt upgrade -y
```

### 2. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential
node -v
npm -v
```

### 3. Install FFmpeg

```bash
sudo apt install -y ffmpeg
ffmpeg -version
```

### 4. Install yt-dlp

```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version
```

### 5. Clone and install dependencies

```bash
git clone https://github.com/zenolambetuna/telegram-media-downloader.git
cd telegram-media-downloader
npm install
```

### 6. Configure environment

```bash
cp .env.example .env
```

Set values:

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

### 7. Build and run

```bash
npm run build
npm start
```

### 8. Development mode

```bash
npm run dev
```

## Telegram setup

1. Create a bot with BotFather
2. Create a Telegram Channel that acts as permanent media storage
3. Add the bot as channel admin
4. Set the numeric channel ID in `.env`
5. Set your Telegram user ID as `ADMIN_ID`

## Bot behavior

### `/start`
Explains supported workflow.

### Send a supported URL
The bot:

1. validates the URL
2. detects the provider
3. extracts metadata
4. checks cache using normalized canonical URL
5. returns cached media instantly if found
6. shows available video and audio choices
7. enqueues the download job
8. downloads, uploads, stores metadata, and cleans up temporary files

## Persistent storage

This project does not use JSON anymore.

It uses SQLite through an internal repository abstraction for a production-grade local database baseline. That gives you transactional integrity now and an easy migration path later to PostgreSQL without touching business logic.

Stored media metadata includes:

- message_id
- file_id
- provider
- original_url
- title
- duration
- thumbnail
- quality
- mime_type
- upload_date
- checksum

## Queue and concurrency

The engine uses an internal job queue with configurable concurrency.

This protects the VPS from overload and keeps provider operations predictable. Shutdown is graceful: active jobs are awaited, new work is rejected, and temporary files are cleaned.

## Admin commands

- `/stats` for high-level counters
- `/queue` for queue depth and active jobs
- `/providers` for provider availability
- `/errors` for recent runtime errors
- `/health` for runtime health summary

## Troubleshooting

### yt-dlp fails immediately
Check:

```bash
yt-dlp --version
which yt-dlp
```

If missing, reinstall yt-dlp and update `YT_DLP_PATH`.

### FFmpeg errors
Check:

```bash
ffmpeg -version
which ffmpeg
```

### Bot uploads fail
Verify the bot is an admin in the storage channel and `CHANNEL_ID` is correct.

### Database file cannot be created
Make sure the process user can write to the `data/` directory or change `DATABASE_PATH`.

### Providers return unavailable content
Some platforms block private, deleted, geo-restricted, or age-restricted content. Those failures are surfaced as typed errors and logged with provider context.

## Why this shape is right

The bot interface is just one adapter.

The real asset here is the engine underneath: provider resolution, metadata extraction, cache lookup, download queue, retry policy, Telegram-backed storage, and persistence. That is the part Telegram Drive will reuse later.

That’s the right architecture. Anything tighter coupled would be short-term nonsense.