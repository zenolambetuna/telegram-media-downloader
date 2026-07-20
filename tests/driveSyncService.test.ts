import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DriveApiClient } from '../src/core/DriveApiClient';
import { DriveSyncService } from '../src/core/DriveSyncService';
import { MetricsCollector } from '../src/core/MetricsCollector';
import { CounterRepository } from '../src/storage/CounterRepository';
import { QueueJobRepository } from '../src/storage/QueueJobRepository';
import { DatabaseConnection } from '../src/storage/Database';
import { MockDriveServer, MOCK_DRIVE_API_KEY } from './mockDriveServer';
import { CreateMediaRequest } from '../src/core/DriveBridgeContract';

let server: MockDriveServer;
let client: DriveApiClient;
let dir: string;
let conn: DatabaseConnection;
let metrics: MetricsCollector;
let sync: DriveSyncService;

beforeEach(async () => {
  server = new MockDriveServer();
  await server.start();
  client = new DriveApiClient({
    baseUrl: server.baseUrl,
    apiKey: MOCK_DRIVE_API_KEY,
    timeoutMs: 1000,
  });
  dir = mkdtempSync(path.join(tmpdir(), 'drivesync-test-'));
  conn = new DatabaseConnection(path.join(dir, 'test.db'));
  const counters = new CounterRepository(conn);
  const queueJobs = new QueueJobRepository(conn);
  metrics = new MetricsCollector(counters, queueJobs);
  sync = new DriveSyncService(client, metrics);
});

afterEach(async () => {
  await server.stop();
  try {
    conn.close();
  } catch {
    // ignore
  }
  rmSync(dir, { recursive: true, force: true });
});

function sampleMedia(overrides: Partial<CreateMediaRequest> = {}): CreateMediaRequest {
  return {
    id: 'media-1',
    ownerId: 1,
    provider: 'youtube',
    canonicalUrl: 'https://www.youtube.com/watch?v=abc',
    originalUrl: 'https://www.youtube.com/watch?v=abc',
    title: 'Sample',
    mimeType: 'video/mp4',
    quality: '720p',
    checksum: 'sha256:abc',
    fileId: 'file-1',
    messageId: 42,
    chatId: '-100123',
    ...overrides,
  };
}

describe('DriveSyncService — post-upload sync (happy path)', () => {
  it('creates the media record, the folder, adds media to folder, and notifies sync', async () => {
    const outcome = await sync.runUploadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
      folder: { id: 'tmd-1', name: 'Telegram Media Downloader' },
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.mediaResult?.ok).toBe(true);
    expect(outcome.mediaResult?.status).toBe(201);

    // Media record stored in the mock.
    expect(server.mediaStore().has('media-1')).toBe(true);
    // Folder created.
    expect(server.folderStore().has('tmd-1')).toBe(true);
    // Recent is NOT recorded on upload (only on download).
    expect(server.recentStore().size).toBe(0);
  });

  it('records drive_sync_success metric on success', async () => {
    await sync.runUploadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
      folder: { id: 'tmd-1', name: 'Test' },
    });
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_success).toBe(1);
    expect(snap.counters.drive_sync_failed).toBe(0);
    expect(snap.lastSyncAt).toBeDefined();
  });

  it('updates last sync time on success', async () => {
    const before = Date.now();
    await sync.runUploadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
    });
    const snap = await metrics.snapshot();
    expect(snap.lastSyncAt).toBeDefined();
    expect(new Date(snap.lastSyncAt!).getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('DriveSyncService — post-download sync (happy path)', () => {
  it('records the media in recent and (when favorite=true) adds to favorites', async () => {
    const outcome = await sync.runDownloadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      favorite: true,
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.recentResult?.ok).toBe(true);

    expect(server.recentStore().size).toBe(1);
    expect(server.favoriteStore().size).toBe(1);
  });

  it('records recent but skips favorites when favorite flag is false', async () => {
    const outcome = await sync.runDownloadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      favorite: false,
    });
    expect(outcome.status).toBe('ok');
    expect(server.recentStore().size).toBe(1);
    expect(server.favoriteStore().size).toBe(0);
  });

  it('records drive_sync_success metric on success', async () => {
    await sync.runDownloadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
    });
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_success).toBe(1);
    expect(snap.counters.drive_sync_failed).toBe(0);
  });
});

describe('DriveSyncService — unconfigured client', () => {
  it('reports skipped when the client is not configured', async () => {
    const unconfigured = new DriveApiClient({ baseUrl: undefined, apiKey: undefined });
    const localSync = new DriveSyncService(unconfigured, metrics);
    const upload = await localSync.runUploadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
    });
    expect(upload.status).toBe('skipped');
    expect(upload.reason).toBe('not-configured');

    const download = await localSync.runDownloadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
    });
    expect(download.status).toBe('skipped');
  });
});

describe('DriveSyncService — retry policy (401/403/422 permanent)', () => {
  it('does NOT retry a 401 from createMedia and reports failure immediately', async () => {
    server.setMode('createMedia', '401');
    const start = Date.now();
    const outcome = await sync.runUploadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
    });
    const elapsed = Date.now() - start;
    expect(outcome.status).toBe('failed');
    expect(outcome.step).toBe('media');
    expect(outcome.result?.status).toBe(401);
    // Permanent failure should not have slept for backoff.
    expect(elapsed).toBeLessThan(2000);
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_failed).toBe(1);
    // Not a retryable-exhausted dead, so drive_sync_dead stays 0.
    expect(snap.counters.drive_sync_dead).toBe(0);
  });

  it('does NOT retry a 422 from createMedia', async () => {
    server.setMode('createMedia', '422');
    const outcome = await sync.runUploadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.result?.status).toBe(422);
  });

  it('does NOT retry a 403 from recordRecent', async () => {
    server.setMode('recordRecent', '403');
    const outcome = await sync.runDownloadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.result?.status).toBe(403);
  });
});

describe('DriveSyncService — retry policy (429/5xx/network retry)', () => {
  it('retries a 500 and eventually succeeds when the server recovers mid-flight', async () => {
    // Fail the first call, then succeed after a short delay.
    server.setMode('createMedia', '500');
    setTimeout(() => server.setMode('createMedia', 'success'), 50);

    const outcome = await sync.runUploadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
    });
    // The retry loop should have caught the recovery and succeeded.
    expect(outcome.status).toBe('ok');
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_success).toBe(1);
    expect(snap.counters.drive_sync_retry).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('records drive_sync_dead when a retryable failure exhausts all attempts', async () => {
    // Force a permanent 500 so every attempt fails.
    server.setMode('createMedia', '500');
    const outcome = await sync.runUploadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
    });
    expect(outcome.status).toBe('failed');
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_failed).toBe(1);
    expect(snap.counters.drive_sync_dead).toBe(1);
    // Should have retried at least once.
    expect(snap.counters.drive_sync_retry).toBeGreaterThanOrEqual(1);
  }, 15000);
});

describe('DriveSyncService — non-blocking contract', () => {
  it('syncAfterUpload returns immediately and runs in the background', async () => {
    // Make the mock slow so we can observe the fire-and-forget behaviour.
    server.setDelay(100);
    const start = Date.now();
    sync.syncAfterUpload({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
    });
    const elapsed = Date.now() - start;
    // The sync was fired but not awaited.
    expect(elapsed).toBeLessThan(100);
    // Wait for the background sync to settle. The upload sync has 4 steps
    // (media, folder, add-to-folder, sync) each at 100ms = ~400ms minimum.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    server.setDelay(0);
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_success).toBe(1);
  });

  it('syncAfterDownload returns immediately and runs in the background', async () => {
    server.setDelay(100);
    const start = Date.now();
    sync.syncAfterDownload({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    await new Promise((resolve) => setTimeout(resolve, 600));
    server.setDelay(0);
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_success).toBe(1);
  });
});

describe('DriveSyncService — idempotency', () => {
  it('replaying syncAfterUpload with the same queue id does not create duplicate media', async () => {
    const payload = {
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
    };
    await sync.runUploadSync(payload);
    await sync.runUploadSync(payload);
    // The mock dedupes by Idempotency-Key, so only one media record exists.
    expect(server.mediaStore().size).toBe(1);
    // The create endpoint was called twice (once per runUploadSync), but
    // the second call returned the cached 201.
    const createRequests = server.getRequests().filter((r) => r.path === '/api/v1/media');
    expect(createRequests.length).toBe(2);
  });

  it('replaying syncAfterDownload with the same queue id returns the cached recent record (idempotent)', async () => {
    const payload = { queueId: 'job-1', ownerId: 1, mediaId: 'file-1' };
    const first = await sync.runDownloadSync(payload);
    const second = await sync.runDownloadSync(payload);
    // Idempotency: the same Idempotency-Key returns the cached response.
    expect(second.status).toBe('ok');
    expect(second.recentResult?.ok).toBe(true);
    // The mock dedupes by Idempotency-Key so the second call returns the
    // cached record without creating a duplicate.
    expect(server.recentStore().size).toBe(1);
    void first;
  });

  it('a different queue id creates a separate recent record (or upserts by mediaId+ownerId)', async () => {
    await sync.runDownloadSync({ queueId: 'job-1', ownerId: 1, mediaId: 'file-1' });
    await sync.runDownloadSync({ queueId: 'job-2', ownerId: 1, mediaId: 'file-1' });
    // The mock upserts by (mediaId, ownerId) so the second call bumps the
    // accessedAt timestamp and the record count stays at 1.
    expect(server.recentStore().size).toBe(1);
  });
});

describe('DriveSyncService — folder sync (best-effort)', () => {
  it('still reports ok when folder creation fails but media creation succeeds', async () => {
    server.setMode('createFolder', '500');
    const outcome = await sync.runUploadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
      folder: { id: 'tmd-1', name: 'Test' },
    });
    // Media creation succeeded, folder failed (best-effort), sync still ok.
    expect(outcome.status).toBe('ok');
    expect(server.mediaStore().has('media-1')).toBe(true);
    expect(server.folderStore().has('tmd-1')).toBe(false);
  }, 30000);

  it('still reports ok when sync notification fails but media creation succeeds', async () => {
    server.setMode('syncMedia', '500');
    const outcome = await sync.runUploadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
    });
    expect(outcome.status).toBe('ok');
    expect(server.mediaStore().has('media-1')).toBe(true);
  }, 30000);
});

describe('DriveSyncService — Drive offline does not break the flow', () => {
  it('swallows network errors and records them as failures', async () => {
    server.setMode('createMedia', 'network');
    const outcome = await sync.runUploadSync({
      queueId: 'job-1',
      ownerId: 1,
      mediaId: 'file-1',
      media: sampleMedia(),
    });
    expect(outcome.status).toBe('failed');
    const snap = await metrics.snapshot();
    expect(snap.counters.drive_sync_failed).toBeGreaterThanOrEqual(1);
  }, 30000);
});
