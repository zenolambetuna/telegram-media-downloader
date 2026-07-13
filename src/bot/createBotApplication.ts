import { Bot, session } from 'grammy';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { DatabaseConnection } from '../storage/Database';
import { SqliteMediaRepository } from '../storage/MediaRepository';
import { ThumbnailRepository } from '../storage/ThumbnailRepository';
import { FormatCacheRepository } from '../storage/FormatCacheRepository';
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
import { CancellationRegistry } from '../core/CancellationToken';
import { BotContext, SessionData } from '../types/bot';
import { MediaMetadata } from '../types/media';
import { AppError } from '../types/errors';
import { assertValidUrl } from '../utils/url';
import { rateLimit } from './rateLimit';
import { ProgressReporter } from './ProgressReporter';
import { buildFormatKeyboard, buildKindKeyboard } from './keyboard';

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
  const formatCacheRepository = new FormatCacheRepository(database);
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
    formatCacheRepository,
    counterRepository,
    errorRepository,
  );
  const queue = new DownloadQueue(config.MAX_CONCURRENT_DOWNLOADS);
  const cancellations = new CancellationRegistry();

  // Short-lived job store mapping a jobId to its resolved metadata + url, so
  // callback queries can act without re-fetching. Kept in memory by design.
  const jobs = new Map<string, { url: string; metadata: MediaMetadata }>();

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
    await ctx.reply('Send a supported media URL. I detect the provider, show real formats, download and store it in your Telegram Drive channel, then send it back. You can cancel any job.');
  });

  bot.command('stats', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) {
      await ctx.reply('not for you');
      return;
    }
    const [formatCount, uploads, cacheHits, errors] = await Promise.all([
      formatCacheRepository.count(),
      counterRepository.get('uploads'),
      counterRepository.get('cache_hits'),
      errorRepository.count(),
    ]);
    await ctx.reply(`cached formats: ${formatCount}\nuploads: ${uploads}\ncache hits: ${cacheHits}\nerrors: ${errors}`);
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
    await ctx.reply(`loaded:\n${loaded}`);
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
    const jobId = randomUUID().slice(0, 8);
    jobs.set(jobId, { url: text, metadata: inspected.metadata });

    const meta = inspected.metadata;
    const info = [
      `🏷 ${meta.title}`,
      `📀 ${meta.provider}`,
      meta.duration ? `⏱ ${meta.duration}s` : undefined,
      meta.uploader ? `👤 ${meta.uploader}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');

    const keyboard = buildKindKeyboard(meta.formats, jobId);

    if (meta.thumbnail) {
      await ctx.replyWithPhoto(meta.thumbnail, { caption: info, reply_markup: keyboard }).catch(async () => {
        await ctx.reply(info, { reply_markup: keyboard });
      });
    } else {
      await ctx.reply(info, { reply_markup: keyboard });
    }
  });

  bot.callbackQuery(/^kind:(video|audio):(.+)$/, async (ctx) => {
    const kind = ctx.match[1] as 'video' | 'audio';
    const jobId = ctx.match[2];
    const job = jobs.get(jobId);
    if (!job) {
      await ctx.answerCallbackQuery({ text: 'request expired' });
      return;
    }
    const keyboard = buildFormatKeyboard(job.metadata.formats, kind, jobId);
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => undefined);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    const jobId = ctx.match[1];
    const removed = queue.cancelPending(jobId);
    const signalled = cancellations.cancel(jobId);
    jobs.delete(jobId);
    await ctx.answerCallbackQuery({ text: removed || signalled ? 'cancelling' : 'nothing to cancel' });
    if (removed || signalled) {
      await ctx.editMessageText('Cancelled').catch(() => undefined);
    }
  });

  bot.callbackQuery(/^fmt:([^:]+):(.+)$/, async (ctx) => {
    const formatId = ctx.match[1];
    const jobId = ctx.match[2];
    const job = jobs.get(jobId);
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!job || !userId || !chatId) {
      await ctx.answerCallbackQuery({ text: 'request expired' });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Queued...').catch(() => undefined);
    const progressMessageId = ctx.callbackQuery.message?.message_id;

    const token = cancellations.create(jobId);
    const reporter =
      progressMessageId !== undefined
        ? new ProgressReporter(ctx.api, chatId, progressMessageId, `cancel:${jobId}`)
        : undefined;

    void queue
      .add(jobId, userId, async () => {
        token.throwIfCancelled();
        const result = await pipeline.execute({
          url: job.url,
          formatId,
          userId,
          chatId,
          token,
          onProgress: (update) => {
            void reporter?.update(update.stage, update.ratio);
          },
        });
        await reporter?.succeed(result.cached ? 'Served from Telegram Drive cache.' : 'Done. Uploaded to Telegram Drive.');
        return result;
      })
      .catch(async (error) => {
        const message = error instanceof AppError ? error.message : 'Job failed';
        await reporter?.fail(message);
      })
      .finally(() => {
        cancellations.release(jobId);
        jobs.delete(jobId);
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