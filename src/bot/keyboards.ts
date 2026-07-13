import { InlineKeyboard } from 'grammy';
import { MediaFormat, MediaKind } from '../types/media';

const VIDEO_LADDER = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];

function formatSize(bytes?: number): string {
  if (!bytes) {
    return '';
  }
  return ` (${Math.round(bytes / 1024 / 1024)} MB)`;
}

/**
 * New API.
 *
 * buildKindKeyboard: the top-level Video / Audio / Cancel chooser. Only shows a
 * bucket when the engine actually returned formats of that kind.
 */
export function buildKindKeyboard(formats: MediaFormat[]): InlineKeyboard {
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
 * New API.
 *
 * buildFormatKeyboard: builds the concrete per-quality keyboard for a given
 * kind. For video, qualities are ordered by the standard ladder and deduped to
 * the highest-bitrate variant per quality. For audio, formats are ordered by
 * bitrate descending and labelled with bitrate and codec. Only formats that
 * actually exist are shown.
 */
export function buildFormatKeyboard(formats: MediaFormat[], kind: MediaKind): InlineKeyboard {
  return kind === 'video' ? buildVideoFormatKeyboard(formats) : buildAudioFormatKeyboard(formats);
}

function buildVideoFormatKeyboard(formats: MediaFormat[]): InlineKeyboard {
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

function buildAudioFormatKeyboard(formats: MediaFormat[]): InlineKeyboard {
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

/**
 * Backward-compatible wrappers.
 *
 * The module was refactored from three functions
 * (buildChoiceKeyboard/buildVideoKeyboard/buildAudioKeyboard) to two
 * (buildKindKeyboard/buildFormatKeyboard). These wrappers restore the original
 * exports so existing callers and tests keep working without behaviour change.
 * The new API is preserved above.
 */
export function buildChoiceKeyboard(formats: MediaFormat[]): InlineKeyboard {
  return buildKindKeyboard(formats);
}

export function buildVideoKeyboard(formats: MediaFormat[]): InlineKeyboard {
  return buildFormatKeyboard(formats, 'video');
}

export function buildAudioKeyboard(formats: MediaFormat[]): InlineKeyboard {
  return buildFormatKeyboard(formats, 'audio');
}
