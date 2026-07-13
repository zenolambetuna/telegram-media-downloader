import { Api } from 'grammy';
import { GrammyError } from 'grammy';
import { logger } from '../logger/logger';
import { DownloadStage, ProgressUpdate } from '../types/download';
import { buildCancelKeyboard } from './keyboards';

const STAGE_TEXT: Record<DownloadStage, string> = {
  fetching_metadata: '🔍 Fetching metadata',
  resolving_formats: '🧩 Resolving formats',
  downloading: '⬇️ Downloading',
  merging: '🎞️ Merging video and audio',
  processing: '⚙️ Processing',
  uploading: '☁️ Uploading to Telegram Drive',
  finished: '✅ Finishing up',
};

/**
 * ProgressPresenter owns a SINGLE Telegram message and edits it as the job
 * advances. It never spams new messages (requirement 14). Edits are throttled
 * and de-duplicated to stay well clear of Telegram rate limits, and edit
 * conflicts / FloodWait during editing are swallowed so progress UI never
 * crashes a job.
 */
export class ProgressPresenter {
  private messageId?: number;
  private lastText = '';
  private lastEditAt = 0;
  private readonly minIntervalMs = 1200;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly jobId: string,
  ) {}

  async begin(initialText: string): Promise<void> {
    const message = await this.api.sendMessage(this.chatId, initialText, {
      reply_markup: buildCancelKeyboard(this.jobId),
    });
    this.messageId = message.message_id;
    this.lastText = initialText;
  }

  async onProgress(update: ProgressUpdate): Promise<void> {
    const base = STAGE_TEXT[update.stage] ?? update.stage;
    const ratio =
      update.ratio !== undefined ? ` ${Math.round(Math.min(1, Math.max(0, update.ratio)) * 100)}%` : '';
    const detail = update.detail ? `\n${update.detail}` : '';
    await this.render(`${base}${ratio}${detail}`, update.stage !== 'finished');
  }

  async succeed(text: string): Promise<void> {
    await this.render(text, false, true);
  }

  async fail(text: string): Promise<void> {
    await this.render(text, false, true);
  }

  get controlMessageId(): number | undefined {
    return this.messageId;
  }

  private async render(text: string, withCancel: boolean, force = false): Promise<void> {
    if (!this.messageId) {
      return;
    }
    if (text === this.lastText) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastEditAt < this.minIntervalMs) {
      return;
    }

    this.lastText = text;
    this.lastEditAt = now;

    try {
      await this.api.editMessageText(this.chatId, this.messageId, text, {
        reply_markup: withCancel ? buildCancelKeyboard(this.jobId) : undefined,
      });
    } catch (error) {
      if (error instanceof GrammyError && error.description.includes('message is not modified')) {
        return;
      }
      logger.debug({ error, jobId: this.jobId }, 'progress edit skipped');
    }
  }
}
