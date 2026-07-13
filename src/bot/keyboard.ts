import { InlineKeyboard } from 'grammy';
import { MediaFormat } from '../types/media';

const VIDEO_QUALITY_ORDER = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'best'];

function humanSize(bytes?: number): string {
  if (!bytes) {
    return '';
  }
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? ` (${mb.toFixed(0)} MB)` : ` (${(bytes / 1024).toFixed(0)} KB)`;
}

/**
 * Builds the top-level Video / Audio / Cancel keyboard. Only shows a kind if
 * the engine actually returned formats of that kind.
 */
export function buildKindKeyboard(formats: MediaFormat[], jobId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (formats.some((format) => format.kind === 'video')) {
    keyboard.text('🎬 Video', `kind:video:${jobId}`);
  }
  if (formats.some((format) => format.kind === 'audio')) {
    keyboard.text('🎵 Audio', `kind:audio:${jobId}`);
  }
  keyboard.row().text('❌ Cancel', `cancel:${jobId}`);
  return keyboard;
}

/**
 * Builds the per-quality keyboard for the chosen kind. Video is sorted along
 * the standard quality ladder; audio is sorted by bitrate. Only real formats
 * are shown, so no fake qualities ever appear.
 */
export function buildFormatKeyboard(
  formats: MediaFormat[],
  kind: 'video' | 'audio',
  jobId: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const filtered = formats.filter((format) => format.kind === kind);

  const sorted =
    kind === 'video'
      ? filtered.sort(
          (a, b) => VIDEO_QUALITY_ORDER.indexOf(a.quality) - VIDEO_QUALITY_ORDER.indexOf(b.quality),
        )
      : filtered.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

  for (const format of sorted) {
    const label = kind === 'video' ? format.quality : format.label;
    keyboard.text(`${label}${humanSize(format.filesize)}`, `fmt:${format.id}:${jobId}`).row();
  }

  keyboard.text('❌ Cancel', `cancel:${jobId}`);
  return keyboard;
}
