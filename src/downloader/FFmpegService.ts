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
    logger.info({
