import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DriveApiClient } from '../src/core/DriveApiClient';
import { MockDriveServer, MOCK_DRIVE_API_KEY } from './mockDriveServer';

let server: MockDriveServer;
let client: DriveApiClient;

beforeEach(async () => {
  server = new MockDriveServer();
  await server.start();
  client = new DriveApiClient({
    baseUrl: server.baseUrl,
    apiKey: MOCK_DRIVE_API_KEY,
    timeoutMs: 1000,
  });
});

afterEach(async () => {
  await server.stop();
});

describe('Stage 4.1 — folder operations', () => {
  it('renames an existing folder', async () => {
    await client.createFolder({ id: 'folder-1', ownerId: 1, name: 'Old' });
    const result = await client.renameFolder('folder-1', { name: 'New', ownerId: 1 });
    expect(result.ok).toBe(true);
    expect(result.body?.name).toBe('New');
    const get = await client.getFolder('folder-1');
    expect(get.body?.name).toBe('New');
  });

  it('returns 404 when renaming a missing folder', async () => {
    const result = await client.renameFolder('no-such', { name: 'X', ownerId: 1 });
    expect(result.status).toBe(404);
  });

  it('moves a folder to a new parent', async () => {
    await client.createFolder({ id: 'parent', ownerId: 1, name: 'Parent' });
    await client.createFolder({ id: 'child', ownerId: 1, name: 'Child' });
    const result = await client.moveFolder('child', { parentId: 'parent', ownerId: 1 });
    expect(result.ok).toBe(true);
    expect(result.body?.parentId).toBe('parent');
  });

  it('deletes a folder', async () => {
    await client.createFolder({ id: 'to-delete', ownerId: 1, name: 'X' });
    const del = await client.deleteFolder('to-delete');
    expect(del.status).toBe(204);
    const get = await client.getFolder('to-delete');
    expect(get.status).toBe(404);
  });

  it('lists folders for an owner', async () => {
    await client.createFolder({ id: 'f1', ownerId: 5, name: 'F1' });
    await client.createFolder({ id: 'f2', ownerId: 5, name: 'F2' });
    await client.createFolder({ id: 'f3', ownerId: 9, name: 'F3' });
    const result = await client.listFolders(5);
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.body)).toBe(true);
    expect(result.body?.length).toBe(2);
  });

  it('filters folder list by parentId', async () => {
    await client.createFolder({ id: 'root', ownerId: 1, name: 'Root' });
    await client.createFolder({ id: 'child', ownerId: 1, name: 'Child', parentId: 'root' });
    const result = await client.listFolders(1, 'root');
    expect(result.body?.length).toBe(1);
    expect(result.body?.[0].id).toBe('child');
  });
});

describe('Stage 4.1 — share operations', () => {
  it('updates a share expiry', async () => {
    // Create a media + share first.
    await client.createMedia({
      id: 'media-1', ownerId: 1, provider: 'youtube',
      canonicalUrl: 'https://e.com/v', originalUrl: 'https://e.com/v',
      title: 'T', mimeType: 'video/mp4', quality: '720p',
      checksum: 'sha256:abc', fileId: 'file-1', messageId: 1, chatId: '-100',
    });
    const created = await client.createShare('media-1', { mediaId: 'media-1', ownerId: 1 });
    const shareId = created.body!.id;
    const result = await client.updateShare(shareId, { ownerId: 1, expiresAt: '2027-01-01T00:00:00Z' });
    expect(result.ok).toBe(true);
    expect(result.body?.expiresAt).toBe('2027-01-01T00:00:00Z');
  });

  it('revokes a share', async () => {
    await client.createMedia({
      id: 'media-2', ownerId: 1, provider: 'youtube',
      canonicalUrl: 'https://e.com/v2', originalUrl: 'https://e.com/v2',
      title: 'T', mimeType: 'video/mp4', quality: '720p',
      checksum: 'sha256:def', fileId: 'file-2', messageId: 2, chatId: '-100',
    });
    const created = await client.createShare('media-2', { mediaId: 'media-2', ownerId: 1 });
    const shareId = created.body!.id;
    const revoked = await client.revokeShare(shareId);
    expect(revoked.status).toBe(204);
  });

  it('lists shares for an owner', async () => {
    await client.createMedia({
      id: 'media-3', ownerId: 7, provider: 'youtube',
      canonicalUrl: 'https://e.com/v3', originalUrl: 'https://e.com/v3',
      title: 'T', mimeType: 'video/mp4', quality: '720p',
      checksum: 'sha256:ghi', fileId: 'file-3', messageId: 3, chatId: '-100',
    });
    await client.createShare('media-3', { mediaId: 'media-3', ownerId: 7 });
    const result = await client.listShares(7);
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.body)).toBe(true);
    expect(result.body?.length).toBe(1);
  });
});

describe('Stage 4.1 — trash operations', () => {
  it('moves a media to trash', async () => {
    const result = await client.moveToTrash({ mediaId: 'media-x', ownerId: 1 });
    expect(result.ok).toBe(true);
    expect(result.body?.mediaId).toBe('media-x');
  });

  it('restores a trashed item', async () => {
    const moved = await client.moveToTrash({ mediaId: 'media-restore', ownerId: 1 });
    const trashId = moved.body!.id;
    const restored = await client.restoreTrash(trashId, { ownerId: 1 });
    expect(restored.ok).toBe(true);
  });

  it('returns 404 when restoring a missing trash item', async () => {
    const result = await client.restoreTrash('no-such', { ownerId: 1 });
    expect(result.status).toBe(404);
  });
});

describe('Stage 4.1 — favorite operations', () => {
  it('lists favorites for an owner', async () => {
    await client.addFavorite({ mediaId: 'fav-1', ownerId: 8 }, 'k1');
    await client.addFavorite({ mediaId: 'fav-2', ownerId: 8 }, 'k2');
    const result = await client.listFavorites(8);
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.body)).toBe(true);
    expect(result.body?.length).toBe(2);
  });

  it('returns an empty list for an owner with no favorites', async () => {
    const result = await client.listFavorites(999);
    expect(result.ok).toBe(true);
    expect(result.body?.length).toBe(0);
  });
});

describe('Stage 4.1 — recent cleanup', () => {
  it('cleans up recent entries keeping only the latest N', async () => {
    // Add 5 recent entries.
    for (let i = 0; i < 5; i++) {
      await client.recordRecent({ mediaId: `m-${i}`, ownerId: 42 }, `k-${i}`);
    }
    const result = await client.cleanupRecent({ ownerId: 42, keep: 2 });
    expect(result.ok).toBe(true);
    expect(result.body?.removed).toBe(3);
    expect(result.body?.kept).toBe(2);
  });
});

describe('Stage 4.1 — collaboration operations', () => {
  it('updates a collaborator role', async () => {
    await client.createFolder({ id: 'colab-f', ownerId: 1, name: 'Shared' });
    const invite = await client.inviteCollaborator('colab-f', {
      folderId: 'colab-f', inviterId: 1, inviteeId: 2, role: 'viewer',
    });
    const inviteId = invite.body!.id;
    const result = await client.updateCollaborator(inviteId, { inviterId: 1, role: 'editor' });
    expect(result.ok).toBe(true);
    expect(result.body?.role).toBe('editor');
  });

  it('removes a collaborator', async () => {
    await client.createFolder({ id: 'colab-f2', ownerId: 1, name: 'Shared2' });
    const invite = await client.inviteCollaborator('colab-f2', {
      folderId: 'colab-f2', inviterId: 1, inviteeId: 3, role: 'viewer',
    });
    const inviteId = invite.body!.id;
    const removed = await client.removeCollaborator(inviteId);
    expect(removed.status).toBe(204);
  });

  it('lists collaborators for a folder', async () => {
    await client.createFolder({ id: 'colab-f3', ownerId: 1, name: 'Shared3' });
    await client.inviteCollaborator('colab-f3', { folderId: 'colab-f3', inviterId: 1, inviteeId: 4, role: 'viewer' });
    await client.inviteCollaborator('colab-f3', { folderId: 'colab-f3', inviterId: 1, inviteeId: 5, role: 'editor' });
    const result = await client.listCollaborators('colab-f3');
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.body)).toBe(true);
    expect(result.body?.length).toBe(2);
  });

  it('returns 404 when listing collaborators for a missing folder', async () => {
    const result = await client.listCollaborators('no-such-folder');
    expect(result.status).toBe(404);
  });
});

describe('Stage 4.1 — downloader stays alive when Drive is offline', () => {
  it('returns a network-failure result (status 0) without throwing', async () => {
    server.setMode('listFolders', 'network');
    const result = await client.listFolders(1);
    expect(result.status).toBe(0);
    expect(result.ok).toBe(false);
  });

  it('returns a timeout result (status -1) without throwing', async () => {
    server.setMode('listFavorites', 'timeout');
    const result = await client.listFavorites(1);
    expect(result.status).toBe(-1);
    expect(result.ok).toBe(false);
  });
});
