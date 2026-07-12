# YouTube Provider

The YouTube provider is the first real provider plugin. It is intentionally thin: it declares identity, matching, capabilities, and a config schema. It never calls yt-dlp, ffmpeg, or Telegram. All download mechanics live in the shared Universal Download Engine.

## Why the provider is thin

The architecture (locked in the plugin-system module) puts every heavy responsibility in shared, reusable services so that no provider re-implements them:

| Requirement | Where it lives |
| --- | --- |
| yt-dlp download backend | `downloader/YtDlpClient` (engine-internal) |
| dynamic format discovery | `downloader/MetadataService` + `downloader/FormatResolver` |
| normalized format model | `downloader/FormatResolver` -> `NormalizedFormat` |
| audio/video merge | `downloader/FFmpegService` |
| clean filenames | `downloader/YtDlpClient` output template |
| progress callbacks | `downloader/ProgressTracker` |
| download retries | `utils/retry` used by `DownloadEngine` |
| integrity verification | `downloader/ChecksumService` (sha256) |
| structured errors | `types/errors` `classifyDownloadError` |
| Telegram upload | `telegram/TelegramStorage` |

If this logic were copied into the provider, every future provider would duplicate it and the zero-core-edit plugin model would break. The provider's job is to say "this is a YouTube URL and here is what YouTube can do"; the engine does the work.

## Detection

The provider matches all YouTube surfaces via a strict host check (not a naive substring), so lookalikes are rejected:

- `youtube.com`, `www.youtube.com`
- `m.youtube.com`
- `music.youtube.com`
- `youtu.be`

Shorts, playlists, and live replay are ordinary `youtube.com` paths and are matched automatically. Lookalikes like `notyoutube.com` or `youtube.com.evil.tld` are rejected because the matcher parses the URL and validates the hostname.

## Capabilities

Video, audio, playlist, shorts, live, age-restricted, private, and login are all advertised. Age-restricted and private downloads require a cookies file, exposed via the config schema.

## Configuration schema

- `cookiesFile` (string, secret, optional): Netscape cookies file for age-restricted or private videos.
- `preferMp4` (boolean, default true): prefer mp4 container when merging.

These are declared as runtime metadata so the admin layer can render them without any hardcoding.

## What the engine returns

For any matched URL the engine returns normalized media: title, duration, uploader, thumbnail, filesize when available, and the full set of video resolutions and audio qualities as `NormalizedFormat` entries. Video-only formats are automatically merged with the best audio track. The result is checksummed and handed to the Storage Engine, which uploads to Telegram. The provider never sees Telegram.

## Tests

`tests/youtube.provider.test.ts` covers metadata, capabilities, manifest version, positive and negative URL detection, and health. `tests/formatResolver.test.ts` covers normalization and the quality ladder. `tests/providerValidator.test.ts` and `tests/semver.test.ts` cover plugin validation and version compatibility.

Run:

```bash
npm test
```
