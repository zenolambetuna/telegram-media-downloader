import { InlineKeyboard } from 'grammy';
import { MediaFormat } from '../types/media';

const VIDEO_LADDER = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];

/**
 * Builds the top-level Video / Audio / Cancel keyboard. Only kinds that
 * actually have formats are shown.
 */
export function buildKindKeyboard(formats: MediaFormat[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (formats.some((format) => format.kind === 'video')) {
    keyboard.text('🎬 Video', 'kind:video');
  }
  if (formats.some((format) => format.kind === 'audio')) {
    keyboard.text('🎵 Audio', 'kind:audio');
  }
  keyboard.row().text('❌ Cancel', 'abort');
  return keyboard;
}

/**
 * Builds a quality keyboard for the chosen kind. Formats are referenced by
 * their index in the session-held metadata list to keep callback_data tiny.
 * Only qualities that actually exist are displayed, ordered by the standard
 * ladder for video and by bitrate for audio.
 */
export function buildFormatKeyboard(formats: MediaFormat[], kind: 'video' | 'audio'): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const entries = formats
    .map((format, index) => ({ format, index }))
    .filter((entry) => entry.format.kind === kind);

  if (kind === 'video') {
    entries.sort((a, b) => VIDEO_LADDER.indexOf(a.format.quality) - VIDEO_LADDER.indexOf(b.format.quality));
  } else {
    entries.sort((a, b) => (b.format.bitrate ?? 0) - (a.format.bitrate ?? 0));
  }

  for (const entry of entries) {
    const size = entry.format.filesize ? ` · ${Math.round(entry.format.filesize / 1024 / 1024)}MB` : '';
    const label = kind === 'video'
      ? `${entry.format.quality}${size}`
      : `${entry.format.label}${size}`;
    keyboard.text(label, `fmt:${entry.index}`).row();
  }

  keyboard.text('⬅️ Back', 'back').text('❌ Cancel', 'abort');
  return keyboard;
}

/** Cancel keyboard shown on the live progress message. */
export function buildCancelKeyboard(jobToken: string): InlineKeyboard {
  return new InlineKeyboard().text('🛑 Cancel download', `cancel:${jobToken}`);
}
