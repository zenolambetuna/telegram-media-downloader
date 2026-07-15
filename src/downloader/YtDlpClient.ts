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
 */
export class YtDlpClient {
  constructor(private readonly processRunner: ProcessRunner) {}

  /**
   * Detect if a URL belongs to TikTok to apply platform-specific args.
   */
  private isTiktokUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase().includes('tiktok.com');
    } catch {
      return false;
    }
  }

  /**
   * Build TikTok-specific yt-dlp arguments.
   * TikTok requires extractor-args to bypass Cloudflare and region blocks.
   */
  private getTiktokExtractorArgs(): string[] {
    return [
      '--extractor-args',
      'tiktok:player_client=iphone;player_region=US',
    ];
  }

  /**
   * Build common yt-dlp arguments with proper headers for anti-bot protection.
   */
  private getCommonArgs(): string[] {
    return [
      '--no-warnings',
      '--no-playlist',
      '--user-agent',
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.147 Mobile Safari/537.36',
      '--referer',
      'https://www.tiktok.com/',
    ];
  }

  async extract(url: string): Promise<Record<string, unknown>> {
    try {
      const commonArgs = this.getCommonArgs();
      const tiktokArgs = this.isTiktokUrl(url) ? this.getTiktokExtractorArgs() : [];

      const result = await this.processRunner.run(
        config.YT_DLP_PATH,
        ['--dump-single-json', ...commonArgs, ...tiktokArgs, url],
        config.PROVIDER_TIMEOUT_MS,
      );

      const data = JSON.parse(result.stdout) as Record<string, unknown>;
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ url, error: message }, 'yt-dlp extract failed');
      throw classifyDownloadError(message);
    }
  }

  async downloadFormat(url: string, formatId: string, outputDir: string): Promise<string> {
    const outputTemplate = path.join(outputDir, '%(title).200B-%(id)s.%(ext)s');
    try {
      const commonArgs = this.getCommonArgs();
      const tiktokArgs = this.isTiktokUrl(url) ? this.getTiktokExtractorArgs() : [];

      await this.processRunner.run(
        config.YT_DLP_PATH,
        ['-f', formatId, ...commonArgs, ...tiktokArgs, '-o', outputTemplate, url],
        config.DOWNLOAD_TIMEOUT_MS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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