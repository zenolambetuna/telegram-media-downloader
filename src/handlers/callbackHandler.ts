import { InlineKeyboard } from 'grammy';
import { MediaCacheService } from '../cache/MediaCacheService';
import { DownloadManager } from '../core/DownloadManager';
import { TelegramStorageService } from '../telegram/TelegramStorageService';
import { BotContext } from '../types/bot';
import { StatsRepository } from '../storage/StatsRepository';
import { safeRemove } from '../utils/fs';
import { normalizeUrl } from '../utils/url';

export function registerCallbackHandler(
  bot: any,
  downloadManager: DownloadManager,
  cacheService: MediaCacheService,
  telegramStorageService: TelegramStorageService,
  statsRepository: StatsRepository,
): void {
  bot.callbackQuery(/^choose:(.+)$/, async (ctx: BotContext) => {
    const action = ctx.match[1];
    const metadata = ctx.session.pendingMetadata;
    const url = ctx.session.pendingUrl;

    if (!metadata || !url) {
      await ctx.answerCallbackQuery({ text: 'expired request' });
      return;
    }

    if (action === 'cancel') {
      ctx.session.pendingMetadata = undefined;
      ctx.session.pendingUrl = undefined;
      await ctx.editMessageText('cancelled');
      await ctx.answerCallbackQuery();
      return;
    }

    if (action === 'video' || action === 'audio') {
      const formats = metadata.formats.filter((format) => format.kind === action);
      const keyboard = new InlineKeyboard();
      for (const format of formats.slice(0, 20)) {
        keyboard.text(format.label, `format:${format.id}`).row();
      }
      keyboard.text('❌ Cancel', 'choose:cancel');
      await ctx.editMessageText(`pick ${action} quality`, { reply_markup: keyboard });
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^format:(.+)$/, async (ctx: BotContext) => {
    const formatId = ctx.match[1];
    const metadata = ctx.session.pendingMetadata;
    const url = ctx.session.pendingUrl;
    if (!metadata || !url || !ctx.from) {
      await ctx.answerCallbackQuery({ text: 'expired request' });
      return;
    }

    await ctx.editMessageText('Downloading...');

    const selected = metadata.formats.find((item) => item.id === formatId);
    if (!selected) {
      await ctx.editMessageText('that format is gone, pick again');
      return;
    }

    const result = await downloadManager.download({
      url,
      formatId,
      kind: selected.kind,
      userId: ctx.from.id,
    });

    await ctx.editMessageText('Uploading...');

    const uploaded = await telegramStorageService.upload(result);
    await cacheService.put({
      messageId: uploaded.messageId,
      fileId: uploaded.fileId,
      platform: result.platform,
      originalUrl: result.originalUrl,
      canonicalUrl: normalizeUrl(result.originalUrl),
      title: result.title,
      duration: result.duration,
      thumbnail: result.thumbnail,
      quality: result.quality,
      mimeType: result.mimeType,
      uploadDate: new Date().toISOString(),
    });

    await telegramStorageService.deliverUploaded(ctx.chat.id, uploaded.messageId);
    await statsRepository.update((stats) => ({
      ...stats,
      uploads: stats.uploads + 1,
      users: stats.users + 1,
    }));

    await safeRemove(result.filePath);
    ctx.session.pendingMetadata = undefined;
    ctx.session.pendingUrl = undefined;

    await ctx.editMessageText('done');
    await ctx.answerCallbackQuery();
  });
}
