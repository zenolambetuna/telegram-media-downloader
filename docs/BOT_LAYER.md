# Telegram Bot Layer

The bot layer is the user-facing adapter on top of the locked architecture. It uses the Provider Registry, the Universal Download Engine, and the Telegram Storage Engine without modifying any of them.

## Flow

1. User sends a URL.
2. `MediaInspector` resolves the provider via the registry and asks the engine for metadata.
3. The bot shows media info (platform, title, duration, thumbnail) with a Video / Audio / Cancel keyboard.
4. Choosing a kind shows only the qualities that actually exist, video ordered by the standard ladder, audio by bitrate.
5. Choosing a quality enqueues a job and posts a single live progress message with a Cancel button.
6. The pipeline checks the format-aware cache, downloads if needed, guards the size, uploads via the Storage Engine, and sends the file back.

## Live progress (edit in place)

`ProgressReporter` edits one message across all stages (fetching, resolving, downloading, merging, processing, uploading). Edits are throttled by `PROGRESS_EDIT_INTERVAL_MS` to avoid Telegram rate limits, and the terminal state is always flushed. No message spam.

## Format-aware deduplication

Deduplication is keyed on `canonical_url + quality`. Requesting 720p reuses a stored 720p file instantly via `copyMessage`; requesting 1080p of the same video downloads fresh. Storage keys on a composite `cache_key` column with a safe migration from the old URL-only schema.

## Queue and multi-user

All downloads go through `DownloadQueue` with configurable concurrency, so multiple users are served fairly without overloading the VPS.

## Cancellation

Each job gets a short token and a Cancel button on the progress message.

- Queued jobs are removed and rejected immediately.
- Running jobs are cancelled cooperatively at the checkpoint before upload; the temp file is always cleaned.

Force-killing an in-flight yt-dlp process mid-download is intentionally not done here because it would require an AbortSignal hook inside the Download Engine, which is locked. Cancellation therefore takes effect at the next safe boundary.

## FloodWait

Handled inside the Storage Engine `UploadManager`, which backs off for the Telegram-provided `retry_after` and retries. The bot inherits this automatically.

## Large files

After download the pipeline stats the real file size. Files over `MAX_TELEGRAM_UPLOAD_MB` (default 50) are rejected with a clear message suggesting a lower quality. Set `TELEGRAM_API_ROOT` to a local Bot API server and raise the limit to allow up to ~2000MB.

## Persisted per upload

File ID, message ID, channel ID, size, media type, duration, platform, original URL, title, quality, checksum, and upload timestamp.

## What the bot never does

It never calls yt-dlp, ffmpeg, or the Telegram storage APIs directly. It orchestrates the existing engines only.
