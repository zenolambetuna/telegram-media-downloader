import { Bot } from 'grammy';
import { BotContext } from '../types/bot';
import { config } from '../config/env';
import { MediaCacheService } from '../cache/MediaCacheService';
import { StatsRepository } from '../storage/StatsRepository';

export function registerAdminCommands(
  bot: Bot<BotContext>,
  cacheService: MediaCacheService,
  statsRepository: StatsRepository,
): void {
  bot.command('stats', async (ctx) => {
    if (ctx.from?.id !== config.adminId) {
      await ctx.reply('Not for you.');
      return;
    }

    const [stats, cacheCount] = await Promise.all([statsRepository.get(), cacheService.count()]);
    await ctx.reply(
      `users: ${stats.users}\nuploads: ${stats.uploads}\nerrors: ${stats.errors}\ncache entries: ${cacheCount}`,
    );
  });

  bot.command('health', async (ctx) => {
    if (ctx.from?.id !== config.adminId) {
      await ctx.reply('Not for you.');
      return;
    }

    await ctx.reply('healthy');
  });
}
