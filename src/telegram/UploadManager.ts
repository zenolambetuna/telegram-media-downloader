import { GrammyError } from 'grammy';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { AppError } from '../types/errors';
import { DownloadArtifact, UploadResult } from '../types/media';
import { withTimeout } from '../utils/time';
import { MediaSender } from './MediaSender';

export class UploadManager {
  constructor(private readonly mediaSender: MediaSender) {}

  async upload(chatId: string, artifact: DownloadArtifact, thumbnailFileId?: string): Promise<UploadResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= config.UPLOAD_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const result = await withTimeout(
          this.mediaSender.send(chatId, artifact, thumbnailFileId),
          config.UPLOAD_TIMEOUT_MS,
          'upload timeout',
        );
        logger.info(
          { attempt, mediaType: result.mediaType, messageId: result.messageId, filePath: artifact.filePath },
          'upload succeeded',
        );
        return result;
      } catch (error) {
        lastError = error;
        const floodWaitSeconds = this.extractFloodWait(error);
        const errorSummary = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : 'UnknownError';

        if (floodWaitSeconds !== null) {
          logger.warn({ attempt, floodWaitSeconds }, 'telegram flood wait, backing off');
          await this.sleep(floodWaitSeconds * 1000);
          continue;
        }

        logger.error(
          { attempt, filePath: artifact.filePath, fileSize: artifact.probe.size, mimeType: artifact.mimeType, mediaType: artifact.probe.mediaType, errorName, errorMessage: errorSummary },
          'upload attempt failed',
        );

        console.error('[UPLOAD_ERROR]', {
          attempt, filePath: artifact.filePath, fileSize: artifact.probe.size, mimeType: artifact.mimeType, errorName, errorMessage: errorSummary,
        });

        if (attempt < config.UPLOAD_RETRY_ATTEMPTS) {
          const delay = config.RETRY_BASE_DELAY_MS * attempt;
          logger.warn({ attempt, delay }, 'retrying upload...');
          await this.sleep(delay);
        }
      }
    }

    const finalError = lastError instanceof Error ? lastError : new Error(String(lastError));
    logger.error(
      { chatId, filePath: artifact.filePath, fileSize: artifact.probe.size, mimeType: artifact.mimeType, mediaType: artifact.probe.mediaType, errorMessage: finalError.message, errorStack: finalError.stack, retries: config.UPLOAD_RETRY_ATTEMPTS },
      'upload failed after all retries',
    );

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
---

Selesai. 14 file di atas adalah semua file source code yang berubah (tidak termasuk file test). Setelah Anda mengganti semua file ini, jalankan:

```bash
npm run build
npm test
