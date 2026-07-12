import { MediaProbe, MediaType } from '../types/media';

const PHOTO_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const ANIMATION_EXTENSIONS = new Set(['gif']);
const VOICE_EXTENSIONS = new Set(['ogg', 'oga', 'opus']);
const STICKER_EXTENSIONS = new Set(['tgs', 'webm']);

export function resolveMediaType(params: {
  kind: 'video' | 'audio';
  extension: string;
  duration?: number;
  mimeType: string;
}): MediaType {
  const ext = params.extension.toLowerCase();

  if (params.kind === 'audio') {
    if (VOICE_EXTENSIONS.has(ext) && (params.duration ?? 0) > 0 && (params.duration ?? 0) <= 60) {
      return 'voice';
    }
    return 'audio';
  }

  if (PHOTO_EXTENSIONS.has(ext) && !params.duration) {
    return 'photo';
  }

  if (ANIMATION_EXTENSIONS.has(ext)) {
    return 'animation';
  }

  if (STICKER_EXTENSIONS.has(ext) && params.mimeType.includes('sticker')) {
    return 'sticker';
  }

  if (params.mimeType.startsWith('video/')) {
    return 'video';
  }

  return 'document';
}

export function isProbablyLargeForTelegram(probe: MediaProbe, limitBytes: number): boolean {
  return (probe.size ?? 0) > limitBytes;
}
