import { Api } from 'grammy';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { AppError } from '../types/errors';

/**
 * MessageManager owns Telegram message-level operations that are not uploads:
 * copying cached media to a user and deleting messages when needed.
 */
export class MessageManager {
  constructor(private readonly api: Api) {}

  async copy(targetChatId: number, sourceMessageId: number): Promise<number> {
    try {
      const result = await this.api.copyMessage(targetChatId, config.CHANNEL_ID, sourceMessageId);
      logger.info({ targetChatId, sourceMessageId, newMessageId: result.message_id }, 'copied cached media');
      return result.message_id;
    } catch (error) {
      throw new AppError('Failed to copy cached media', 'UPLOAD_FAILED', error);
    }
  }

  async deleteFromStorage(messageId: number): Promise<void> {
    try {
      await this.api.deleteMessage(config.CHANNEL_ID, messageId);
    } catch (error) {
      logger.warn({ messageId, error }, 'failed to delete storage message');
    }
  }
}
