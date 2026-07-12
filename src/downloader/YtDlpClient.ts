import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env';
import { classifyDownloadError } from '../types/errors';
import { ProcessRunner } from './ProcessRunner';

/**
 * YtDlpClient is the ONLY place in the codebase that shells out to yt-dlp.
 * It is used exclusively by the Universal Download Engine. Providers must
 * never import this.
 */
export class YtDlpClient {
  constructor(private readonly processRunner: ProcessRunner) {}

  async extract(url: string): Promise<Record<string, unknown>> {
    try {
      const result = await this.processRunner.run(
        config.YT_DLP_PATH,
        ['--dump-single-json', '--no-warnings', '--no-playlist', url],
        config.PROVIDER_TIMEOUT_MS,
      );
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch (error) {
      throw classifyDownloadError(error instanceof Error ? error.message : String(error));
    }
  }

  async downloadFormat(url: string, formatId: string, outputDir: string): Promise<string> {
    const outputTemplate = path.join(outputDir, '%(title).200B-%(id)s.f%(format_id)s.%(ext)s');
    try {
      await this.processRunner.run(
        config.YT_DLP_PATH,
        ['-f', formatId, '--no-playlist', '--no-warnings', '-o', outputTemplate, url],
        config.DOWNLOAD_TIMEOUT_MS,
      );
    } catch (error) {
      throw classifyDownloadError(error instanceof Error ? error.message : String(error));
    }

    const files = await readdir(outputDir);
    const match = files.filter((file) => file.includes(`.f${formatId}.`)).sort();
    const chosen = match[0] ?? files.sort((a, b) => b.localeCompare(a))[0];
    if (!chosen) {
      throw classifyDownloadError('downloaded file not found');
    }
    return path.join(outputDir, chosen);
  }
}
