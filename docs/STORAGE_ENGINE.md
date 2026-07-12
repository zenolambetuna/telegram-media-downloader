# Telegram Storage Engine

The Telegram Storage Engine is the heart of the future Telegram Drive ecosystem. It is the single, reusable service responsible for everything that touches Telegram as a storage backend.

Providers never call the Telegram API. Providers only download media and return a `DownloadArtifact`. The Storage Engine takes it from there.

## Responsibilities

The engine owns:

- choosing the correct Telegram upload method per media type
- upload reliability: timeout, retry, FloodWait backoff
- cache lookup by checksum, original URL, and normalized URL
- thumbnail upload, reuse, and caching
- metadata persistence through an abstract repository
- delivering stored media to users via `copyMessage`
- temporary file cleanup

## Components

| Component | Responsibility |
| --- | --- |
| `TelegramStorage` | Public facade. The only surface providers and Telegram Drive use. |
| `UploadManager` | Upload retry, timeout, and FloodWait backoff. |
| `MessageManager` | `copyMessage` delivery and storage message deletion. |
| `MediaSender` | Maps media type to `sendVideo`, `sendAudio`, `sendPhoto`, `sendVoice`, `sendAnimation`, `sendSticker`, `sendDocument`. |
| `FileCache` | Multi-signal cache lookup and metadata save. |
| `ThumbnailUploader` | Uploads thumbnails once, reuses cached `file_id`. |

## Public API

```ts
interface TelegramStorage {
  exists(lookup: CacheLookup): Promise<StoredMediaRecord | null>;
  get(canonicalUrl: string): Promise<StoredMediaRecord | null>;
  upload(artifact: DownloadArtifact): Promise<StoredMediaRecord>;
  copy(targetChatId: number, messageId: number): Promise<number>;
  saveMetadata(record: StoredMediaRecord): Promise<void>;
  deleteTemp(filePath: string): Promise<void>;
}
```

## Media types

The engine never uploads everything as a document. `MediaSender` selects:

- video -> `sendVideo`
- audio -> `sendAudio`
- voice -> `sendVoice`
- photo -> `sendPhoto`
- animation -> `sendAnimation`
- sticker -> `sendSticker`
- everything else -> `sendDocument`

New media types only require extending `resolveMediaType` and adding a branch in `MediaSender`. Nothing else changes.

## Stored metadata

Each record stores: `message_id`, `file_id`, `chat_id`, `provider`, `original_url`, `canonical_url`, `title`, `description`, `duration`, `thumbnail`, `mime_type`, `quality`, `resolution`, `fps`, `bitrate`, `codec`, `size`, `upload_date`, and `checksum`.

## Cache strategy

Before any download, the pipeline calls `exists()`. The engine checks in order:

1. checksum
2. original URL
3. normalized canonical URL

If any match is found, the media is delivered with `copyMessage` and no download happens.

## Large files

`mediaType.ts` exposes `isProbablyLargeForTelegram` so the engine can branch on Telegram size limits. The upload path is centralized in `UploadManager`, so future chunking or a local Bot API server can be added in one place without touching providers.

## Why this matters for Telegram Drive

Telegram Drive will not implement download or storage logic itself. It will call this engine:

```ts
const existing = await telegramStorage.exists({ originalUrl });
if (existing) {
  return telegramStorage.copy(chatId, existing.messageId);
}

const artifact = await downloadEngine.download(request);
const stored = await telegramStorage.upload(artifact);
await telegramStorage.deleteTemp(artifact.filePath);
return stored;
```

That is the whole point: one storage brain, many consumers, zero duplication.
