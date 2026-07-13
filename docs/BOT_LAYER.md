# Telegram Bot Layer

The bot layer is the user-facing adapter on top of the frozen architecture. It uses the Provider Registry, the Universal Download Engine, and the Telegram Storage Engine without modifying any of them.

## Flow

1. User sends a URL.
2. `MediaInspector` resolves the provider via the registry and asks the engine for metadata.
3. The bot shows the thumbnail, title, platform, duration, and uploader.
4. An inline keyboard offers Video or Audio, then the concrete qualities that actually exist.
5. On selection, a job is queued through `JobManager` (which wraps the existing `DownloadQueue`).
6. A single progress message is edited live through every stage.
7. The engine downloads and merges; the Storage Engine uploads to the Drive channel and persists metadata.
8. The stored file is delivered back to the user with `copyMessage`.

## Components (bot layer only)

| Component | Responsibility |
| --- | --- |
| `keyboards.ts` | Builds choice, video-ladder, and audio inline keyboards from real engine formats. |
| `ProgressReporter` | Owns one message and edits it in place, throttled to avoid FloodWait. |
| `JobManager` | Per-user job tracking and cooperative cancellation on top of `DownloadQueue`. |
| `CancellationToken` | Cooperative cancellation signal checked at safe checkpoints. |
| `limits.ts` | Central Telegram upload-size guard. |

## Requirement mapping

| Requirement | Where |
| --- | --- |
| Use existing engine | `MediaInspector`, `MediaPipeline` call the engine; no engine edits. |
| Auto provider detection | `ProviderRegistry.platformFor` |
| Media info + thumbnail | `message:text` handler renders photo + caption |
| All formats from engine | `metadata.formats` straight from the engine |
| Inline keyboard | `buildChoiceKeyboard`, `buildVideoKeyboard`, `buildAudioKeyboard` |
| Live progress, edit in place | `ProgressReporter` |
| Store metadata | `TelegramStorage` (unchanged) persists file id, message id, channel, size, type, duration, platform, url, title, timestamp, checksum |
| Deliver file back | `TelegramStorage.copy` |
| No duplicate media+format | `MediaPipeline` composite cache key `url::formatId` |
| FloodWait | `UploadManager` backoff (unchanged) + throttled progress edits |
| Large files | `limits.assertUploadable` guard |
| Queue for multiple users | `DownloadQueue` + `JobManager` |
| Cancellation | `/cancel`, per-job cancel button, `CancellationToken` |

## Honest limitations

- **Cancellation is cooperative.** It stops a job at the next checkpoint (stage boundary or before upload). It does not kill an in-flight yt-dlp/ffmpeg process mid-stream, because that would require changing the frozen Download Engine contract. When you want hard cancellation, add an `AbortSignal` to the engine's `download()` and I will wire it through.
- **Large files are guarded, not chunked.** Files over the 50 MB bot limit are rejected with a clear message. Raising the ceiling to 2 GB requires a self-hosted Bot API server; the limit lives in one place (`limits.ts`) for that day.
- **Audio formats are what the source exposes.** For YouTube that is m4a/opus/webm. MP3 transcoding is not performed by the engine, so MP3 is only offered when the source itself provides it.
