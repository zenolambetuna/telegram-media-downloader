import { Bot, session } from 'grammy';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { DatabaseConnection } from '../storage/Database';
import { SqliteMediaRepository } from '../storage/MediaRepository';
import { ThumbnailRepository } from '../storage/ThumbnailRepository';
import { ErrorRepository } from '../storage/ErrorRepository';
import { CounterRepository } from '../storage/CounterRepository';
import { QueueJobRepository } from '../storage/QueueJobRepository';
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
import { DriveApiClient } from '../core/DriveApiClient';
import { HealthCheck } from '../core/HealthCheck';
import { MetricsCollector } from '../core/MetricsCollector';
import { QueueWorker } from '../core/QueueWorker';
import { CompatibilityChecker } from '../core/CompatibilityChecker';
import { DriveSyncService } from '../core/DriveSyncService';
import { MediaSender } from '../telegram/MediaSender';
import { UploadManager } from '../telegram/UploadManager';
import { MessageManager } from '../telegram/MessageManager';
import { FileCache } from '../telegram/FileCache';
import { ThumbnailUploader } from '../telegram/ThumbnailUploader';
import { TelegramStorage } from '../telegram/TelegramStorage';
import { MediaPipeline } from '../core/MediaPipeline';
import { DownloadQueue } from '../queue/DownloadQueue';
import { ProgressReporter } from './ProgressReporter';
import {
  buildMediaTypeKeyboard,
  buildResolutionKeyboard,
  buildCancelKeyboard,
} from './keyboards';
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
  const queueJobRepository = new QueueJobRepository(database);

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

  const queue = new DownloadQueue(config.MAX_CONCURRENT_DOWNLOADS);
  const driveApiClient = new DriveApiClient();
  const healthCheck = new HealthCheck(database, bot.api, driveApiClient);
  const metrics = new MetricsCollector(counterRepository, queueJobRepository);
  const driveSync = new DriveSyncService(driveApiClient, metrics);
  const pipeline = new MediaPipeline(
    providerRegistry,
    downloadEngine,
    telegramStorage,
    counterRepository,
    errorRepository,
    driveSync,
  );
  const worker = new QueueWorker(queueJobRepository, queue, pipeline, counterRepository, errorRepository, metrics, bot.api, driveApiClient);

  // Queue recovery: bring forward any jobs left pending from a previous run.
  if (config.QUEUE_RECOVERY_ENABLED) {
    await worker.recoverPending();
  }

  await downloadEngine.recoverOrphans();

  bot.use(session({ initial: initialSession }));

  bot.use(async (ctx, next) => {
    ctx.pipeline = pipeline;
    await next();
  });

  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) {
      logger.info(
        { callbackData: ctx.callbackQuery.data, userId: ctx.from?.id, messageId: ctx.callbackQuery.message?.message_id },
        'Callback received',
      );
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
    const [pending, processing, dead] = await Promise.all([
      queueJobRepository.countByStatus('pending'),
      queueJobRepository.countByStatus('processing'),
      queueJobRepository.deadLetterCount(),
    ]);
    await ctx.reply(
      `in-memory: pending=${stats.pending} active=${stats.active} concurrency=${stats.concurrency}\n` +
        `persistent: pending=${pending} processing=${processing} dead=${dead}\n` +
        `worker active=${worker.activeCount()}`,
    );
  });

  bot.command('health', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const report = await healthCheck.runRuntime();
    const lines = report.components.map(
      (c) => `${c.status === 'ok' ? '✅' : c.status === 'degraded' ? '⚠️' : '❌'} ${c.name}: ${c.detail ?? ''} (${c.durationMs ?? 0}ms)`,
    );
    await ctx.reply(`status: ${report.status}\n${lines.join('\n')}`);
  });

  bot.command('metrics', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    await ctx.reply(await metrics.asText());
  });

  bot.command('dead', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const dead = await worker.listDeadLetters(10);
    if (dead.length === 0) {
      await ctx.reply('dead letter queue is empty');
      return;
    }
    const lines = dead.map(
      (d) => `${d.id} | ${d.url.slice(0, 40)} | attempts=${d.attempts} | ${d.lastErrorCode ?? 'unknown'} | ${d.lastErrorMessage?.slice(0, 60) ?? ''}`,
    );
    await ctx.reply(`dead letters:\n${lines.join('\n')}\n\n/reply <id> to retry, /drop <id> to remove.`);
  });

  bot.command('retry', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const id = ctx.match;
    if (!id) { await ctx.reply('usage: /retry <id>'); return; }
    const result = await worker.retryDeadLetter(id.trim());
    if (!result) { await ctx.reply('id not found in dead letter queue'); return; }
    await ctx.reply(`re-queued ${result.id} (max_attempts=${config.QUEUE_MAX_RETRIES + 1})`);
  });

  bot.command('drop', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const id = ctx.match;
    if (!id) { await ctx.reply('usage: /drop <id>'); return; }
    const ok = await worker.dropDeadLetter(id.trim());
    await ctx.reply(ok ? `dropped ${id}` : 'id not found');
  });

  // Stage 2.9 — Integration diagnostic commands.
  bot.command('drive', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const checker = new CompatibilityChecker(driveApiClient);
    const report = await checker.run();
    const lines: string[] = [];
    lines.push(`status: ${report.status}`);
    if (report.driveVersion) lines.push(`version: ${report.driveVersion}`);
    if (report.apiVersion) lines.push(`api: ${report.apiVersion}`);
    lines.push(`compatible: ${report.compatibleRange}`);
    for (const e of report.endpointResults) {
      const icon = e.ok ? '✅' : e.reachable ? '⚠️' : '❌';
      lines.push(`${icon} ${e.method} ${e.endpoint}: ${e.detail}`);
    }
    for (const s of report.schemaResults) {
      const icon = s.ok ? '✅' : '⚠️';
      lines.push(`${icon} schema ${s.schema}: ${s.detail}`);
    }
    for (const note of report.notes) {
      lines.push(`• ${note}`);
    }
    await ctx.reply(lines.join('\n'));
  });

  // Stage 4.0 — Drive connection health check.
  bot.command('drivehealth', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    if (!driveApiClient.configured) {
      await ctx.reply('Drive API not configured (set DRIVE_API_BASE_URL and DRIVE_API_KEY)');
      return;
    }
    const lines: string[] = [];
    lines.push('== Drive Connection ==');
    const start = Date.now();
    const health = await driveApiClient.health();
    lines.push(`health: ${health.status} (${Date.now() - start}ms)`);
    if (health.version) lines.push(`version: ${health.version}`);
    if (health.checks) {
      for (const [name, value] of Object.entries(health.checks)) {
        lines.push(`  ${name}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
      }
    }
    const versionStart = Date.now();
    const version = await driveApiClient.getVersion();
    lines.push(`version probe: ${version.ok ? 'ok' : 'failed'} (${Date.now() - versionStart}ms)`);
    if (version.ok && version.body) {
      lines.push(`  service: ${version.body.service}`);
      lines.push(`  version: ${version.body.version}`);
      lines.push(`  api: ${version.body.apiVersion}`);
      if (version.body.engineCompatibility) lines.push(`  compat: ${version.body.engineCompatibility}`);
    } else if (!version.ok) {
      lines.push(`  status: ${version.status}`);
      lines.push(`  error: ${(version.text ?? '').slice(0, 100)}`);
    }
    const snap = await metrics.snapshot();
    lines.push('== Sync Metrics ==');
    lines.push(`success: ${snap.counters.drive_sync_success}`);
    lines.push(`failed:  ${snap.counters.drive_sync_failed}`);
    lines.push(`retry:   ${snap.counters.drive_sync_retry}`);
    lines.push(`dead:    ${snap.counters.drive_sync_dead}`);
    lines.push(`availability: ${snap.driveAvailability.status} (latency=${snap.driveAvailability.latencyMs ?? 'n/a'}ms)`);
    lines.push(`last sync: ${snap.lastSyncAt ?? 'never'}`);
    await ctx.reply(lines.join('\n'));
  });

  bot.command('retryq', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const pending = await queueJobRepository.listByStatus('pending', 20);
    // Retry queue = pending jobs that have already been attempted at least
    // once (i.e. they are waiting for their next attempt) OR are scheduled
    // in the future due to backoff.
    const retryJobs = pending.filter((j) => j.attempts > 0 || (j.nextAttemptAt !== undefined && j.lastErrorCode !== undefined));
    if (retryJobs.length === 0) {
      await ctx.reply('retry queue is empty');
      return;
    }
    const lines = retryJobs.map((j) => {
      const next = j.nextAttemptAt ? new Date(j.nextAttemptAt).toISOString() : 'now';
      return `${j.id} | attempts=${j.attempts}/${j.maxAttempts} | next=${next} | ${j.lastErrorCode ?? 'unknown'} | ${j.url.slice(0, 40)}`;
    });
    await ctx.reply(`retry queue (${retryJobs.length}):\n${lines.join('\n')}`);
  });

  bot.command('deadq', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const dead = await worker.listDeadLetters(20);
    if (dead.length === 0) {
      await ctx.reply('dead queue is empty');
      return;
    }
    const lines = dead.map(
      (d) => `${d.id} | attempts=${d.attempts} | ${d.lastErrorCode ?? 'unknown'} | ${d.lastErrorCategory ?? '?'} | ${d.url.slice(0, 40)}`,
    );
    await ctx.reply(`dead queue (${dead.length}):\n${lines.join('\n')}\n\n/retry <id> | /drop <id>`);
  });

  bot.command('sync', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const snap = await metrics.snapshot();
    const lines: string[] = [];
    lines.push(`last sync: ${snap.lastSyncAt ?? 'never'}`);
    if (snap.syncTimeMs) {
      lines.push(`sync time: avg=${snap.rates.averageSyncTimeMs}ms p50=${snap.syncTimeMs.p50}ms p95=${snap.syncTimeMs.p95}ms max=${snap.syncTimeMs.max}ms n=${snap.syncTimeMs.count}`);
    } else {
      lines.push('sync time: n/a');
    }
    lines.push(`drive sync: success=${snap.counters.drive_sync_success} failed=${snap.counters.drive_sync_failed} retry=${snap.counters.drive_sync_retry}`);
    lines.push(`drive availability: ${snap.driveAvailability.status} (latency=${snap.driveAvailability.latencyMs ?? 'n/a'}ms)`);
    if (snap.driveAvailability.detail) {
      lines.push(`detail: ${snap.driveAvailability.detail}`);
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command('diag', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const lines: string[] = [];
    // 1. Component health (database, telegram, drive).
    const report = await healthCheck.runRuntime();
    lines.push('== Health ==');
    for (const c of report.components) {
      const icon = c.status === 'ok' ? '✅' : c.status === 'degraded' ? '⚠️' : '❌';
      lines.push(`${icon} ${c.name}: ${c.detail ?? ''} (${c.durationMs ?? 0}ms)`);
    }
    // 2. Queue snapshot.
    const queueStats = queue.stats();
    const [pending, processing, deadCount] = await Promise.all([
      queueJobRepository.countByStatus('pending'),
      queueJobRepository.countByStatus('processing'),
      queueJobRepository.deadLetterCount(),
    ]);
    lines.push('== Queue ==');
    lines.push(`in-memory: active=${queueStats.active} pending=${queueStats.pending} concurrency=${queueStats.concurrency}`);
    lines.push(`persistent: pending=${pending} processing=${processing} dead=${deadCount}`);
    lines.push(`worker active=${worker.activeCount()}`);
    // 3. Metrics summary.
    const snap = await metrics.snapshot();
    lines.push('== Metrics ==');
    lines.push(`success=${snap.counters.queue_success} failed=${snap.counters.queue_failed} retry=${snap.counters.queue_retry} dead=${snap.counters.queue_dead}`);
    lines.push(`success_rate=${(snap.rates.successRate * 100).toFixed(1)}% retry_rate=${(snap.rates.retryRate * 100).toFixed(1)}%`);
    lines.push(`drive_sync: success=${snap.counters.drive_sync_success} failed=${snap.counters.drive_sync_failed}`);
    lines.push(`drive_availability: ${snap.driveAvailability.status}`);
    lines.push(`last_sync: ${snap.lastSyncAt ?? 'never'}`);
    // 4. Drive compatibility (only if configured — otherwise it's redundant).
    if (driveApiClient.configured) {
      const checker = new CompatibilityChecker(driveApiClient);
      const compat = await checker.run();
      lines.push('== Drive Bridge ==');
      lines.push(`compat: ${compat.status}`);
      if (compat.driveVersion) lines.push(`version: ${compat.driveVersion}`);
      if (compat.notes.length > 0) lines.push(`notes: ${compat.notes.join('; ')}`);
    } else {
      lines.push('== Drive Bridge ==');
      lines.push('not configured');
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command('providers', async (ctx) => {
    if (ctx.from?.id !== config.ADMIN_ID) { await ctx.reply('not for you'); return; }
    const health = providerRegistry.health();
    const loaded = health.loaded.map((item) => `${item.name} v${item.version} (${item.priority})`).join('\n') || 'none';
    const failed = health.failed.map((item) => `${item.providerId}: ${item.reason}`).join('\n') || 'none';
    await ctx.reply(`loaded:\n${loaded}\n\nfailed:\n${failed}`);
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    assertValidUrl(text);

    const platform = providerRegistry.platformFor(text);
    const resolved = await metadataService.fetch(text, platform);

    ctx.session.pendingUrl = text;
    ctx.session.pendingInfo = resolved;

    logger.info(
      { platform: resolved.platform, hasVideo: resolved.hasVideo, hasAudio: resolved.hasAudio, videoCount: resolved.videoFormats.length, audioCount: resolved.audioFormats.length, supportsResolutionSelection: resolved.supportsResolutionSelection },
      'Media resolved - building keyboard',
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

  bot.callbackQuery('media:video', async (ctx) => {
    const info = ctx.session.pendingInfo;
    const url = ctx.session.pendingUrl;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    logger.info({ hasInfo: !!info, hasUrl: !!url }, 'media:video callback');

    if (!info || !url || userId === undefined || chatId === undefined) {
      await ctx.answerCallbackQuery({ text: 'Session expired - send the URL again' });
      return;
    }

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

      await startDownload(ctx, url, format.id, format.quality, userId, chatId, worker);
    }
  });

  bot.callbackQuery('media:audio', async (ctx) => {
    const info = ctx.session.pendingInfo;
    const url = ctx.session.pendingUrl;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    logger.info({ hasInfo: !!info, hasUrl: !!url }, 'media:audio callback');

    if (!info || !url || userId === undefined || chatId === undefined) {
      await ctx.answerCallbackQuery({ text: 'Session expired - send the URL again' });
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

    await startDownload(ctx, url, format.id, format.quality, userId, chatId, worker);
  });

  bot.callbackQuery(/^format:(.+)$/, async (ctx) => {
    const formatId = ctx.match[1];
    const info = ctx.session.pendingInfo;
    const url = ctx.session.pendingUrl;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    logger.info({ formatId, hasInfo: !!info, hasUrl: !!url }, 'format: callback');

    if (!info || !url || userId === undefined || chatId === undefined) {
      await ctx.answerCallbackQuery({ text: 'Session expired - send the URL again' });
      return;
    }

    const format = info.videoFormats.find((f) => f.id === formatId) || info.audioFormats.find((f) => f.id === formatId);
    if (!format) {
      await ctx.answerCallbackQuery({ text: 'That format is no longer available' });
      return;
    }

    logger.info({ formatId: format.id, quality: format.quality, kind: format.kind }, 'Format selected - starting download');
    await ctx.answerCallbackQuery();
    ctx.session.pendingUrl = undefined;
    ctx.session.pendingInfo = undefined;

    await startDownload(ctx, url, format.id, format.quality, userId, chatId, worker);
  });

  bot.callbackQuery('abort', async (ctx) => {
    ctx.session.pendingUrl = undefined;
    ctx.session.pendingInfo = undefined;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
  });

  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    const jobToken = ctx.match[1];
    const cancelledPending = queue.cancelPending(jobToken);
    const cancelledPersistent = await worker.cancelPending(jobToken);
    await ctx.answerCallbackQuery({
      text: cancelledPending || cancelledPersistent ? 'Cancelling...' : 'Too late to cancel',
    });
  });

  return {
    start: async () => {
      if (config.HEALTH_CHECK_ENABLED) {
        // runStartup() already calls bot.api.getMe() for the telegram_bot
        // component, so we do not invoke it again here.
        await healthCheck.runStartup();
      } else {
        await bot.api.getMe();
      }
      if (config.WORKER_ENABLED) {
        await worker.start();
      }
      await bot.start();
      logger.info('bot started');
    },
    stop: async () => {
      await worker.stop();
      await queue.shutdown();
      await bot.stop();
      database.close();
      logger.info('bot stopped');
    },
  };
}

/**
 * startDownload enqueues a durable job through the QueueWorker. The live
 * progress message is wired to the worker via attachProgress/attachCompletion
 * so the user still sees stage updates and a final status line, while the
 * worker handles persistence, retry, and dead-letter routing.
 */
async function startDownload(
  ctx: BotContext,
  url: string,
  formatId: string,
  quality: string,
  userId: number,
  chatId: number,
  worker: QueueWorker,
): Promise<void> {
  const jobToken = randomUUID().slice(0, 8);
  const progressMessage = await ctx.reply('Queued...', { reply_markup: buildCancelKeyboard(jobToken) });
  const reporter = new ProgressReporter(ctx.api, chatId, progressMessage.message_id, buildCancelKeyboard(jobToken));

  worker.attachProgress(jobToken, (update) => {
    void reporter.update(update);
  });
  worker.attachCompletion(
    jobToken,
    async (result) => {
      logger.info({ queueId: jobToken, cached: result.cached }, 'Download finished');
      await reporter.finalize(result.cached ? 'Served instantly from Telegram Drive cache' : 'Done');
    },
    async (error) => {
      const message = error instanceof AppError && error.code === 'CANCELLED'
        ? 'Cancelled'
        : `Error: ${error instanceof Error ? error.message : 'Job failed'}`;
      logger.error({ queueId: jobToken, error: error instanceof Error ? error.message : String(error) }, 'Download failed');
      await reporter.finalize(message);
    },
  );

  logger.info({ queueId: jobToken, formatId, quality }, 'Download enqueued');

  await worker.enqueue({
    jobId: jobToken,
    url,
    formatId,
    quality,
    userId,
    chatId,
    ownerId: userId,
    requestId: jobToken,
  });
}
