import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseConnection } from '../src/storage/Database';
import { QueueJobRepository } from '../src/storage/QueueJobRepository';
import { CounterRepository } from '../src/storage/CounterRepository';
import { MetricsCollector } from '../src/core/MetricsCollector';

let dir: string;
let conn: DatabaseConnection;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'queue-test-'));
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

describe('QueueJobRepository', () => {
  it('round-trips a job record', async () => {
    const repo = new QueueJobRepository(conn);
    const now = new Date().toISOString();
    await repo.enqueue({
      id: 'job-1',
      kind: 'download',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      url: 'https://example.com/v',
      formatId: '12',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now,
      updatedAt: now,
    });
    const found = await repo.findById('job-1');
    expect(found).toBeDefined();
    expect(found?.url).toBe('https://example.com/v');
    expect(found?.status).toBe('pending');
  });

  it('claims the next due job and marks it processing', async () => {
    const repo = new QueueJobRepository(conn);
    const now = new Date();
    await repo.enqueue({
      id: 'a',
      kind: 'download',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      url: 'https://e.com/a',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await repo.enqueue({
      id: 'b',
      kind: 'download',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      url: 'https://e.com/b',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextAttemptAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    const claimed = await repo.claimNext(now, 30_000);
    expect(claimed?.id).toBe('a');
    expect(claimed?.status).toBe('processing');
    const none = await repo.claimNext(now, 30_000);
    expect(none).toBeNull();
  });

  it('marks dead jobs into the dead letter queue', async () => {
    const repo = new QueueJobRepository(conn);
    const now = new Date().toISOString();
    await repo.enqueue({
      id: 'dead-1',
      kind: 'download',
      status: 'pending',
      attempts: 3,
      maxAttempts: 3,
      url: 'https://e.com/x',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now,
      updatedAt: now,
    });
    await repo.markDead('dead-1', { code: 'DOWNLOAD_FAILED', message: 'nope', category: 'retryable' });
    const queueRow = await repo.findById('dead-1');
    expect(queueRow?.status).toBe('dead');
    const dead = await repo.listDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0].id).toBe('dead-1');
    expect(dead[0].lastErrorCode).toBe('DOWNLOAD_FAILED');
    expect(dead[0].attempts).toBe(3);
  });

  it('requeues a dead letter back into pending', async () => {
    const repo = new QueueJobRepository(conn);
    const now = new Date().toISOString();
    await repo.enqueue({
      id: 'dq',
      kind: 'download',
      status: 'pending',
      attempts: 3,
      maxAttempts: 3,
      url: 'https://e.com/dq',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now,
      updatedAt: now,
    });
    await repo.markDead('dq', { code: 'TIMEOUT', message: 'slow', category: 'network' });
    const requeued = await repo.requeueFromDeadLetter('dq', 3);
    expect(requeued?.id).toBe('dq');
    const job = await repo.findById('dq');
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(0);
    expect(await repo.deadLetterCount()).toBe(0);
  });

  it('counts by status', async () => {
    const repo = new QueueJobRepository(conn);
    const now = new Date().toISOString();
    await repo.enqueue({
      id: 'p1',
      kind: 'download',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      url: 'https://e.com/p1',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now,
      updatedAt: now,
    });
    await repo.markProcessing('p1', 30_000);
    expect(await repo.countByStatus('pending')).toBe(0);
    expect(await repo.countByStatus('processing')).toBe(1);
  });

  it('marks pending with backoff and stores last error', async () => {
    const repo = new QueueJobRepository(conn);
    const now = new Date().toISOString();
    await repo.enqueue({
      id: 'retry-1',
      kind: 'download',
      status: 'processing',
      attempts: 0,
      maxAttempts: 3,
      url: 'https://e.com/r',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now,
      updatedAt: now,
    });
    const next = new Date(Date.now() + 5000);
    await repo.markPending('retry-1', next, { code: 'TIMEOUT', message: 'slow', category: 'network' });
    const job = await repo.findById('retry-1');
    expect(job?.status).toBe('pending');
    expect(job?.lastErrorCode).toBe('TIMEOUT');
    expect(job?.nextAttemptAt).toBe(next.toISOString());
  });

  it('deletes completed jobs so they do not linger', async () => {
    const repo = new QueueJobRepository(conn);
    const now = new Date().toISOString();
    await repo.enqueue({
      id: 'done-1',
      kind: 'download',
      status: 'processing',
      attempts: 0,
      maxAttempts: 3,
      url: 'https://e.com/done',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now,
      updatedAt: now,
    });
    await repo.markCompleted('done-1');
    expect(await repo.findById('done-1')).toBeNull();
  });
});

describe('MetricsCollector', () => {
  it('records and reports counters and gauges', async () => {
    const counters = new CounterRepository(conn);
    const queueJobs = new QueueJobRepository(conn);
    const metrics = new MetricsCollector(counters, queueJobs);

    await metrics.increment('queue_success');
    await metrics.increment('queue_success');
    await metrics.increment('queue_failed');
    await metrics.increment('queue_retry');
    metrics.setQueueDepth('pending', 4);
    metrics.recordProcessing(120);
    metrics.recordProcessing(240);
    metrics.recordProcessing(60);
    metrics.markSync();

    const text = await metrics.asText();
    expect(text).toContain('success:     2');
    expect(text).toContain('failed:      1');
    expect(text).toContain('retry:       1');

    const snap = await metrics.snapshot();
    expect(snap.counters.queue_success).toBe(2);
    expect(snap.counters.queue_failed).toBe(1);
    expect(snap.counters.queue_retry).toBe(1);
    expect(snap.queue.depths.pending).toBe(4);
    expect(snap.processingTimeMs?.count).toBe(3);
    expect(snap.processingTimeMs?.max).toBe(240);
    expect(snap.lastSyncAt).toBeDefined();
  });
});
