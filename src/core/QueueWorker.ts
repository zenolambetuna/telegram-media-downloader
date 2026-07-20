import { randomUUID } from 'node:crypto';
import { Api } from 'grammy';
import { config } from '../config/env';
import { logger, loggerFor } from '../logger/logger';
import { DownloadQueue } from '../queue/DownloadQueue';
import { CancellationRegistry } from '../queue/CancellationToken';
import { QueueJobRepository, QueueJobRecord, DeadLetterRecord } from '../storage/QueueJobRepository';
import { CounterRepository } from '../storage/CounterRepository';
import { ErrorRepository } from '../storage/ErrorRepository';
import { MetricsCollector } from './MetricsCollector';
import { MediaPipeline } from './MediaPipeline';
import { DriveApiClient } from './DriveApiClient';
import { AppError, ErrorCategory, categorize, isRetryableCode } from '../types/errors';
import { ProgressUpdate } from '../types/download';

/**
 * QueueWorker is the Stage 2.8 background worker. It owns three flows:
 *
 * - Pending Queue: pulls rows from `queue_jobs` whose `next_attempt_at` is due
 *   and submits them to the in-memory `DownloadQueue` for concurrency control.
 * - Retry Queue: when a job fails with a retryable category and has remaining
 *   attempts, the worker schedules it back into the pending queue with an
 *   exponential backoff.
 * - Dead Queue: when a job exhausts its retry budget or fails with a
 *   permanent error, it is moved to `dead_letter` for inspection.
 *
 * The worker runs in a separate async loop so it never blocks the grammY
 * update handler. It cooperates with graceful shutdown: in-flight jobs are
 * allowed to finish, but no new jobs are claimed after shutdown starts.
 */
export class QueueWorker {
  private readonly pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();
  private running = false;
  private readonly loopPromise: { current?: Promise<void> } = {};
  private readonly activeJobIds = new Set<string>();
  private readonly cancellationRegistry: CancellationRegistry;
  private readonly progressCallbacks = new Map<string, (update: ProgressUpdate) => void>();
  private readonly completionCallbacks = new Map<
    string,
    { onResult: (r: JobResult) => void; onError: (e: unknown) => void }
  >();
  private tickCounter = 0;

  constructor(
    private readonly queueJobs: QueueJobRepository,
    private readonly queue: DownloadQueue,
    private readonly pipeline: MediaPipeline,
    private readonly counters: CounterRepository,
    private readonly errors: ErrorRepository,
    private readonly metrics: MetricsCollector,
    private readonly botApi: Api,
    private readonly driveClient?: DriveApiClient,
  ) {
    this.cancellationRegistry = new CancellationRegistry();
  }

  /**
   * Register a live progress callback for a job that is about to be enqueued.
   * The bot layer uses this to wire the in-line progress message to the job
   * so users still get stage updates while the worker handles durability.
   */
  attachProgress(jobId: string, onProgress: (update: ProgressUpdate) => void): void {
    this.progressCallbacks.set(jobId, onProgress);
  }

  /**
   * Register completion callbacks for a job that is about to be enqueued. The
   * bot layer uses this so the live UX (finalise the progress message) still
   * fires even though the worker owns the lifecycle.
   */
  attachCompletion(
    jobId: string,
    onResult: (r: JobResult) => void,
    onError: (e: unknown) => void,
  ): void {
    this.completionCallbacks.set(jobId, { onResult, onError });
  }

  /** Detach all live callbacks for a job (called after finalise). */
  detachLive(jobId: string): void {
    this.progressCallbacks.delete(jobId);
    this.completionCallbacks.delete(jobId);
  }

  /**
   * Enqueue a brand new job. The user-facing `startDownload` flow calls this
   * so the job is durable across restarts. The job runs as soon as the
   * worker claims it from the pending queue. Returns the job id (also
   * stored in the DB) so the caller can attach it to the inline keyboard.
   */
  async enqueue(request: EnqueueRequest): Promise<string> {
    const id = request.jobId ?? randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const record: QueueJobRecord = {
      id,
      kind: 'download',
      status: 'pending',
      attempts: 0,
      maxAttempts: config.QUEUE_MAX_RETRIES + 1,
      url: request.url,
      formatId: request.formatId,
      quality: request.quality,
      userId: request.userId,
      chatId: request.chatId,
      ownerId: request.ownerId ?? request.userId,
      requestId: request.requestId,
      createdAt: now,
      updatedAt: now,
    };
    await this.queueJobs.enqueue(record);
    await this.counters.increment('queue_enqueued');
    logger.info({ queueId: id, url: request.url, ownerId: record.ownerId }, 'job enqueued');
    return id;
  }

  /** Returns true if the job was pending and is now cancelled. */
  async cancelPending(jobId: string): Promise<boolean> {
    const record = await this.queueJobs.findById(jobId);
    if (!record) {
      return this.cancellationRegistry.cancel(jobId);
    }
    if (record.status === 'pending') {
      await this.queueJobs.markDead(jobId, { code: 'CANCELLED', message: 'cancelled by user', category: 'permanent' });
      return true;
    }
    return this.cancellationRegistry.cancel(jobId);
  }

  /** Start the background loop. Idempotent. */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loopPromise.current = this.loop();
    logger.info({ tickMs: config.WORKER_TICK_MS }, 'queue worker started');
  }

  /** Graceful shutdown. Waits up to WORKER_GRACEFUL_SHUTDOWN_MS for in-flight jobs. */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    logger.info('queue worker stopping - waiting for in-flight jobs');
    const deadline = Date.now() + config.WORKER_GRACEFUL_SHUTDOWN_MS;
    await Promise.race([
      this.loopPromise.current,
      new Promise<void>((resolve) => setTimeout(() => resolve(), Math.max(0, deadline - Date.now()))),
    ]);
    await this.queue.shutdown();
    logger.info('queue worker stopped');
  }

  /**
   * Recover any pending jobs left from a previous run. Called once at startup
   * before the worker loop starts. Pending jobs stay pending and are picked
   * up naturally; `processing` jobs are already reset to `pending` by the
   * Database migration, so we just log the count.
   */
  async recoverPending(): Promise<number> {
    const pending = await this.queueJobs.listByStatus('pending', 1000);
    if (pending.length > 0) {
      logger.info({ recovered: pending.length }, 'recovered pending jobs from previous run');
    }
    return pending.length;
  }

  /** Returns the number of jobs currently being executed by this worker. */
  activeCount(): number {
    return this.activeJobIds.size;
  }

  async listDeadLetters(limit = 20): Promise<DeadLetterRecord[]> {
    return await this.queueJobs.listDeadLetters(limit);
  }

  async retryDeadLetter(id: string): Promise<DeadLetterRecord | null> {
    return await this.queueJobs.requeueFromDeadLetter(id, config.QUEUE_MAX_RETRIES + 1);
  }

  async dropDeadLetter(id: string): Promise<boolean> {
    return await this.queueJobs.deleteDeadLetter(id);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const tickStart = Date.now();
      try {
        await this.tick();
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, 'queue worker tick failed');
      }
      const elapsed = Date.now() - tickStart;
      const sleep = Math.max(0, config.WORKER_TICK_MS - elapsed);
      await new Promise((resolve) => setTimeout(resolve, sleep));
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    // Claim and dispatch one job per tick. Concurrency is still controlled by
    // the in-memory DownloadQueue; the worker just feeds it. We avoid
    // claiming more than we can run by checking queue.stats().
    const stats = this.queue.stats();
    const [pending, processing, dead] = await Promise.all([
      this.queueJobs.countByStatus('pending'),
      this.queueJobs.countByStatus('processing'),
      this.queueJobs.deadLetterCount(),
    ]);

    // Live monitoring snapshot. Cheap counters are emitted every tick so
    // external log shippers can build dashboards without polling the bot.
    this.metrics.setQueueDepth('pending', pending);
    this.metrics.setQueueDepth('processing', processing);
    this.metrics.setQueueDepth('in_memory_active', stats.active);
    this.metrics.setQueueDepth('in_memory_pending', stats.pending);
    this.metrics.setQueueDepth('dead_letter', dead);

    if (this.tickCounter % 15 === 0) {
      logger.info(
        {
          pending,
          processing,
          dead,
          inMemoryActive: stats.active,
          inMemoryPending: stats.pending,
          activeJobs: this.activeJobIds.size,
        },
        'queue tick',
      );
      // Probe Drive availability every 15 ticks so the /metrics gauge stays
      // fresh without a separate flush loop. The probe is fire-and-forget.
      void this.probeDriveAvailability();
    }
    this.tickCounter += 1;

    if (stats.pending > 0) {
      // The in-memory queue already has work; let it drain.
      return;
    }
    if (stats.active >= stats.concurrency) {
      return;
    }

    const claimed = await this.queueJobs.claimNext(now, config.QUEUE_PROCESSING_TIMEOUT_MS);
    if (!claimed) {
      return;
    }
    this.activeJobIds.add(claimed.id);
    void this.runJob(claimed).finally(() => {
      this.activeJobIds.delete(claimed.id);
    });
  }

  private async runJob(record: QueueJobRecord): Promise<void> {
    const cancellation = this.cancellationRegistry.create(record.id);
    const log = loggerFor({
      queueId: record.id,
      requestId: record.requestId,
      ownerId: record.ownerId,
    });
    const liveProgress = this.progressCallbacks.get(record.id);
    const liveCompletion = this.completionCallbacks.get(record.id);

    const startedAt = Date.now();
    log.info({ url: record.url, attempts: record.attempts, maxAttempts: record.maxAttempts }, 'job started');

    const onProgress = (update: ProgressUpdate) => {
      if (liveProgress) {
        liveProgress(update);
      }
      log.debug({ stage: update.stage, ratio: update.ratio }, 'job progress');
    };

    try {
      const result = await this.queue.add<JobResult>(record.id, async () => {
        cancellation.throwIfCancelled();
        return await this.pipeline.execute({
          url: record.url,
          formatId: record.formatId,
          quality: record.quality,
          userId: record.userId,
          chatId: record.chatId,
          cancellation,
          onProgress,
          queueId: record.id,
        });
      });

      await this.queueJobs.markCompleted(record.id);
      await this.counters.increment('queue_success');
      this.metrics.recordProcessing(Date.now() - startedAt);
      this.metrics.markSync();
      log.info(
        { cached: result.cached, processingDurationMs: Date.now() - startedAt },
        'job completed',
      );
      if (liveCompletion) {
        liveCompletion.onResult(result);
        this.detachLive(record.id);
      }
    } catch (error) {
      const category = categorize(error);
      const code = error instanceof AppError ? error.code : 'DOWNLOAD_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      const attempt = record.attempts + 1;
      const isCancelled = code === 'CANCELLED';

      await this.errors.log({
        code,
        message,
        context: JSON.stringify({ queueId: record.id, url: record.url, ownerId: record.ownerId, attempt }),
      });

      if (isCancelled) {
        await this.queueJobs.markDead(record.id, { code, message, category });
        await this.counters.increment('queue_dead');
        log.info({ attempt, processingDurationMs: Date.now() - startedAt }, 'job cancelled');
        if (liveCompletion) {
          liveCompletion.onError(error);
          this.detachLive(record.id);
        }
        return;
      }

      const canRetry = isRetryableCode(code) && attempt < record.maxAttempts;
      if (canRetry) {
        const delay = this.backoffMs(attempt);
        const nextAttemptAt = new Date(Date.now() + delay);
        await this.queueJobs.incrementAttempts(record.id);
        await this.queueJobs.markPending(record.id, nextAttemptAt, { code, message, category });
        await this.counters.increment('queue_retry');
        log.warn(
          { attempt, maxAttempts: record.maxAttempts, nextAttemptAt: nextAttemptAt.toISOString(), code, category },
          'job scheduled for retry',
        );
        // Note: do not detach the live progress callback on retry. The
        // next attempt will reuse it. If the bot restarts before the next
        // attempt, the callback is lost (acceptable: the recovered job
        // still completes and the user receives the media).
        return;
      }

      // Permanent error or out of retries -> dead letter.
      await this.queueJobs.markDead(record.id, { code, message, category });
      await this.counters.increment('queue_failed');
      await this.counters.increment('queue_dead');
      log.error(
        { attempt, maxAttempts: record.maxAttempts, code, category, processingDurationMs: Date.now() - startedAt },
        'job moved to dead letter',
      );
      if (liveCompletion) {
        liveCompletion.onError(error);
        this.detachLive(record.id);
      }
    } finally {
      this.cancellationRegistry.release(record.id);
    }
  }

  private backoffMs(attempt: number): number {
    // Exponential backoff with a small jitter to avoid thundering herd on a
    // shared network failure. Capped at 5 minutes.
    const base = config.QUEUE_RETRY_BASE_DELAY_MS;
    const exponential = base * Math.pow(2, Math.min(attempt, 6));
    const jitter = Math.floor(Math.random() * 250);
    return Math.min(exponential + jitter, 5 * 60 * 1000);
  }

  /**
   * Probe the Drive Bridge health endpoint and record the result as a gauge
   * on the MetricsCollector. Fire-and-forget so the tick loop never blocks
   * on a slow Drive. Skipped when the Drive is not configured.
   */
  private async probeDriveAvailability(): Promise<void> {
    if (!this.driveClient || !this.driveClient.configured) {
      this.metrics.recordDriveAvailability({
        status: 'unknown',
        lastCheckedAt: new Date().toISOString(),
        detail: 'drive api not configured',
      });
      return;
    }
    const start = Date.now();
    try {
      const result = await this.driveClient.health();
      const status = result.status === 'ok' ? 'ok' : result.status === 'degraded' ? 'degraded' : 'down';
      this.metrics.recordDriveAvailability({
        status,
        lastCheckedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        detail: status === 'down' ? (result.checks?.error as string | undefined) ?? 'unknown error' : undefined,
      });
    } catch (error) {
      this.metrics.recordDriveAvailability({
        status: 'down',
        lastCheckedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        detail: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }
}

export interface EnqueueRequest {
  jobId?: string;
  url: string;
  formatId: string;
  quality: string;
  userId: number;
  chatId: number;
  ownerId?: number;
  requestId?: string;
}

interface JobResult {
  messageId: number;
  cached: boolean;
}

export type { ErrorCategory };
