import { InlineKeyboard } from 'grammy';
import { ResolvedMediaInfo } from '../types/media';
import { logger } from '../logger/logger';

const VIDEO_LADDER = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  return ` (${Math.round(bytes / 1024 / 1024)} MB)`;
}

export function buildMediaTypeKeyboard(info: ResolvedMediaInfo): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  logger.info(
    { platform: info.platform, hasVideo: info.hasVideo, hasAudio: info.hasAudio, supportsResolutionSelection: info.supportsResolutionSelection },
    'Building media type keyboard',
  );

  if (info.hasVideo) {
    keyboard.text('🎥 MP4', 'media:video');
  }
  if (info.hasAudio) {
    keyboard.text('🎵 MP3', 'media:audio');
  }
  keyboard.text('❌ Cancel', 'abort');

  const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
  logger.info({ buttons: labels }, 'Media type keyboard generated');

  return keyboard;
}

export function buildResolutionKeyboard(info: ResolvedMediaInfo): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  const byQuality = new Map<string, typeof info.videoFormats[0]>();
  for (const format of info.videoFormats) {
    const existing = byQuality.get(format.quality);
    if (!existing || (format.bitrate ?? 0) > (existing.bitrate ?? 0)) {
      byQuality.set(format.quality, format);
    }
  }

  for (let index = VIDEO_LADDER.length - 1; index >= 0; index -= 1) {
    const format = byQuality.get(VIDEO_LADDER[index]);
    if (format) {
      keyboard.text(`${VIDEO_LADDER[index]}${formatSize(format.filesize)}`, `format:${format.id}`).row();
    }
  }

  for (const [quality, format] of byQuality) {
    if (!VIDEO_LADDER.includes(quality)) {
      keyboard.text(`${quality}${formatSize(format.filesize)}`, `format:${format.id}`).row();
    }
  }

  keyboard.text('❌ Cancel', 'abort');

  logger.info({ resolutions: [...byQuality.keys()] }, 'Resolution keyboard generated');

  return keyboard;
}

export function buildCancelKeyboard(jobId: string): InlineKeyboard {
  return new InlineKeyboard().text('✖ Cancel download', `cancel:${jobId}`);
}
