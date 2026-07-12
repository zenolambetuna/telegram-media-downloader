import { DownloadEngine } from '../downloader/DownloadEngine';
import { CounterRepository } from '../storage/CounterRepository';
import { ErrorRepository } from '../storage/ErrorRepository';
import { TelegramStorage } from '../telegram/TelegramStorage';
import { DownloadRequest, QueueJobResult } from '../types/media';
import { AppError } from '../types/errors';
import { logger } from '../logger/logger';
import { normalizeUrl } from '../utils/url';

/**
 * MediaPipeline orchestrates the full workflow:
 *   cache check -> download -> upload via Storage Engine -> deliver -> cleanup.
 * It never calls Telegram directly; all Telegram concerns go through
 * TelegramStorage. Providers only ever produce a DownloadArtifact.
 */
export class MediaPipeline {
  constructor(
    private readonly downloadEngine: DownloadEngine,
    private readonly telegramStorage: TelegramStorage,
    private readonly counterRepository: CounterRepository,
    private readonly errorRepository: ErrorRepository,
  ) {}

  async execute(request: DownloadRequest): Promise<QueueJobResult> {
    const canonicalUrl = normalizeUrl(request.url);

    const cached = await this.telegramStorage.exists({
      originalUrl: request.url,
      canonicalUrl,
    });

    if (cached) {
      const newMessageId = await this.telegramStorage.copy(request.chatId, cached.messageId);
      await this.counterRepository.increment('cache_hits');
      logger.info({ canonicalUrl }, 'served from cache without download');
      return { messageId: newMessageId, cached: true };
    }

    const artifact = await this.downloadEngine.download(request);

    try {
      const stored = await this.telegramStorage.upload(artifact);
      const deliveredMessageId = await this.telegramStorage.copy(request.chatId, stored.messageId);
      await this.counterRepository.increment('uploads');
      return { messageId: deliveredMessageId, cached: false };
    } catch (error) {
      const appError =
        error instanceof AppError ? error : new AppError('Upload failed', 'UPLOAD_FAILED', error);
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
