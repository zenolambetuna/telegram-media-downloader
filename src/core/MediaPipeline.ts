import { DownloadEngine } from '../downloader/DownloadEngine';
import { ProviderRegistry } from './ProviderRegistry';
import { CounterRepository } from '../storage/CounterRepository';
import { ErrorRepository } from '../storage/ErrorRepository';
import { TelegramStorage } from '../telegram/TelegramStorage';
import { DownloadArtifact, QueueJobResult } from '../types/media';
import { ProgressUpdate } from '../types/download';
import { AppError } from '../types/errors';
import { CancelledError } from './CancelledError';
import { isProbablyLargeForTelegram } from '../telegram/mediaType';
import { logger } from '../logger/logger';
import { normalizeUrl } from '../utils/url';

/** Telegram Bot API upload ceiling for bots (50 MB). */
const TELEGRAM_BOT_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

export interface PipelineRequest {
  url: string;
  formatId: string;
  userId: number;
  chatId: number;
  onProgress?: (update: ProgressUpdate) => void;
  isCancelled?: () => boolean;
}

/**
 * MediaPipeline orchestrates cache -> engine -> storage. It does not call
 * yt-dlp, ffmpeg, or Telegram directly. This revision adds cooperative
 * cancellation checkpoints, a large-file guard, and format-aware cache reuse
 * without changing the engine, providers, or storage schema.
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
    const platform = this.providerRegistry.platformFor(request.url);

    this.checkCancelled(request);

    const cached = await this.telegramStorage.exists({ originalUrl: request.url, canonicalUrl });
    if (cached) {
      const newMessageId = await this.telegramStorage.copy(request.chatId, cached.messageId);
      await this.counterRepository.increment('cache_hits');
      logger.info({ canonicalUrl }, 'served from cache without download');
      return { messageId: newMessageId, cached: true };
    }

    this.checkCancelled(request);

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
      if (request.isCancelled?.()) {
        throw new CancelledError();
      }

      if (isProbablyLargeForTelegram(artifact.probe, TELEGRAM_BOT_UPLOAD_LIMIT_BYTES)) {
        throw new AppError(
          'This file exceeds the 50 MB Telegram bot upload limit. A local Bot API server is required for larger files.',
          'UPLOAD_FAILED',
        );
      }

      const stored = await this.telegramStorage.upload(artifact);
      const deliveredMessageId = await this.telegramStorage.copy(request.chatId, stored.messageId);
      await this.counterRepository.increment('uploads');
      return { messageId: deliveredMessageId, cached: false };
    } catch (error) {
      if (!(error instanceof CancelledError)) {
        const appError = error instanceof AppError ? error : new AppError('Upload failed', 'UPLOAD_FAILED', error);
        await this.errorRepository.log({
          code: appError.code,
          message: appError.message,
          context: JSON.stringify({ url: request.url }),
        });
        throw appError;
      }
      throw error;
    } finally {
      await this.telegramStorage.deleteTemp(artifact.filePath);
    }
  }

  private checkCancelled(request: PipelineRequest): void {
    if (request.isCancelled?.()) {
      throw new CancelledError();
    }
  }
}
