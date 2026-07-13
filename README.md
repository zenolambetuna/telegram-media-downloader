# Telegram Media Downloader Engine

Production-grade media acquisition and Telegram storage engine, built as the reusable media module for a future Telegram Drive ecosystem.

It is architected in clean layers: a plugin-based provider system, a shared Universal Download Engine, a Telegram Storage Engine, and a thin bot layer on top. Adding a new provider requires only a new folder under `src/providers/`.

## Layers

| Layer | Docs | Role |
| --- | --- | --- |
| Provider plugins | [docs/PROVIDER_PLUGINS.md](docs/PROVIDER_PLUGINS.md) | Self-registering provider descriptors. Zero core edits to add one. |
| YouTube provider | [docs/YOUTUBE_PROVIDER.md](docs/YOUTUBE_PROVIDER.md) | The reference provider implementation. |
| Download engine | [docs/DOWNLOAD_ENGINE.md](docs/DOWNLOAD_ENGINE.md) | yt-dlp + ffmpeg orchestration, formats, merge, progress, retries, checksums. |
| Storage engine | [docs/STORAGE_ENGINE.md](docs/STORAGE_ENGINE.md) | Telegram upload, media-type routing, cache, thumbnails, persistence. |
| Bot layer | [docs/BOT_LAYER.md](docs/BOT_LAYER.md) | Conversation, keyboards, live progress, queue, cancellation. |

## Supported providers

YouTube is the current reference provider. The architecture supports Facebook, Instagram, TikTok, X (Twitter), Threads, Reddit, Pinterest, Vimeo, and SoundCloud as thin plugins to be finalized next.

## Bot experience

1. Send a supported URL.
2. See platform, title, duration, and thumbnail.
3. Pick Video or Audio, then a specific quality (only real formats are shown).
4. Watch a single live progress message update through each stage.
5. Receive the file, stored in your Telegram Drive channel and reused on repeat requests.

Queueing, per-user concurrency limits, cancellation, FloodWait backoff, and a large-file guard are all built in.

## Runtime requirements

- Ubuntu 22.04 or newer
- Node.js 20 or newer
- FFmpeg in PATH
- yt-dlp in PATH
- Telegram bot token, storage channel id, admin user id

## Ubuntu VPS installation

### 1. System packages

```bash
sudo apt update && sudo apt upgrade -y
```

### 2. Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential
```

### 3. FFmpeg

```bash
sudo apt install -y ffmpeg
```

### 4. yt-dlp

```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

### 5. Install and configure

```bash
git clone https://github.com/zenolambetuna/telegram-media-downloader.git
cd telegram-media-downloader
npm install
cp .env.example .env
```

Fill in `BOT_TOKEN`, `CHANNEL_ID`, and `ADMIN_ID`.

### 6. Build, test, run

```bash
npm run build
npm test
npm start
```

## Telegram setup

1. Create a bot with BotFather.
2. Create a private channel as permanent storage.
3. Add the bot as an admin of that channel.
4. Set `CHANNEL_ID` and `ADMIN_ID` in `.env`.

## Admin commands

- `/stats` cache, uploads, cache hits, errors
- `/queue` queue depth and active jobs
- `/providers` loaded, disabled, and failed providers with versions
- `/errors` recent errors
- `/health` health check

## Project structure

```text
src/
  bot/            conversation, keyboards, progress, jobs, composition
  providers/      self-registering provider plugins (youtube is the reference)
  downloader/     universal download engine and its services
  telegram/       storage engine: upload, send, cache, thumbnails
  storage/        database connection and repositories
  cache/          cache service
  queue/          download queue and concurrency
  core/           registry, matcher, validator, pipeline, inspector
  config/         env and provider config
  logger/         structured logging
  types/          shared contracts
  main.ts         entrypoint
tests/            vitest unit tests
docs/             per-layer architecture docs
```

## Testing

```bash
npm test
```

Covers provider metadata and URL detection, format normalization, plugin validation (duplicates, dependencies, engine compatibility), and semver.

## Troubleshooting

- **yt-dlp not found**: check `which yt-dlp` and set `YT_DLP_PATH`.
- **ffmpeg errors**: check `ffmpeg -version` and set `FFMPEG_PATH`.
- **uploads fail**: confirm the bot is an admin of the storage channel and `CHANNEL_ID` is correct.
- **file too large**: files over 50 MB need a local Telegram Bot API server.
- **provider rejected**: check `/providers`; the reason (duplicate id/domain, engine incompatibility, missing dependency) is shown.
