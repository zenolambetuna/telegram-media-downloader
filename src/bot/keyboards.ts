import { InlineKeyboard } from 'grammy';
import { MediaFormat } from '../types/media';

const VIDEO_LADDER = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];

function formatSize(bytes?: number): string {
  if (!bytes) {
    return '';
  }
  return ` (${Math.round(bytes / 1024 / 1024)} MB)`;
}

/**
 * Top-level choice keyboard: Video / Audio / Cancel. Only shows a bucket if the
 * engine actually returned formats of that kind.
 */
export function buildChoiceKeyboard(formats: MediaFormat[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (formats.some((format) => format.kind === 'video')) {
    keyboard.text('🎬 Video', 'choose:video');
  }
  if (formats.some((format) => format.kind === 'audio')) {
    keyboard.text('🎵 Audio', 'choose:audio');
  }
  keyboard.text('❌ Cancel', 'choose:cancel');
  return keyboard;
}

/**
 * Builds the video quality keyboard ordered by the standard ladder. Only
 * qualities that actually exist for this media are shown. Each row is one
 * quality mapped to its concrete engine format id.
 */
export function buildVideoKeyboard(formats: MediaFormat[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const videos = formats.filter((format) => format.kind === 'video');

  const byQuality = new Map<string, MediaFormat>();
  for (const format of videos) {
    const existing = byQuality.get(format.quality);
    if (!existing || (format.bitrate ?? 0) > (existing.bitrate ?? 0)) {
      byQuality.set(format.quality, format);
    }
  }

  for (const quality of VIDEO_LADDER) {
    const format = byQuality.get(quality);
    if (format) {
      keyboard.text(`${quality}${formatSize(format.filesize)}`, `format:${format.id}`).row();
    }
  }

  for (const [quality, format] of byQuality) {
    if (!VIDEO_LADDER.includes(quality)) {
      keyboard.text(`${quality}${formatSize(format.filesize)}`, `format:${format.id}`).row();
    }
  }

  keyboard.text('❌ Cancel', 'choose:cancel');
  return keyboard;
}

/**
 * Builds the audio keyboard from the actually available audio formats. Labels
 * show bitrate and codec/container so the user picks a real, existing format.
 * Note: these are the formats the source and engine expose (for YouTube:
 * m4a/opus/webm). MP3 transcoding is not performed by the engine, so MP3 is
 * only offered if the source itself provides it.
 */
export function buildAudioKeyboard(formats: MediaFormat[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const audios = formats
    .filter((format) => format.kind === 'audio')
    .sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0));

  for (const format of audios) {
    const kbps = format.bitrate ? `${Math.round(format.bitrate / 1000)}k ` : '';
    const codec = format.audioCodec ?? format.extension;
    keyboard.text(`${kbps}${codec}${formatSize(format.filesize)}`.trim(), `format:${format.id}`).row();
  }

  keyboard.text('❌ Cancel', 'choose:cancel');
  return keyboard;
}

export function buildProgressKeyboard(jobId: string): InlineKeyboard {
  return new InlineKeyboard().text('✖ Cancel download', `cancel:${jobId}`);
}
