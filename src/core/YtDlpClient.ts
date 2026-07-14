import path from 'node:path';
import { config } from '../config/env';
import { ProcessRunner } from './ProcessRunner';
import { ensureDirectory } from '../utils/fs';

export class YtDlpClient {
  constructor(private readonly processRunner: ProcessRunner) {}

  async fetchJson(url: string): Promise<unknown> {
    const result = await this.processRunner.run(
      config.YT_DLP_PATH,
      ['--dump-single-json', '--no-warnings', url],
      config.DOWNLOAD_TIMEOUT_MS,
    );

    return JSON.parse(result.stdout);
  }

  async download(url: string, formatId: string, outputDir: string): Promise<string> {
    await ensureDirectory(outputDir);
    const outputTemplate = path.join(outputDir, '%(title).200B-%(id)s.%(ext)s');
    await this.processRunner.run(
      config.YT_DLP_PATH,
      ['-f', formatId, '-o', outputTemplate, '--no-warnings', url],
      config.DOWNLOAD_TIMEOUT_MS,
    );

    const probe = await this.processRunner.run(
      'bash',
      ['-lc', `ls -t ${JSON.stringify(outputDir)} | head -n 1`],
      10_000,
    );

    const fileName = probe.stdout.trim();
    if (!fileName) {
      throw new Error('Downloaded file not found');
    }

    return path.join(outputDir, fileName);
  }
}
