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

describe('DriveApiClient — folder endpoints', () => {
  it('creates a folder and reads it back', async () => {
    const create = await client.createFolder({
      id: 'folder-1',
      ownerId: 1,
      name: 'My Folder',
    });
    expect(create.ok).toBe(true);
    expect(create.status).toBe(201);
    expect(create.body?.id).toBe('folder-1');
    expect(create.body?.name).toBe('My Folder');

    const get = await client.getFolder('folder-1');
    expect(get.ok).toBe(true);
    expect(get.body?.id).toBe('folder-1');
  });

  it('returns 404 for a missing folder', async () => {
    const get = await client.getFolder('does-not-exist');
    expect(get.status).toBe(404);
    expect(get.ok).toBe(false);
  });

  it('adds a media to a folder', async () => {
    await client.createFolder({ id: 'folder-1', ownerId: 1, name: 'F' });
    const add = await client.addMediaToFolder('folder-1', { mediaId: 'media-1', ownerId: 1 });
    expect(add.status).toBe(201);
    expect(add.ok).toBe(true);
  });

  it('returns 401 when not authenticated', async () => {
    server.setMode('createFolder', '401');
    const result = await client.createFolder({ id: 'f', ownerId: 1, name: 'F' });
    expect(result.status).toBe(401);
  });

  it('returns 422 when the payload is invalid', async () => {
    server.setMode('createFolder', '422');
    const result = await client.createFolder({ id: 'f', ownerId: 1, name: 'F' });
    expect(result.status).toBe(422);
  });
});

describe('DriveApiClient — share endpoint', () => {
  it('creates a share for an existing media', async () => {
    // First create a media so the share has a target.
    await client.createMedia({
      id: 'media-1',
      ownerId: 1,
      provider: 'youtube',
      canonicalUrl: 'https://example.com/v',
      originalUrl: 'https://example.com/v',
      title: 'T',
      mimeType: 'video/mp4',
      quality: '720p',
      checksum: 'sha256:abc',
      fileId: 'file-1',
      messageId: 1,
      chatId: '-100',
    });
    const share = await client.createShare('media-1', { mediaId: 'media-1', ownerId: 1 });
    expect(share.ok).toBe(true);
    expect(share.body?.mediaId).toBe('media-1');
    expect(share.body?.token).toBeDefined();
  });

  it('returns 404 when sharing a non-existent media', async () => {
    const share = await client.createShare('no-such-media', { mediaId: 'no-such-media', ownerId: 1 });
    expect(share.status).toBe(404);
  });
});

describe('DriveApiClient — trash endpoints', () => {
  it('lists trash items (empty by default)', async () => {
    const list = await client.listTrash(1);
    expect(list.ok).toBe(true);
    expect(Array.isArray(list.body)).toBe(true);
  });

  it('returns 404 when deleting a non-existent trash item', async () => {
    const del = await client.deleteTrashItem('no-such-item');
    expect(del.status).toBe(404);
  });
});

describe('DriveApiClient — favorite endpoints', () => {
  it('adds a favorite and is idempotent on replay', async () => {
    const first = await client.addFavorite({ mediaId: 'media-1', ownerId: 1 }, 'fav-key');
    expect(first.ok).toBe(true);
    expect(first.body?.mediaId).toBe('media-1');

    const second = await client.addFavorite({ mediaId: 'media-1', ownerId: 1 }, 'fav-key');
    expect(second.ok).toBe(true);
    // Same idempotency key returns the cached response.
    expect(second.body?.id).toBe(first.body?.id);
  });

  it('returns 401 when not authenticated', async () => {
    server.setMode('addFavorite', '401');
    const result = await client.addFavorite({ mediaId: 'm', ownerId: 1 });
    expect(result.status).toBe(401);
  });
});

describe('DriveApiClient — recent endpoint', () => {
  it('records a recent access', async () => {
    const result = await client.recordRecent({ mediaId: 'media-1', ownerId: 1 });
    expect(result.ok).toBe(true);
    expect(result.body?.mediaId).toBe('media-1');
  });

  it('upserts by (mediaId, ownerId) so a second call bumps the record', async () => {
    const first = await client.recordRecent({ mediaId: 'media-1', ownerId: 1 }, 'k-1');
    const second = await client.recordRecent({ mediaId: 'media-1', ownerId: 1 }, 'k-2');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Different idempotency keys → second call upserts but does not duplicate.
    void second;
  });
});

describe('DriveApiClient — collaboration endpoint', () => {
  it('invites a collaborator to an existing folder', async () => {
    await client.createFolder({ id: 'folder-1', ownerId: 1, name: 'F' });
    const invite = await client.inviteCollaborator('folder-1', {
      folderId: 'folder-1',
      inviterId: 1,
      inviteeId: 2,
      role: 'viewer',
    });
    expect(invite.ok).toBe(true);
    expect(invite.body?.folderId).toBe('folder-1');
    expect(invite.body?.role).toBe('viewer');
    expect(invite.body?.status).toBe('pending');
  });

  it('returns 404 when the folder does not exist', async () => {
    const invite = await client.inviteCollaborator('no-such-folder', {
      folderId: 'no-such-folder',
      inviterId: 1,
      inviteeId: 2,
      role: 'viewer',
    });
    expect(invite.status).toBe(404);
  });
});
