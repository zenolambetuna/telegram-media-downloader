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
 * Current API.
 *
 * buildKindKeyboard: top-level Video / Audio / Cancel chooser. Only shows a
 * bucket when the engine actually returned formats of that kind.
 */
export function buildKindKeyboard(formats: MediaFormat[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const videoCount = formats.filter((format) => format.kind === 'video').length;
  const audioCount = formats.filter((format) => format.kind === 'audio').length;
  console.log('[DEBUG] buildKindKeyboard input:', { total: formats.length, video: videoCount, audio: audioCount });
  if (formats.some((format) => format.kind === 'video')) {
    keyboard.text('🎬 Video', 'kind:video');
  }
  if (formats.some((format) => format.kind === 'audio')) {
    keyboard.text('🎵 Audio', 'kind:audio');
  }
  keyboard.text('❌ Cancel', 'abort');
  console.log('[DEBUG] Keyboard buttons:', keyboard.inline_keyboard.flat().map(b => b.text));
  return keyboard;
}

/**
 * Current API.
 *
 * buildFormatKeyboard: builds the concrete per-quality keyboard for a kind.
 * Video qualities are ordered by the standard ladder, highest first, and
 * deduped to the highest-bitrate variant per quality. Audio is ordered by
 * bitrate descending and labelled with bitrate and codec. Only formats that
 * actually exist show.
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

  // Highest quality first: walk the standard ladder in reverse.
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

  keyboard.text('❌ Cancel', 'abort');
  return keyboard;
}

/**
 * Current API.
 *
 * buildCancelKeyboard: single cancel button for an in-flight download job.
 */
export function buildCancelKeyboard(jobId: string): InlineKeyboard {
  return new InlineKeyboard().text('✖ Cancel download', `cancel:${jobId}`);
}

/**
 * Alias kept for the progress reporter, which imports buildProgressKeyboard.
 * Delegates to buildCancelKeyboard so there is a single implementation.
 */
export function buildProgressKeyboard(jobId: string): InlineKeyboard {
  return buildCancelKeyboard(jobId);
}

/**
 * Backward-compatible wrappers.
 *
 * The module was refactored to buildKindKeyboard / buildFormatKeyboard. These
 * wrappers restore the original three exports so existing callers and tests
 * keep working. They only delegate to the current API; no logic is duplicated
 * and no behaviour changes.
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
