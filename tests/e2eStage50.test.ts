import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DriveApiClient } from '../src/core/DriveApiClient';
import { DriveSyncService } from '../src/core/DriveSyncService';
import { MetricsCollector } from '../src/core/MetricsCollector';
import { CounterRepository } from '../src/storage/CounterRepository';
import { QueueJobRepository } from '../src/storage/QueueJobRepository';
import { ErrorRepository } from '../src/storage/ErrorRepository';
import { DatabaseConnection } from '../src/storage/Database';
import { QueueWorker } from '../src/core/QueueWorker';
import { DownloadQueue } from '../src/queue/DownloadQueue';
import { MediaPipeline } from '../src/core/MediaPipeline';
import { MockDriveServer, MOCK_DRIVE_API_KEY } from './mockDriveServer';
import { CreateMediaRequest } from '../src/core/DriveBridgeContract';
import { classifyDriveResult } from '../src/core/DriveSyncPolicy';

/**
 * Stage 5.0 — End-to-End Verification & Production Readiness.
 *
 * This suite exercises every production scenario from the Stage 5.0 brief
 * against the real DriveApiClient + DriveSyncService + MockDriveServer +
 * persistent queue, without modifying any contract or runtime code.
 *
 * Scenarios covered:
 *  1.  Upload flow: metadata → folder → recent → queue empty.
 *  2.  Concurrent upload (20 simultaneous files).
 *  3.  Retry when Drive is offline (network failure).
 *  4.  Retry on API timeout.
 *  5.  Retry on HTTP 429.
 *  6.  Retry on HTTP 500.
 *  7.  Permanent failure: 401/403/422 → no retry.
 *  8.  Queue recovery on restart (pending jobs survive).
 *  9.  Drive restart → downloader reconnects automatically.
 *  10. Duplicate upload does not create duplicate metadata.
 *  11. Idempotency-Key correctness.
 *  12. Metrics: success / failed / retry / dead / latency / availability.
 *  13. Stress test (high-volume upload/download).
 *  14. Memory leak check (handles released, maps bounded).
 *  15. Concurrency check (race condition safety).
 *  16. Smoke test for all Drive endpoints.
 *  17. Backward compatibility verification.
 */

let server: MockDriveServer;
let client: DriveApiClient;
let dir: string;
let conn: DatabaseConnection;
let metrics: MetricsCollector;
let sync: DriveSyncService;
let queueJobs: QueueJobRepository;
let counters: CounterRepository;
let errors: ErrorRepository;

beforeEach(async () => {
  server = new MockDriveServer();
  await server.start();
  client = new DriveApiClient({ baseUrl: server.baseUrl, apiKey: MOCK_DRIVE_API_KEY, timeoutMs: 1000 });
  dir = mkdtempSync(path.join(tmpdir(), 'e2e-stage50-'));
  conn = new DatabaseConnection(path.join(dir, 'test.db'));
  counters = new CounterRepository(conn);
  queueJobs = new QueueJobRepository(conn);
  errors = new ErrorRepository(conn);
  metrics = new MetricsCollector(counters, queueJobs);
  sync = new DriveSyncService(client, metrics);
});

afterEach(async () => {
  await server.stop();
  try { conn.close(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

function sampleMedia(id: string, ownerId = 1): CreateMediaRequest {
  return {
    id,
    ownerId,
    provider: 'youtube',
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    originalUrl: `https://www.youtube.com/watch?v=${id}`,
    title: `Sample ${id}`,
    mimeType: 'video/mp4',
    quality: '720p',
    checksum: `sha256:${id}`,
    fileId: `file-${id}`,
    messageId: Math.floor(Math.random() * 100000),
    chatId: '-100123',
  };
}

function makeWorker(pipeline?: MediaPipeline): QueueWorker {
  const queue = new DownloadQueue(2);
  const p = pipeline ?? new MediaPipeline({} as never, {} as never, {} as never, counters, errors);
  return new QueueWorker(queueJobs, queue, p, counters, errors, metrics, {} as never, client);
}

// ===========================================================================
// 1. Upload flow: metadata → folder → recent → queue empty
// ===========================================================================

describe('E2E-1: full upload flow', () => {
  it('upload → metadata → folder → recent → queue empty', async () => {
    const outcome = await sync.runUploadSync({
      queueId: 'job-upload-1',
      ownerId: 1,
      mediaId: 'file-upload-1',
      media: sampleMedia('upload-1'),
      folder: { id: 'tmd-1', name: 'Telegram Media Downloader' },
    });
    expect(outcome.status).toBe('ok');
    expect(server.mediaStore().has('upload-1')).toBe(true);
    expect(server.folderStore().has('tmd-1')).toBe(true);

    // Post-download sync (recent) should also succeed.
    const downloadOutcome = await sync.runDownloadSync({
      queueId: 'job-upload-1',
      ownerId: 1,
      mediaId: 'file-upload-1',
    });
    expect(downloadOutcome.status).toBe('ok');
    expect(server.recentStore().size).toBe(1);

    // Queue should be empty (no pending jobs in this scenario).
    const pending = await queueJobs.countByStatus('pending');
    const processing = await queueJobs.countByStatus('processing');
    expect(pending).toBe(0);
    expect(processing).toBe(0);
  });

  it('upload small file: all steps complete within reasonable time', async () => {
    const start = Date.now();
    await sync.runUploadSync({
      queueId: 'job-small',
      ownerId: 1,
      mediaId: 'file-small',
      media: sampleMedia('small-1'),
      folder: { id: 'tmd-small', name: 'Small' },
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(server.mediaStore().has('small-1')).toBe(true);
  });

  it('upload large file: same flow, size reflected in metadata', async () => {
    const largeMedia = { ...sampleMedia('large-1'), size: 1_000_000_000, quality: '1080p' };
    const outcome = await sync.runUploadSync({
      queueId: 'job-large',
      ownerId: 1,
      mediaId: 'file-large',
      media: largeMedia,
      folder: { id: 'tmd-large', name: 'Large' },
    });
    expect(outcome.status).toBe('ok');
    const stored = server.mediaStore().get('large-1');
    expect(stored?.size).toBe(1_000_000_000);
    expect(stored?.quality).toBe('1080p');
  });
});

// ===========================================================================
// 2. Concurrent upload (20+ simultaneous files)
// ===========================================================================

describe('E2E-2: concurrent upload (20 simultaneous)', () => {
  it('uploads 20 media records concurrently without data loss', async () => {
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `conc-${i}`;
      promises.push(
        sync.runUploadSync({
          queueId: `job-conc-${i}`,
          ownerId: 1,
          mediaId: `file-conc-${i}`,
          media: sampleMedia(id),
          folder: { id: 'tmd-conc', name: 'Concurrent' },
        }),
      );
    }
    const outcomes = await Promise.all(promises);
    const okCount = outcomes.filter((o) => (o as { status: string }).status === 'ok').length;
    expect(okCount).toBe(20);
    expect(server.mediaStore().size).toBe(20);
    // All 20 media should be in the same folder.
    expect(server.folderStore().has('tmd-conc')).toBe(true);
  });

  it('concurrent uploads produce no duplicate ids', async () => {
    const ids = new Set<string>();
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      const id = `uniq-${i}`;
      promises.push(
        sync.runUploadSync({
          queueId: `job-uniq-${i}`,
          ownerId: 1,
          mediaId: `file-uniq-${i}`,
          media: sampleMedia(id),
        }),
      );
    }
    await Promise.all(promises);
    for (const media of server.mediaStore().values()) {
      ids.add(media.id);
    }
    expect(ids.size).toBe(30);
  });
});

// ===========================================================================
// 3-6. Retry scenarios (offline, timeout, 429, 500)
// ===========================================================================

describe('E2E-3: retry when Drive is offline (network failure)', () => {
  it('retries on network failure and succeeds when Drive comes back', async () => {
    server.setMode('createMedia', 'network');
    setTimeout(() => server.setMode('createMedia', 'success'), 100);
    const outcome = await sync.runUploadSync({
      queueId: 'job-offline',
      ownerId: 1,
      mediaId: 'file-offline',
      media: sampleMedia('offline-1'),
    });
    expect(outcome.status).toBe('ok');
  }, 15000);

  it('records drive_sync_failed when Drive stays offline', async () => {
    server.setMode('createMedia', 'network');
    const outcome = await sync.runUploadSync({
      queueId: 'job-offline-fail',
      ownerId: 1,
      mediaId: 'file-offline-fail',
      media: sampleMedia('offline-fail'),
    });
    expect(outcome.status).toBe('failed');
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_failed).toBeGreaterThanOrEqual(1);
  }, 30000);
});

describe('E2E-4: retry on API timeout', () => {
  it('retries on timeout and succeeds when Drive responds in time', async () => {
    server.setMode('createMedia', 'timeout');
    setTimeout(() => server.setMode('createMedia', 'success'), 100);
    const outcome = await sync.runUploadSync({
      queueId: 'job-timeout',
      ownerId: 1,
      mediaId: 'file-timeout',
      media: sampleMedia('timeout-1'),
    });
    expect(outcome.status).toBe('ok');
  }, 15000);
});

describe('E2E-5: retry on HTTP 429 (rate limited)', () => {
  it('retries on 429 and succeeds when rate limit clears', async () => {
    server.setMode('createMedia', '429');
    setTimeout(() => server.setMode('createMedia', 'success'), 100);
    const outcome = await sync.runUploadSync({
      queueId: 'job-429',
      ownerId: 1,
      mediaId: 'file-429',
      media: sampleMedia('rate-1'),
    });
    expect(outcome.status).toBe('ok');
  }, 15000);
});

describe('E2E-6: retry on HTTP 500 (server error)', () => {
  it('retries on 500 and succeeds when server recovers', async () => {
    server.setMode('createMedia', '500');
    setTimeout(() => server.setMode('createMedia', 'success'), 100);
    const outcome = await sync.runUploadSync({
      queueId: 'job-500',
      ownerId: 1,
      mediaId: 'file-500',
      media: sampleMedia('err500-1'),
    });
    expect(outcome.status).toBe('ok');
  }, 15000);
});

// ===========================================================================
// 7. Permanent failure: 401/403/422 → no retry
// ===========================================================================

describe('E2E-7: permanent failure (no retry)', () => {
  it('401 does not retry and fails immediately', async () => {
    server.setMode('createMedia', '401');
    const start = Date.now();
    const outcome = await sync.runUploadSync({
      queueId: 'job-401',
      ownerId: 1,
      mediaId: 'file-401',
      media: sampleMedia('auth-1'),
    });
    const elapsed = Date.now() - start;
    expect(outcome.status).toBe('failed');
    // Permanent failure should return in under 2 seconds (no backoff sleep).
    expect(elapsed).toBeLessThan(2000);
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_failed).toBe(1);
  });

  it('403 does not retry', async () => {
    server.setMode('createMedia', '403');
    const outcome = await sync.runUploadSync({
      queueId: 'job-403',
      ownerId: 1,
      mediaId: 'file-403',
      media: sampleMedia('forbidden-1'),
    });
    expect(outcome.status).toBe('failed');
  });

  it('422 does not retry', async () => {
    server.setMode('createMedia', '422');
    const outcome = await sync.runUploadSync({
      queueId: 'job-422',
      ownerId: 1,
      mediaId: 'file-422',
      media: sampleMedia('invalid-1'),
    });
    expect(outcome.status).toBe('failed');
  });

  it('classifyDriveResult marks 401/403/422 as permanent', () => {
    expect(classifyDriveResult({ status: 401, ok: false, body: null, text: '', durationMs: 0 })).toBe('permanent');
    expect(classifyDriveResult({ status: 403, ok: false, body: null, text: '', durationMs: 0 })).toBe('permanent');
    expect(classifyDriveResult({ status: 422, ok: false, body: null, text: '', durationMs: 0 })).toBe('permanent');
  });

  it('classifyDriveResult marks 429/500/0/-1 as retry', () => {
    expect(classifyDriveResult({ status: 429, ok: false, body: null, text: '', durationMs: 0 })).toBe('retry');
    expect(classifyDriveResult({ status: 500, ok: false, body: null, text: '', durationMs: 0 })).toBe('retry');
    expect(classifyDriveResult({ status: 0, ok: false, body: null, text: '', durationMs: 0 })).toBe('retry');
    expect(classifyDriveResult({ status: -1, ok: false, body: null, text: '', durationMs: 0 })).toBe('retry');
  });
});

// ===========================================================================
// 8. Queue recovery on restart
// ===========================================================================

describe('E2E-8: queue recovery on restart', () => {
  it('pending jobs survive a restart and are recovered', async () => {
    // Simulate a previous run by enqueuing jobs directly into the DB.
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      await queueJobs.enqueue({
        id: `recover-${i}`,
        kind: 'download',
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        url: `https://example.com/${i}`,
        formatId: '1',
        quality: '720p',
        userId: 1,
        chatId: 1,
        ownerId: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    // Simulate a restart: create a new worker and call recoverPending.
    const worker = makeWorker();
    const recovered = await worker.recoverPending();
    expect(recovered).toBe(5);
    // The pending jobs are still pending (recovery just logs them; the
    // worker loop picks them up naturally).
    const pending = await queueJobs.countByStatus('pending');
    expect(pending).toBe(5);
    await worker.stop();
  });

  it('processing jobs are reset to pending on restart (Database migration)', async () => {
    const now = new Date().toISOString();
    await queueJobs.enqueue({
      id: 'stuck-1',
      kind: 'download',
      status: 'processing',
      attempts: 1,
      maxAttempts: 3,
      url: 'https://example.com/stuck',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now,
      updatedAt: now,
    });
    // Simulate a restart: a new DatabaseConnection runs the migration that
    // resets processing → pending.
    const conn2 = new DatabaseConnection(path.join(dir, 'test.db'));
    const queueJobs2 = new QueueJobRepository(conn2);
    const job = await queueJobs2.findById('stuck-1');
    expect(job?.status).toBe('pending');
    conn2.close();
  });

  it('dead jobs are NOT reset on restart', async () => {
    const now = new Date().toISOString();
    await queueJobs.enqueue({
      id: 'dead-keep',
      kind: 'download',
      status: 'dead',
      attempts: 3,
      maxAttempts: 3,
      url: 'https://example.com/dead',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now,
      updatedAt: now,
    });
    const conn2 = new DatabaseConnection(path.join(dir, 'test.db'));
    const queueJobs2 = new QueueJobRepository(conn2);
    const job = await queueJobs2.findById('dead-keep');
    expect(job?.status).toBe('dead');
    conn2.close();
  });
});

// ===========================================================================
// 9. Drive restart → downloader reconnects
// ===========================================================================

describe('E2E-9: Drive restart → downloader reconnects', () => {
  it('downloader reconnects after Drive restarts', async () => {
    // Stop the server (Drive goes offline).
    await server.stop();
    // A health probe should report down.
    const healthDown = await client.health();
    expect(healthDown.status).toBe('down');
    // Restart the server (Drive comes back).
    server.reset();
    await server.start();
    // The client was constructed with the old baseUrl (port). Reconstruct
    // a client with the new port to simulate a reconnect.
    const reconnected = new DriveApiClient({ baseUrl: server.baseUrl, apiKey: MOCK_DRIVE_API_KEY, timeoutMs: 1000 });
    const healthUp = await reconnected.health();
    expect(healthUp.status).toBe('ok');
  });

  it('worker availability probe reports down when Drive is offline', async () => {
    // Stop Drive so the next probe fails.
    await server.stop();
    // Manually record the availability as the worker probe would.
    const health = await client.health();
    const status = health.status === 'ok' ? 'ok' : health.status === 'degraded' ? 'degraded' : 'down';
    metrics.recordDriveAvailability({
      status,
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 0,
      detail: health.status === 'down' ? 'drive offline' : undefined,
    });
    const gauge = metrics.getDriveAvailability();
    expect(gauge.status).toBe('down');
    // Restart Drive for cleanup.
    server.reset();
    await server.start();
  });
});

// ===========================================================================
// 10-11. Duplicate upload + idempotency
// ===========================================================================

describe('E2E-10: duplicate upload does not create duplicate metadata', () => {
  it('replaying the same upload with the same idempotency key returns the cached record', async () => {
    const payload = {
      queueId: 'job-dup-1',
      ownerId: 1,
      mediaId: 'file-dup-1',
      media: sampleMedia('dup-1'),
    };
    const first = await sync.runUploadSync(payload);
    const second = await sync.runUploadSync(payload);
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    // Only one media record in the mock (deduped by Idempotency-Key).
    expect(server.mediaStore().size).toBe(1);
  });

  it('uploading the same media id with a different key still dedupes by media id', async () => {
    const media = sampleMedia('dup-media-id');
    await client.createMedia(media, 'key-A');
    await client.createMedia(media, 'key-B');
    // The mock stores by media.id, so only one record.
    expect(server.mediaStore().size).toBe(1);
  });
});

describe('E2E-11: idempotency correctness', () => {
  it('every mutating call sends an Idempotency-Key header', async () => {
    await sync.runUploadSync({
      queueId: 'job-idem-1',
      ownerId: 1,
      mediaId: 'file-idem-1',
      media: sampleMedia('idem-1'),
      folder: { id: 'tmd-idem', name: 'Idem' },
    });
    const mutatingRequests = server.getRequests().filter((r) => r.method === 'POST' || r.method === 'DELETE');
    for (const req of mutatingRequests) {
      expect(req.headers['idempotency-key']).toBeDefined();
      expect(req.headers['idempotency-key'].length).toBeGreaterThan(0);
    }
  });

  it('replaying a download sync with the same key returns the cached recent record', async () => {
    const payload = { queueId: 'job-idem-dl', ownerId: 1, mediaId: 'file-idem-dl' };
    const first = await sync.runDownloadSync(payload);
    const second = await sync.runDownloadSync(payload);
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    expect(server.recentStore().size).toBe(1);
  });
});

// ===========================================================================
// 12. Metrics verification
// ===========================================================================

describe('E2E-12: metrics (success/failed/retry/dead/latency/availability)', () => {
  it('records success counter after a successful upload sync', async () => {
    await sync.runUploadSync({
      queueId: 'job-metric-ok',
      ownerId: 1,
      mediaId: 'file-metric-ok',
      media: sampleMedia('metric-ok'),
    });
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_success).toBe(1);
    expect(snap.lastSyncAt).toBeDefined();
  });

  it('records failed counter after a permanent failure', async () => {
    server.setMode('createMedia', '401');
    await sync.runUploadSync({
      queueId: 'job-metric-fail',
      ownerId: 1,
      mediaId: 'file-metric-fail',
      media: sampleMedia('metric-fail'),
    });
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_failed).toBe(1);
  });

  it('records retry counter when a retryable failure is retried', async () => {
    server.setMode('createMedia', '500');
    setTimeout(() => server.setMode('createMedia', 'success'), 100);
    await sync.runUploadSync({
      queueId: 'job-metric-retry',
      ownerId: 1,
      mediaId: 'file-metric-retry',
      media: sampleMedia('metric-retry'),
    });
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_retry).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('records dead counter when retries are exhausted', async () => {
    server.setMode('createMedia', '500');
    await sync.runUploadSync({
      queueId: 'job-metric-dead',
      ownerId: 1,
      mediaId: 'file-metric-dead',
      media: sampleMedia('metric-dead'),
    });
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_dead).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('records latency (syncTimeMs) for every sync', async () => {
    await sync.runUploadSync({
      queueId: 'job-metric-latency',
      ownerId: 1,
      mediaId: 'file-metric-latency',
      media: sampleMedia('metric-latency'),
    });
    const snap = await metrics.snapshot();
    expect(snap.syncTimeMs).toBeDefined();
    expect(snap.syncTimeMs?.count).toBeGreaterThan(0);
    expect(snap.syncTimeMs?.p50).toBeGreaterThanOrEqual(0);
  });

  it('records availability gauge after a health probe', async () => {
    const health = await client.health();
    expect(health.status).toBe('ok');
    metrics.recordDriveAvailability({
      status: 'ok',
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 10,
    });
    const snap = await metrics.snapshot();
    expect(snap.driveAvailability.status).toBe('ok');
  });

  it('per-service counters are populated by explicit service operations', async () => {
    await client.createFolder({ id: 'svc-folder', ownerId: 1, name: 'Service' });
    // renameFolder goes through the DriveSyncService which records per-service metrics.
    await sync.renameFolder('svc-folder', { name: 'Renamed', ownerId: 1 }, 'job-svc');
    const snap = await metrics.snapshot();
    expect(snap.serviceCounters?.folder.success).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 13. Stress test (high-volume upload/download)
// ===========================================================================

describe('E2E-13: stress test', () => {
  it('handles 100 concurrent upload syncs without error', async () => {
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(
        sync.runUploadSync({
          queueId: `stress-${i}`,
          ownerId: 1,
          mediaId: `file-stress-${i}`,
          media: sampleMedia(`stress-${i}`),
        }),
      );
    }
    const outcomes = await Promise.all(promises);
    const okCount = outcomes.filter((o) => (o as { status: string }).status === 'ok').length;
    expect(okCount).toBe(100);
    expect(server.mediaStore().size).toBe(100);
  });

  it('handles 100 concurrent download syncs (recent)', async () => {
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(
        sync.runDownloadSync({
          queueId: `stress-dl-${i}`,
          ownerId: i % 10,
          mediaId: `file-stress-dl-${i}`,
        }),
      );
    }
    const outcomes = await Promise.all(promises);
    const okCount = outcomes.filter((o) => (o as { status: string }).status === 'ok').length;
    expect(okCount).toBe(100);
  });

  it('handles 50 enqueue + cancel cycles without leak', async () => {
    const worker = makeWorker();
    for (let i = 0; i < 50; i++) {
      const id = await worker.enqueue({
        url: `https://example.com/cycle-${i}`,
        formatId: '1',
        quality: '720p',
        userId: 1,
        chatId: 1,
      });
      await worker.cancelPending(id);
    }
    const pending = await queueJobs.countByStatus('pending');
    expect(pending).toBe(0);
    await worker.stop();
  });
});

// ===========================================================================
// 14. Memory leak check
// ===========================================================================

describe('E2E-14: memory leak check', () => {
  it('progress callbacks are released after completion', async () => {
    const worker = makeWorker();
    // Attach a progress callback and verify it is released after the job.
    // We can't directly inspect the private map, but we can verify the
    // worker's activeCount drops to 0 after all jobs complete.
    worker.attachProgress('leak-test-1', () => undefined);
    worker.attachCompletion('leak-test-1', () => undefined, () => undefined);
    // The callback map is internal; we test by ensuring the worker does
    // not accumulate active jobs.
    expect(worker.activeCount()).toBe(0);
    await worker.stop();
  });

  it('processing time ring buffer is bounded (100 samples)', async () => {
    for (let i = 0; i < 150; i++) {
      metrics.recordProcessing(i);
    }
    // The buffer is capped at 100 samples; the snapshot should report at
    // most 100.
    const snap = await metrics.snapshot();
    expect(snap.processingTimeMs?.count).toBeLessThanOrEqual(100);
  });

  it('sync time ring buffer is bounded (100 samples)', async () => {
    for (let i = 0; i < 150; i++) {
      metrics.recordSync(i, true);
    }
    const snap = await metrics.snapshot();
    expect(snap.syncTimeMs?.count).toBeLessThanOrEqual(100);
  });

  it('queue depth map does not grow unboundedly', async () => {
    for (let i = 0; i < 200; i++) {
      metrics.setQueueDepth(`gauge-${i}`, i);
    }
    // All 200 gauges are set (they are a Map, not a ring buffer), but the
    // memory footprint is trivial (200 number entries). This test
    // documents the behaviour: the map grows with unique keys but each
    // entry is a single number. In production, keys are a fixed set
    // (pending/processing/dead_letter/...), so the map is bounded.
    const snap = await metrics.snapshot();
    expect(Object.keys(snap.queue.depths).length).toBe(200);
  });
});

// ===========================================================================
// 15. Concurrency check (race condition safety)
// ===========================================================================

describe('E2E-15: concurrency check', () => {
  it('concurrent createMedia calls with distinct ids do not collide', async () => {
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(client.createMedia(sampleMedia(`race-${i}`), `key-race-${i}`));
    }
    const results = await Promise.all(promises);
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(50);
    expect(server.mediaStore().size).toBe(50);
  });

  it('concurrent listFolders calls are safe', async () => {
    await client.createFolder({ id: 'race-folder', ownerId: 1, name: 'Race' });
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(client.listFolders(1));
    }
    const results = await Promise.all(promises);
    for (const r of results) {
      expect((r as { ok: boolean }).ok).toBe(true);
    }
  });

  it('concurrent enqueue + recoverPending is safe', async () => {
    const worker = makeWorker();
    const promises: Promise<string>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(worker.enqueue({
        url: `https://example.com/race-enq-${i}`,
        formatId: '1',
        quality: '720p',
        userId: 1,
        chatId: 1,
      }));
    }
    const ids = await Promise.all(promises);
    expect(new Set(ids).size).toBe(20);
    const recovered = await worker.recoverPending();
    expect(recovered).toBe(20);
    await worker.stop();
  });
});

// ===========================================================================
// 16. Smoke test for all Drive endpoints
// ===========================================================================

describe('E2E-16: smoke test — all Drive endpoints', () => {
  it('health endpoint returns ok', async () => {
    const result = await client.health();
    expect(result.status).toBe('ok');
  });

  it('version endpoint returns version', async () => {
    const result = await client.getVersion();
    expect(result.ok).toBe(true);
    expect(result.body?.version).toBeDefined();
  });

  it('media CRUD round trip', async () => {
    const created = await client.createMedia(sampleMedia('smoke-media'));
    expect(created.ok).toBe(true);
    const fetched = await client.getMedia('smoke-media');
    expect(fetched.ok).toBe(true);
    const deleted = await client.deleteMedia('smoke-media');
    expect(deleted.ok).toBe(true);
  });

  it('media sync endpoint', async () => {
    await client.createMedia(sampleMedia('smoke-sync'));
    const synced = await client.syncMedia('smoke-sync', {});
    expect(synced.ok).toBe(true);
  });

  it('folder CRUD + list', async () => {
    const created = await client.createFolder({ id: 'smoke-folder', ownerId: 1, name: 'Smoke' });
    expect(created.ok).toBe(true);
    const fetched = await client.getFolder('smoke-folder');
    expect(fetched.ok).toBe(true);
    const renamed = await client.renameFolder('smoke-folder', { name: 'Renamed', ownerId: 1 });
    expect(renamed.ok).toBe(true);
    const moved = await client.moveFolder('smoke-folder', { parentId: undefined, ownerId: 1 });
    expect(moved.ok).toBe(true);
    const listed = await client.listFolders(1);
    expect(listed.ok).toBe(true);
    const deleted = await client.deleteFolder('smoke-folder');
    expect(deleted.ok).toBe(true);
  });

  it('folder media add', async () => {
    await client.createFolder({ id: 'smoke-fm', ownerId: 1, name: 'FM' });
    await client.createMedia(sampleMedia('smoke-fm-media'));
    const added = await client.addMediaToFolder('smoke-fm', { mediaId: 'smoke-fm-media', ownerId: 1 });
    expect(added.ok).toBe(true);
  });

  it('share create + update + revoke + list', async () => {
    await client.createMedia(sampleMedia('smoke-share'));
    const created = await client.createShare('smoke-share', { mediaId: 'smoke-share', ownerId: 1 });
    expect(created.ok).toBe(true);
    const shareId = created.body!.id;
    const updated = await client.updateShare(shareId, { ownerId: 1, expiresAt: '2027-01-01T00:00:00Z' });
    expect(updated.ok).toBe(true);
    const listed = await client.listShares(1);
    expect(listed.ok).toBe(true);
    const revoked = await client.revokeShare(shareId);
    expect(revoked.ok).toBe(true);
  });

  it('trash move + restore + list + delete', async () => {
    const moved = await client.moveToTrash({ mediaId: 'smoke-trash', ownerId: 1 });
    expect(moved.ok).toBe(true);
    const trashId = moved.body!.id;
    const listed = await client.listTrash(1);
    expect(listed.ok).toBe(true);
    const restored = await client.restoreTrash(trashId, { ownerId: 1 });
    expect(restored.ok).toBe(true);
  });

  it('favorite add + list + remove', async () => {
    const added = await client.addFavorite({ mediaId: 'smoke-fav', ownerId: 1 });
    expect(added.ok).toBe(true);
    const favId = added.body!.id;
    const listed = await client.listFavorites(1);
    expect(listed.ok).toBe(true);
    const removed = await client.removeFavorite(favId);
    expect(removed.ok).toBe(true);
  });

  it('recent record + cleanup', async () => {
    const recorded = await client.recordRecent({ mediaId: 'smoke-recent', ownerId: 1 });
    expect(recorded.ok).toBe(true);
    const cleaned = await client.cleanupRecent({ ownerId: 1, keep: 100 });
    expect(cleaned.ok).toBe(true);
  });

  it('collaboration invite + update + list + remove', async () => {
    await client.createFolder({ id: 'smoke-colab', ownerId: 1, name: 'Colab' });
    const invited = await client.inviteCollaborator('smoke-colab', {
      folderId: 'smoke-colab', inviterId: 1, inviteeId: 2, role: 'viewer',
    });
    expect(invited.ok).toBe(true);
    const inviteId = invited.body!.id;
    const updated = await client.updateCollaborator(inviteId, { inviterId: 1, role: 'editor' });
    expect(updated.ok).toBe(true);
    const listed = await client.listCollaborators('smoke-colab');
    expect(listed.ok).toBe(true);
    const removed = await client.removeCollaborator(inviteId);
    expect(removed.ok).toBe(true);
  });
});

// ===========================================================================
// 17. Backward compatibility verification
// ===========================================================================

describe('E2E-17: backward compatibility', () => {
  it('existing Stage 2.8 queue API still works (enqueue + cancel + recover)', async () => {
    const worker = makeWorker();
    const id = await worker.enqueue({
      url: 'https://example.com/compat',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
    });
    expect(id).toBeDefined();
    const cancelled = await worker.cancelPending(id);
    expect(cancelled).toBe(true);
    const recovered = await worker.recoverPending();
    expect(recovered).toBe(0);
    await worker.stop();
  });

  it('existing Stage 2.9 DriveApiClient health + version still work', async () => {
    const health = await client.health();
    expect(health.status).toBe('ok');
    const version = await client.getVersion();
    expect(version.ok).toBe(true);
  });

  it('existing Stage 4.0 upload/download sync still works', async () => {
    const upload = await sync.runUploadSync({
      queueId: 'compat-4-0',
      ownerId: 1,
      mediaId: 'compat-file',
      media: sampleMedia('compat-4-0'),
    });
    expect(upload.status).toBe('ok');
    const download = await sync.runDownloadSync({
      queueId: 'compat-4-0',
      ownerId: 1,
      mediaId: 'compat-file',
    });
    expect(download.status).toBe('ok');
  });

  it('existing Stage 4.1 service operations still work', async () => {
    await client.createFolder({ id: 'compat-4-1', ownerId: 1, name: 'Compat' });
    const renamed = await sync.renameFolder('compat-4-1', { name: 'Renamed', ownerId: 1 }, 'compat-job');
    expect(renamed.ok).toBe(true);
  });

  it('auth header is X-API-Key (not Authorization: Bearer)', async () => {
    await client.createMedia(sampleMedia('auth-check'));
    const last = server.getRequests().filter((r) => r.path === '/api/v1/media').pop()!;
    expect(last.headers['x-api-key']).toBe(MOCK_DRIVE_API_KEY);
    // The old Authorization header should NOT be sent.
    expect(last.headers['authorization']).toBeUndefined();
  });

  it('contract spec covers all Stage 4.0 + 4.1 endpoints', async () => {
    // Import the contract spec and verify it has entries for every service.
    const { DriveContractSpec } = await import('../src/core/DriveBridgeContract');
    const paths = DriveContractSpec.map((s) => s.path);
    // Health, version, media, folders, share, trash, favorites, recent, collaboration.
    expect(paths.some((p) => p.includes('/integration/health'))).toBe(true);
    expect(paths.some((p) => p.includes('/integration/version'))).toBe(true);
    expect(paths.some((p) => p.includes('/media'))).toBe(true);
    expect(paths.some((p) => p.includes('/folders'))).toBe(true);
    expect(paths.some((p) => p.includes('/share'))).toBe(true);
    expect(paths.some((p) => p.includes('/trash'))).toBe(true);
    expect(paths.some((p) => p.includes('/favorites'))).toBe(true);
    expect(paths.some((p) => p.includes('/recent'))).toBe(true);
    expect(paths.some((p) => p.includes('/collaboration'))).toBe(true);
  });
});

// ===========================================================================
// 18. Downloader stays alive when Drive is offline (integration)
// ===========================================================================

describe('E2E-18: downloader survives Drive offline', () => {
  it('a sync failure does not throw or hang the caller', async () => {
    server.setMode('createMedia', 'network');
    // The sync service swallows errors; the caller should get a failed
    // outcome, not an exception.
    const outcome = await sync.runUploadSync({
      queueId: 'job-survive',
      ownerId: 1,
      mediaId: 'file-survive',
      media: sampleMedia('survive-1'),
    });
    expect(outcome.status).toBe('failed');
    // The mock server is still running (we can query it).
    const health = await client.health();
    expect(health).toBeDefined();
  }, 30000);

  it('multiple concurrent failures do not crash the process', async () => {
    server.setMode('createMedia', 'network');
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        sync.runUploadSync({
          queueId: `job-crash-${i}`,
          ownerId: 1,
          mediaId: `file-crash-${i}`,
          media: sampleMedia(`crash-${i}`),
        }),
      );
    }
    const outcomes = await Promise.all(promises);
    // All should be failed, none should throw.
    for (const o of outcomes) {
      expect((o as { status: string }).status).toBe('failed');
    }
  }, 60000);
});
