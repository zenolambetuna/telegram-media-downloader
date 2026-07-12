import { GrammyError } from 'grammy';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { AppError } from '../types/errors';
import { DownloadArtifact, UploadResult } from '../types/media';
import { withTimeout } from '../utils/time';
import { MediaSender } from './MediaSender';

/**
 * UploadManager owns upload reliability: timeout, retry, and FloodWait
 * backoff. It delegates the actual Telegram method selection to MediaSender.
 */
export class UploadManager {
  constructor(private readonly mediaSender: MediaSender) {}

  async upload(chatId: string, artifact: DownloadArtifact, thumbnailFileId?: string): Promise<UploadResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= config.UPLOAD_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await withTimeout(
          this.mediaSender.send(chatId, artifact, thumbnailFileId),
          config.UPLOAD_TIMEOUT_MS,
          'upload timeout',
        );
      } catch (error) {
        lastError = error;
        const floodWaitSeconds = this.extractFloodWait(error);

        if (floodWaitSeconds !== null) {
          logger.warn({ attempt, floodWaitSeconds }, 'telegram flood wait, backing off');
          await this.sleep(floodWaitSeconds * 1000);
          continue;
        }

        logger.warn({ attempt, error }, 'upload attempt failed');
        if (attempt < config.UPLOAD_RETRY_ATTEMPTS) {
          await this.sleep(config.RETRY_BASE_DELAY_MS * attempt);
        }
      }
    }

    throw new AppError('Upload failed after retries', 'UPLOAD_FAILED', lastError);
  }

  private extractFloodWait(error: unknown): number | null {
    if (error instanceof GrammyError && error.error_code === 429) {
      const retryAfter = error.parameters?.retry_after;
      if (typeof retryAfter === 'number') {
        return retryAfter;
      }
    }
    return null;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
