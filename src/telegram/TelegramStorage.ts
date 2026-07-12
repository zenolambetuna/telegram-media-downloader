import { config } from '../config/env';
import { logger } from '../logger/logger';
import {
  CacheLookup,
  DownloadArtifact,
  StoredMediaRecord,
  UploadResult,
} from '../types/media';
import { safeRemove } from '../utils/fs';
import { FileCache } from './FileCache';
import { MessageManager } from './MessageManager';
import { ThumbnailUploader } from './ThumbnailUploader';
import { UploadManager } from './UploadManager';

/**
 * TelegramStorage is the reusable Storage Engine facade. It is the single
 * entry point for everything Telegram related. Providers and future Telegram
 * Drive services depend only on this surface, never on the Telegram API or the
 * database implementation directly.
 *
 * Public API:
 *   exists()       -> is this media already stored?
 *   upload()       -> upload a downloaded artifact and persist metadata
 *   copy()         -> deliver stored media to a chat via CopyMessage
 *   get()          -> fetch stored metadata
 *   deleteTemp()   -> remove a temporary local file
 *   saveMetadata() -> persist a media record
 */
export class TelegramStorage {
  constructor(
    private readonly uploadManager: UploadManager,
    private readonly messageManager: MessageManager,
    private readonly fileCache: FileCache,
    private readonly thumbnailUploader: ThumbnailUploader,
  ) {}

  async exists(lookup: CacheLookup): Promise<StoredMediaRecord | null> {
    return await this.fileCache.lookup(lookup);
  }

  async get(canonicalUrl: string): Promise<StoredMediaRecord | null> {
    return await this.fileCache.lookup({ canonicalUrl });
  }

  async upload(artifact: DownloadArtifact): Promise<StoredMediaRecord> {
    const thumbnailFileId = await this.thumbnailUploader.resolve(
      artifact.metadata.canonicalUrl,
      artifact.metadata.thumbnail,
    );

    const uploadResult = await this.uploadManager.upload(config.CHANNEL_ID, artifact, thumbnailFileId);
    logger.info(
      { mediaType: uploadResult.mediaType, messageId: uploadResult.messageId },
      'media uploaded to storage channel',
    );

    const record = this.buildRecord(artifact, uploadResult);
    await this.saveMetadata(record);
    return record;
  }

  async copy(targetChatId: number, messageId: number): Promise<number> {
    return await this.messageManager.copy(targetChatId, messageId);
  }

  async saveMetadata(record: StoredMediaRecord): Promise<void> {
    await this.fileCache.save(record);
    logger.info({ canonicalUrl: record.canonicalUrl }, 'media metadata persisted');
  }

  async deleteTemp(filePath: string): Promise<void> {
    await safeRemove(filePath);
    logger.info({ filePath }, 'temporary file deleted');
  }

  async cacheCount(): Promise<number> {
    return await this.fileCache.count();
  }

  private buildRecord(artifact: DownloadArtifact, uploadResult: UploadResult): StoredMediaRecord {
    return {
      messageId: uploadResult.messageId,
      fileId: uploadResult.fileId,
      chatId: config.CHANNEL_ID,
      provider: artifact.metadata.provider,
      originalUrl: artifact.metadata.originalUrl,
      canonicalUrl: artifact.metadata.canonicalUrl,
      title: artifact.metadata.title,
      description: artifact.metadata.description,
      duration: artifact.metadata.duration,
      thumbnail: artifact.metadata.thumbnail,
      mimeType: artifact.mimeType,
      quality: artifact.quality,
      resolution: artifact.probe.resolution,
      fps: artifact.probe.fps,
      bitrate: artifact.probe.bitrate,
      codec: artifact.probe.codec,
      size: artifact.probe.size,
      uploadDate: new Date().toISOString(),
      checksum: artifact.checksum,
    };
  }
}
