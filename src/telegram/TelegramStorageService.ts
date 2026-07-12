import { Api, InputFile } from 'grammy';
import path from 'node:path';
import { config } from '../config/env';
import { DownloadResult } from '../types/media';

export class TelegramStorageService {
  constructor(private readonly api: Api) {}

  async upload(download: DownloadResult): Promise<{ messageId: number; fileId: string }> {
    const caption = `${download.title}\n${download.originalUrl}`;
    const response = await this.api.sendDocument(
      config.channelId,
      new InputFile(download.filePath, path.basename(download.filePath)),
      { caption },
    );

    const fileId = response.document?.file_id ?? response.video?.file_id ?? response.audio?.file_id;
    if (!fileId) {
      throw new Error('Telegram did not return file_id');
    }

    return {
      messageId: response.message_id,
      fileId,
    };
  }

  async deliverFromCache(chatId: number, messageId: number): Promise<void> {
    await this.api.copyMessage(chatId, config.channelId, messageId);
  }

  async deliverUploaded(chatId: number, messageId: number): Promise<void> {
    await this.api.copyMessage(chatId, config.channelId, messageId);
  }
}
