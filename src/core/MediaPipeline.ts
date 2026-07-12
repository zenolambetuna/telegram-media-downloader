import { CacheService } from '../cache/CacheService';
import { DownloadEngine } from '../downloader/DownloadEngine';
import { CounterRepository } from '../storage/CounterRepository';
import { ErrorRepository } from '../storage/ErrorRepository';
import { TelegramStorageService } from '../telegram/TelegramStorageService';
import { DownloadRequest, QueueJobResult } from '../types/media';
import { normalizeUrl } from '../utils/url';
import { safeRemove } from '../utils/fs';

export class MediaPipeline {
  constructor(
    private readonly cacheService: CacheService,
    private readonly downloadEngine: DownloadEngine,
    private readonly telegramStorageService: TelegramStorageService,
    private readonly counterRepository: CounterRepository,
    private readonly errorRepository: ErrorRepository,
  ) {}

  async execute(request: DownloadRequest): Promise<QueueJobResult> {
    const canonicalUrl = normalizeUrl(request.url);
    const cached = await this.cacheService.get(canonicalUrl);
    if (cached) {
      await this.telegramStorageService.copyFromStorage(request.chatId, cached.messageId);
      await this.counterRepository.increment('cache_hits');
      return { messageId: cached.messageId, cached: true };
    }

    const artifact = await this.downloadEngine.download(request);

    try {
      const uploadResult = await this.telegramStorageService.uploadWithRetry(artifact);
      await this.cacheService.put({
        messageId: uploadResult.messageId,
        fileId: uploadResult.fileId,
        provider: artifact.metadata.provider,
        originalUrl: artifact.metadata.originalUrl,
        canonicalUrl: artifact.metadata.canonicalUrl,
        title: artifact.metadata.title,
        duration: artifact.metadata.duration,
        thumbnail: artifact.metadata.thumbnail,
        quality: artifact.quality,
        mimeType: artifact.mimeType,
        uploadDate: new Date().toISOString(),
        checksum: artifact.checksum,
      });
      await this.telegramStorageService.copyFromStorage(request.chatId, uploadResult.messageId);
      await this.counterRepository.increment('uploads');
      return { messageId: uploadResult.messageId, cached: false };
    } catch (error) {
      await this.errorRepository.log({
        code: 'UPLOAD_FAILED',
        message: error instanceof Error ? error.message : 'upload failed',
        context: JSON.stringify({ url: request.url }),
      });
      throw error;
    } finally {
      await safeRemove(artifact.filePath);
    }
  }
}
