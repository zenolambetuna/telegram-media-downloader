import { Bot, session } from 'grammy';
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
import { JobManager } from './JobManager';
import { ProgressReporter } from './ProgressReporter';
import { buildChoiceKeyboard, buildVideoKeyboard, buildAudioKeyboard } from './keyboards';
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
  const jobManager = new JobManager(queue);

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
      await ctx.reply(appError.message).catch(() => undefined);
    }
  });

  bot.command('start', async (ctx) => {
    await ctx.reply('Send a supported media URL. I detect the provider, show formats, download, store it in your Telegram Drive channel, and send it back. Use /cancel to stop your downloads.');
  });

  bot.command('cancel', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }
    const count = jobManager.cancelAllForUser(userId);
    await ctx.reply(count > 0 ? `cancelling ${count} download(s)` : 'nothing running to cancel');
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
    await ctx.reply(`pending: ${stats.pending}\nactive: ${stats.active}\nconcurrency: ${stats.concurrency}`);
  });

  bot.command('providers', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) {
      await ctx.reply('not for you');
      return;
    }
    const health = providerRegistry.health();
    const loaded = health.loaded.map((item) => `${item.name} v${item.version} (${item.priority})`).join('\n') || 'none';
    const failed = health.failed.map((item) => `${item.providerId}: ${item.reason}`).join('\n') || 'none';
    await ctx.reply(`loaded:\n${loaded}\n\nfailed:\n${failed}`);
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

    const platform = inspected.metadata.provider;
    const info = [
      `title: ${inspected.metadata.title}`,
      `platform: ${platform}`,
      `duration: ${inspected.metadata.duration ?? 'unknown'}`,
      `uploader: ${inspected.metadata.uploader ?? 'unknown'}`,
    ].join('\n');

    if (inspected.metadata.thumbnail) {
      await ctx.replyWithPhoto(inspected.metadata.thumbnail, {
        caption: info,
        reply_markup: buildChoiceKeyboard(inspected.metadata.formats),
      }).catch(async () => {
        await ctx.reply(info, { reply_markup: buildChoiceKeyboard(inspected.metadata.formats) });
      });
      return;
    }

    await ctx.reply(info, { reply_markup: buildChoiceKeyboard(inspected.metadata.formats) });
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
      await ctx.editMessageCaption({ caption: 'cancelled' }).catch(async () => {
        await ctx.editMessageText('cancelled').catch(() => undefined);
      });
      await ctx.answerCallbackQuery();
      return;
    }

    const keyboard = action === 'video'
      ? buildVideoKeyboard(metadata.formats)
      : buildAudioKeyboard(metadata.formats);

    await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => undefined);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    const jobId = ctx.match[1];
    const cancelled = jobManager.cancel(jobId);
    await ctx.answerCallbackQuery({ text: cancelled ? 'cancelling' : 'already done' });
  });

  bot.callbackQuery(/^format:(.+)$/, async (ctx) => {
    const formatId = ctx.match[1];
    const url = ctx.session.pendingUrl;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!url || !userId || !chatId) {
      await ctx.answerCallbackQuery({ text: 'request expired' });
      return;
    }

    await ctx.answerCallbackQuery();

    const jobId = `${userId}:${Date.now()}`;
    const progressMessage = await ctx.reply('Queued...');
    const reporter = new ProgressReporter(ctx.api, chatId, progressMessage.message_id, jobId);

    ctx.session.pendingMetadata = undefined;
    ctx.session.pendingUrl = undefined;

    void jobManager
      .run(userId, jobId, async (token) => {
        const result = await pipeline.execute({
          url,
          formatId,
          userId,
          chatId,
          onProgress: (update) => {
            void reporter.update(update);
          },
          shouldCancel: () => token.isCancelled,
        });
        await reporter.finish(result.cached ? 'Served from Telegram Drive cache.' : 'Done. Uploaded to your Telegram Drive.');
        return result;
      })
      .catch(async (error) => {
        if (JobManager.isCancellation(error)) {
          await reporter.finish('Cancelled.');
          return;
        }
        const message = error instanceof AppError ? error.message : 'Download failed. Try again.';
        await reporter.finish(message);
      });
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