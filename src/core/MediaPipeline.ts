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

export interface PipelineRequest {
  url: string;
  formatId: string;
  userId: number;
  chatId: number;
  onProgress?: (update: ProgressUpdate) => void;
}

/**
 * MediaPipeline wires the Universal Download Engine to the Telegram Storage
 * Engine. It resolves the provider, checks cache, runs the engine, then hands
 * the artifact to storage. It never calls yt-dlp, ffmpeg, or Telegram directly.
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

    const cached = await this.telegramStorage.exists({ originalUrl: request.url, canonicalUrl });
    if (cached) {
      const newMessageId = await this.telegramStorage.copy(request.chatId, cached.messageId);
      await this.counterRepository.increment('cache_hits');
      logger.info({ canonicalUrl }, 'served from cache without download');
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
      const stored = await this.telegramStorage.upload(artifact);
      const deliveredMessageId = await this.telegramStorage.copy(request.chatId, stored.messageId);
      await this.counterRepository.increment('uploads');
      return { messageId: deliveredMessageId, cached: false };
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('Upload failed', 'UPLOAD_FAILED', error);
      await this.errorRepository.log({
        code: appError.code,
        message: appError.message,
        context: JSON.stringify({ url: request.url }),
      });
      throw appError;
    } finally {
      await this.telegramStorage.deleteTemp(artifact.filePath);
    }
  }
}
