import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { AppError } from '../types/errors';
import {
  EngineDownloadRequest,
  EngineDownloadResult,
  EngineMetadata,
  NormalizedFormat,
} from '../types/download';
import { MediaProbe, SupportedPlatform } from '../types/media';
import { assertValidUrl } from '../utils/url';
import { withRetry } from '../utils/retry';
import { resolveMediaType } from '../telegram/mediaType';
import { ChecksumService } from './ChecksumService';
import { FFmpegService } from './FFmpegService';
import { MetadataService } from './MetadataService';
import { ProgressTracker } from './ProgressTracker';
import { TempFileManager } from './TempFileManager';
import { YtDlpClient } from './YtDlpClient';

/**
 * DownloadEngine is the single core engine for the whole ecosystem. Every
 * provider (current and future) uses it. Providers pass only a URL and their
 * platform name. The engine owns validation, metadata, format resolution,
 * download, merge, ffmpeg processing, thumbnail extraction, progress,
 * temp-file lifecycle, retries, and checksum generation.
 */
export class DownloadEngine {
  constructor(
    private readonly metadataService: MetadataService,
    private readonly ytDlpClient: YtDlpClient,
    private readonly ffmpegService: FFmpegService,
    private readonly checksumService: ChecksumService,
    private readonly tempFileManager: TempFileManager,
  ) {}

  async inspect(url: string, provider: SupportedPlatform): Promise<EngineMetadata> {
    assertValidUrl(url);
    const result = await this.metadataService.fetch(url, provider);
    if (result.isLive) {
      throw new AppError('Live streams are not downloadable yet', 'LIVE_STREAM');
    }
    return result;
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
      const inspected = await this.inspect(request.url, request.provider);

      tracker.setStage('resolving_formats');
      const format = this.selectFormat(inspected.formats, request.formatId);

      tracker.setStage('downloading');
      const mediaPath = await this.acquireMedia(request, inspected.formats, format, workspace, tracker);

      tracker.setStage('processing');
      const thumbnailPath = await this.ffmpegService.extractThumbnail(mediaPath, workspace);

      const checksum = await this.checksumService.generate(mediaPath);
      const mimeType = this.resolveMimeType(format);
      const probe = this.buildProbe(format, mimeType, inspected.metadata.duration);

      tracker.setStage('finished');

      return {
        filePath: mediaPath,
        fileName: path.basename(mediaPath),
        mimeType,
        quality: format.quality,
        checksum,
        probe,
        metadata: inspected.metadata,
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

  private selectFormat(formats: NormalizedFormat[], formatId: string): NormalizedFormat {
    const format = formats.find((item) => item.id === formatId);
    if (!format) {
      throw new AppError('Requested format is not available', 'UNSUPPORTED_FORMAT');
    }
    return format;
  }

  private async acquireMedia(
    request: EngineDownloadRequest,
    formats: NormalizedFormat[],
    format: NormalizedFormat,
    workspace: string,
    tracker: ProgressTracker,
  ): Promise<string> {
    const download = (formatId: string): Promise<string> =>
      withRetry('engine-download', config.DOWNLOAD_RETRY_ATTEMPTS, () =>
        this.ytDlpClient.downloadFormat(request.url, formatId, workspace),
      );

    if (format.hasVideo && !format.hasAudio) {
      const audioFormat = this.pickBestAudio(formats);
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

  private pickBestAudio(formats: NormalizedFormat[]): NormalizedFormat | undefined {
    return formats
      .filter((format) => format.hasAudio && !format.hasVideo)
      .sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0))[0];
  }

  private resolveMimeType(format: NormalizedFormat): string {
    if (format.kind === 'audio') {
      return format.extension === 'mp3' ? 'audio/mpeg' : `audio/${format.extension}`;
    }
    return format.extension === 'mp4' || format.hasVideo ? 'video/mp4' : `video/${format.extension}`;
  }

  private buildProbe(format: NormalizedFormat, mimeType: string, duration?: number): MediaProbe {
    return {
      mediaType: resolveMediaType({
        kind: format.kind,
        extension: format.extension,
        duration,
        mimeType,
      }),
      resolution: format.resolution ?? (format.height ? `${format.height}p` : undefined),
      width: format.width,
      height: format.height,
      fps: format.fps,
      bitrate: format.bitrate,
      codec: format.kind === 'audio' ? format.audioCodec : format.videoCodec,
      size: format.filesize,
    };
  }
}
