# Universal Download Engine

The Universal Download Engine is the single core download engine for the entire Telegram Drive ecosystem. Every provider, current and future, uses it. No provider ever calls yt-dlp or ffmpeg directly.

## The inversion

Before this module, each provider extended a yt-dlp base class and effectively *was* a downloader. That coupled every provider to yt-dlp.

Now the relationship is inverted:

- A provider is a thin descriptor: platform name + URL matcher.
- The engine owns validation, metadata, formats, download, merge, ffmpeg, thumbnails, progress, temp files, retries, and checksums.

Adding a new provider is now three lines: extend `BaseProvider`, set `platform`, set `pattern`.

## Components

| Component | Responsibility |
| --- | --- |
| `DownloadEngine` | Orchestrates the full download lifecycle. The single entry point. |
| `MetadataService` | Extracts metadata, detects live streams and playlists. |
| `FormatResolver` | Normalizes raw yt-dlp formats into standardized formats. |
| `ProgressTracker` | Reusable, listener-based staged progress system. |
| `TempFileManager` | Creates and cleans workspaces, recovers orphans after crash. |
| `FFmpegService` | Merges video/audio and extracts thumbnails. |
| `ChecksumService` | Generates content checksums for cache reuse. |
| `YtDlpClient` | The only place that shells out to yt-dlp. Engine-internal. |

## Standardized formats

Providers and consumers never see raw yt-dlp fields. `FormatResolver` emits `NormalizedFormat` with: `quality`, `resolution`, `width`, `height`, `fps`, `bitrate`, `videoCodec`, `audioCodec`, `container`, `extension`, `hasAudio`, `hasVideo`.

## Quality ladder

Qualities map to a fixed ladder: 144p, 240p, 360p, 480p, 720p, 1080p, 1440p, 2160p, Best Available, Audio Only. Only qualities that actually exist for the media are shown. Duplicate qualities are collapsed to the highest-bitrate variant.

## Progress stages

`fetching_metadata -> resolving_formats -> downloading -> merging -> processing -> uploading -> finished`. Consumers subscribe with a listener and never touch engine internals.

## Merging

When a chosen video format has no audio, the engine downloads the best matching audio-only track and merges with ffmpeg (`-c copy`) into an mp4. Merge is retried on failure.

## Temp file lifecycle

Each job gets a unique workspace under `TMP_DIR`. Workspaces are always cleaned after the job. On startup the engine calls `recoverOrphans()` to purge workspaces left by a crash.

## Error handling

`classifyDownloadError` maps raw stderr into typed errors: private, age restricted, geo restricted, removed, unavailable, live stream, unsupported format, disk full, timeout, network failure. Consumers get clean, safe messages.

## Retries

Network and download operations retry with backoff. Merges retry independently.

## Caching

The engine produces a checksum for every downloaded file. Combined with the Storage Engine cache lookup (checksum + original URL + normalized URL), identical media is never downloaded twice.

## How providers use it

```ts
// A provider is only this:
export class YouTubeProvider extends BaseProvider {
  readonly platform = 'youtube' as const;
  protected readonly pattern = /(?:youtube\.com|youtu\.be)/i;
}

// The engine does everything:
const platform = providerRegistry.platformFor(url);
const { metadata, formats } = await downloadEngine.inspect(url, platform);
const result = await downloadEngine.download({ url, provider: platform, formatId, userId, chatId });
```

That is the contract for every current and future provider.
