import { Api } from 'grammy';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { DownloadStage } from '../types/download';

const STAGE_TEXT: Record<DownloadStage, string> = {
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
 * job advances. It throttles edits and skips no-op edits so it never trips
 * Telegram rate limits or the "message is not modified" error. This satisfies
 * the requirement that progress edits one message instead of spamming many.
 */
export class ProgressReporter {
  private lastText = '';
  private lastEditAt = 0;
  private readonly replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly messageId: number,
    cancelData: string,
  ) {
    this.replyMarkup = {
      inline_keyboard: [[{ text: 'Cancel', callback_data: cancelData }]],
    };
  }

  async update(stage: DownloadStage, ratio?: number): Promise<void> {
    const bar = ratio !== undefined ? ` ${Math.round(ratio * 100)}%` : '';
    const text = `${STAGE_TEXT[stage]}${bar}...`;
    await this.render(text, stage !== 'finished');
  }

  async succeed(text: string): Promise<void> {
    await this.render(text, false);
  }

  async fail(text: string): Promise<void> {
    await this.render(text, false);
  }

  private async render(text: string, withCancel: boolean): Promise<void> {
    const now = Date.now();
    if (text === this.lastText) {
      return;
    }
    if (withCancel && now - this.lastEditAt < config.PROGRESS_THROTTLE_MS) {
      return;
    }
    this.lastText = text;
    this.lastEditAt = now;

    try {
      await this.api.editMessageText(this.chatId, this.messageId, text, {
        reply_markup: withCancel ? this.replyMarkup : { inline_keyboard: [] },
      });
    } catch (error) {
      logger.debug({ error }, 'progress edit skipped');
    }
  }
}
