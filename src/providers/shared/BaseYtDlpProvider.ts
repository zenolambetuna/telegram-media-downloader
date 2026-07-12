import path from 'node:path';
import { DownloadRequest, DownloadResult, MediaFormat, MediaMetadata, SupportedPlatform } from '../../types/media';
import { MediaProvider } from '../../types/provider';
import { YtDlpClient } from '../../core/YtDlpClient';
import { normalizeUrl } from '../../utils/url';

interface RawYtDlpFormat {
  format_id?: string;
  ext?: string;
  filesize?: number;
  format_note?: string;
  acodec?: string;
  vcodec?: string;
  resolution?: string;
}

interface RawYtDlpMetadata {
  id: string;
  title: string;
  duration?: number;
  uploader?: string;
  thumbnail?: string;
  webpage_url?: string;
  formats?: RawYtDlpFormat[];
}

export abstract class BaseYtDlpProvider implements MediaProvider {
  abstract readonly platform: SupportedPlatform;

  constructor(protected readonly ytDlpClient: YtDlpClient) {}

  abstract supports(url: string): boolean;

  async getMetadata(url: string): Promise<MediaMetadata> {
    const raw = (await this.ytDlpClient.fetchJson(url)) as RawYtDlpMetadata;
    const formats = (raw.formats ?? [])
      .filter((format) => format.format_id && format.ext)
      .map((format) => this.mapFormat(format));

    return {
      id: raw.id,
      originalUrl: url,
      canonicalUrl: normalizeUrl(raw.webpage_url ?? url),
      platform: this.platform,
      title: raw.title,
      duration: raw.duration,
      uploader: raw.uploader,
      thumbnail: raw.thumbnail,
      webpageUrl: raw.webpage_url,
      formats,
    };
  }

  async download(request: DownloadRequest): Promise<DownloadResult> {
    const metadata = await this.getMetadata(request.url);
    const selected = metadata.formats.find((format) => format.id === request.formatId);
    if (!selected) {
      throw new Error('Requested format is not available');
    }

    const outputDir = path.join(process.cwd(), 'tmp', String(request.userId), metadata.id);
    const filePath = await this.ytDlpClient.download(request.url, request.formatId, outputDir);

    return {
      filePath,
      fileName: path.basename(filePath),
      mimeType: this.inferMimeType(selected),
      quality: selected.quality ?? selected.label,
      title: metadata.title,
      thumbnail: metadata.thumbnail,
      duration: metadata.duration,
      platform: this.platform,
      originalUrl: request.url,
    };
  }

  private mapFormat(format: RawYtDlpFormat): MediaFormat {
    const isAudioOnly = format.vcodec === 'none';
    const quality = format.resolution ?? format.format_note ?? format.ext ?? 'unknown';

    return {
      id: format.format_id ?? 'unknown',
      label: `${isAudioOnly ? 'Audio' : 'Video'} ${quality}`,
      extension: format.ext ?? 'bin',
      kind: isAudioOnly ? 'audio' : 'video',
      quality,
      filesize: format.filesize,
      formatNote: format.format_note,
      audioCodec: format.acodec,
      videoCodec: format.vcodec,
    };
  }

  private inferMimeType(format: MediaFormat): string {
    if (format.kind === 'audio') {
      if (format.extension === 'mp3') {
        return 'audio/mpeg';
      }
      return `audio/${format.extension}`;
    }
    if (format.extension === 'mp4') {
      return 'video/mp4';
    }
    return `video/${format.extension}`;
  }
}
