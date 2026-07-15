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
import {
  buildMediaTypeKeyboard,
  buildResolutionKeyboard,
  buildCancelKeyboard,
} from './keyboards';
import { BotContext, SessionData } from '../types/bot';
import { ResolvedMediaInfo } from '../types/media';
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

  await tempFileManager.init();

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

  // Inject pipeline into context
  bot.use(async (ctx, next) => {
    ctx.pipeline = pipeline;
    await next();
  });

  // -- Debug logging middleware --
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) {
      logger.info(
        {
          callbackData: ctx.callbackQuery.data,
          userId: ctx.from?.id,
          messageId: ctx.callbackQuery.message?.message_id,
        },
        'Callback received',
      );
    }
    await next();
  });

  // -- Rate limiter --
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      await rateLimit(ctx.from.id);
    }
    await next();
  });

  // -- Global error handler --
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

  // -- Admin commands --
  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Send a supported media URL. I detect the provider, show real available formats, download and merge, store it in your Telegram Drive channel, and send it back. Duplicate media at the same quality is reused instantly.',
    );
  });

  bot.command('stats', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const [cacheCount, uploads, cacheHits, errors] = await Promise.all([
      telegramStorage.cacheCount(),
      counterRepository.get('uploads'),
      counterRepository.get('cache_hits'),
      errorRepository.count(),
    ]);
    await ctx.reply(`cache: ${cacheCount}\nuploads: ${uploads}\ncache hits: ${cacheHits}\nerrors: ${errors}`);
  });

  bot.command('queue', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const stats = queue.stats();
    await ctx.reply(`pending: ${stats.pending}\nactive: ${stats.active}\nconcurrency: ${stats.concurrency}`);
  });

  bot.command('providers', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const health = providerRegistry.health();
    const loaded = health.loaded.map((item) => `${item.name} v${item.version} (${item.priority})`).join('\n') || 'none';
    const failed = health.failed.map((item) => `${item.providerId}: ${item.reason}`).join('\n') || 'none';
    await ctx.reply(`loaded:\n${loaded}\n\nfailed:\n${failed}`);
  });

  // ============================================================
  // LINK INPUT → Detect → Resolve → Show 🎥 MP4 / 🎵 MP3 / ❌ Cancel
  // ============================================================
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    assertValidUrl(text);

    // Get resolved media info via FormatResolver
    const platform = providerRegistry.platformFor(text);
    const resolved = await metadataService.fetch(text, platform);

    // Store in session for callback handlers
    ctx.session.pendingUrl = text;
    ctx.session.pendingInfo = resolved;

    logger.info(
      {
        platform: resolved.platform,
        hasVideo: resolved.hasVideo,
        hasAudio: resolved.hasAudio,
        videoCount: resolved.videoFormats.length,
        audioCount: resolved.audioFormats.length,
        supportsResolutionSelection: resolved.supportsResolutionSelection,
      },
      'Media resolved — building keyboard',
    );

    const durationText = resolved.duration ? `${resolved.duration}s` : 'unknown';
    const info = [
      `📀 ${resolved.platform}`,
      `🏷️ ${resolved.title}`,
      `⏱️ ${durationText}`,
      resolved.uploader ? `👤 ${resolved.uploader}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');

    const keyboard = buildMediaTypeKeyboard(resolved);

    if (resolved.thumbnail) {
      await ctx.replyWithPhoto(resolved.thumbnail, { caption: info, reply_markup: keyboard }).catch(async () => {
        await ctx.reply(info, { reply_markup: keyboard });
      });
    } else {
      await ctx.reply(info, { reply_markup: keyboard });
    }
  });

  // ============================================================
  // CALLBACK: "media:video" — user pressed 🎥 MP4
  // ============================================================
  bot.callbackQuery('media:video', async (ctx) => {
    const info = ctx.session.pendingInfo;
    const url = ctx.session.pendingUrl;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    logger.info({ hasInfo: !!info, hasUrl: !!url }, 'media:video callback');

    if (!info || !url || userId === undefined || chatId === undefined) {
      await ctx.answerCallbackQuery({ text: '⏳ Session expired — send the URL again' });
      return;
    }

    // Check if we need a resolution picker
    if (info.supportsResolutionSelection) {
      logger.info({ platform: info.platform, resolutions: info.videoFormats.map(f => f.quality) }, 'Showing resolution picker');
      const keyboard = buildResolutionKeyboard(info);
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      } catch {
        await ctx.reply('Choose video quality:', { reply_markup: keyboard });
      }
      await ctx.answerCallbackQuery();
    } else {
      // Direct download — no resolution picker needed
      const format = info.bestVideo;
      if (!format) {
        logger.error({ platform: info.platform }, 'No best video despite hasVideo=true');
        await ctx.answerCallbackQuery({ text: 'No video format available' });
        return;
      }

      logger.info({ platform: info.platform, formatId: format.id, quality: format.quality }, 'Starting video download (single quality)');
      await ctx.answerCallbackQuery();
      ctx.session.pendingUrl = undefined;
      ctx.session.pendingInfo = undefined;

      await startDownload(ctx, url, format.id, format.quality, userId, chatId, queue, cancellations);
    }
  });

  // ============================================================
  // CALLBACK: "media:audio" — user pressed 🎵 MP3
  // ============================================================
  bot.callbackQuery('media:audio', async (ctx) => {
    const info = ctx.session.pendingInfo;
    const url = ctx.session.pendingUrl;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    logger.info({ hasInfo: !!info, hasUrl: !!url }, 'media:audio callback');

    if (!info || !url || userId === undefined || chatId === undefined) {
      await ctx.answerCallbackQuery({ text: '⏳ Session expired — send the URL again' });
      return;
    }

    const format = info.bestAudio;
    if (!format) {
      await ctx.answerCallbackQuery({ text: 'No audio format available' });
      return;
    }

    logger.info({ platform: info.platform, formatId: format.id, quality: format.quality }, 'Starting audio download');
    await ctx.answerCallbackQuery();
    ctx.session.pendingUrl = undefined;
    ctx.session.pendingInfo = undefined;

    await startDownload(ctx, url, format.id, format.quality, userId, chatId, queue, cancellations);
  });

  // ============================================================
  // CALLBACK: "format:{formatId}" — user picked a specific resolution
  // ============================================================
  bot.callbackQuery(/^format:(.+)$/, async (ctx) => {
    const formatId = ctx.match[1];
    const info = ctx.session.pendingInfo;
    const url = ctx.session.pendingUrl;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    logger.info({ formatId, hasInfo: !!info, hasUrl: !!url }, 'format: callback');

    if (!info || !url || userId === undefined || chatId === undefined) {
      await ctx.answerCallbackQuery({ text: '⏳ Session expired — send the URL again' });
      return;
    }

    const format = info.videoFormats.find((f) => f.id === formatId) || info.audioFormats.find((f) => f.id === formatId);
    if (!format) {
      await ctx.answerCallbackQuery({ text: 'That format is no longer available' });
      return;
    }

    logger.info({ formatId: format.id, quality: format.quality, kind: format.kind }, 'Format selected — starting download');
    await ctx.answerCallbackQuery();
    ctx.session.pendingUrl = undefined;
    ctx.session.pendingInfo = undefined;

    await startDownload(ctx, url, format.id, format.quality, userId, chatId, queue, cancellations);
  });

  // ============================================================
  // CALLBACK: "abort"
  // ============================================================
  bot.callbackQuery('abort', async (ctx) => {
    ctx.session.pendingUrl = undefined;
    ctx.session.pendingInfo = undefined;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
  });

  // ============================================================
  // CALLBACK: "cancel:{jobToken}"
  // ============================================================
  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    const jobToken = ctx.match[1];
    const cancelledPending = queue.cancelPending(jobToken);
    const cancelledActive = cancellations.cancel(jobToken);
    await ctx.answerCallbackQuery({
      text: cancelledPending || cancelledActive ? 'Cancelling...' : 'Too late to cancel',
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

// ============================================================
// Shared download starter
// ============================================================
async function startDownload(
  ctx: BotContext,
  url: string,
  formatId: string,
  quality: string,
  userId: number,
  chatId: number,
  queue: DownloadQueue,
  cancellations: CancellationRegistry,
): Promise<void> {
  const jobToken = randomUUID().slice(0, 8);
  const cancellation = cancellations.create(jobToken);
  const progressMessage = await ctx.reply('⏳ Queued...', { reply_markup: buildCancelKeyboard(jobToken) });
  const reporter = new ProgressReporter(ctx.api, chatId, progressMessage.message_id, buildCancelKeyboard(jobToken));

  logger.info({ jobToken, formatId, quality, url }, 'Download started');

  void queue
    .add(jobToken, async () => {
      cancellation.throwIfCancelled();
      return await ctx.pipeline.execute({
        url,
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
      logger.info({ jobToken, cached: result.cached }, 'Download finished');
      await reporter.finalize(result.cached ? '✅ Served instantly from Telegram Drive cache' : '✅ Done');
    })
    .catch(async (error) => {
      const message = error instanceof AppError && error.code === 'CANCELLED'
        ? '🛑 Cancelled'
        : `⚠️ ${error instanceof Error ? error.message : 'Job failed'}`;
      logger.error({ jobToken, error: error instanceof Error ? error.message : String(error) }, 'Download failed');
      await reporter.finalize(message);
    })
    .finally(() => {
      cancellations.release(jobToken);
    });
}
