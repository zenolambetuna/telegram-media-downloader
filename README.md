# Telegram Media Downloader Bot

Production-ready Telegram Media Downloader Bot built with TypeScript, Node.js, grammY, yt-dlp, FFmpeg, dotenv, and Pino.

This project is designed as the media download engine for a larger Telegram Drive ecosystem. It is modular, provider-based, cache-aware, and optimized for Telegram Channel backed storage.

## Features

- Multi-provider URL detection
- Supported platforms:
  - YouTube
  - Facebook
  - Instagram
  - X (Twitter)
  - TikTok
  - Threads
  - Vimeo
  - Reddit
  - Pinterest
  - SoundCloud
- Provider isolation with a common interface
- Metadata extraction before download
- Inline keyboard flow for format selection
- yt-dlp based download orchestration
- FFmpeg powered post-processing hooks
- Telegram Channel as storage backend
- Cache-first delivery using `copyMessage`
- Temporary local storage with guaranteed cleanup
- Structured logging with Pino
- Rate limiting and flood protection
- Admin statistics and health visibility
- Clean architecture for future Telegram Drive integration

## Architecture

This bot is not a one-off downloader. It is the Media Downloader module for a future Telegram Drive platform.

Core design goals:

- provider implementations are isolated
- storage backend can evolve independently
- metadata persistence is abstracted
- download pipeline is reusable by future services
- Telegram specific delivery logic is separated from domain logic

## Project Structure

```text
src/
  bot/
  commands/
  handlers/
  providers/
    youtube/
    facebook/
    instagram/
    twitter/
    tiktok/
    threads/
    vimeo/
    reddit/
    pinterest/
    soundcloud/
  telegram/
  storage/
  cache/
  core/
  utils/
  config/
  logs/
  types/
  main.ts
```

## Requirements

- Ubuntu 22.04 or newer
- Node.js 20+
- FFmpeg installed and available in PATH
- yt-dlp installed and available in PATH
- Telegram Bot Token
- Telegram Channel ID for storage
- Admin Telegram user ID

## Ubuntu VPS Setup

### 1. Update system

```bash
sudo apt update && sudo apt upgrade -y
```

### 2. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### 3. Install FFmpeg

```bash
sudo apt install -y ffmpeg
ffmpeg -version
```

### 4. Install yt-dlp

Recommended method:

```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version
```

Alternative with pipx:

```bash
sudo apt install -y pipx
pipx install yt-dlp
```

### 5. Clone and install

```bash
git clone https://github.com/zenolambetuna/telegram-media-downloader.git
cd telegram-media-downloader
npm install
```

### 6. Configure environment

```bash
cp .env.example .env
```

Set:

```env
BOT_TOKEN=
CHANNEL_ID=
ADMIN_ID=
LOG_LEVEL=info
TMP_DIR=/tmp/media-downloader
MAX_CONCURRENT_DOWNLOADS=2
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=15
DOWNLOAD_TIMEOUT_MS=900000
UPLOAD_TIMEOUT_MS=900000
YT_DLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
```

### 7. Build

```bash
npm run build
```

### 8. Run

```bash
npm start
```

### 9. Development mode

```bash
npm run dev
```

## Telegram Setup

1. Create a bot with BotFather
2. Create a private Telegram Channel for storage
3. Add the bot as an admin in the storage channel
4. Get the channel numeric ID
5. Set `CHANNEL_ID` in `.env`
6. Set your Telegram user ID as `ADMIN_ID`

## Bot Flow

### `/start`

Shows welcome message and instructions.

### User sends supported URL

Flow:

1. validate URL
2. resolve provider
3. extract metadata
4. check cache by canonical URL
5. if cached, deliver from storage channel using `copyMessage`
6. if not cached, show available format actions
7. download selected format
8. upload to Telegram storage channel
9. persist metadata
10. delete local temporary file
11. deliver to user

## Cache Strategy

Cache key is built from normalized original URL.

If media already exists:

- skip download
- skip processing
- copy previously uploaded media from storage channel

This keeps VPS disk usage low and makes repeated requests fast.

## Storage Model

Stored metadata includes:

- `message_id`
- `file_id`
- `platform`
- `original_url`
- `title`
- `duration`
- `thumbnail`
- `quality`
- `mime_type`
- `upload_date`

Current implementation uses local JSON persistence for metadata bootstrap. The storage boundary is abstract so it can later be replaced by PostgreSQL, Redis, or Telegram Drive internal services without breaking providers.

## Admin Commands

- `/stats` shows users, cache entries, uploads, and errors
- `/health` shows runtime health summary

Admin-only behavior is enforced by middleware.

## Error Handling

Handled cases include:

- invalid URL
- unsupported provider
- private video
- deleted media
- age restriction
- download failure
- upload failure
- timeout
- network failure

## Logging

Structured logs are written with Pino.

- console output for runtime visibility
- file output hooks ready in logger layer
- contextual fields for provider, URL, user, phase, and errors

## Production Notes

This foundation is designed for future Telegram Drive integration.

What is intentionally abstracted now:

- provider registry
- metadata repository
- storage delivery
- download pipeline
- Telegram transport layer
- cache lookup layer

That means you can later plug in:

- queue workers
- PostgreSQL
- Redis
- object storage mirrors
- admin dashboards
- Telegram Drive indexing services

without tearing apart the current design.

## Recommended Next Step

If you want this fully battle-hardened for scale, the next thing to add is a real persistent database and a job queue. For a clean foundation though, this version is the right shape: modular first, hacks never.
