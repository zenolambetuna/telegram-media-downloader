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

let server: MockDriveServer;
let client: DriveApiClient;
let dir: string;
let conn: DatabaseConnection;
let metrics: MetricsCollector;
let sync: DriveSyncService;

beforeEach(async () => {
  server = new MockDriveServer();
  await server.start();
  client = new DriveApiClient({ baseUrl: server.baseUrl, apiKey: MOCK_DRIVE_API_KEY, timeoutMs: 1000 });
  dir = mkdtempSync(path.join(tmpdir(), 'drivesync41-'));
  conn = new DatabaseConnection(path.join(dir, 'test.db'));
  const counters = new CounterRepository(conn);
  const queueJobs = new QueueJobRepository(conn);
  metrics = new MetricsCollector(counters, queueJobs);
  sync = new DriveSyncService(client, metrics);
});

afterEach(async () => {
  await server.stop();
  try { conn.close(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('DriveSyncService Stage 4.1 — folder operations', () => {
  it('renames a folder via the sync service and records folder_sync_success', async () => {
    await client.createFolder({ id: 'f1', ownerId: 1, name: 'Old' });
    const result = await sync.renameFolder('f1', { name: 'New', ownerId: 1 }, 'job-1');
    expect(result.ok).toBe(true);
    const snap = await metrics.snapshot();
    expect(snap.serviceCounters?.folder.success).toBe(1);
  });

  it('moves a folder via the sync service', async () => {
    await client.createFolder({ id: 'parent', ownerId: 1, name: 'P' });
    await client.createFolder({ id: 'child', ownerId: 1, name: 'C' });
    const result = await sync.moveFolder('child', { parentId: 'parent', ownerId: 1 }, 'job-1');
    expect(result.ok).toBe(true);
  });

  it('deletes a folder via the sync service', async () => {
    await client.createFolder({ id: 'del', ownerId: 1, name: 'X' });
    const result = await sync.deleteFolder('del', 'job-1');
    expect(result.ok).toBe(true);
  });

  it('lists folders via the sync service', async () => {
    await client.createFolder({ id: 'f1', ownerId: 1, name: 'F1' });
    const result = await sync.listFolders(1, undefined, 'job-1');
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.body)).toBe(true);
    expect(result.body?.length).toBe(1);
  });
});

describe('DriveSyncService Stage 4.1 — share operations', () => {
  it('updates a share via the sync service', async () => {
    await client.createMedia({
      id: 'm1', ownerId: 1, provider: 'youtube',
      canonicalUrl: 'https://e.com', originalUrl: 'https://e.com',
      title: 'T', mimeType: 'video/mp4', quality: '720p',
      checksum: 'sha256:a', fileId: 'f1', messageId: 1, chatId: '-100',
    });
    const created = await client.createShare('m1', { mediaId: 'm1', ownerId: 1 });
    const result = await sync.updateShare(created.body!.id, { ownerId: 1, expiresAt: '2027-01-01T00:00:00Z' }, 'job-1');
    expect(result.ok).toBe(true);
    const snap = await metrics.snapshot();
    expect(snap.serviceCounters?.share.success).toBe(1);
  });

  it('revokes a share via the sync service', async () => {
    await client.createMedia({
      id: 'm2', ownerId: 1, provider: 'youtube',
      canonicalUrl: 'https://e.com/2', originalUrl: 'https://e.com/2',
      title: 'T', mimeType: 'video/mp4', quality: '720p',
      checksum: 'sha256:b', fileId: 'f2', messageId: 2, chatId: '-100',
    });
    const created = await client.createShare('m2', { mediaId: 'm2', ownerId: 1 });
    const result = await sync.revokeShare(created.body!.id, 'job-1');
    expect(result.ok).toBe(true);
  });

  it('lists shares via the sync service', async () => {
    await client.createMedia({
      id: 'm3', ownerId: 3, provider: 'youtube',
      canonicalUrl: 'https://e.com/3', originalUrl: 'https://e.com/3',
      title: 'T', mimeType: 'video/mp4', quality: '720p',
      checksum: 'sha256:c', fileId: 'f3', messageId: 3, chatId: '-100',
    });
    await client.createShare('m3', { mediaId: 'm3', ownerId: 3 });
    const result = await sync.listShares(3, undefined, 'job-1');
    expect(result.ok).toBe(true);
    expect(result.body?.length).toBe(1);
  });
});

describe('DriveSyncService Stage 4.1 — trash operations', () => {
  it('moves a media to trash via the sync service', async () => {
    const result = await sync.moveToTrash({ mediaId: 'trash-me', ownerId: 1 }, 'job-1');
    expect(result.ok).toBe(true);
    const snap = await metrics.snapshot();
    expect(snap.serviceCounters?.trash.success).toBe(1);
  });

  it('restores a trashed item via the sync service', async () => {
    const moved = await sync.moveToTrash({ mediaId: 'restore-me', ownerId: 1 }, 'job-1');
    const result = await sync.restoreTrash(moved.body!.id, { ownerId: 1 }, 'job-1');
    expect(result.ok).toBe(true);
  });
});

describe('DriveSyncService Stage 4.1 — favorite + recent operations', () => {
  it('lists favorites via the sync service', async () => {
    await client.addFavorite({ mediaId: 'fav1', ownerId: 2 }, 'k1');
    const result = await sync.listFavorites(2, 'job-1');
    expect(result.ok).toBe(true);
    expect(result.body?.length).toBe(1);
    const snap = await metrics.snapshot();
    expect(snap.serviceCounters?.favorite.success).toBe(1);
  });

  it('cleans up recent entries via the sync service', async () => {
    for (let i = 0; i < 5; i++) {
      await client.recordRecent({ mediaId: `m-${i}`, ownerId: 42 }, `k-${i}`);
    }
    const result = await sync.cleanupRecent({ ownerId: 42, keep: 2 }, 'job-1');
    expect(result.ok).toBe(true);
    expect(result.body?.removed).toBe(3);
    const snap = await metrics.snapshot();
    expect(snap.serviceCounters?.recent.success).toBe(1);
  });
});

describe('DriveSyncService Stage 4.1 — collaboration operations', () => {
  it('updates a collaborator via the sync service', async () => {
    await client.createFolder({ id: 'colab-f', ownerId: 1, name: 'Shared' });
    const invite = await client.inviteCollaborator('colab-f', {
      folderId: 'colab-f', inviterId: 1, inviteeId: 2, role: 'viewer',
    });
    const result = await sync.updateCollaborator(invite.body!.id, { inviterId: 1, role: 'editor' }, 'job-1');
    expect(result.ok).toBe(true);
    expect(result.body?.role).toBe('editor');
    const snap = await metrics.snapshot();
    expect(snap.serviceCounters?.collaboration.success).toBe(1);
  });

  it('removes a collaborator via the sync service', async () => {
    await client.createFolder({ id: 'colab-f2', ownerId: 1, name: 'Shared2' });
    const invite = await client.inviteCollaborator('colab-f2', {
      folderId: 'colab-f2', inviterId: 1, inviteeId: 3, role: 'viewer',
    });
    const result = await sync.removeCollaborator(invite.body!.id, 'job-1');
    expect(result.ok).toBe(true);
  });

  it('lists collaborators via the sync service', async () => {
    await client.createFolder({ id: 'colab-f3', ownerId: 1, name: 'Shared3' });
    await client.inviteCollaborator('colab-f3', { folderId: 'colab-f3', inviterId: 1, inviteeId: 4, role: 'viewer' });
    const result = await sync.listCollaborators('colab-f3', 'job-1');
    expect(result.ok).toBe(true);
    expect(result.body?.length).toBe(1);
  });
});

describe('DriveSyncService Stage 4.1 — per-service metrics', () => {
  it('records success per service in the serviceCounters block', async () => {
    await sync.moveToTrash({ mediaId: 'm1', ownerId: 1 }, 'job-1');
    await sync.listFavorites(1, 'job-1');
    await sync.listFolders(1, undefined, 'job-1');
    const snap = await metrics.snapshot();
    expect(snap.serviceCounters?.trash.success).toBe(1);
    expect(snap.serviceCounters?.favorite.success).toBe(1);
    expect(snap.serviceCounters?.folder.success).toBe(1);
  });

  it('records failed per service on a 404', async () => {
    await sync.renameFolder('no-such-folder', { name: 'X', ownerId: 1 }, 'job-1');
    const snap = await metrics.snapshot();
    expect(snap.serviceCounters?.folder.failed).toBe(1);
    expect(snap.serviceCounters?.folder.success).toBe(0);
  });
});

describe('DriveSyncService Stage 4.1 — unconfigured client', () => {
  it('returns a not-configured result without throwing', async () => {
    const unconfigured = new DriveApiClient({ baseUrl: undefined, apiKey: undefined });
    const localSync = new DriveSyncService(unconfigured, metrics);
    const result = await localSync.renameFolder('f1', { name: 'X', ownerId: 1 }, 'job-1');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });
});

describe('DriveSyncService Stage 4.1 — retry on 500', () => {
  it('retries a 500 on moveToTrash and records folder_sync_dead when exhausted', async () => {
    server.setMode('moveToTrash', '500');
    const result = await sync.moveToTrash({ mediaId: 'm1', ownerId: 1 }, 'job-1');
    expect(result.ok).toBe(false);
    const snap = await metrics.snapshot();
    expect(snap.serviceCounters?.trash.failed).toBe(1);
    expect(snap.counters.drive_sync_dead).toBeGreaterThanOrEqual(1);
  }, 30000);
});
