# Telegram Bot Layer

The bot layer is a thin consumer built entirely on top of the existing architecture. It does not modify the provider system, the Universal Download Engine, or the Telegram Storage Engine. It only orchestrates the user conversation and delegates all real work.

## Flow

1. User sends a URL.
2. `MediaInspector` resolves the provider via the registry and asks the engine for metadata + normalized formats.
3. The bot shows platform, title, duration, and thumbnail with a Video / Audio keyboard.
4. Selecting a kind edits the same message to show the actual available qualities.
5. Selecting a format registers a job, shows a single live progress message, and enqueues the work.
6. The pipeline checks the Telegram Drive cache, downloads through the engine if needed, uploads through the Storage Engine, and delivers the file back.
7. Duplicates are served from cache with `copyMessage`, no re-download.

## Components

| Component | Responsibility |
| --- | --- |
| `keyboards.ts` | Builds the kind keyboard and the quality keyboard from engine formats. |
| `ProgressPresenter` | Owns ONE message and edits it per stage. Throttled and conflict-safe. |
| `JobManager` | Tracks per-user jobs and provides cooperative cancellation. |
| `MediaPipeline` | Cache -> engine -> storage, with cancel checkpoints and large-file guard. |

## Live progress (single message)

`ProgressPresenter` sends exactly one message when a job is queued and then
**edits** it as the job moves through fetching, resolving, downloading,
merging, processing, uploading, and finishing. Edits are throttled to ~1.2s and
de-duplicated, and 'message is not modified' / edit FloodWait are swallowed so
the UI can never crash a job. This replaces the previous behavior that sent a
new message per stage.

## Queue and multiple users

Downloads run through the shared `DownloadQueue` with configurable concurrency.
Each user is limited to 3 concurrent jobs so one user cannot starve others.

## Cancellation

Every queued job and every live progress message carries a Cancel button.
Cancelling flips a cooperative flag the pipeline checks before download, before
upload, and before delivery. A job cancelled while still queued never starts.

Scope: this is cooperative cancellation. It stops the job at the next
checkpoint; it does not force-kill an in-flight yt-dlp process mid-stream. That
would require an engine-level abort hook, which is intentionally out of scope
for the bot layer.

## Large files

Before upload, the pipeline checks the probed size against the 50 MB Telegram
bot upload limit and returns a clear, typed message when a file is too large.
Raising this ceiling requires a local Telegram Bot API server; the guard is the
honest boundary until that exists.

## FloodWait

Upload FloodWait is handled inside the Storage Engine's `UploadManager` with
automatic backoff. Progress-edit FloodWait is swallowed by the presenter.

## Persistence

On a fresh upload the Storage Engine stores file id, message id, channel id,
size, media type, duration, platform, original URL, title, quality, checksum,
and upload timestamp. The bot does not persist anything itself.

## Duplicate reuse

Before downloading, the pipeline calls `telegramStorage.exists()`. On a hit the
media is delivered with `copyMessage` reusing the stored Telegram file, so the
same media is never downloaded or uploaded twice.
