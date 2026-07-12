import { Bot, InlineKeyboard, session } from 'grammy';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { DatabaseConnection } from '../storage/Database';
import { SqliteMediaRepository } from '../storage/MediaRepository';
import { CacheService } from '../cache/CacheService';
import { ErrorRepository } from '../storage/ErrorRepository';
import { CounterRepository } from '../storage/CounterRepository';
import { ProcessRunner } from '../downloader/ProcessRunner';
import { YtDlpClient } from '../downloader/YtDlpClient';
import { ProviderRegistry } from '../core/ProviderRegistry';
import { YouTubeProvider } from '../providers/youtube/YouTubeProvider';
import { FacebookProvider } from '../providers/facebook/FacebookProvider';
import { InstagramProvider } from '../providers/instagram/InstagramProvider';
import { TikTokProvider } from '../providers/tiktok/TikTokProvider';
import { TwitterProvider } from '../providers/twitter/TwitterProvider';
import { ThreadsProvider } from '../providers/threads/ThreadsProvider';
import { RedditProvider } from '../providers/reddit/RedditProvider';
import { PinterestProvider } from '../providers/pinterest/PinterestProvider';
import { VimeoProvider } from '../providers/vimeo/VimeoProvider';
import { SoundCloudProvider } from '../providers/soundcloud/SoundCloudProvider';
import { MediaInspector } from '../core/MediaInspector';
import { DownloadEngine } from '../downloader/DownloadEngine';
import { TelegramStorageService } from '../telegram/TelegramStorageService';
import { MediaPipeline } from '../core/MediaPipeline';
import { DownloadQueue } from '../queue/DownloadQueue';
import { BotContext, SessionData } from '../types/bot';
import { AppError } from '../types/errors';
import { assertValidUrl } from '../utils/url';
import { rateLimit } from './rateLimit';

function createProviders(ytDlpClient: YtDlpClient) {
  return [
    new YouTubeProvider(ytDlpClient),
    new FacebookProvider(ytDlpClient),
    new InstagramProvider(ytDlpClient),
    new TikTokProvider(ytDlpClient),
    new TwitterProvider(ytDlpClient),
    new ThreadsProvider(ytDlpClient),
    new RedditProvider(ytDlpClient),
    new PinterestProvider(ytDlpClient),
    new VimeoProvider(ytDlpClient),
    new SoundCloudProvider(ytDlpClient),
  ];
}

function initialSession(): SessionData {
  return {};
}

export async function createBotApplication(): Promise<{
  start: () => Promise<void>;
  stop: () => Promise<void>;
}> {
  const database = new DatabaseConnection();
  const mediaRepository = new SqliteMediaRepository(database);
  const cacheService = new CacheService(mediaRepository);
  const errorRepository = new ErrorRepository(database);
  const counterRepository = new CounterRepository(database);
  const processRunner = new ProcessRunner();
  const ytDlpClient = new YtDlpClient(processRunner);
  const providerRegistry = new ProviderRegistry(createProviders(ytDlpClient));
  const mediaInspector = new MediaInspector(providerRegistry);
  const downloadEngine = new DownloadEngine(providerRegistry);
  const bot = new Bot<BotContext>(config.BOT_TOKEN);
  const telegramStorageService = new TelegramStorageService(bot.api);
  const pipeline = new MediaPipeline(
    cacheService,
    downloadEngine,
    telegramStorageService,
    counterRepository,
    errorRepository,
  );
  const queue = new DownloadQueue(config.MAX_CONCURRENT_DOWNLOADS);

  bot.use(session({ initial: initialSession }));

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      await rateLimit(ctx.from.id);
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('Internal error', 'NETWORK_FAILURE', error);
      await errorRepository.log({
        code: appError.code,
        message: appError.message,
        context: JSON.stringify({ updateId: ctx.update.update_id, userId: ctx.from?.id }),
      });
      logger.error({ error: appError, update: ctx.update }, 'bot update failed');
      await ctx.reply(appError.message);
    }
  });

  bot.command('start', async (ctx) => {
    await ctx.reply('send a supported media URL. i will inspect it, show real formats, queue the job, store it in your Telegram Drive channel, then clean the temp file.');
  });

  bot.command('stats', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) {
      await ctx.reply('not for you');
      return;
    }

    const [cacheCount, uploads, cacheHits, errors] = await Promise.all([
      cacheService.count(),
      counterRepository.get('uploads'),
      counterRepository.get('cache_hits'),
      errorRepository.count(),
    ]);

    await ctx.reply(`cache: ${cacheCount}\nuploads: ${uploads}\ncache hits: ${cacheHits}\nerrors: ${errors}`);
  });

  bot.command('queue', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) {
      await ctx.reply('not for you');
      return;
    }

    const stats = queue.stats();
    await ctx.reply(`pending: ${stats.pending}\nactive: ${stats.active}\nconcurrency: ${stats.concurrency}\nshutting down: ${stats.shuttingDown}`);
  });

  bot.command('providers', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) {
      await ctx.reply('not for you');
      return;
    }

    const health = await Promise.all(
      providerRegistry.list().map(async (provider) => `${provider.platform}: ${await provider.healthCheck() ? 'ok' : 'down'}`),
    );
    await ctx.reply(health.join('\n'));
  });

  bot.command('errors', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) {
      await ctx.reply('not for you');
      return;
    }

    const latest = await errorRepository.latest(5);
    if (latest.length === 0) {
      await ctx.reply('no recent errors');
      return;
    }

    await ctx.reply(latest.map((item) => `[${item.code}] ${item.message}`).join('\n'));
  });

  bot.command('health', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) {
      await ctx.reply('not for you');
      return;
    }

    await ctx.reply('healthy');
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    assertValidUrl(text);

    const metadata = await mediaInspector.inspect(text);
    ctx.session.pendingUrl = text;
    ctx.session.pendingMetadata = metadata;

    const keyboard = new InlineKeyboard();
    if (metadata.formats.some((item) => item.kind === 'video')) {
      keyboard.text('🎥 Video', 'choose:video');
    }
    if (metadata.formats.some((item) => item.kind === 'audio')) {
      keyboard.text('🎵 Audio', 'choose:audio');
    }
    keyboard.text('❌ Cancel', 'choose:cancel');

    await ctx.reply(
      `title: ${metadata.title}\nduration: ${metadata.duration ?? 'unknown'}\nuploader: ${metadata.uploader ?? 'unknown'}\nfile size: ${metadata.filesize ?? 'unknown'}`,
      { reply_markup: keyboard },
    );
  });

  bot.callbackQuery(/^choose:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const metadata = ctx.session.pendingMetadata;
    if (!metadata) {
      await ctx.answerCallbackQuery({ text: 'request expired' });
      return;
    }

    if (action === 'cancel') {
      ctx.session.pendingMetadata = undefined;
      ctx.session.pendingUrl = undefined;
      await ctx.editMessageText('cancelled');
      await ctx.answerCallbackQuery();
      return;
    }

    const formats = metadata.formats.filter((item) => item.kind === action);
    const keyboard = new InlineKeyboard();
    for (const format of formats) {
      keyboard.text(
        `${format.label}${format.filesize ? ` (${Math.round(format.filesize / 1024 / 1024)} MB)` : ''}`,
        `format:${format.id}`,
      ).row();
    }
    keyboard.text('❌ Cancel', 'choose:cancel');

    await ctx.editMessageText(`pick ${action} format`, { reply_markup: keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^format:(.+)$/, async (ctx) => {
    const formatId = ctx.match[1];
    const metadata = ctx.session.pendingMetadata;
    const url = ctx.session.pendingUrl;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!metadata || !url || !userId || !chatId) {
      await ctx.answerCallbackQuery({ text: 'request expired' });
      return;
    }

    await ctx.editMessageText('queued');

    void queue
      .add(`${userId}:${Date.now()}`, async () => {
        await ctx.api.sendMessage(chatId, 'downloading...');
        const result = await pipeline.execute({
          url,
          formatId,
          userId,
          chatId,
        });
        await ctx.api.sendMessage(chatId, result.cached ? 'served from cache' : 'uploaded from fresh download');
        return result;
      })
      .catch(async (error) => {
        await ctx.api.sendMessage(chatId, error instanceof Error ? error.message : 'job failed');
      });

    ctx.session.pendingMetadata = undefined;
    ctx.session.pendingUrl = undefined;
    await ctx.answerCallbackQuery();
  });

  return {
    start: async () => {
      await bot.api.getMe();
      await bot.start();
      logger.info('bot started');
    },
    stop: async () => {
      await queue.shutdown();
      await bot.stop();
      database.close();
      logger.info('bot stopped');
    },
  };
}