import { Bot, InlineKeyboard, session } from 'grammy';
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
import { CancelledError } from '../core/CancelledError';
import { DownloadQueue } from '../queue/DownloadQueue';
import { BotContext, SessionData } from '../types/bot';
import { EngineMetadata } from '../types/download';
import { AppError } from '../types/errors';
import { assertValidUrl } from '../utils/url';
import { rateLimit } from './rateLimit';
import { buildKindKeyboard, buildFormatKeyboard } from './keyboards';
import { ProgressPresenter } from './ProgressPresenter';
import { JobManager } from './JobManager';

const MAX_JOBS_PER_USER = 3;

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
  const jobManager = new JobManager();

  // Per-chat inspected engine result, so the format keyboard can be built
  // without re-fetching metadata.
  const inspectedByChat = new Map<number, EngineMetadata>();

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
    await ctx.reply(
      'Send a supported media URL. I detect the provider, show formats, download through the shared engine, store it in your Telegram Drive channel, and send it back. Duplicates are reused automatically.',
    );
  });

  registerAdminCommands();

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    assertValidUrl(text);

    const inspected = await mediaInspector.inspect(text);
    inspectedByChat.set(ctx.chat.id, inspected);
    ctx.session.pendingUrl = text;
    ctx.session.pendingMetadata = inspected.metadata;

    const platform = inspected.metadata.provider;
    const caption =
      `📺 ${platform}\n` +
      `🏷️ ${inspected.metadata.title}\n` +
      `⏱️ ${formatDuration(inspected.metadata.duration)}\n` +
      `👤 ${inspected.metadata.uploader ?? 'unknown'}`;

    const keyboard = buildKindKeyboard(inspected.formats);

    if (inspected.metadata.thumbnail) {
      await ctx.replyWithPhoto(inspected.metadata.thumbnail, { caption, reply_markup: keyboard });
    } else {
      await ctx.reply(caption, { reply_markup: keyboard });
    }
  });

  bot.callbackQuery(/^choose:(video|audio)$/, async (ctx) => {
    const kind = ctx.match[1] as 'video' | 'audio';
    const inspected = inspectedByChat.get(ctx.chat?.id ?? -1);
    if (!inspected) {
      await ctx.answerCallbackQuery({ text: 'request expired, send the link again' });
      return;
    }

    const keyboard = buildFormatKeyboard(inspected.formats, kind);
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('cancel:pending', async (ctx) => {
    inspectedByChat.delete(ctx.chat?.id ?? -1);
    ctx.session.pendingMetadata = undefined;
    ctx.session.pendingUrl = undefined;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.answerCallbackQuery({ text: 'cancelled' });
  });

  bot.callbackQuery(/^cancel:job:(.+)$/, async (ctx) => {
    const jobId = ctx.match[1];
    const cancelled = jobManager.cancel(jobId);
    await ctx.answerCallbackQuery({ text: cancelled ? 'cancelling...' : 'job already finished' });
  });

  bot.callbackQuery(/^format:(.+)$/, async (ctx) => {
    const formatId = ctx.match[1];
    const url = ctx.session.pendingUrl;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!url || !userId || !chatId) {
      await ctx.answerCallbackQuery({ text: 'request expired, send the link again' });
      return;
    }

    if (jobManager.activeForUser(userId) >= MAX_JOBS_PER_USER) {
      await ctx.answerCallbackQuery({ text: 'you already have 3 jobs running, let them finish' });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });

    const jobId = randomUUID();
    const handle = jobManager.register(jobId, userId, chatId);
    const presenter = new ProgressPresenter(ctx.api, chatId, jobId);
    await presenter.begin('🕒 Queued');

    void queue
      .add(jobId, async () => {
        if (handle.cancelled) {
          throw new CancelledError();
        }
        return await pipeline.execute({
          url,
          formatId,
          userId,
          chatId,
          isCancelled: () => handle.cancelled,
          onProgress: (update) => {
            void presenter.onProgress(update);
          },
        });
      })
      .then(async (result) => {
        await presenter.succeed(result.cached ? '✅ Served from Telegram Drive cache' : '✅ Done');
      })
      .catch(async (error) => {
        if (error instanceof CancelledError) {
          await presenter.fail('❌ Cancelled');
          return;
        }
        const message = error instanceof AppError ? error.message : 'job failed, try again';
        await presenter.fail(`⚠️ ${message}`);
      })
      .finally(() => {
        jobManager.release(jobId);
      });

    ctx.session.pendingMetadata = undefined;
    ctx.session.pendingUrl = undefined;
    inspectedByChat.delete(chatId);
  });

  function registerAdminCommands(): void {
    const guard = (id?: number): boolean => id === config.ADMIN_ID;

    bot.command('stats', async (ctx) => {
      if (!guard(ctx.from?.id)) {
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
      if (!guard(ctx.from?.id)) {
        await ctx.reply('not for you');
        return;
      }
      const stats = queue.stats();
      await ctx.reply(
        `pending: ${stats.pending}\nactive: ${stats.active}\nconcurrency: ${stats.concurrency}\nshutting down: ${stats.shuttingDown}`,
      );
    });

    bot.command('providers', async (ctx) => {
      if (!guard(ctx.from?.id)) {
        await ctx.reply('not for you');
        return;
      }
      const health = providerRegistry.health();
      const loaded = health.loaded.map((item) => `${item.name} v${item.version} (${item.priority})`).join('\n') || 'none';
      const disabled = health.disabled.map((item) => item.name).join(', ') || 'none';
      const failed = health.failed.map((item) => `${item.providerId}: ${item.reason}`).join('\n') || 'none';
      await ctx.reply(`loaded:\n${loaded}\n\ndisabled: ${disabled}\n\nfailed:\n${failed}`);
    });

    bot.command('errors', async (ctx) => {
      if (!guard(ctx.from?.id)) {
        await ctx.reply('not for you');
        return;
      }
      const latest = await errorRepository.latest(5);
      await ctx.reply(latest.length === 0 ? 'no recent errors' : latest.map((item) => `[${item.code}] ${item.message}`).join('\n'));
    });

    bot.command('health', async (ctx) => {
      if (!guard(ctx.from?.id)) {
        await ctx.reply('not for you');
        return;
      }
      await ctx.reply('healthy');
    });
  }

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

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) {
    return 'unknown';
  }
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts = hrs > 0 ? [hrs, mins, secs] : [mins, secs];
  return parts.map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0'))).join(':');
}
