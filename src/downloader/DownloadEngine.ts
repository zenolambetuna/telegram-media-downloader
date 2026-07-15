import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { AppError } from '../types/errors';
import {
  EngineDownloadRequest,
  EngineDownloadResult,
  NormalizedFormat,
} from '../types/download';
import { MediaProbe, ResolvedMediaInfo } from '../types/media';
import { assertValidUrl } from '../utils/url';
import { withRetry } from '../utils/retry';
import { resolveMediaType } from '../telegram/mediaType';
import { ChecksumService } from './ChecksumService';
import { FFmpegService } from './FFmpegService';
import { MetadataService } from './MetadataService';
import { ProgressTracker } from './ProgressTracker';
import { TempFileManager } from './TempFileManager';
import { YtDlpClient } from './YtDlpClient';

export class DownloadEngine {
  constructor(
    private readonly metadataService: MetadataService,
    private readonly ytDlpClient: YtDlpClient,
    private readonly ffmpegService: FFmpegService,
    private readonly checksumService: ChecksumService,
    private readonly tempFileManager: TempFileManager,
  ) {}

  async inspect(url: string, provider: string): Promise<ResolvedMediaInfo> {
    assertValidUrl(url);
    return await this.metadataService.fetch(url, provider);
  }

  async download(request: EngineDownloadRequest): Promise<EngineDownloadResult> {
    assertValidUrl(request.url);
    const jobId = randomUUID();
    const tracker = new ProgressTracker(jobId);
    if (request.onProgress) {
      tracker.subscribe(request.onProgress);
    }

    const workspace = await this.tempFileManager.createWorkspace(request.userId, jobId);

    try {
      tracker.setStage('fetching_metadata');
      const info: ResolvedMediaInfo = await this.inspect(request.url, request.provider);

      tracker.setStage('resolving_formats');
      const allFormats = [...info.videoFormats, ...info.audioFormats];
      const format = this.selectFormat(allFormats as any, request.formatId);
      const nf = this.toNormalized(format as any);

      tracker.setStage('downloading');
      const mediaPath = await this.acquireMedia(request, allFormats as any, format as any, workspace, tracker);

      tracker.setStage('processing');
      const thumbnailPath = await this.ffmpegService.extractThumbnail(mediaPath, workspace);

      const checksum = await this.checksumService.generate(mediaPath);
      const mimeType = this.resolveMimeType(format as any);
      const probe = this.buildProbe(nf, mimeType, info.duration);

      tracker.setStage('finished');

      return {
        filePath: mediaPath,
        fileName: path.basename(mediaPath),
        mimeType,
        quality: format.quality,
        checksum,
        probe,
        metadata: {
          id: info.canonicalUrl || 'unknown',
          provider: info.platform,
          originalUrl: info.originalUrl,
          canonicalUrl: info.canonicalUrl,
          title: info.title,
          description: info.description,
          duration: info.duration,
          thumbnail: info.thumbnail,
          uploader: info.uploader,
          filesize: format.filesize,
          formats: allFormats,
        },
        thumbnailPath,
      };
    } catch (error) {
      await this.tempFileManager.cleanWorkspace(workspace);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Download failed', 'DOWNLOAD_FAILED', error);
    }
  }

  async recoverOrphans(): Promise<number> {
    return await this.tempFileManager.recoverOrphans(6 * 60 * 60 * 1000);
  }

  private selectFormat(formats: { id: string; kind: string }[], formatId: string): { id: string; kind: string; quality: string; filesize?: number; extension?: string; width?: number; height?: number; fps?: number; bitrate?: number; hasVideo?: boolean; hasAudio?: boolean } {
    const format = formats.find((item) => item.id === formatId);
    if (!format) {
      throw new AppError('Requested format is not available', 'UNSUPPORTED_FORMAT');
    }
    return format as any;
  }

  private async acquireMedia(
    request: EngineDownloadRequest,
    formats: { id: string; kind: string; quality: string; hasVideo?: boolean; hasAudio?: boolean; extension?: string }[],
    format: { id: string; kind: string; quality: string; hasVideo?: boolean; hasAudio?: boolean; extension?: string },
    workspace: string,
    tracker: ProgressTracker,
  ): Promise<string> {
    const download = (formatId: string): Promise<string> =>
      withRetry('engine-download', config.DOWNLOAD_RETRY_ATTEMPTS, () =>
        this.ytDlpClient.downloadFormat(request.url, formatId, workspace),
      );

    if (format.hasVideo === true && format.hasAudio === false) {
      const audioFormat = formats
        .filter((f) => (f as any).hasAudio && !(f as any).hasVideo)
        .sort((a, b) => ((b as any).bitrate ?? 0) - ((a as any).bitrate ?? 0))[0];
      if (audioFormat) {
        const videoPath = await download(format.id);
        const audioPath = await download(audioFormat.id);
        tracker.setStage('merging');
        const mergedPath = path.join(workspace, `merged-${request.provider}.mp4`);
        return await this.ffmpegService.mergeTracks(videoPath, audioPath, mergedPath);
      }
    }

    return await download(format.id);
  }

  private resolveMimeType(format: { kind: string; extension?: string; hasVideo?: boolean }): string {
    if (format.kind === 'audio') {
      return format.extension === 'mp3' ? 'audio/mpeg' : `audio/${format.extension ?? 'mp4'}`;
    }
    return format.extension === 'mp4' || format.hasVideo ? 'video/mp4' : `video/${format.extension ?? 'mp4'}`;
  }

  private buildProbe(format: NormalizedFormat, mimeType: string, duration?: number): MediaProbe {
    return {
      mediaType: resolveMediaType({ kind: format.kind, extension: format.extension, duration, mimeType }),
      resolution: format.resolution ?? (format.height ? `${format.height}p` : undefined),
      width: format.width,
      height: format.height,
      fps: format.fps,
      bitrate: format.bitrate,
      codec: format.kind === 'audio' ? format.audioCodec : format.videoCodec,
      size: format.filesize,
    };
  }

  private toNormalized(f: any): NormalizedFormat {
    return {
      id: f.id,
      kind: f.kind,
      quality: f.quality,
      label: f.label || f.quality,
      container: f.extension || 'mp4',
      extension: f.extension || 'mp4',
      resolution: f.resolution,
      width: f.width,
      height: f.height,
      fps: f.fps,
      bitrate: f.bitrate,
      videoCodec: f.videoCodec,
      audioCodec: f.audioCodec,
      filesize: f.filesize,
      hasAudio: f.hasAudio ?? (f.kind === 'audio'),
      hasVideo: f.hasVideo ?? (f.kind === 'video'),
    };
  }
}
