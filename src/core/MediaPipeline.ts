import { stat } from 'node:fs/promises';
import { DownloadEngine } from '../downloader/DownloadEngine';
import { ProviderRegistry } from './ProviderRegistry';
import { CounterRepository } from '../storage/CounterRepository';
import { ErrorRepository } from '../storage/ErrorRepository';
import { FormatCacheRepository } from '../storage/FormatCacheRepository';
import { TelegramStorage } from '../telegram/TelegramStorage';
import { DownloadArtifact, QueueJobResult } from '../types/media';
import { ProgressUpdate } from '../types/download';
import { AppError } from '../types/errors';
import { CancellationToken } from './CancellationToken';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { normalizeUrl } from '../utils/url';

export interface PipelineRequest {
  url: string;
  formatId: string;
  userId: number;
  chatId: number;
  token: CancellationToken;
  onProgress?: (update: ProgressUpdate) => void;
}

/**
 * MediaPipeline wires the Universal Download Engine to the Telegram Storage
 * Engine. It resolves the provider, checks the per-format cache, runs the
 * engine, guards Telegram size limits, then hands the artifact to storage.
 * It never calls yt-dlp, ffmpeg, or Telegram directly, and it never modifies
 * the engine or providers.
 */
export class MediaPipeline {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly downloadEngine: DownloadEngine,
    private readonly telegramStorage: TelegramStorage,
    private readonly formatCache: FormatCacheRepository,
    private readonly counterRepository: CounterRepository,
    private readonly errorRepository: ErrorRepository,
  ) {}

  async execute(request: PipelineRequest): Promise<QueueJobResult> {
    const canonicalUrl = normalizeUrl(request.url);
    const platform = this.providerRegistry.platformFor(request.url);

    request.token.throwIfCancelled();

    // Requirement 13: dedup by media + format. Same URL, same format id => reuse.
    const cached = await this.formatCache.find(canonicalUrl, request.formatId);
    if (cached) {
      const newMessageId = await this.telegramStorage.copy(request.chatId, cached.messageId);
      await this.counterRepository.increment('cache_hits');
      logger.info({ canonicalUrl, formatId: request.formatId }, 'served from per-format cache');
      return { messageId: newMessageId, cached: true };
    }

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
      // If cancelled during download, stop before uploading.
      if (request.token.isCancelled) {
        throw new AppError('Cancelled by user', 'CANCELLED');
      }

      await this.guardSize(artifact);

      const stored = await this.telegramStorage.upload(artifact);

      await this.formatCache.save({
        canonicalUrl,
        formatId: request.formatId,
        messageId: stored.messageId,
        fileId: stored.fileId,
        chatId: stored.chatId,
        provider: platform,
        originalUrl: request.url,
        title: artifact.metadata.title,
        mediaType: artifact.probe.mediaType,
        quality: artifact.quality,
        duration: artifact.metadata.duration,
        size: artifact.probe.size,
        checksum: artifact.checksum,
        uploadDate: new Date().toISOString(),
      });

      const deliveredMessageId = await this.telegramStorage.copy(request.chatId, stored.messageId);
      await this.counterRepository.increment('uploads');
      return { messageId: deliveredMessageId, cached: false };
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('Upload failed', 'UPLOAD_FAILED', error);
      if (appError.code !== 'CANCELLED') {
        await this.errorRepository.log({
          code: appError.code,
          message: appError.message,
          context: JSON.stringify({ url: request.url, formatId: request.formatId }),
        });
      }
      throw appError;
    } finally {
      await this.telegramStorage.deleteTemp(artifact.filePath);
    }
  }

  private async guardSize(artifact: DownloadArtifact): Promise<void> {
    let size = artifact.probe.size;
    if (!size) {
      try {
        size = (await stat(artifact.filePath)).size;
      } catch {
        size = 0;
      }
    }
    if (size && size > config.MAX_TELEGRAM_UPLOAD_BYTES) {
      const limitMb = Math.round(config.MAX_TELEGRAM_UPLOAD_BYTES / 1024 / 1024);
      const sizeMb = Math.round(size / 1024 / 1024);
      throw new AppError(
        `File is ${sizeMb} MB which exceeds the ${limitMb} MB Telegram upload limit. Pick a lower quality, or configure a local Bot API server.`,
        'FILE_TOO_LARGE',
      );
    }
  }
}
