import path from 'node:path';
import {
  DownloadArtifact,
  DownloadRequest,
  MediaFormat,
  MediaMetadata,
  MediaProbe,
  SupportedPlatform,
} from '../../types/media';
import { MediaProvider } from '../../types/provider';
import { YtDlpClient } from '../../downloader/YtDlpClient';
import { normalizeUrl } from '../../utils/url';
import { resolveMediaType } from '../../telegram/mediaType';

interface RawFormat {
  format_id?: string;
  ext?: string;
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

interface RawMetadata {
  id: string;
  title: string;
  description?: string;
  duration?: number;
  uploader?: string;
  thumbnail?: string;
  webpage_url?: string;
  filesize?: number;
  formats?: RawFormat[];
}

/**
 * BaseYtDlpProvider handles metadata extraction and raw download only.
 * It never touches Telegram. It returns a DownloadArtifact that the Telegram
 * Storage Engine consumes. Every provider inherits this contract.
 */
export abstract class BaseYtDlpProvider implements MediaProvider {
  abstract readonly platform: SupportedPlatform;

  constructor(protected readonly ytDlpClient: YtDlpClient) {}

  abstract supports(url: string): boolean;

  async getMetadata(url: string): Promise<MediaMetadata> {
    const raw = (await this.ytDlpClient.extract(url)) as RawMetadata;
    const formats = (raw.formats ?? [])
      .filter((format) => format.format_id && format.ext)
      .map((format) => this.mapFormat(format))
      .filter((format, index, collection) => collection.findIndex((item) => item.id === format.id) === index);

    return {
      id: raw.id,
      provider: this.platform,
      originalUrl: url,
      canonicalUrl: normalizeUrl(raw.webpage_url ?? url),
      title: raw.title,
      description: raw.description,
      duration: raw.duration,
      thumbnail: raw.thumbnail,
      uploader: raw.uploader,
      filesize: raw.filesize,
      formats,
    };
  }

  async download(request: DownloadRequest): Promise<DownloadArtifact> {
    const metadata = await this.getMetadata(request.url);
    const format = metadata.formats.find((item) => item.id === request.formatId);
    if (!format) {
      throw new Error('selected format is unavailable');
    }

    const outputDir = path.join(process.cwd(), 'tmp', String(request.userId), metadata.id, format.id);
    const filePath = await this.ytDlpClient.download(request.url, format.id, outputDir);
    const mimeType = this.resolveMimeType(format);

    const probe: MediaProbe = {
      mediaType: resolveMediaType({
        kind: format.kind,
        extension: format.extension,
        duration: metadata.duration,
        mimeType,
      }),
      resolution: format.width && format.height ? `${format.width}x${format.height}` : format.quality,
      width: format.width,
      height: format.height,
      fps: format.fps,
      bitrate: format.bitrate,
      codec: format.kind === 'audio' ? format.audioCodec : format.videoCodec,
      size: format.filesize,
    };

    return {
      filePath,
      fileName: path.basename(filePath),
      mimeType,
      quality: format.quality,
      checksum: '',
      probe,
      metadata,
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  private mapFormat(format: RawFormat): MediaFormat {
    const isAudio = format.vcodec === 'none';
    const quality = format.resolution ?? format.format_note ?? format.ext ?? 'unknown';
    const bitrate = format.vbr ?? format.abr ?? format.tbr;

    return {
      id: format.format_id ?? 'unknown',
      kind: isAudio ? 'audio' : 'video',
      label: `${isAudio ? 'Audio' : 'Video'} ${quality}`,
      extension: format.ext ?? 'bin',
      quality,
      filesize: format.filesize ?? format.filesize_approx,
      width: format.width,
      height: format.height,
      fps: format.fps,
      bitrate: bitrate ? Math.round(bitrate * 1000) : undefined,
      audioCodec: format.acodec && format.acodec !== 'none' ? format.acodec : undefined,
      videoCodec: format.vcodec && format.vcodec !== 'none' ? format.vcodec : undefined,
    };
  }

  private resolveMimeType(format: MediaFormat): string {
    if (format.kind === 'audio') {
      return format.extension === 'mp3' ? 'audio/mpeg' : `audio/${format.extension}`;
    }
    return format.extension === 'mp4' ? 'video/mp4' : `video/${format.extension}`;
  }
}
