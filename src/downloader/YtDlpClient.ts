import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env';
import { classifyDownloadError } from '../types/errors';
import { logger } from '../logger/logger';
import { ProcessRunner } from './ProcessRunner';

/**
 * YtDlpClient is the ONLY place in the codebase that shells out to yt-dlp.
 * It is used exclusively by the Universal Download Engine. Providers must
 * never import this.
 *
 * Design principle: the bot should run yt-dlp as close to `yt-dlp <url>`
 * as possible. Extra flags are only added when they are provably safe and
 * do not override yt-dlp's per-extractor defaults.
 */
export class YtDlpClient {
  constructor(private readonly processRunner: ProcessRunner) {}

  /**
   * Build common yt-dlp arguments that are safe for every provider.
   * We intentionally do NOT set --user-agent or --referer here because
   * yt-dlp has its own per-extractor defaults that are more correct
   * than any hardcoded value. Forcing a TikTok referer on a YouTube
   * URL, or a mobile Android UA on a desktop extractor, breaks
   * extraction. (Stage 5.1 fix: TikTok "status code 0" bug.)
   */
  private getCommonArgs(): string[] {
    return ['--no-warnings', '--no-playlist'];
  }

  /**
   * Detect if a URL belongs to TikTok.
   */
  private isTiktokUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase().includes('tiktok.com');
    } catch {
      return false;
    }
  }

  async extract(url: string): Promise<Record<string, unknown>> {
    const commonArgs = this.getCommonArgs();

    // Attempt 1: --dump-single-json (preferred — single JSON object).
    try {
      const result = await this.processRunner.run(
        config.YT_DLP_PATH,
        ['--dump-single-json', ...commonArgs, url],
        config.PROVIDER_TIMEOUT_MS,
      );
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch (primaryError) {
      const primaryMessage = errorToMessage(primaryError);
      logger.warn({ url, error: primaryMessage }, 'yt-dlp --dump-single-json failed, trying fallback');

      // Attempt 2: -J (alias for --dump-json). Sometimes works when
      // --dump-single-json fails on playlist-adjacent pages.
      try {
        const result = await this.processRunner.run(
          config.YT_DLP_PATH,
          ['-J', ...commonArgs, url],
          config.PROVIDER_TIMEOUT_MS,
        );
        return JSON.parse(result.stdout) as Record<string, unknown>;
      } catch (fallbackError) {
        const fallbackMessage = errorToMessage(fallbackError);
        logger.error({ url, primaryError: primaryMessage, fallbackError: fallbackMessage }, 'yt-dlp extract failed (both attempts)');
        throw classifyDownloadError(fallbackMessage || primaryMessage);
      }
    }
  }

  async downloadFormat(url: string, formatId: string, outputDir: string): Promise<string> {
    const outputTemplate = path.join(outputDir, '%(title).200B-%(id)s.%(ext)s');
    const commonArgs = this.getCommonArgs();

    try {
      await this.processRunner.run(
        config.YT_DLP_PATH,
        ['-f', formatId, ...commonArgs, '-o', outputTemplate, url],
        config.DOWNLOAD_TIMEOUT_MS,
      );
    } catch (error) {
      const message = errorToMessage(error);
      logger.error({ url, formatId, error: message }, 'yt-dlp download failed');
      throw classifyDownloadError(message);
    }

    // Small delay to ensure file system has flushed
    await new Promise((r) => setTimeout(r, 500));

    const files = await readdir(outputDir);
    const candidates = files
      .filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.temp'))
      .sort()
      .reverse();

    if (candidates.length === 0) {
      throw classifyDownloadError('downloaded file not found');
    }

    let newestFile = candidates[0];
    let newestMtime = 0;
    for (const file of candidates) {
      try {
        const info = await stat(path.join(outputDir, file));
        if (info.mtimeMs > newestMtime) {
          newestMtime = info.mtimeMs;
          newestFile = file;
        }
      } catch {
        /* skip unreadable */
      }
    }

    const result = path.join(outputDir, newestFile);
    const fileInfo = await stat(result);
    logger.info({ formatId, file: newestFile, size: fileInfo.size }, 'download completed');

    if (fileInfo.size === 0) {
      throw classifyDownloadError('downloaded file is empty (size 0 bytes)');
    }

    return result;
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}