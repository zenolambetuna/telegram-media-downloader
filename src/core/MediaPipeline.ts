import { DownloadEngine } from '../downloader/DownloadEngine';
import { ProviderRegistry } from './ProviderRegistry';
import { CounterRepository } from '../storage/CounterRepository';
import { ErrorRepository } from '../storage/ErrorRepository';
import { TelegramStorage } from '../telegram/TelegramStorage';
import { DownloadArtifact, QueueJobResult } from '../types/media';
import { ProgressUpdate } from '../types/download';
import { AppError } from '../types/errors';
import { logger } from '../logger/logger';
import { normalizeUrl } from '../utils/url';
import { assertUploadable } from '../bot/limits';

export interface PipelineRequest {
  url: string;
  formatId: string;
  userId: number;
  chatId: number;
  onProgress?: (update: ProgressUpdate) => void;
  shouldCancel?: () => boolean;
}

/**
 * MediaPipeline wires the Universal Download Engine to the Telegram Storage
 * Engine. It resolves the provider, checks a format-aware cache, runs the
 * engine, guards Telegram size limits, then hands the artifact to storage. It
 * never calls yt-dlp, ffmpeg, or Telegram directly, and it does not touch the
 * provider architecture or the engine internals.
 *
 * Requirement 13 (never upload duplicate media+format) is implemented with a
 * composite cache key: normalized URL plus the selected format id. The clean
 * original URL is preserved on the record for display.
 */
export class MediaPipeline {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly downloadEngine: DownloadEngine,
    private readonly telegramStorage: TelegramStorage,
    private readonly counterRepository: CounterRepository,
    private readonly errorRepository: ErrorRepository,
  ) {}

  async execute(request: PipelineRequest): Promise<QueueJobResult> {
    const canonicalUrl = normalizeUrl(request.url);
    const cacheKey = `${canonicalUrl}::${request.formatId}`;
    const platform = this.providerRegistry.platformFor(request.url);

    const cached = await this.telegramStorage.exists({ canonicalUrl: cacheKey });
    if (cached) {
      const newMessageId = await this.telegramStorage.copy(request.chatId, cached.messageId);
      await this.counterRepository.increment('cache_hits');
      logger.info({ cacheKey }, 'served from cache without download');
      return { messageId: newMessageId, cached: true };
    }

    this.checkCancel(request);

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
      // The composite cache key becomes the stored canonical url so the same
      // media+format is never downloaded or uploaded twice.
      metadata: { ...engineResult.metadata, canonicalUrl: cacheKey },
    };

    try {
      this.checkCancel(request);
      await assertUploadable(artifact.filePath);
      const stored = await this.telegramStorage.upload(artifact);
      const deliveredMessageId = await this.telegramStorage.copy(request.chatId, stored.messageId);
      await this.counterRepository.increment('uploads');
      return { messageId: deliveredMessageId, cached: false };
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('Upload failed', 'UPLOAD_FAILED', error);
      await this.errorRepository.log({
        code: appError.code,
        message: appError.message,
        context: JSON.stringify({ url: request.url, formatId: request.formatId }),
      });
      throw appError;
    } finally {
      await this.telegramStorage.deleteTemp(artifact.filePath);
    }
  }

  private checkCancel(request: PipelineRequest): void {
    if (request.shouldCancel?.()) {
      const error = new Error('cancelled');
      error.name = 'CancellationError';
      throw error;
    }
  }
}
