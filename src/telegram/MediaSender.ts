import { Api, InputFile } from 'grammy';
import path from 'node:path';
import { DownloadArtifact, MediaType, UploadResult } from '../types/media';

/**
 * MediaSender is the only place that knows how to map a downloaded media
 * artifact to the correct Telegram send method. Providers never touch this.
 */
export class MediaSender {
  constructor(private readonly api: Api) {}

  async send(chatId: string, artifact: DownloadArtifact, thumbnailFileId?: string): Promise<UploadResult> {
    const file = new InputFile(artifact.filePath, path.basename(artifact.filePath));
    const caption = this.buildCaption(artifact);
    const mediaType = artifact.probe.mediaType;

    switch (mediaType) {
      case 'video': {
        const message = await this.api.sendVideo(chatId, file, {
          caption,
          duration: artifact.metadata.duration,
          width: artifact.probe.width,
          height: artifact.probe.height,
          supports_streaming: true,
          thumbnail: thumbnailFileId,
        });
        return this.fromFileId(message.message_id, message.video?.file_id, mediaType);
      }
      case 'audio': {
        const message = await this.api.sendAudio(chatId, file, {
          caption,
          duration: artifact.metadata.duration,
          performer: artifact.metadata.uploader,
          title: artifact.metadata.title,
          thumbnail: thumbnailFileId,
        });
        return this.fromFileId(message.message_id, message.audio?.file_id, mediaType);
      }
      case 'voice': {
        const message = await this.api.sendVoice(chatId, file, {
          caption,
          duration: artifact.metadata.duration,
        });
        return this.fromFileId(message.message_id, message.voice?.file_id, mediaType);
      }
      case 'photo': {
        const message = await this.api.sendPhoto(chatId, file, { caption });
        const largest = message.photo?.[message.photo.length - 1];
        return this.fromFileId(message.message_id, largest?.file_id, mediaType);
      }
      case 'animation': {
        const message = await this.api.sendAnimation(chatId, file, {
          caption,
          duration: artifact.metadata.duration,
          width: artifact.probe.width,
          height: artifact.probe.height,
        });
        return this.fromFileId(message.message_id, message.animation?.file_id, mediaType);
      }
      case 'sticker': {
        const message = await this.api.sendSticker(chatId, file);
        return this.fromFileId(message.message_id, message.sticker?.file_id, mediaType);
      }
      case 'document':
      default: {
        const message = await this.api.sendDocument(chatId, file, {
          caption,
          thumbnail: thumbnailFileId,
        });
        return this.fromFileId(message.message_id, message.document?.file_id, 'document');
      }
    }
  }

  private buildCaption(artifact: DownloadArtifact): string {
    const parts = [artifact.metadata.title, artifact.metadata.originalUrl];
    return parts.filter(Boolean).join('\n');
  }

  private fromFileId(messageId: number, fileId: string | undefined, mediaType: MediaType): UploadResult {
    if (!fileId) {
      throw new Error(`telegram returned no file_id for ${mediaType}`);
    }
    return { messageId, fileId, mediaType };
  }
}
