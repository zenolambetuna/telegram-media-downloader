import { Api } from 'grammy';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { DownloadStage, ProgressUpdate } from '../types/download';

const STAGE_TEXT: Record<DownloadStage, string> = {
  fetching_metadata: 'Fetching metadata',
  resolving_formats: 'Resolving formats',
  downloading: 'Downloading',
  merging: 'Merging audio and video',
  processing: 'Processing',
  uploading: 'Uploading to Telegram Drive',
  finished: 'Finishing',
};

const STAGE_SEQUENCE: DownloadStage[] = [
  'fetching_metadata',
  'resolving_formats',
  'downloading',
  'merging',
  'processing',
  'uploading',
  'finished',
];

/**
 * ProgressReporter edits a single Telegram message in place instead of sending
 * a new message per stage. Edits are throttled to avoid Telegram rate limits,
 * and the final state is always flushed.
 */
export class ProgressReporter {
  private lastEditAt = 0;
  private lastText = '';

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly messageId: number,
    private readonly cancelMarkup: unknown,
  ) {}

  async update(progress: ProgressUpdate): Promise<void> {
    const now = Date.now();
    const text = this.render(progress);
    if (text === this.lastText) {
      return;
    }
    if (now - this.lastEditAt < config.PROGRESS_EDIT_INTERVAL_MS && progress.stage !== 'finished') {
      return;
    }
    await this.flush(text, progress.stage !== 'finished');
  }

  async finalize(text: string): Promise<void> {
    await this.flush(text, false);
  }

  private async flush(text: string, withCancel: boolean): Promise<void> {
    this.lastEditAt = Date.now();
    this.lastText = text;
    try {
      await this.api.editMessageText(this.chatId, this.messageId, text, {
        reply_markup: withCancel ? (this.cancelMarkup as never) : undefined,
      });
    } catch (error) {
      logger.debug({ error }, 'progress edit skipped');
    }
  }

  private render(progress: ProgressUpdate): string {
    const currentIndex = STAGE_SEQUENCE.indexOf(progress.stage);
    const lines = STAGE_SEQUENCE.slice(0, 6).map((stage, index) => {
      const label = STAGE_TEXT[stage];
      if (index < currentIndex) {
        return `✅ ${label}`;
      }
      if (index === currentIndex) {
        const ratio = progress.ratio !== undefined ? ` ${Math.round(progress.ratio * 100)}%` : '';
        return `⏳ ${label}${ratio}`;
      }
      return `• ${label}`;
    });
    return lines.join('\n');
  }
}
