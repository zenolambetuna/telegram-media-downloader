import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseConnection } from '../src/storage/Database';
import { QueueJobRepository } from '../src/storage/QueueJobRepository';
import { CounterRepository } from '../src/storage/CounterRepository';
import { ErrorRepository } from '../src/storage/ErrorRepository';
import { MetricsCollector } from '../src/core/MetricsCollector';
import { QueueWorker } from '../src/core/QueueWorker';
import { DownloadQueue } from '../src/queue/DownloadQueue';
import { MediaPipeline } from '../src/core/MediaPipeline';

class FakeApi {
  constructor() {}
}

function makeWorker(conn: DatabaseConnection): QueueWorker {
  const queueJobs = new QueueJobRepository(conn);
  const counters = new CounterRepository(conn);
  const errors = new ErrorRepository(conn);
  const metrics = new MetricsCollector(counters, queueJobs);
  const queue = new DownloadQueue(1);
  // The pipeline is never executed in these tests — we only test the
  // enqueue/recover/cancel surface. Cast keeps the test decoupled from the
  // real MediaPipeline constructor surface.
  const pipeline = new MediaPipeline(
    {} as never,
    {} as never,
    {} as never,
    counters,
    errors,
  );
  return new QueueWorker(queueJobs, queue, pipeline, counters, errors, metrics, new FakeApi() as never);
}

let dir: string;
let conn: DatabaseConnection;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'worker-test-'));
  conn = new DatabaseConnection(path.join(dir, 'test.db'));
});

afterEach(() => {
  try {
    conn.close();
  } catch {
    // ignore
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('QueueWorker.enqueue', () => {
  it('persists a pending job and increments the enqueued counter', async () => {
    const worker = makeWorker(conn);
    const id = await worker.enqueue({
      url: 'https://example.com/v',
      formatId: '12',
      quality: '720p',
      userId: 1,
      chatId: 1,
    });
    expect(id).toBeDefined();
    const queueJobs = new QueueJobRepository(conn);
    const job = await queueJobs.findById(id);
    expect(job?.status).toBe('pending');
    expect(job?.url).toBe('https://example.com/v');
    const counters = new CounterRepository(conn);
    expect(await counters.get('queue_enqueued')).toBe(1);
  });

  it('recovers pending jobs from a previous run', async () => {
    const queueJobs = new QueueJobRepository(conn);
    const now = new Date().toISOString();
    await queueJobs.enqueue({
      id: 'recovered-1',
      kind: 'download',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      url: 'https://example.com/r1',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now,
      updatedAt: now,
    });
    const worker = makeWorker(conn);
    const count = await worker.recoverPending();
    expect(count).toBe(1);
  });

  it('cancels a pending job by marking it dead with CANCELLED', async () => {
    const worker = makeWorker(conn);
    const id = await worker.enqueue({
      url: 'https://example.com/c',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
    });
    const cancelled = await worker.cancelPending(id);
    expect(cancelled).toBe(true);
    const queueJobs = new QueueJobRepository(conn);
    const job = await queueJobs.findById(id);
    expect(job?.status).toBe('dead');
    expect(job?.lastErrorCode).toBe('CANCELLED');
  });

  it('returns false when cancelling an unknown job', async () => {
    const worker = makeWorker(conn);
    const cancelled = await worker.cancelPending('does-not-exist');
    expect(cancelled).toBe(false);
  });

  it('starts and stops gracefully without claiming jobs when concurrency is full', async () => {
    const worker = makeWorker(conn);
    await worker.enqueue({
      url: 'https://example.com/x',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
    });
    await worker.start();
    // Stop immediately; the worker should not deadlock.
    await worker.stop();
    expect(worker.activeCount()).toBe(0);
  });
});
