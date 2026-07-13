import { InlineKeyboard } from 'grammy';
import { NormalizedFormat } from '../types/download';

/**
 * Builds the top-level Video / Audio / Cancel keyboard, only showing a section
 * when the engine actually returned formats of that kind.
 */
export function buildKindKeyboard(formats: NormalizedFormat[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (formats.some((format) => format.kind === 'video')) {
    keyboard.text('🎬 Video', 'choose:video');
  }
  if (formats.some((format) => format.kind === 'audio')) {
    keyboard.text('🎵 Audio', 'choose:audio');
  }
  keyboard.row().text('❌ Cancel', 'cancel:pending');
  return keyboard;
}

function megabytes(bytes?: number): string {
  if (!bytes) {
    return '';
  }
  return ` · ${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;
}

/**
 * Builds a quality keyboard for the chosen kind. Video formats are ordered by
 * the standardized quality ladder the engine already produced. Only qualities
 * that actually exist are shown.
 */
export function buildFormatKeyboard(formats: NormalizedFormat[], kind: 'video' | 'audio'): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const filtered = formats.filter((format) => format.kind === kind);

  for (const format of filtered) {
    const label =
      kind === 'video'
        ? `${format.quality}${format.fps && format.fps > 30 ? ` ${Math.round(format.fps)}fps` : ''}${megabytes(format.filesize)}`
        : `${format.label}${megabytes(format.filesize)}`;
    keyboard.text(label.trim(), `format:${format.id}`).row();
  }

  keyboard.text('❌ Cancel', 'cancel:pending');
  return keyboard;
}

/**
 * A single Cancel button attached to a live progress message, carrying the job
 * id so the handler can target the exact running job.
 */
export function buildCancelKeyboard(jobId: string): InlineKeyboard {
  return new InlineKeyboard().text('❌ Cancel', `cancel:job:${jobId}`);
}
