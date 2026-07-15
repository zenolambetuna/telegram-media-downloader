import { logger } from '../logger/logger';
import { MediaFormat, ResolvedMediaInfo } from '../types/media';
import { NormalizedFormat, QualityLabel } from '../types/download';

const VIDEO_LADDER = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];

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
 * FormatResolver — single pipeline stage that:
 * 1. Takes raw yt-dlp formats
 * 2. Normalizes each into MediaFormat with correct kind (video/audio)
 * 3. Deduplicates by quality
 * 4. Returns a ResolvedMediaInfo with clear hasVideo/hasAudio/supportsResolutionSelection
 */
export class FormatResolver {
  resolve(rawFormats: RawFormat[], platform: string, title: string, url: string): ResolvedMediaInfo {
    const valid = rawFormats.filter((f) => f.format_id && f.ext);
    const allNormalized: MediaFormat[] = valid.map((f) => this.normalize(f));
    const unique: MediaFormat[] = allNormalized.filter(
      (f, i, arr) => arr.findIndex((x) => x.id === f.id) === i,
    );
    const videoFormats = unique.filter((f) => f.kind === 'video');
    const audioFormats = unique.filter((f) => f.kind === 'audio');
    const dedupedVideos = this.dedupeVideoByQuality(videoFormats);
    const dedupedAudios = audioFormats;
    const uniqueQualities = new Set(dedupedVideos.map((f) => f.quality));
    const supportsResolutionSelection = uniqueQualities.size > 1;
    const bestVideo = dedupedVideos.length > 0
      ? this.pickBestVideo(dedupedVideos)
      : undefined;
    const bestAudio = dedupedAudios.length > 0
      ? this.pickBestAudio(dedupedAudios)
      : undefined;
    const hasVideo = dedupedVideos.length > 0;
    const hasAudio = dedupedAudios.length > 0;

    logger.info(
      { platform, hasVideo, hasAudio, videoFormatsCount: dedupedVideos.length, audioFormatsCount: dedupedAudios.length, supportsResolutionSelection, qualities: [...uniqueQualities] },
      'FormatResolver resolved',
    );

    return {
      platform,
      title,
      originalUrl: url,
      canonicalUrl: url,
      hasVideo,
      hasAudio,
      videoFormats: dedupedVideos,
      audioFormats: dedupedAudios,
      bestVideo,
      bestAudio,
      supportsResolutionSelection,
    };
  }

  private normalize(format: RawFormat): MediaFormat {
    const hasVideoSignal =
      Boolean(format.vcodec && format.vcodec !== 'none') ||
      Boolean(format.width && format.height);
    const hasAudioSignal = Boolean(format.acodec && format.acodec !== 'none');
    const isVideo = hasVideoSignal;
    const isAudio = !hasVideoSignal && hasAudioSignal;
    const kind: 'video' | 'audio' = isVideo ? 'video' : 'audio';
    const dimension =
      format.width && format.height
        ? format.width > format.height
          ? format.height
          : format.width
        : format.height || format.width;
    const quality = this.mapQuality(kind, dimension);
    const bitrateKbps = format.vbr ?? format.abr ?? format.tbr;
    const label =
      kind === 'audio'
        ? `Audio ${format.abr ? `${Math.round(format.abr)}kbps` : format.ext ?? ''}`.trim()
        : quality;

    return {
      id: format.format_id ?? 'unknown',
      kind,
      quality,
      label,
      extension: format.ext ?? 'bin',
      width: format.width,
      height: format.height,
      fps: format.fps,
      bitrate: bitrateKbps ? Math.round(bitrateKbps * 1000) : undefined,
      videoCodec: isVideo ? format.vcodec : undefined,
      audioCodec: isAudio ? format.acodec : undefined,
      filesize: format.filesize ?? format.filesize_approx,
    };
  }

  private mapQuality(kind: 'video' | 'audio', height?: number): QualityLabel {
    if (kind === 'audio') return 'audio';
    if (!height) return 'best';
    for (const entry of HEIGHT_TO_QUALITY) {
      if (height <= entry.maxHeight) return entry.label;
    }
    return '2160p';
  }

  private dedupeVideoByQuality(formats: MediaFormat[]): MediaFormat[] {
    const bestByQuality = new Map<string, MediaFormat>();
    for (const f of formats) {
      const existing = bestByQuality.get(f.quality);
      if (!existing || (f.bitrate ?? 0) > (existing.bitrate ?? 0)) {
        bestByQuality.set(f.quality, f);
      }
    }
    return [...bestByQuality.values()].sort((a, b) => {
      const aIdx = VIDEO_LADDER.indexOf(a.quality);
      const bIdx = VIDEO_LADDER.indexOf(b.quality);
      if (aIdx !== bIdx) return bIdx - aIdx;
      return (b.bitrate ?? 0) - (a.bitrate ?? 0);
    });
  }

  private pickBestVideo(formats: MediaFormat[]): MediaFormat {
    return formats.reduce((best, current) => {
      const bestRank = VIDEO_LADDER.indexOf(best.quality);
      const currentRank = VIDEO_LADDER.indexOf(current.quality);
      if (currentRank > bestRank) return current;
      if (currentRank === bestRank && (current.bitrate ?? 0) > (best.bitrate ?? 0))
        return current;
      return best;
    });
  }

  private pickBestAudio(formats: MediaFormat[]): MediaFormat {
    return formats.reduce((best, current) =>
      (current.bitrate ?? 0) > (best.bitrate ?? 0) ? current : best,
    );
  }

  resolveLegacy(rawFormats: RawFormat[]): NormalizedFormat[] {
    const normalized = rawFormats
      .filter((format) => format.format_id && format.ext)
      .map((f) => this.normalizeLegacy(f))
      .filter((f, i, all) => all.findIndex((x) => x.id === f.id) === i);
    return this.dedupeLegacy(normalized);
  }

  private normalizeLegacy(format: RawFormat): NormalizedFormat {
    const hasVideo = Boolean(format.vcodec && format.vcodec !== 'none') || Boolean(format.width && format.height);
    const hasAudio = Boolean(format.acodec && format.acodec !== 'none');
    const resolvedHasVideo = hasVideo || Boolean(format.width && format.height);
    const resolvedKind: 'video' | 'audio' = resolvedHasVideo ? 'video' : 'audio';
    const dimension = format.width && format.height
      ? format.width > format.height ? format.height : format.width
      : format.height || format.width;
    const quality = this.mapQuality(resolvedKind as any, dimension);
    const bitrateKbps = format.vbr ?? format.abr ?? format.tbr;
    return {
      id: format.format_id ?? 'unknown',
      kind: resolvedKind,
      quality,
      label: resolvedKind === 'audio' ? `Audio ${format.abr ? `${Math.round(format.abr)}kbps` : format.ext ?? ''}`.trim() : quality,
      container: format.container ?? format.ext ?? 'bin',
      extension: format.ext ?? 'bin',
      resolution: format.width && format.height ? `${format.width}x${format.height}` : format.resolution,
      width: format.width, height: format.height,
      fps: format.fps,
      bitrate: bitrateKbps ? Math.round(bitrateKbps * 1000) : undefined,
      videoCodec: resolvedHasVideo ? format.vcodec : undefined,
      audioCodec: hasAudio ? format.acodec : undefined,
      filesize: format.filesize ?? format.filesize_approx,
      hasAudio, hasVideo: resolvedHasVideo,
    };
  }

  private dedupeLegacy(formats: NormalizedFormat[]): NormalizedFormat[] {
    const bestByKey = new Map<string, NormalizedFormat>();
    const videoF = formats.filter((f) => f.kind === 'video');
    const audioF = formats.filter((f) => f.kind === 'audio');
    for (const f of videoF) {
      const key = `video:${f.quality}`;
      const existing = bestByKey.get(key);
      if (!existing || (f.bitrate ?? 0) > (existing.bitrate ?? 0)) bestByKey.set(key, f);
    }
    for (const f of audioF) bestByKey.set(`audio:${f.id}`, f);
    return [...bestByKey.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1;
      return (b.height ?? 0) - (a.height ?? 0);
    });
  }
}
