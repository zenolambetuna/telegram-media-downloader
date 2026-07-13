# Telegram Bot Layer

The bot layer is a thin consumer built entirely on top of the existing architecture. It does not modify the provider system or the Universal Download Engine. It orchestrates user interaction and delegates all work to the engine, the queue, and the Storage Engine.

## Flow

1. User sends a URL.
2. `MediaInspector` resolves the provider via the registry and asks the engine for metadata.
3. The bot shows title, platform, duration, uploader, and the thumbnail as a photo.
4. An inline keyboard offers Video / Audio, then per-quality choices built only from formats the engine actually returned.
5. On selection, the job is enqueued. A single message is edited in place through every stage.
6. `MediaPipeline` checks the per-format cache, runs the engine, guards the Telegram size limit, uploads via the Storage Engine, persists metadata, and delivers the file with `copyMessage`.
7. The temp file is always deleted.

## Live progress (single message)

`ProgressReporter` owns one Telegram message and edits it as the job advances through the engine stages (fetching metadata, resolving formats, downloading, merging, processing, uploading, finishing). Edits are throttled by `PROGRESS_THROTTLE_MS` and identical edits are skipped, so Telegram never sees spam or a "message is not modified" error. This replaces the old behavior of sending one message per stage.

## Cancellation

Every in-progress message carries a Cancel button. Pressing it:

- removes the job from the queue if it has not started yet, or
- trips a `CancellationToken` that the pipeline checks at stage boundaries, stopping before upload and cleaning the temp file.

Honest limitation: cancellation is cooperative. It cancels queued jobs instantly and halts post-download work immediately, but it does not force-kill an in-flight yt-dlp process, because that would require adding a hook to the Download Engine, which this layer intentionally does not modify. If you want hard mid-download aborts, that is a small, clean engine hook I can add on request.

## Per-format deduplication

Requirement 13 is enforced by `FormatCacheRepository`, keyed by `(canonical_url, format_id)`. The same video at 720p and 1080p are distinct cache entries, so:

- the same media + format is never downloaded twice; it is delivered by `copyMessage` reusing the stored Telegram file, and
- different qualities of the same media never overwrite each other.

## Large files

Before uploading, `MediaPipeline` compares the file size against `MAX_TELEGRAM_UPLOAD_BYTES` (default 50 MB for the standard bot API). Oversized files produce a clear `FILE_TOO_LARGE` error telling the user to pick a lower quality or configure a local Bot API server (which raises the limit to ~2 GB). The size check is centralized so a future chunking or local-server strategy plugs in here without touching the engine.

## Queue and multiple users

`DownloadQueue` runs jobs with bounded concurrency (`MAX_CONCURRENT_DOWNLOADS`) and supports per-job cancellation. Multiple users are served fairly; excess jobs wait.

## FloodWait and errors

Upload retries and Telegram FloodWait backoff live in `UploadManager` (Storage Engine). Download and network errors are classified into typed, user-safe messages by the engine's `classifyDownloadError`. The bot simply shows the resulting message.

## What this layer intentionally does not do

- It does not call yt-dlp or ffmpeg.
- It does not talk to Telegram for storage directly; it goes through the Storage Engine.
- It does not modify providers or the engine.

That separation is the whole point: the bot is one of potentially many consumers of the same engine and storage, exactly as a future Telegram Drive service will be.
