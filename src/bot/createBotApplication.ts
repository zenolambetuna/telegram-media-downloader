import { Bot, InlineKeyboard, session } from 'grammy';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { DatabaseConnection } from '../storage/Database';
import { SqliteMediaRepository } from '../storage/MediaRepository';
import { ThumbnailRepository } from '../storage/ThumbnailRepository';
import { ErrorRepository } from '../storage/ErrorRepository';
import { CounterRepository } from '../storage/CounterRepository';
import { ProcessRunner } from '../downloader/ProcessRunner';
import { YtDlpClient } from '../downloader/YtDlpClient';
import { FormatResolver } from '../downloader/FormatResolver';
import { MetadataService } from '../downloader/MetadataService';
import { FFmpegService } from '../downloader/FFmpegService';
import { ChecksumService } from '../downloader/ChecksumService';
import { TempFileManager } from '../downloader/TempFileManager';
import { DownloadEngine } from '../downloader/DownloadEngine';
import { ProviderLoader } from '../core/ProviderLoader';
import { ProviderFactory } from '../core/ProviderFactory';
import { ProviderValidator } from '../core/ProviderValidator';
import { ProviderMatcher } from '../core/ProviderMatcher';
import { ProviderRegistry } from '../core/ProviderRegistry';
import { MediaInspector } from '../core/MediaInspector';
import { MediaSender } from '../telegram/MediaSender';
import { UploadManager } from '../telegram/UploadManager';
import { MessageManager } from '../telegram/MessageManager';
import { FileCache } from '../telegram/FileCache';
import { ThumbnailUploader } from '../telegram/ThumbnailUploader';
import { TelegramStorage } from '../telegram/TelegramStorage';
import { MediaPipeline } from '../core/MediaPipeline';
import { DownloadQueue } from '../queue/DownloadQueue';
import { BotContext, SessionData } from '../types/bot';
import { AppError } from '../types/errors';
import { assertValidUrl } from '../utils/url';
import { rateLimit } from './rateLimit';

function initialSession(): SessionData {
  return {};
}

export async function createBotApplication(): Promise<{
  start: () => Promise<void>;
  stop: () => Promise<void>;
}> {
  const database = new DatabaseConnection();
  const mediaRepository = new SqliteMediaRepository(database);
  const thumbnailRepository = new ThumbnailRepository(database);
  const errorRepository = new ErrorRepository(database);
  const counterRepository = new CounterRepository(database);

  const processRunner = new ProcessRunner();
  const ytDlpClient = new YtDlpClient(processRunner);
  const formatResolver = new FormatResolver();
  const metadataService = new MetadataService(ytDlpClient, formatResolver);
  const ffmpegService = new FFmpegService(processRunner);
  const checksumService = new ChecksumService();
  const tempFileManager = new TempFileManager();
  const downloadEngine = new DownloadEngine(
    metadataService,
    ytDlpClient,
    ffmpegService,
    checksumService,
    tempFileManager,
  );

  const providerRegistry = new ProviderRegistry(
    new ProviderLoader(new ProviderFactory()),
    new ProviderValidator(),
    new ProviderMatcher(),
  );
  await providerRegistry.initialize();

  const mediaInspector = new MediaInspector(providerRegistry, downloadEngine);

  const bot = new Bot<BotContext>(config.BOT_TOKEN);

  const mediaSender = new MediaSender(bot.api);
  const uploadManager = new UploadManager(mediaSender);
  const messageManager = new MessageManager(bot.api);
  const fileCache = new FileCache(mediaRepository);
  const thumbnailUploader = new ThumbnailUploader(bot.api, thumbnailRepository);
  const telegramStorage = new TelegramStorage(uploadManager, messageManager, fileCache, thumbnailUploader);

  const pipeline = new MediaPipeline(
    providerRegistry,
    downloadEngine,
    telegramStorage,
    counterRepository,
    errorRepository,
  );
  const queue = new DownloadQueue(config.MAX_CONCURRENT_DOWNLOADS);

  await downloadEngine.recoverOrphans();

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
    await ctx.reply('send a supported media URL. the plugin registry resolves the provider, the Universal Download Engine downloads and merges, and the Storage Engine stores it in your Telegram Drive channel.');
  });

  bot.command('stats', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) {
      await ctx.reply('not for you');
      return;
    }

    const [cacheCount, uploads, cacheHits, errors] = await Promise.all([
      telegramStorage.cacheCount(),
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
    const health = providerRegistry.health();
    const loaded = health.loaded.map((item) => `${item.name} (${item.priority})`).join('\n') || 'none';
    const disabled = health.disabled.map((item) => item.name).join(', ') || 'none';
    const failed = health.failed.map((item) => `${item.providerId}: ${item.reason}`).join('\n') || 'none';
    await ctx.reply(`loaded:\n${loaded}\n\ndisabled: ${disabled}\n\nfailed:\n${failed}`);
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

    const inspected = await mediaInspector.inspect(text);
    ctx.session.pendingUrl = text;
    ctx.session.pendingMetadata = inspected.metadata;

    const keyboard = new InlineKeyboard();
    if (inspected.formats.some((item) => item.kind === 'video')) {
      keyboard.text('🎥 Video', 'choose:video');
    }
    if (inspected.formats.some((item) => item.kind === 'audio')) {
      keyboard.text('🎵 Audio', 'choose:audio');
    }
    keyboard.text('❌ Cancel', 'choose:cancel');

    await ctx.reply(
      `title: ${inspected.metadata.title}\nduration: ${inspected.metadata.duration ?? 'unknown'}\nuploader: ${inspected.metadata.uploader ?? 'unknown'}\nfile size: ${inspected.metadata.filesize ?? 'unknown'}`,
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

    await ctx.editMessageText(`pick ${action} quality`, { reply_markup: keyboard });
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

    const stageMessages: Record<string, string> = {
      fetching_metadata: 'fetching metadata...',
      resolving_formats: 'resolving formats...',
      downloading: 'downloading...',
      merging: 'merging...',
      processing: 'processing...',
      uploading: 'uploading...',
      finished: 'finishing...',
    };

    void queue
      .add(`${userId}:${Date.now()}`, async () => {
        let lastStage = '';
        const result = await pipeline.execute({
          url,
          formatId,
          userId,
          chatId,
          onProgress: (update) => {
            const message = stageMessages[update.stage];
            if (message && update.stage !== lastStage) {
              lastStage = update.stage;
              void ctx.api.sendMessage(chatId, message);
            }
          },
        });
        await ctx.api.sendMessage(chatId, result.cached ? 'served from cache' : 'done');
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