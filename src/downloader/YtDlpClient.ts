import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env';
import { ProcessRunner } from './ProcessRunner';
import { ensureDirectory } from '../utils/fs';

export class YtDlpClient {
  constructor(private readonly processRunner: ProcessRunner) {}

  async extract(url: string): Promise<unknown> {
    const result = await this.processRunner.run(
      config.YT_DLP_PATH,
      ['--dump-single-json', '--no-warnings', '--no-playlist', url],
      config.PROVIDER_TIMEOUT_MS,
    );

    return JSON.parse(result.stdout);
  }

  async download(url: string, formatId: string, outputDir: string): Promise<string> {
    await ensureDirectory(outputDir);
    const outputTemplate = path.join(outputDir, '%(title).200B-%(id)s.%(ext)s');

    await this.processRunner.run(
      config.YT_DLP_PATH,
      ['-f', formatId, '--no-playlist', '--no-warnings', '-o', outputTemplate, url],
      config.DOWNLOAD_TIMEOUT_MS,
    );

    const files = await readdir(outputDir);
    const sorted = files.sort((left, right) => right.localeCompare(left));
    if (sorted.length === 0) {
      throw new Error('downloaded file not found');
    }

    return path.join(outputDir, sorted[0]);
  }
}
