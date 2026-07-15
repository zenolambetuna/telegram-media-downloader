import { ResolvedMediaInfo } from '../types/media';
import { normalizeUrl } from '../utils/url';
import { withTimeout } from '../utils/time';
import { config } from '../config/env';
import { FormatResolver } from './FormatResolver';
import { YtDlpClient } from './YtDlpClient';
import { logger } from '../logger/logger';

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
  extractor?: string;
  extractor_key?: string;
}

export class MetadataService {
  constructor(
    private readonly ytDlpClient: YtDlpClient,
    private readonly formatResolver: FormatResolver,
  ) {}

  async fetch(url: string, provider: string): Promise<ResolvedMediaInfo> {
    const raw = (await withTimeout(
      this.ytDlpClient.extract(url),
      config.PROVIDER_TIMEOUT_MS,
      'metadata timeout',
    )) as RawMetadata;

    const isLive = Boolean(raw.is_live) || raw.live_status === 'is_live';
    if (isLive) {
      throw Object.assign(new Error('Live streams are not downloadable yet'), { code: 'LIVE_STREAM' });
    }

    const platform = provider || raw.extractor_key?.toLowerCase() || 'unknown';
    const title = raw.title || 'Untitled';
    const canonicalUrl = normalizeUrl(raw.webpage_url ?? url);

    const resolved = this.formatResolver.resolve(
      (raw.formats ?? []) as never[],
      platform,
      title,
      url,
    );

    resolved.canonicalUrl = canonicalUrl;
    resolved.description = raw.description;
    resolved.duration = raw.duration;
    resolved.thumbnail = raw.thumbnail;
    resolved.uploader = raw.uploader;

    logger.info(
      {
        platform: resolved.platform,
        hasVideo: resolved.hasVideo,
        hasAudio: resolved.hasAudio,
        videoCount: resolved.videoFormats.length,
        audioCount: resolved.audioFormats.length,
        supportsResolutionSelection: resolved.supportsResolutionSelection,
        title: resolved.title,
      },
      'MetadataService resolved',
    );

    return resolved;
  }
}
