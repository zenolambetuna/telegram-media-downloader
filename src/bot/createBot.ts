import { Bot, session } from 'grammy';
import { registerStartCommand } from '../commands/start';
import { registerAdminCommands } from '../commands/admin';
import { createUrlHandler } from '../handlers/urlHandler';
import { registerCallbackHandler } from '../handlers/callbackHandler';
import { BotContext, SessionData } from '../types/bot';
import { config } from '../config/env';
import { logger } from '../logs/logger';
import { ProcessRunner } from '../core/ProcessRunner';
import { YtDlpClient } from '../core/YtDlpClient';
import { ProviderRegistry } from '../core/ProviderRegistry';
import { YouTubeProvider } from '../providers/youtube/YouTubeProvider';
import { FacebookProvider } from '../providers/facebook/FacebookProvider';
import { InstagramProvider } from '../providers/instagram/InstagramProvider';
import { TwitterProvider } from '../providers/twitter/TwitterProvider';
import { TikTokProvider } from '../providers/tiktok/TikTokProvider';
import { ThreadsProvider } from '../providers/threads/ThreadsProvider';
import { VimeoProvider } from '../providers/vimeo/VimeoProvider';
import { RedditProvider } from '../providers/reddit/RedditProvider';
import { PinterestProvider } from '../providers/pinterest/PinterestProvider';
import { SoundCloudProvider } from '../providers/soundcloud/SoundCloudProvider';
import { DownloadManager } from '../core/DownloadManager';
import { JsonMediaRepository } from '../storage/JsonMediaRepository';
import { MediaCacheService } from '../cache/MediaCacheService';
import { TelegramStorageService } from '../telegram/TelegramStorageService';
import { StatsRepository } from '../storage/StatsRepository';
import { AppError } from '../utils/errors';

function initialSessionData(): SessionData {
  return {};
}

export function createBot(): Bot<BotContext> {
  const bot = new Bot<BotContext>(config.botToken);
  const processRunner = new ProcessRunner();
  const ytDlpClient = new YtDlpClient(processRunner);

  const providerRegistry = new ProviderRegistry([
    new YouTubeProvider(ytDlpClient),
    new FacebookProvider(ytDlpClient),
    new InstagramProvider(ytDlpClient),
    new TwitterProvider(ytDlpClient),
    new TikTokProvider(ytDlpClient),
    new ThreadsProvider(ytDlpClient),
    new VimeoProvider(ytDlpClient),
    new RedditProvider(ytDlpClient),
    new PinterestProvider(ytDlpClient),
    new SoundCloudProvider(ytDlpClient),
  ]);

  const downloadManager = new DownloadManager(providerRegistry);
  const mediaRepository = new JsonMediaRepository();
  const cacheService = new MediaCacheService(mediaRepository);
  const telegramStorageService = new TelegramStorageService(bot.api);
  const statsRepository = new StatsRepository();

  bot.use(session({ initial: initialSessionData }));

  bot.use(async (ctx, next) => {
    const startedAt = Date.now();
    try {
      await next();
      logger.info(
        {
          updateId: ctx.update.update_id,
          durationMs: Date.now() - startedAt,
          userId: ctx.from?.id,
        },
        'update handled',
      );
    } catch (error) {
      await statsRepository.update((stats) => ({
        ...stats,
        errors: stats.errors + 1,
      }));

      logger.error({ error, update: ctx.update }, 'failed to handle update');
      const message = error instanceof AppError ? error.message : 'something broke, try again';
      await ctx.reply(message);
    }
  });

  registerStartCommand(bot);
  registerAdminCommands(bot, cacheService, statsRepository);
  registerCallbackHandler(bot, downloadManager, cacheService, telegramStorageService, statsRepository);
  bot.on('message:text', createUrlHandler(providerRegistry, cacheService));

  return bot;
}
