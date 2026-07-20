import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DriveApiClient } from '../src/core/DriveApiClient';
import { DriveStatus } from '../src/core/DriveBridgeContract';
import { MockDriveServer, MOCK_DRIVE_API_KEY } from './mockDriveServer';
import { satisfies } from '../src/utils/semver';
import { DRIVE_COMPATIBLE_RANGE } from '../src/core/DriveBridgeContract';

let server: MockDriveServer;
let client: DriveApiClient;

beforeEach(async () => {
  server = new MockDriveServer();
  await server.start();
  client = new DriveApiClient({
    baseUrl: server.baseUrl,
    apiKey: MOCK_DRIVE_API_KEY,
    timeoutMs: 1500,
  });
});

afterEach(async () => {
  await server.stop();
});

function sampleCreateRequest(overrides: Partial<ReturnType<typeof sampleCreateRequest>> = {}) {
  return {
    id: 'media-1',
    ownerId: 1,
    provider: 'youtube',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    originalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Sample',
    description: 'sample desc',
    duration: 212,
    thumbnail: 'https://example.com/thumb.jpg',
    mimeType: 'video/mp4',
    quality: '720p',
    resolution: '1280x720',
    size: 5_000_000,
    checksum: 'sha256:abc',
    fileId: 'file-1',
    messageId: 42,
    chatId: '-100123',
    ...overrides,
  };
}

describe('DriveApiClient integration — health endpoint', () => {
  it('returns ok when the drive is healthy', async () => {
    const result = await client.health();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('drive');
    expect(result.version).toBe('3.2.1');
  });

  it('reports down when the health endpoint returns 500', async () => {
    server.setMode('health', '500');
    const result = await client.health();
    expect(result.status).toBe('down');
    expect(result.checks?.httpStatus).toBe(500);
  });

  it('reports down when the server is unreachable', async () => {
    const dead = new DriveApiClient({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: MOCK_DRIVE_API_KEY,
      timeoutMs: 300,
    });
    const result = await dead.health();
    expect(result.status).toBe('down');
    expect(result.checks?.error).toBeDefined();
  });
});

describe('DriveApiClient integration — authentication', () => {
  it('rejects requests without an API key with 401', async () => {
    server.setMode('version', '401');
    const noAuth = new DriveApiClient({
      baseUrl: server.baseUrl,
      apiKey: undefined,
      timeoutMs: 1000,
    });
    const result = await noAuth.getVersion();
    expect(result.status).toBe(401);
    expect(result.ok).toBe(false);
    // The error body is parsed as JSON so callers can read the error code.
    expect(result.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid API key' } });
  });

  it('rejects requests with the wrong API key with 401', async () => {
    const wrongKey = new DriveApiClient({
      baseUrl: server.baseUrl,
      apiKey: 'wrong-key',
      timeoutMs: 1000,
    });
    const result = await wrongKey.getVersion();
    expect(result.status).toBe(401);
  });

  it('accepts requests with the correct API key', async () => {
    const result = await client.getVersion();
    expect(result.ok).toBe(true);
    expect(result.body?.version).toBe('3.2.1');
  });

  it('returns 401 when the create endpoint is forced to 401', async () => {
    server.setMode('createMedia', '401');
    const result = await client.createMedia(sampleCreateRequest(), 'idem-1');
    expect(result.status).toBe(401);
    expect(result.ok).toBe(false);
  });

  it('returns 403 when forbidden', async () => {
    server.setMode('createMedia', '403');
    const result = await client.createMedia(sampleCreateRequest(), 'idem-1');
    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
  });
});

describe('DriveApiClient integration — idempotency', () => {
  it('returns the same response for repeated requests with the same key', async () => {
    const request = sampleCreateRequest();
    const key = 'idem-repeated';
    const first = await client.createMedia(request, key);
    const second = await client.createMedia(request, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.body?.id).toBe('media-1');
  });

  it('creates separate records for different idempotency keys', async () => {
    const requestA = sampleCreateRequest({ id: 'media-a' });
    const requestB = sampleCreateRequest({ id: 'media-b' });
    const a = await client.createMedia(requestA, 'key-a');
    const b = await client.createMedia(requestB, 'key-b');
    expect(a.body?.id).toBe('media-a');
    expect(b.body?.id).toBe('media-b');
  });

  it('treats delete as idempotent', async () => {
    await client.createMedia(sampleCreateRequest(), 'k-create');
    const first = await client.deleteMedia('media-1', 'k-delete');
    const second = await client.deleteMedia('media-1', 'k-delete');
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  it('treats sync as idempotent', async () => {
    await client.createMedia(sampleCreateRequest(), 'k-create');
    const first = await client.syncMedia('media-1', {}, 'k-sync');
    const second = await client.syncMedia('media-1', {}, 'k-sync');
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
  });
});

describe('DriveApiClient integration — retry semantics', () => {
  it('classifies 429 as a retryable rate limit', async () => {
    server.setMode('createMedia', '429');
    const result = await client.createMedia(sampleCreateRequest(), 'idem-1');
    expect(result.status).toBe(429);
    expect(result.ok).toBe(false);
    // The DriveApiClient itself does not retry — the queue worker does —
    // but the status is the retry signal the worker uses.
  });

  it('classifies 500 as a retryable server error', async () => {
    server.setMode('createMedia', '500');
    const result = await client.createMedia(sampleCreateRequest(), 'idem-1');
    expect(result.status).toBe(500);
    expect(result.ok).toBe(false);
  });

  it('classifies 409 as a permanent conflict', async () => {
    server.setMode('createMedia', '409');
    const result = await client.createMedia(sampleCreateRequest(), 'idem-1');
    expect(result.status).toBe(409);
    expect(result.ok).toBe(false);
    // The queue worker maps this to a permanent error: another media already
    // has this checksum. Retrying with the same id will not help.
  });

  it('does not retry a 404 from getMedia', async () => {
    server.setMode('getMedia', '404');
    const result = await client.getMedia('does-not-exist');
    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
  });
});

describe('DriveApiClient integration — timeout', () => {
  it('returns status -1 when the server never responds', async () => {
    server.setMode('version', 'timeout');
    const result = await client.getVersion();
    expect(result.status).toBe(-1);
    expect(result.ok).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('times out faster than the configured deadline', async () => {
    server.setMode('version', 'timeout');
    const slow = new DriveApiClient({
      baseUrl: server.baseUrl,
      apiKey: MOCK_DRIVE_API_KEY,
      timeoutMs: 200,
    });
    const start = Date.now();
    const result = await slow.getVersion();
    const elapsed = Date.now() - start;
    expect(result.status).toBe(-1);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('DriveApiClient integration — invalid payload', () => {
  it('returns 422 when the create payload is invalid', async () => {
    // Bypass client validation by sending a bad payload via a direct fetch
    // to confirm the server still rejects it. The client always sends a
    // valid body, so we emulate a broken caller.
    server.setMode('createMedia', 'success');
    const response = await fetch(`${server.baseUrl}/api/v1/media`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': MOCK_DRIVE_API_KEY,
        'Idempotency-Key': 'bad-1',
      },
      body: JSON.stringify({ id: 'x', ownerId: 'not-a-number' }),
    });
    expect(response.status).toBe(422);
    const payload = (await response.json()) as { error: { code: string; details: Array<{ field: string }> } };
    expect(payload.error.code).toBe('VALIDATION_ERROR');
    expect(payload.error.details[0].field).toBe('payload');
  });

  it('returns 422 when the create endpoint is forced to 422', async () => {
    server.setMode('createMedia', '422');
    const result = await client.createMedia(sampleCreateRequest(), 'idem-1');
    expect(result.status).toBe(422);
    expect(result.ok).toBe(false);
  });
});

describe('DriveApiClient integration — duplicate request', () => {
  it('returns the cached response for an identical idempotency key', async () => {
    const request = sampleCreateRequest();
    const first = await client.createMedia(request, 'dup-key');
    const second = await client.createMedia(request, 'dup-key');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it('records both requests in the server request log', async () => {
    const request = sampleCreateRequest();
    await client.createMedia(request, 'log-key');
    await client.createMedia(request, 'log-key');
    const createRequests = server.getRequests().filter((r) => r.path === '/api/v1/media');
    expect(createRequests).toHaveLength(2);
    expect(createRequests[0].headers['idempotency-key']).toBe('log-key');
    expect(createRequests[1].headers['idempotency-key']).toBe('log-key');
  });
});

describe('DriveApiClient integration — network failure', () => {
  it('returns status 0 when the server destroys the socket', async () => {
    server.setMode('createMedia', 'network');
    const result = await client.createMedia(sampleCreateRequest(), 'net-1');
    expect(result.status).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.text).toBeDefined();
  });

  it('reports down for an unreachable baseUrl', async () => {
    const dead = new DriveApiClient({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: MOCK_DRIVE_API_KEY,
      timeoutMs: 200,
    });
    const health = await dead.health();
    expect(health.status).toBe('down');
  });
});

describe('DriveApiClient integration — full CRUD round trip', () => {
  it('creates, reads, syncs, and deletes a media record', async () => {
    const created = await client.createMedia(sampleCreateRequest(), 'crud-key');
    expect(created.status).toBe(201);
    expect(created.body?.id).toBe('media-1');

    const fetched = await client.getMedia('media-1');
    expect(fetched.ok).toBe(true);
    expect(fetched.body?.id).toBe('media-1');
    expect(fetched.body?.title).toBe('Sample');

    const synced = await client.syncMedia('media-1', {}, 'crud-sync');
    expect(synced.status).toBe(202);
    expect(synced.body?.status).toBe('queued');

    const deleted = await client.deleteMedia('media-1', 'crud-delete');
    expect(deleted.status).toBe(204);

    const afterDelete = await client.getMedia('media-1');
    expect(afterDelete.status).toBe(404);
  });
});

describe('DriveApiClient integration — contract version', () => {
  it('reports a version that satisfies the downloader compatible range', async () => {
    const result = await client.getVersion();
    expect(result.ok).toBe(true);
    expect(satisfies(result.body!.version, DRIVE_COMPATIBLE_RANGE)).toBe(true);
    expect(result.body!.apiVersion).toBe('v1');
  });
});

describe('DriveApiClient integration — request headers', () => {
  it('sends X-API-Key, Idempotency-Key, Accept, and Content-Type headers', async () => {
    await client.createMedia(sampleCreateRequest(), 'hdr-1');
    const last = server.getRequests().filter((r) => r.path === '/api/v1/media').pop()!;
    expect(last.headers['x-api-key']).toBe(MOCK_DRIVE_API_KEY);
    expect(last.headers['idempotency-key']).toBe('hdr-1');
    expect(last.headers['accept']).toBe('application/json');
    expect(last.headers['content-type']).toBe('application/json');
  });

  it('sends the X-Api-Version and X-Client headers on every call', async () => {
    await client.getVersion();
    const last = server.getRequests().filter((r) => r.path === '/api/v1/integration/version').pop()!;
    expect(last.headers['x-api-version']).toBe('/api/v1');
    expect(last.headers['x-client']).toBe('telegram-media-downloader');
  });
});

describe('DriveApiClient integration — duration reporting', () => {
  it('reports a non-negative durationMs for every call', async () => {
    const result = await client.getVersion();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('DriveApiClient integration — unconfigured client', () => {
  it('returns status 0 from every method when not configured', async () => {
    const unconfigured = new DriveApiClient({
      baseUrl: undefined,
      apiKey: undefined,
    });
    expect(unconfigured.configured).toBe(false);
    expect((await unconfigured.getVersion()).status).toBe(0);
    expect((await unconfigured.createMedia(sampleCreateRequest())).status).toBe(0);
    expect((await unconfigured.getMedia('x')).status).toBe(0);
    expect((await unconfigured.deleteMedia('x')).status).toBe(0);
    expect((await unconfigured.syncMedia('x')).status).toBe(0);
  });

  it('reports health as down when not configured', async () => {
    const unconfigured = new DriveApiClient({ baseUrl: undefined, apiKey: undefined });
    const health = await unconfigured.health();
    expect(health.status).toBe('down');
    expect(health.checks?.configured).toBe(false);
  });
});

export { DriveStatus };
