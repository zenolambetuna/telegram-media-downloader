import { stat } from 'node:fs/promises';
import { DownloadEngine } from '../downloader/DownloadEngine';
import { ProviderRegistry } from './ProviderRegistry';
import { CounterRepository } from '../storage/CounterRepository';
import { ErrorRepository } from '../storage/ErrorRepository';
import { TelegramStorage } from '../telegram/TelegramStorage';
import { DownloadArtifact, QueueJobResult } from '../types/media';
import { ProgressUpdate } from '../types/download';
import { AppError } from '../types/errors';
import { CancellationToken } from '../queue/CancellationToken';
import { logger } from '../logger/logger';
import { config } from '../config/env';
import { normalizeUrl } from '../utils/url';
import path from 'node:path';

export interface PipelineRequest {
  url: string;
  formatId: string;
  quality: string;
  userId: number;
  chatId: number;
  cancellation: CancellationToken;
  onProgress?: (update: ProgressUpdate) => void;
}

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

    const cached = await this.telegramStorage.existsByFormat(canonicalUrl, request.quality);
    if (cached) {
      const newMessageId = await this.telegramStorage.copy(request.chatId, cached.messageId);
      await this.counterRepository.increment('cache_hits');
      logger.info({ canonicalUrl, quality: request.quality }, 'served from cache without download');
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
      request.cancellation.throwIfCancelled();

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

      await this.telegramStorage.deleteTemp(artifact.filePath);

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
}
