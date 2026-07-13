import { config } from '../config/env';
import { logger } from '../logger/logger';
import { CacheLookup, DownloadArtifact, StoredMediaRecord, UploadResult } from '../types/media';
import { AppError } from '../types/errors';
import { safeRemove } from '../utils/fs';
import { FileCache } from './FileCache';
import { MessageManager } from './MessageManager';
import { ThumbnailUploader } from './ThumbnailUploader';
import { UploadManager } from './UploadManager';

/**
 * TelegramStorage is the reusable Storage Engine facade and the single entry
 * point for everything Telegram related. Providers and future Telegram Drive
 * services depend only on this surface.
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

  /** Format-aware existence check: same media AND same quality. */
  async existsByFormat(canonicalUrl: string, quality: string): Promise<StoredMediaRecord | null> {
    return await this.fileCache.lookupByFormat(canonicalUrl, quality);
  }

  async get(canonicalUrl: string): Promise<StoredMediaRecord | null> {
    return await this.fileCache.lookup({ canonicalUrl });
  }

  async upload(artifact: DownloadArtifact): Promise<StoredMediaRecord> {
    this.assertWithinLimit(artifact);

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
    logger.info({ canonicalUrl: record.canonicalUrl, quality: record.quality }, 'media metadata persisted');
  }

  async deleteTemp(filePath: string): Promise<void> {
    await safeRemove(filePath);
    logger.info({ filePath }, 'temporary file deleted');
  }

  async cacheCount(): Promise<number> {
    return await this.fileCache.count();
  }

  private assertWithinLimit(artifact: DownloadArtifact): void {
    const sizeBytes = artifact.probe.size ?? 0;
    const limitBytes = config.MAX_TELEGRAM_UPLOAD_MB * 1024 * 1024;
    if (sizeBytes > limitBytes) {
      const sizeMb = Math.round(sizeBytes / 1024 / 1024);
      throw new AppError(
        `File is ${sizeMb} MB which exceeds the ${config.MAX_TELEGRAM_UPLOAD_MB} MB Telegram upload limit. Pick a lower quality or configure a local Bot API server.`,
        'TOO_LARGE',
      );
    }
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
