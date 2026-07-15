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

  // DEBUG: Log ALL updates to verify callback_query updates reach the bot
  bot.use(async (ctx, next) => {
    let updateType = 'unknown';
    if (ctx.callbackQuery) {
      updateType = 'callback_query';
    } else if (ctx.message) {
      updateType = 'message';
    } else if (ctx.inlineQuery) {
      updateType = 'inline_query';
    } else if (ctx.editedMessage) {
      updateType = 'edited_message';
    } else if (ctx.channelPost) {
      updateType = 'channel_post';
    } else if (ctx.editedChannelPost) {
      updateType = 'edited_channel_post';
    } else if (ctx.chatMember) {
      updateType = 'chat_member';
    } else if (ctx.myChatMember) {
      updateType = 'my_chat_member';
    } else if (ctx.chatJoinRequest) {
      updateType = 'chat_join_request';
    } else if (ctx.poll) {
      updateType = 'poll';
    } else if (ctx.pollAnswer) {
      updateType = 'poll_answer';
    } else if (ctx.shippingQuery) {
      updateType = 'shipping_query';
    } else if (ctx.preCheckoutQuery) {
      updateType = 'pre_checkout_query';
    } else if (ctx.chosenInlineResult) {
      updateType = 'chosen_inline_result';
    }
    
    console.log('[UPDATE] type:', updateType, 'data:', JSON.stringify(ctx.update).slice(0, 200));
    if (ctx.callbackQuery) {
      console.log('[CALLBACK] update received', {
        callbackId: ctx.callbackQuery.id,
        callbackData: ctx.callbackQuery.data,
        from: ctx.callbackQuery.from?.id,
        messageId: ctx.callbackQuery.message?.message_id,
      });
    }
    await next();
  });

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

    console.log('[DEBUG] Session updated:', {
      pendingUrl: ctx.session.pendingUrl,
      metadataHasFormats: !!(inspected.metadata.formats?.length),
      metadataFormatCount: inspected.metadata.formats.length
    });

    // DEBUG: Log format counts from metadata
    const videoCount = inspected.metadata.formats.filter(f => f.kind === 'video').length;
    const audioCount = inspected.metadata.formats.filter(f => f.kind === 'audio').length;
    console.log('[DEBUG] metadata.formats:', {
      total: inspected.metadata.formats.length,
      video: videoCount,
      audio: audioCount,
      types: inspected.metadata.formats.map(f => ({ id: f.id, kind: f.kind, quality: f.quality }))
    });
    console.log('[DEBUG] NormalizedFormat from inspect():', inspected.formats.map(f => ({ id: f.id, kind: f.kind, hasVideo: f.hasVideo, hasAudio: f.hasAudio })));

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
    console.log('[DEBUG] Sending message with keyboard, formats count:', inspected.metadata.formats.length);
    if (inspected.metadata.thumbnail) {
      await ctx.replyWithPhoto(inspected.metadata.thumbnail, { caption: info, reply_markup: keyboard }).catch(async () => {
        await ctx.reply(info, { reply_markup: keyboard });
      });
    } else {
      await ctx.reply(info, { reply_markup: keyboard });
    }
    console.log('[DEBUG] Message sent');
  });

  bot.callbackQuery(/^kind:(video|audio)$/, async (ctx) => {
    console.log('[CALLBACK] kind handler invoked');
    const kind = ctx.match[1] as 'video' | 'audio';
    console.log('[CALLBACK] received kind:', kind);
    console.log('[CALLBACK] data:', ctx.callbackQuery.data);
    const metadata = ctx.session.pendingMetadata;
    console.log('[CALLBACK] session found:', !!metadata);
    if (!metadata) {
      console.log('[CALLBACK] ERROR: no pendingMetadata in session');
      await ctx.answerCallbackQuery({ text: 'request expired' });
      return;
    }
    console.log('[CALLBACK] metadata formats count:', metadata.formats.length);
    const keyboard = buildFormatKeyboard(metadata.formats, kind);
    console.log('[CALLBACK] sending format keyboard');
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      console.log('[CALLBACK] editMessageReplyMarkup succeeded');
    } catch (error) {
      console.log('[CALLBACK] editMessageReplyMarkup failed, sending new message:', error);
      await ctx.reply(`Pick ${kind} quality`, { reply_markup: keyboard });
    }
    await ctx.answerCallbackQuery();
    console.log('[CALLBACK] answered');
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

  bot.callbackQuery(/^format:(.+)$/, async (ctx) => {
    const formatId = ctx.match[1];
    console.log('[CALLBACK] received format:', formatId);
    const metadata = ctx.session.pendingMetadata;
    const url = ctx.session.pendingUrl;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    console.log('[CALLBACK] session found:', !!metadata, !!url, !!userId, !!chatId);
    if (!metadata || !url || userId === undefined || chatId === undefined) {
      console.log('[CALLBACK] ERROR: missing session data');
      await ctx.answerCallbackQuery({ text: 'request expired' });
      return;
    }
    const format = metadata.formats.find((item) => item.id === formatId);
    console.log('[CALLBACK] selected format:', format ? { id: format.id, kind: format.kind, quality: format.quality } : null);
    if (!format) {
      console.log('[CALLBACK] ERROR: format not found with id', formatId);
      await ctx.answerCallbackQuery({ text: 'that format is gone' });
      return;
    }

    await ctx.answerCallbackQuery();
    console.log('[CALLBACK] answered callback');

    const jobToken = randomUUID().slice(0, 8);
    const cancellation = cancellations.create(jobToken);
    console.log('[CALLBACK] download started, token:', jobToken);
    const progressMessage = await ctx.reply('Queued', { reply_markup: buildCancelKeyboard(jobToken) });
    const reporter = new ProgressReporter(ctx.api, chatId, progressMessage.message_id, buildCancelKeyboard(jobToken));

    const url2 = url;
    const quality = format.quality;
    const selectedFormatId = format.id;

    ctx.session.pendingMetadata = undefined;
    ctx.session.pendingUrl = undefined;

    void queue
      .add(jobToken, async () => {
        cancellation.throwIfCancelled();
        console.log('[CALLBACK] executing pipeline');
        return await pipeline.execute({
          url: url2,
          formatId: selectedFormatId,
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
        console.log('[CALLBACK] download finished, cached:', result.cached);
        await reporter.finalize(result.cached ? '✅ Served instantly from Telegram Drive cache' : '✅ Done');
      })
      .catch(async (error) => {
        console.log('[CALLBACK] ERROR:', error);
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
