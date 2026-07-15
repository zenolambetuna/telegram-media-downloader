import { ResolvedMediaInfo } from '../types/media';
import { normalizeUrl, resolveTikTokShortUrl } from '../utils/url';
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
    // Resolve TikTok short URLs (vt.tiktok.com, vm.tiktok.com) BEFORE passing to yt-dlp.
    // yt-dlp often fails with "Video not available" on short URLs because it cannot
    // follow the redirect properly through Cloudflare protection.
    const resolvedUrl = await resolveTikTokShortUrl(url);
    if (resolvedUrl !== url) {
      logger.info({ original: url, resolved: resolvedUrl }, 'TikTok short URL resolved');
    }

    const raw = (await withTimeout(
      this.ytDlpClient.extract(resolvedUrl),
      config.PROVIDER_TIMEOUT_MS,
      'metadata timeout',
    )) as RawMetadata;

    const isLive = Boolean(raw.is_live) || raw.live_status === 'is_live';
    if (isLive) {
      throw Object.assign(new Error('Live streams are not downloadable yet'), { code: 'LIVE_STREAM' });
    }

    const platform = provider || raw.extractor_key?.toLowerCase() || 'unknown';
    const title = raw.title || 'Untitled';
    const canonicalUrl = normalizeUrl(raw.webpage_url ?? resolvedUrl);

    const resolved = this.formatResolver.resolve(
      (raw.formats ?? []) as never[],
      platform,
      title,
      resolvedUrl,
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