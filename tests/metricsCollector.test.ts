import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseConnection } from '../src/storage/Database';
import { CounterRepository } from '../src/storage/CounterRepository';
import { QueueJobRepository } from '../src/storage/QueueJobRepository';
import { MetricsCollector } from '../src/core/MetricsCollector';

let dir: string;
let conn: DatabaseConnection;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'metrics-test-'));
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

describe('MetricsCollector — drive sync metrics', () => {
  it('records drive sync success and updates last sync time', async () => {
    const counters = new CounterRepository(conn);
    const queueJobs = new QueueJobRepository(conn);
    const metrics = new MetricsCollector(counters, queueJobs);

    metrics.recordSync(1500, true);
    metrics.recordSync(2500, true);
    const snap = await metrics.snapshot();
    expect(snap.syncTimeMs?.count).toBe(2);
    expect(snap.syncTimeMs?.p50).toBeGreaterThanOrEqual(1500);
    expect(snap.lastSyncAt).toBeDefined();
  });

  it('does not mark sync on failure', async () => {
    const counters = new CounterRepository(conn);
    const queueJobs = new QueueJobRepository(conn);
    const metrics = new MetricsCollector(counters, queueJobs);

    metrics.recordSync(1000, false);
    const snap = await metrics.snapshot();
    expect(snap.syncTimeMs?.count).toBe(1);
    expect(snap.lastSyncAt).toBeUndefined();
  });
});

describe('MetricsCollector — drive availability gauge', () => {
  it('records and reads the drive availability gauge', async () => {
    const counters = new CounterRepository(conn);
    const queueJobs = new QueueJobRepository(conn);
    const metrics = new MetricsCollector(counters, queueJobs);

    metrics.recordDriveAvailability({
      status: 'ok',
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 42,
      detail: 'drive healthy',
    });
    const snap = await metrics.snapshot();
    expect(snap.driveAvailability.status).toBe('ok');
    expect(snap.driveAvailability.latencyMs).toBe(42);
    expect(snap.rates.driveAvailability).toBe('ok');
  });

  it('defaults to unknown when no probe has run', async () => {
    const counters = new CounterRepository(conn);
    const queueJobs = new QueueJobRepository(conn);
    const metrics = new MetricsCollector(counters, queueJobs);
    const snap = await metrics.snapshot();
    expect(snap.driveAvailability.status).toBe('unknown');
    expect(snap.rates.driveAvailability).toBe('unknown');
  });
});

describe('MetricsCollector — derived rates', () => {
  it('computes success rate, retry rate, and average sync time', async () => {
    const counters = new CounterRepository(conn);
    const queueJobs = new QueueJobRepository(conn);
    const metrics = new MetricsCollector(counters, queueJobs);

    // 8 successes, 2 failures, 1 retry -> success rate 0.8, retry rate 0.1
    for (let i = 0; i < 8; i++) await metrics.increment('queue_success');
    for (let i = 0; i < 2; i++) await metrics.increment('queue_failed');
    await metrics.increment('queue_retry');
    metrics.recordSync(200, true);
    metrics.recordSync(400, true);
    metrics.recordSync(600, true);

    const snap = await metrics.snapshot();
    expect(snap.rates.successRate).toBeCloseTo(0.8, 5);
    expect(snap.rates.retryRate).toBeCloseTo(0.1, 5);
    expect(snap.rates.failedSync).toBe(2);
    expect(snap.rates.averageSyncTimeMs).toBeGreaterThanOrEqual(200);
  });

  it('reports zero rates when no jobs have run', async () => {
    const counters = new CounterRepository(conn);
    const queueJobs = new QueueJobRepository(conn);
    const metrics = new MetricsCollector(counters, queueJobs);
    const snap = await metrics.snapshot();
    expect(snap.rates.successRate).toBe(0);
    expect(snap.rates.retryRate).toBe(0);
    expect(snap.rates.averageSyncTimeMs).toBe(0);
  });
});

describe('MetricsCollector — queue length', () => {
  it('reports queue length as pending + processing', async () => {
    const counters = new CounterRepository(conn);
    const queueJobs = new QueueJobRepository(conn);
    const metrics = new MetricsCollector(counters, queueJobs);

    const now = new Date().toISOString();
    await queueJobs.enqueue({
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
    await queueJobs.enqueue({
      id: 'p2',
      kind: 'download',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      url: 'https://e.com/p2',
      formatId: '1',
      quality: '720p',
      userId: 1,
      chatId: 1,
      ownerId: 1,
      createdAt: now,
      updatedAt: now,
    });
    await queueJobs.markProcessing('p2', 30_000);

    const snap = await metrics.snapshot();
    expect(snap.queue.length).toBe(2);
    expect(snap.queue.pending).toBe(1);
    expect(snap.queue.processing).toBe(1);
  });
});

describe('MetricsCollector — asText rendering', () => {
  it('includes the new drive sync and rates sections', async () => {
    const counters = new CounterRepository(conn);
    const queueJobs = new QueueJobRepository(conn);
    const metrics = new MetricsCollector(counters, queueJobs);

    await metrics.increment('drive_sync_success', 5);
    await metrics.increment('drive_sync_failed', 1);
    metrics.recordDriveAvailability({ status: 'ok', latencyMs: 30 });

    const text = await metrics.asText();
    expect(text).toContain('Drive sync:');
    expect(text).toContain('Rates:');
    expect(text).toContain('success_rate:');
    expect(text).toContain('drive_availability:');
  });
});
