import { Api, InputFile } from 'grammy';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { ThumbnailRepository } from '../storage/ThumbnailRepository';

/**
 * ThumbnailUploader uploads a thumbnail to the storage channel once and reuses
 * the resulting Telegram file_id for every subsequent media that shares the
 * same thumbnail source. Thumbnails are cached by source key.
 */
export class ThumbnailUploader {
  constructor(
    private readonly api: Api,
    private readonly thumbnailRepository: ThumbnailRepository,
  ) {}

  async resolve(sourceKey: string, thumbnailUrl?: string): Promise<string | undefined> {
    if (!thumbnailUrl) {
      return undefined;
    }

    const cached = await this.thumbnailRepository.find(sourceKey);
    if (cached) {
      logger.info({ sourceKey }, 'thumbnail cache hit');
      return cached.fileId;
    }

    try {
      const message = await this.api.sendPhoto(config.CHANNEL_ID, new InputFile(new URL(thumbnailUrl)));
      const largest = message.photo?.[message.photo.length - 1];
      if (!largest) {
        return undefined;
      }

      await this.thumbnailRepository.save({
        sourceKey,
        fileId: largest.file_id,
        messageId: message.message_id,
      });

      logger.info({ sourceKey }, 'thumbnail uploaded and cached');
      return largest.file_id;
    } catch (error) {
      logger.warn({ sourceKey, error }, 'thumbnail upload failed, continuing without thumbnail');
      return undefined;
    }
  }
}
