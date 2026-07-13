import { Api } from 'grammy';
import { DownloadStage, ProgressUpdate } from '../types/download';
import { logger } from '../logger/logger';
import { buildProgressKeyboard } from './keyboards';

const STAGE_LABELS: Record<DownloadStage, string> = {
  fetching_metadata: 'Fetching metadata',
  resolving_formats: 'Resolving formats',
  downloading: 'Downloading',
  merging: 'Merging audio and video',
  processing: 'Processing',
  uploading: 'Uploading to Telegram Drive',
  finished: 'Finishing',
};

/**
 * ProgressReporter owns a single Telegram message and edits it in place as the
 * job advances. It never sends a new message per stage (requirement 14) and it
 * throttles edits so rapid ratio updates do not trigger Telegram FloodWait.
 */
export class ProgressReporter {
  private lastText = '';
  private lastEditAt = 0;
  private readonly minIntervalMs = 2000;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly messageId: number,
    private readonly jobId: string,
  ) {}

  async update(progress: ProgressUpdate): Promise<void> {
    const label = STAGE_LABELS[progress.stage];
    const bar = progress.ratio !== undefined ? this.renderBar(progress.ratio) : '';
    const detail = progress.detail ? `\n${progress.detail}` : '';
    const text = `${label}...${bar}${detail}`;

    const now = Date.now();
    const stageChanged = !this.lastText.startsWith(label);
    if (!stageChanged && now - this.lastEditAt < this.minIntervalMs) {
      return;
    }
    if (text === this.lastText) {
      return;
    }

    this.lastText = text;
    this.lastEditAt = now;
    await this.safeEdit(text, progress.stage !== 'finished');
  }

  async finish(message: string): Promise<void> {
    await this.safeEdit(message, false);
  }

  private renderBar(ratio: number): string {
    const clamped = Math.max(0, Math.min(1, ratio));
    const filled = Math.round(clamped * 10);
    return `\n[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${Math.round(clamped * 100)}%`;
  }

  private async safeEdit(text: string, withCancel: boolean): Promise<void> {
    try {
      await this.api.editMessageText(this.chatId, this.messageId, text, {
        reply_markup: withCancel ? buildProgressKeyboard(this.jobId) : undefined,
      });
    } catch (error) {
      logger.debug({ error, jobId: this.jobId }, 'progress edit skipped');
    }
  }
}
