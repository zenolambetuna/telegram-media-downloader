import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { AppError } from '../types/errors';
import { withRetry } from '../utils/retry';
import { ProcessRunner } from './ProcessRunner';

/**
 * FFmpegService owns all ffmpeg interactions: remuxing/merging separate video
 * and audio tracks and extracting thumbnails. Nothing else in the codebase
 * shells out to ffmpeg.
 */
export class FFmpegService {
  constructor(private readonly processRunner: ProcessRunner) {}

  async mergeTracks(videoPath: string, audioPath: string, outputPath: string): Promise<string> {
    await withRetry('ffmpeg-merge', config.DOWNLOAD_RETRY_ATTEMPTS, async () => {
      await this.processRunner.run(
        config.FFMPEG_PATH,
        ['-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', outputPath],
        config.DOWNLOAD_TIMEOUT_MS,
      );
    });

    await this.assertExists(outputPath, 'merge produced no output');
    return outputPath;
  }

  async extractThumbnail(sourcePath: string, workspace: string): Promise<string | undefined> {
    const outputPath = path.join(workspace, 'thumbnail.jpg');
    try {
      await this.processRunner.run(
        config.FFMPEG_PATH,
        ['-y', '-i', sourcePath, '-ss', '00:00:01.000', '-vframes', '1', outputPath],
        60_000,
      );
      await this.assertExists(outputPath, 'thumbnail extraction produced no output');
      return outputPath;
    } catch (error) {
      logger.warn({ sourcePath, error }, 'thumbnail extraction failed');
      return undefined;
    }
  }

  private async assertExists(filePath: string, message: string): Promise<void> {
    try {
      await access(filePath);
      const info = await stat(filePath);
      if (info.size === 0) {
        throw new AppError(message, 'MERGE_FAILED');
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(message, 'MERGE_FAILED', error);
    }
  }
}
