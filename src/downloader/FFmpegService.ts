import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { AppError } from '../types/errors';
import { withRetry } from '../utils/retry';
import { ProcessRunner } from './ProcessRunner';

export class FFmpegService {
  constructor(private readonly processRunner: ProcessRunner) {}

  async mergeTracks(videoPath: string, audioPath: string, outputPath: string): Promise<string> {
    logger.info({ videoPath, audioPath, outputPath }, 'merging video and audio tracks');

    await withRetry('ffmpeg-merge', config.DOWNLOAD_RETRY_ATTEMPTS, async () => {
      try {
        await this.processRunner.run(
          config.FFMPEG_PATH,
          ['-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', outputPath],
          config.DOWNLOAD_TIMEOUT_MS,
        );
      } catch (error) {
        logger.warn({ error, videoPath, audioPath }, 'stream copy merge failed, re-encoding to mp4');
        const fallbackOutput = outputPath.replace(/\.[^.]+$/, '.mp4');
        await this.processRunner.run(
          config.FFMPEG_PATH,
          ['-y', '-i', videoPath, '-i', audioPath, '-c:v', 'libx264', '-c:a', 'aac',
           '-preset', 'fast', '-crf', '23', fallbackOutput],
          config.DOWNLOAD_TIMEOUT_MS,
        );
        const renames = await import('node:fs/promises');
        await renames.rename(fallbackOutput, outputPath);
      }
    });

    await this.assertExists(outputPath, 'merge produced no output');
    logger.info({ outputPath }, 'merge completed');
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
