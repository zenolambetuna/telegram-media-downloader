import { InlineKeyboard } from 'grammy';
import { ResolvedMediaInfo, MediaFormat } from '../types/media';
import { logger } from '../logger/logger';

const VIDEO_LADDER = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  return ` (${Math.round(bytes / 1024 / 1024)} MB)`;
}

/**
 * Build a keyboard that lets the user choose between video and audio buckets.
 * Only shows buckets for kinds that exist in the provided formats.
 */
export function buildChoiceKeyboard(formats: MediaFormat[]): InlineKeyboard {
  const hasVideo = formats.some((f) => f.kind === 'video');
  const hasAudio = formats.some((f) => f.kind === 'audio');

  const keyboard = new InlineKeyboard();

  if (hasVideo) {
    keyboard.text('🎬 Video', 'kind:video');
  }
  if (hasAudio) {
    keyboard.text('🎵 Audio', 'kind:audio');
  }
  keyboard.text('❌ Cancel', 'abort');

  const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
  logger.info({ buttons: labels }, 'choice keyboard generated');

  return keyboard;
}

/**
 * Build a keyboard with video quality options.
 * Deduplicates by quality (keeps highest bitrate) and orders by VIDEO_LADDER descending.
 */
export function buildVideoKeyboard(formats: MediaFormat[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  const byQuality = new Map<string, MediaFormat>();
  for (const format of formats) {
    const existing = byQuality.get(format.quality);
    if (!existing || (format.bitrate ?? 0) > (existing.bitrate ?? 0)) {
      byQuality.set(format.quality, format);
    }
  }

  // Ordered by VIDEO_LADDER descending
  for (let index = VIDEO_LADDER.length - 1; index >= 0; index -= 1) {
    const format = byQuality.get(VIDEO_LADDER[index]);
    if (format) {
      keyboard.text(`${VIDEO_LADDER[index]}${formatSize(format.filesize)}`, `format:${format.id}`).row();
    }
  }

  // Any qualities not in the ladder
  for (const [quality, format] of byQuality) {
    if (!VIDEO_LADDER.includes(quality)) {
      keyboard.text(`${quality}${formatSize(format.filesize)}`, `format:${format.id}`).row();
    }
  }

  keyboard.text('❌ Cancel', 'abort');

  const resolutions = [...byQuality.keys()];
  logger.info({ resolutions }, 'video keyboard generated');

  return keyboard;
}

/**
 * Build a keyboard with audio options, sorted by bitrate descending.
 */
export function buildAudioKeyboard(formats: MediaFormat[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  const sorted = [...formats].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

  for (const format of sorted) {
    const label = format.audioCodec
      ? `${format.audioCodec.toUpperCase()} ${Math.round((format.bitrate ?? 0) / 1000)}kbps`
      : `Audio ${format.extension ?? ''}`;
    keyboard.text(label, `format:${format.id}`).row();
  }

  keyboard.text('❌ Cancel', 'abort');

  logger.info({ count: sorted.length }, 'audio keyboard generated');

  return keyboard;
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