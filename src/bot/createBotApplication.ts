import { Bot, session } from 'grammy';
import { randomUUID } from 'node:crypto';
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
import { CancellationRegistry } from '../queue/CancellationToken';
import { ProgressReporter } from './ProgressReporter';
import { buildKindKeyboard, buildFormatKeyboard, buildCancelKeyboard } from './keyboards';
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

  const bot = new Bot<BotContext>(
    config.BOT_TOKEN,
    config.TELEGRAM_API_ROOT ? { client: { apiRoot: config.TELEGRAM_API_ROOT } } : undefined,
  );

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
  const cancellations = new CancellationRegistry();

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
    await ctx.reply(
      'Send a supported media URL. I detect the provider, show real available formats, download and merge, store it in your Telegram Drive channel, and send it back. Duplicate media at the same quality is reused instantly.',
    );
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

  bot.command('errors', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) {
      await ctx.reply('not for you');
      return;
    }
    const latest = await errorRepository.latest(5);
    await ctx.reply(latest.length ? latest.map((item) => `[${item.code}] ${item.message}`).join('\n') : 'no recent errors');
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    assertValidUrl(text);

    const inspected = await mediaInspector.inspect(text);
    ctx.session.pendingUrl = text;
    ctx.session.pendingMetadata = inspected.metadata;

    const durationText = inspected.metadata.duration ? `${inspected.metadata.duration}s` : 'unknown';
    const info = [
      `📀 ${inspected.metadata.provider}`,
      `🏷️ ${inspected.metadata.title}`,
      `⏱️ ${durationText}`,
      inspected.metadata.uploader ? `👤 ${inspected.metadata.uploader}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');

    const keyboard = buildKindKeyboard(inspected.metadata.formats);
    if (inspected.metadata.thumbnail) {
      await ctx.replyWithPhoto(inspected.metadata.thumbnail, { caption: info, reply_markup: keyboard }).catch(async () => {
        await ctx.reply(info, { reply_markup: keyboard });
      });
    } else {
      await ctx.reply(info, { reply_markup: keyboard });
    }
  });

  bot.callbackQuery(/^kind:(video|audio)$/, async (ctx) => {
    const kind = ctx.match[1] as 'video' | 'audio';
    const metadata = ctx.session.pendingMetadata;
    if (!metadata) {
      await ctx.answerCallbackQuery({ text: 'request expired' });
      return;
    }
    const keyboard = buildFormatKeyboard(metadata.formats, kind);
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(async () => {
      await ctx.reply(`Pick ${kind} quality`, { reply_markup: keyboard });
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('back', async (ctx) => {
    const metadata = ctx.session.pendingMetadata;
    if (!metadata) {
      await ctx.answerCallbackQuery({ text: 'request expired' });
      return;
    }
    await ctx.editMessageReplyMarkup({ reply_markup: buildKindKeyboard(metadata.formats) }).catch(() => undefined);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('abort', async (ctx) => {
    ctx.session.pendingMetadata = undefined;
    ctx.session.pendingUrl = undefined;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await ctx.answerCallbackQuery({ text: 'cancelled' });
  });

  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    const jobToken = ctx.match[1];
    const cancelledPending = queue.cancelPending(jobToken);
    const cancelledActive = cancellations.cancel(jobToken);
    await ctx.answerCallbackQuery({
      text: cancelledPending || cancelledActive ? 'cancelling...' : 'too late to cancel',
    });
  });

  bot.callbackQuery(/^fmt:(\d+)$/, async (ctx) => {
    const index = Number(ctx.match[1]);
    const metadata = ctx.session.pendingMetadata;
    const url = ctx.session.pendingUrl;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!metadata || !url || userId === undefined || chatId === undefined) {
      await ctx.answerCallbackQuery({ text: 'request expired' });
      return;
    }
    const format = metadata.formats[index];
    if (!format) {
      await ctx.answerCallbackQuery({ text: 'that format is gone' });
      return;
    }

    await ctx.answerCallbackQuery();

    const jobToken = randomUUID().slice(0, 8);
    const cancellation = cancellations.create(jobToken);
    const progressMessage = await ctx.reply('Queued', { reply_markup: buildCancelKeyboard(jobToken) });
    const reporter = new ProgressReporter(ctx.api, chatId, progressMessage.message_id, buildCancelKeyboard(jobToken));

    const url2 = url;
    const quality = format.quality;
    const formatId = format.id;

    ctx.session.pendingMetadata = undefined;
    ctx.session.pendingUrl = undefined;

    void queue
      .add(jobToken, async () => {
        cancellation.throwIfCancelled();
        return await pipeline.execute({
          url: url2,
          formatId,
          quality,
          userId,
          chatId,
          cancellation,
          onProgress: (update) => {
            void reporter.update(update);
          },
        });
      })
      .then(async (result) => {
        await reporter.finalize(result.cached ? '✅ Served instantly from Telegram Drive cache' : '✅ Done');
      })
      .catch(async (error) => {
        const message = error instanceof AppError && error.code === 'CANCELLED'
          ? '🛑 Cancelled'
          : `⚠️ ${error instanceof Error ? error.message : 'job failed'}`;
        await reporter.finalize(message);
      })
      .finally(() => {
        cancellations.release(jobToken);
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
