import { CounterRepository } from '../storage/CounterRepository';
import { QueueJobRepository } from '../storage/QueueJobRepository';

export type MetricKey =
  | 'queue_success'
  | 'queue_failed'
  | 'queue_retry'
  | 'queue_dead'
  | 'queue_enqueued'
  | 'cache_hits'
  | 'uploads'
  | 'drive_sync_success'
  | 'drive_sync_failed'
  | 'drive_sync_retry'
  | 'drive_sync_dead'
  // Stage 4.1 — per-service sync counters.
  | 'folder_sync_success'
  | 'folder_sync_failed'
  | 'folder_sync_retry'
  | 'share_sync_success'
  | 'share_sync_failed'
  | 'share_sync_retry'
  | 'trash_sync_success'
  | 'trash_sync_failed'
  | 'trash_sync_retry'
  | 'favorite_sync_success'
  | 'favorite_sync_failed'
  | 'favorite_sync_retry'
  | 'recent_sync_success'
  | 'recent_sync_failed'
  | 'recent_sync_retry'
  | 'collaboration_sync_success'
  | 'collaboration_sync_failed'
  | 'collaboration_sync_retry';

/** Stage 4.1 service names used by per-service metric recording. */
export type DriveServiceName = 'folder' | 'share' | 'trash' | 'favorite' | 'recent' | 'collaboration';

/**
 * MetricsCollector is the runtime observability surface. Stage 2.8
 * introduced persistent queue counters and in-memory gauges. Stage 2.9
 * extends it with:
 *
 *  - drive sync metrics (success/failed/retry counters + processing time)
 *  - drive availability gauge (last probe status + latency)
 *  - derived rates (success rate, retry rate, average sync time)
 *
 * The derived rates are computed lazily in `snapshot()` so the gauges stay
 * fresh without a separate flush loop. Persistent counters survive
 * restarts; in-memory gauges reset on every boot.
 */
export class MetricsCollector {
  private readonly queueDepths = new Map<string, number>();
  private lastSyncAt: Date | undefined;
  private readonly processingTimes: number[] = [];
  private readonly syncTimes: number[] = [];
  private readonly maxSamples = 100;
  private driveAvailability: DriveAvailabilityGauge = { status: 'unknown', lastCheckedAt: undefined, latencyMs: undefined };

  constructor(
    private readonly counters: CounterRepository,
    private readonly queueJobs: QueueJobRepository,
  ) {}

  async increment(key: MetricKey, amount = 1): Promise<void> {
    await this.counters.increment(key, amount);
  }

  /**
   * Record the outcome of a per-service Drive sync operation. Bumps the
   * service-specific success/failed counter and the retry counter when
   * the operation took more than one attempt. Used by DriveSyncService so
   * the admin `/metrics` command can show per-service health.
   */
  async recordServiceOutcome(service: DriveServiceName, success: boolean, retries = 0): Promise<void> {
    await this.counters.increment(`${service}_sync_${success ? 'success' : 'failed'}` as MetricKey);
    if (retries > 0) {
      await this.counters.increment(`${service}_sync_retry` as MetricKey, retries);
    }
  }

  setQueueDepth(name: string, depth: number): void {
    this.queueDepths.set(name, depth);
  }

  recordProcessing(durationMs: number): void {
    this.processingTimes.push(durationMs);
    if (this.processingTimes.length > this.maxSamples) {
      this.processingTimes.shift();
    }
  }

  /** Records a Drive sync attempt with its duration and outcome. */
  recordSync(durationMs: number, success: boolean): void {
    this.syncTimes.push(durationMs);
    if (this.syncTimes.length > this.maxSamples) {
      this.syncTimes.shift();
    }
    if (success) {
      this.markSync();
    }
  }

  markSync(): void {
    this.lastSyncAt = new Date();
  }

  lastSync(): Date | undefined {
    return this.lastSyncAt;
  }

  /** Records the latest Drive availability probe result. */
  recordDriveAvailability(gauge: DriveAvailabilityGauge): void {
    this.driveAvailability = gauge;
  }

  getDriveAvailability(): DriveAvailabilityGauge {
    return this.driveAvailability;
  }

  async snapshot(): Promise<MetricsSnapshot> {
    const [success, failed, retry, dead, enqueued, cacheHits, uploads, syncSuccess, syncFailed, syncRetry, syncDead] = await Promise.all([
      this.counters.get('queue_success'),
      this.counters.get('queue_failed'),
      this.counters.get('queue_retry'),
      this.counters.get('queue_dead'),
      this.counters.get('queue_enqueued'),
      this.counters.get('cache_hits'),
      this.counters.get('uploads'),
      this.counters.get('drive_sync_success'),
      this.counters.get('drive_sync_failed'),
      this.counters.get('drive_sync_retry'),
      this.counters.get('drive_sync_dead'),
    ]);

    // Stage 4.1 — per-service sync counters.
    const services: DriveServiceName[] = ['folder', 'share', 'trash', 'favorite', 'recent', 'collaboration'];
    const serviceCounters: Record<string, { success: number; failed: number; retry: number }> = {};
    for (const service of services) {
      const [s, f, r] = await Promise.all([
        this.counters.get(`${service}_sync_success` as MetricKey),
        this.counters.get(`${service}_sync_failed` as MetricKey),
        this.counters.get(`${service}_sync_retry` as MetricKey),
      ]);
      serviceCounters[service] = { success: s, failed: f, retry: r };
    }

    const [pending, processing, deadLetter] = await Promise.all([
      this.queueJobs.countByStatus('pending'),
      this.queueJobs.countByStatus('processing'),
      this.queueJobs.deadLetterCount(),
    ]);

    const queueLength = pending + processing;
    const queueTotal = success + failed;
    const processingSummary = summarize(this.processingTimes);
    const syncSummary = summarize(this.syncTimes);

    return {
      counters: {
        queue_success: success,
        queue_failed: failed,
        queue_retry: retry,
        queue_dead: dead,
        queue_enqueued: enqueued,
        cache_hits: cacheHits,
        uploads,
        drive_sync_success: syncSuccess,
        drive_sync_failed: syncFailed,
        drive_sync_retry: syncRetry,
        drive_sync_dead: syncDead,
      },
      serviceCounters,
      queue: {
        pending,
        processing,
        deadLetter,
        length: queueLength,
        depths: Object.fromEntries(this.queueDepths),
      },
      processingTimeMs: processingSummary,
      syncTimeMs: syncSummary,
      lastSyncAt: this.lastSyncAt?.toISOString(),
      driveAvailability: this.driveAvailability,
      rates: {
        successRate: queueTotal === 0 ? 0 : success / queueTotal,
        retryRate: queueTotal === 0 ? 0 : retry / queueTotal,
        averageSyncTimeMs: syncSummary ? Math.round(syncSummary.p50) : 0,
        failedSync: failed,
        driveAvailability: this.driveAvailability.status,
      },
    };
  }

  async asText(): Promise<string> {
    const s = await this.snapshot();
    const lines: string[] = [];
    lines.push('Metrics:');
    lines.push(`  success:     ${s.counters.queue_success}`);
    lines.push(`  failed:      ${s.counters.queue_failed}`);
    lines.push(`  retry:       ${s.counters.queue_retry}`);
    lines.push(`  dead:        ${s.counters.queue_dead}`);
    lines.push(`  enqueued:    ${s.counters.queue_enqueued}`);
    lines.push(`  cache_hits:  ${s.counters.cache_hits}`);
    lines.push(`  uploads:     ${s.counters.uploads}`);
    lines.push('Drive sync:');
    lines.push(`  success:     ${s.counters.drive_sync_success}`);
    lines.push(`  failed:      ${s.counters.drive_sync_failed}`);
    lines.push(`  retry:       ${s.counters.drive_sync_retry}`);
    lines.push(`  dead:        ${s.counters.drive_sync_dead}`);
    if (s.serviceCounters) {
      lines.push('Per-service sync:');
      for (const [service, c] of Object.entries(s.serviceCounters)) {
        lines.push(`  ${service.padEnd(13)} success=${c.success} failed=${c.failed} retry=${c.retry}`);
      }
    }
    lines.push('Queue:');
    lines.push(`  pending:     ${s.queue.pending}`);
    lines.push(`  processing:  ${s.queue.processing}`);
    lines.push(`  dead_letter: ${s.queue.deadLetter}`);
    lines.push(`  length:      ${s.queue.length}`);
    if (s.processingTimeMs) {
      lines.push(
        `Processing: p50=${s.processingTimeMs.p50}ms p95=${s.processingTimeMs.p95}ms max=${s.processingTimeMs.max}ms n=${s.processingTimeMs.count}`,
      );
    } else {
      lines.push('Processing: n/a');
    }
    if (s.syncTimeMs) {
      lines.push(
        `Sync time:  avg=${s.rates.averageSyncTimeMs}ms p50=${s.syncTimeMs.p50}ms p95=${s.syncTimeMs.p95}ms max=${s.syncTimeMs.max}ms n=${s.syncTimeMs.count}`,
      );
    } else {
      lines.push('Sync time:  n/a');
    }
    lines.push('Rates:');
    lines.push(`  success_rate:       ${(s.rates.successRate * 100).toFixed(1)}%`);
    lines.push(`  retry_rate:         ${(s.rates.retryRate * 100).toFixed(1)}%`);
    lines.push(`  average_sync_time:  ${s.rates.averageSyncTimeMs}ms`);
    lines.push(`  failed_sync:        ${s.rates.failedSync}`);
    lines.push(`  drive_availability: ${s.rates.driveAvailability}`);
    lines.push(`Last sync:  ${s.lastSyncAt ?? 'never'}`);
    return lines.join('\n');
  }
}

export interface DriveAvailabilityGauge {
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  lastCheckedAt?: string;
  latencyMs?: number;
  detail?: string;
}

export interface MetricsSnapshot {
  counters: {
    queue_success: number;
    queue_failed: number;
    queue_retry: number;
    queue_dead: number;
    queue_enqueued: number;
    cache_hits: number;
    uploads: number;
    drive_sync_success: number;
    drive_sync_failed: number;
    drive_sync_retry: number;
    drive_sync_dead: number;
  };
  /** Stage 4.1 — per-service sync counters. */
  serviceCounters?: Record<string, { success: number; failed: number; retry: number }>;
  queue: {
    pending: number;
    processing: number;
    deadLetter: number;
    length: number;
    depths: Record<string, number>;
  };
  processingTimeMs?: {
    count: number;
    p50: number;
    p95: number;
    max: number;
  };
  syncTimeMs?: {
    count: number;
    p50: number;
    p95: number;
    max: number;
  };
  lastSyncAt?: string;
  driveAvailability: DriveAvailabilityGauge;
  rates: {
    successRate: number;
    retryRate: number;
    averageSyncTimeMs: number;
    failedSync: number;
    driveAvailability: string;
  };
}

function summarize(samples: number[]): { count: number; p50: number; p95: number; max: number } | undefined {
  if (samples.length === 0) {
    return undefined;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = (p: number) => Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return {
    count: sorted.length,
    p50: sorted[index(50)],
    p95: sorted[index(95)],
    max: sorted[sorted.length - 1],
  };
}
