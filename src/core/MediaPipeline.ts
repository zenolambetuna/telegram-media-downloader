import { stat } from 'node:fs/promises';
import { DownloadEngine } from '../downloader/DownloadEngine';
import { ProviderRegistry } from './ProviderRegistry';
import { CounterRepository } from '../storage/CounterRepository';
import { ErrorRepository } from '../storage/ErrorRepository';
import { TelegramStorage } from '../telegram/TelegramStorage';
import { DownloadArtifact, QueueJobResult, StoredMediaRecord } from '../types/media';
import { ProgressUpdate } from '../types/download';
import { AppError } from '../types/errors';
import { CancellationToken } from '../queue/CancellationToken';
import { logger } from '../logger/logger';
import { config } from '../config/env';
import { normalizeUrl } from '../utils/url';
import { DriveSyncService } from './DriveSyncService';
import { CreateMediaRequest } from './DriveBridgeContract';

export interface PipelineRequest {
  url: string;
  formatId: string;
  quality: string;
  userId: number;
  chatId: number;
  cancellation: CancellationToken;
  onProgress?: (update: ProgressUpdate) => void;
  /** Stage 4.0: queue job id, used as the Drive sync idempotency key prefix. */
  queueId?: string;
}

/**
 * MediaPipeline wires the Universal Download Engine to the Telegram Storage
 * Engine. It performs format-aware cache reuse, cooperative cancellation, and
 * a real on-disk size guard before upload. It never calls yt-dlp, ffmpeg, or
 * Telegram directly.
 *
 * Stage 4.0: after a successful upload or cache hit, the pipeline fires the
 * DriveSyncService so the Telegram Drive Bridge receives the metadata. The
 * sync is fire-and-forget — the download never fails because the Drive is
 * offline.
 */
export class MediaPipeline {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly downloadEngine: DownloadEngine,
    private readonly telegramStorage: TelegramStorage,
    private readonly counterRepository: CounterRepository,
    private readonly errorRepository: ErrorRepository,
    private readonly driveSync?: DriveSyncService,
  ) {}

  async execute(request: PipelineRequest): Promise<QueueJobResult> {
    const canonicalUrl = normalizeUrl(request.url);
    const platform = this.providerRegistry.platformFor(request.url);

    // Format-aware dedup: reuse only when the same media AND quality exists.
    const cached = await this.telegramStorage.existsByFormat(canonicalUrl, request.quality);
    if (cached) {
      const newMessageId = await this.telegramStorage.copy(request.chatId, cached.messageId);
      await this.counterRepository.increment('cache_hits');
      logger.info({ canonicalUrl, quality: request.quality }, 'served from cache without download');
      // Stage 4.0: record the cache hit as a recent access for the owner.
      this.fireDownloadSync(request, cached, true);
      return { messageId: newMessageId, cached: true };
    }

    request.cancellation.throwIfCancelled();

    const engineResult = await this.downloadEngine.download({
      url: request.url,
      provider: platform,
      formatId: request.formatId,
      userId: request.userId,
      chatId: request.chatId,
      onProgress: request.onProgress,
    });

    const artifact: DownloadArtifact = {
      filePath: engineResult.filePath,
      fileName: engineResult.fileName,
      mimeType: engineResult.mimeType,
      quality: engineResult.quality,
      checksum: engineResult.checksum,
      probe: engineResult.probe,
      metadata: engineResult.metadata,
    };

    try {
      // Cancellation checkpoint before the expensive upload.
      request.cancellation.throwIfCancelled();

      // Real size from disk (probe size can be an estimate or missing).
      const actualSize = (await stat(artifact.filePath)).size;
      artifact.probe.size = actualSize;
      const limitBytes = config.MAX_TELEGRAM_UPLOAD_MB * 1024 * 1024;
      if (actualSize > limitBytes) {
        const sizeMb = Math.round(actualSize / 1024 / 1024);
        throw new AppError(
          `File is ${sizeMb} MB, over the ${config.MAX_TELEGRAM_UPLOAD_MB} MB Telegram limit. Try a lower quality.`,
          'TOO_LARGE',
        );
      }

      const stored = await this.telegramStorage.upload(artifact);
      const deliveredMessageId = await this.telegramStorage.copy(request.chatId, stored.messageId);
      await this.counterRepository.increment('uploads');

      // Clean up temp file ONLY after upload fully succeeds.
      // Deleting before grammY sends the file causes "Upload failed after retries".
      await this.telegramStorage.deleteTemp(artifact.filePath);

      // Stage 4.0: fire the Drive sync (post-upload flow). Non-blocking.
      this.fireUploadSync(request, stored, artifact);

      return { messageId: deliveredMessageId, cached: false };
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('Upload failed', 'UPLOAD_FAILED', error);
      if (appError.code !== 'CANCELLED') {
        await this.errorRepository.log({
          code: appError.code,
          message: appError.message,
          context: JSON.stringify({ url: request.url, quality: request.quality }),
        });
        logger.error({ error: appError, url: request.url, quality: request.quality }, 'Upload failed details');
      }
      throw appError;
    }
  }

  /**
   * Fire-and-forget the post-upload Drive sync. Builds a
   * `CreateMediaRequest` from the stored record and the download artifact,
   * then hands it to the DriveSyncService. Any sync failure is logged and
   * counted inside the service — it never propagates to the pipeline.
   */
  private fireUploadSync(request: PipelineRequest, stored: StoredMediaRecord, artifact: DownloadArtifact): void {
    if (!this.driveSync) {
      return;
    }
    const mediaId = stored.fileId;
    const media: CreateMediaRequest = {
      id: mediaId,
      ownerId: request.userId,
      provider: artifact.metadata.provider,
      canonicalUrl: artifact.metadata.canonicalUrl,
      originalUrl: artifact.metadata.originalUrl,
      title: artifact.metadata.title,
      description: artifact.metadata.description,
      duration: artifact.metadata.duration,
      thumbnail: artifact.metadata.thumbnail,
      mimeType: artifact.mimeType,
      quality: artifact.quality,
      resolution: artifact.probe.resolution,
      size: artifact.probe.size,
      checksum: artifact.checksum,
      fileId: stored.fileId,
      messageId: stored.messageId,
      chatId: stored.chatId,
    };
    const folderId = `tmd-${request.userId}`;
    this.driveSync.syncAfterUpload({
      queueId: request.queueId ?? mediaId,
      ownerId: request.userId,
      mediaId,
      media,
      folder: {
        id: folderId,
        name: config.DRIVE_SYNC_FOLDER_NAME,
      },
    });
  }

  /**
   * Fire-and-forget the post-download Drive sync (recent + favorite). Used
   * for both cache hits and fresh downloads.
   */
  private fireDownloadSync(request: PipelineRequest, stored: StoredMediaRecord, favorite: boolean): void {
    if (!this.driveSync) {
      return;
    }
    this.driveSync.syncAfterDownload({
      queueId: request.queueId ?? stored.fileId,
      ownerId: request.userId,
      mediaId: stored.fileId,
      favorite,
    });
  }
}
