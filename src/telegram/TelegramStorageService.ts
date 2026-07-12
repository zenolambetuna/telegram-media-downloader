import { Api, InputFile } from 'grammy';
import path from 'node:path';
import { config } from '../config/env';
import { DownloadArtifact } from '../types/media';
import { withRetry } from '../utils/retry';

export class TelegramStorageService {
  constructor(private readonly api: Api) {}

  async uploadWithRetry(artifact: DownloadArtifact): Promise<{ messageId: number; fileId: string }> {
    return await withRetry('telegram-upload', config.UPLOAD_RETRY_ATTEMPTS, async () => {
      const caption = `${artifact.metadata.title}\n${artifact.metadata.originalUrl}`;
      const response = artifact.mimeType.startsWith('audio/')
        ? await this.api.sendAudio(
            config.CHANNEL_ID,
            new InputFile(artifact.filePath, path.basename(artifact.filePath)),
            { caption },
          )
        : await this.api.sendDocument(
            config.CHANNEL_ID,
            new InputFile(artifact.filePath, path.basename(artifact.filePath)),
            { caption },
          );

      const fileId = response.audio?.file_id ?? response.document?.file_id ?? response.video?.file_id;
      if (!fileId) {
        throw new Error('telegram did not return file_id');
      }

      return {
        messageId: response.message_id,
        fileId,
      };
    });
  }

  async copyFromStorage(chatId: number, messageId: number): Promise<void> {
    await this.api.copyMessage(chatId, config.CHANNEL_ID, messageId);
  }
}
