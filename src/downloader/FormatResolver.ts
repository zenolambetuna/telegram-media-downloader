import { NormalizedFormat, QualityLabel } from '../types/download';

interface RawFormat {
  format_id?: string;
  ext?: string;
  container?: string;
  filesize?: number;
  filesize_approx?: number;
  format_note?: string;
  acodec?: string;
  vcodec?: string;
  resolution?: string;
  width?: number;
  height?: number;
  fps?: number;
  tbr?: number;
  vbr?: number;
  abr?: number;
}

const HEIGHT_TO_QUALITY: Array<{ maxHeight: number; label: QualityLabel }> = [
  { maxHeight: 144, label: '144p' },
  { maxHeight: 240, label: '240p' },
  { maxHeight: 360, label: '360p' },
  { maxHeight: 480, label: '480p' },
  { maxHeight: 720, label: '720p' },
  { maxHeight: 1080, label: '1080p' },
  { maxHeight: 1440, label: '1440p' },
  { maxHeight: 2160, label: '2160p' },
];

/**
 * FormatResolver converts the raw yt-dlp format list into a standardized,
 * normalized set of formats. Providers never see raw yt-dlp fields.
 */
export class FormatResolver {
  resolve(rawFormats: RawFormat[]): NormalizedFormat[] {
    const normalized = rawFormats
      .filter((format) => format.format_id && format.ext)
      .map((format) => this.normalize(format))
      .filter((format, index, all) => all.findIndex((item) => item.id === format.id) === index);

    return this.dedupeByQuality(normalized);
  }

  private normalize(format: RawFormat): NormalizedFormat {
    const hasVideo = Boolean(
      format.vcodec && format.vcodec !== 'none',
    ) || Boolean(format.width && format.height);
    const hasAudio = Boolean(format.acodec && format.acodec !== 'none');
    const kind: 'video' | 'audio' = hasVideo && !hasAudio ? 'video' : 'audio';
    // Use height for horizontal videos, width for vertical videos to get correct quality label
    const dimension = format.width && format.height
      ? format.width > format.height
        ? format.height
        : format.width
      : format.height || format.width;
    const quality = this.mapQuality(kind, dimension);
    const bitrateKbps = format.vbr ?? format.abr ?? format.tbr;

    // TikTok/vertical videos: dimensions may exist even if vcodec is blank/unknown.
    // Treat any format with both width+height as video-capable unless audio is present.
    const resolvedHasVideo = hasVideo || Boolean(format.width && format.height);
    const resolvedHasAudio = hasAudio;
    const resolvedKind: 'video' | 'audio' = resolvedHasVideo && !resolvedHasAudio ? 'video' : 'audio';

    return {
      id: format.format_id ?? 'unknown',
      kind: resolvedKind,
      quality,
      label: resolvedKind === 'audio' ? `Audio ${format.abr ? `${Math.round(format.abr)}kbps` : format.ext ?? ''}`.trim() : quality,
      container: format.container ?? format.ext ?? 'bin',
      extension: format.ext ?? 'bin',
      resolution: format.width && format.height ? `${format.width}x${format.height}` : format.resolution,
      width: format.width,
      height: format.height,
      fps: format.fps,
      bitrate: bitrateKbps ? Math.round(bitrateKbps * 1000) : undefined,
      videoCodec: resolvedHasVideo ? format.vcodec : undefined,
      audioCodec: resolvedHasAudio ? format.acodec : undefined,
      filesize: format.filesize ?? format.filesize_approx,
      hasAudio: resolvedHasAudio,
      hasVideo: resolvedHasVideo,
    };
  }

  private mapQuality(kind: 'video' | 'audio', height?: number): QualityLabel {
    if (kind === 'audio') {
      return 'audio';
    }
    if (!height) {
      return 'best';
    }
    for (const entry of HEIGHT_TO_QUALITY) {
      if (height <= entry.maxHeight) {
        return entry.label;
      }
    }
    return '2160p';
  }

  private dedupeByQuality(formats: NormalizedFormat[]): NormalizedFormat[] {
    const bestByKey = new Map<string, NormalizedFormat>();
    const videoFormats = formats.filter((format) => format.kind === 'video');
    const audioFormats = formats.filter((format) => format.kind === 'audio');

    for (const format of formats) {
      const key = `${format.kind}:${format.quality}`;
      const existing = bestByKey.get(key);
      if (!existing || (format.bitrate ?? 0) > (existing.bitrate ?? 0)) {
        bestByKey.set(key, format);
      }
    }

    const deduped = [...bestByKey.values()].sort((left, right) => (right.height ?? 0) - (left.height ?? 0));
    return deduped;
  }
}
