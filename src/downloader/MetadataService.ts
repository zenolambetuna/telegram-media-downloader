import { EngineMetadata } from '../types/download';
import { MediaMetadata, SupportedPlatform } from '../types/media';
import { normalizeUrl } from '../utils/url';
import { withTimeout } from '../utils/time';
import { config } from '../config/env';
import { FormatResolver } from './FormatResolver';
import { YtDlpClient } from './YtDlpClient';

interface RawMetadata {
  id?: string;
  title?: string;
  description?: string;
  duration?: number;
  uploader?: string;
  thumbnail?: string;
  webpage_url?: string;
  filesize?: number;
  is_live?: boolean;
  live_status?: string;
  _type?: string;
  formats?: unknown[];
}

/**
 * MetadataService extracts and standardizes metadata. It detects live streams
 * and playlists and delegates format normalization to FormatResolver.
 */
export class MetadataService {
  constructor(
    private readonly ytDlpClient: YtDlpClient,
    private readonly formatResolver: FormatResolver,
  ) {}

  async fetch(url: string, provider: SupportedPlatform): Promise<EngineMetadata> {
    const raw = (await withTimeout(
      this.ytDlpClient.extract(url),
      config.PROVIDER_TIMEOUT_MS,
      'metadata timeout',
    )) as RawMetadata;

    // DEBUG: Log raw yt-dlp formats before FormatResolver
    const rawFormatsBeforeResolver = (raw.formats ?? []) as Array<{
      format_id?: string;
      ext?: string;
      vcodec?: string;
      acodec?: string;
      width?: number;
      height?: number;
      protocol?: string;
      filesize?: number;
      filesize_approx?: number;
      format_note?: string;
      tbr?: number;
      vbr?: number;
      abr?: number;
    }>;
    console.log('[DEBUG] RAW formats BEFORE FormatResolver (COMPLETE):', JSON.stringify(rawFormatsBeforeResolver, null, 2));

    const formatResolverOutput = this.formatResolver.resolve((raw.formats ?? []) as never[]);
    const formats = formatResolverOutput;

    // DEBUG: Log FormatResolver output
    console.log('[DEBUG] FormatResolver.resolve() output:', {
      total: formats.length,
      video: formats.filter(f => f.kind === 'video').length,
      audio: formats.filter(f => f.kind === 'audio').length,
      samples: formats.map(f => ({ id: f.id, kind: f.kind, quality: f.quality, hasVideo: f.hasVideo, hasAudio: f.hasAudio }))
    });

    const isLive = Boolean(raw.is_live) || raw.live_status === 'is_live';
    const isPlaylist = raw._type === 'playlist';

    const mappedFormats = formats.map((format) => ({
      id: format.id,
      kind: format.kind,
      label: format.label,
      extension: format.extension,
      quality: format.quality,
      filesize: format.filesize,
      width: format.width,
      height: format.height,
      fps: format.fps,
      bitrate: format.bitrate,
      audioCodec: format.audioCodec,
      videoCodec: format.videoCodec,
    }));

    // DEBUG: Log mapped MediaFormat[]
    console.log('[DEBUG] Mapped MediaFormat[]:', {
      total: mappedFormats.length,
      video: mappedFormats.filter(f => f.kind === 'video').length,
      audio: mappedFormats.filter(f => f.kind === 'audio').length,
      types: mappedFormats.map(f => ({ id: f.id, kind: f.kind, quality: f.quality }))
    });

    const metadata: MediaMetadata = {
      id: raw.id ?? 'unknown',
      provider,
      originalUrl: url,
      canonicalUrl: normalizeUrl(raw.webpage_url ?? url),
      title: raw.title ?? 'Untitled',
      description: raw.description,
      duration: raw.duration,
      thumbnail: raw.thumbnail,
      uploader: raw.uploader,
      filesize: raw.filesize,
      formats: mappedFormats,
    };

    return { metadata, formats, isLive, isPlaylist };
  }
}
