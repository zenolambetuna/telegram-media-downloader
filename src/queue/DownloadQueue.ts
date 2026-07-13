import { logger } from '../logger/logger';
import { AppError } from '../types/errors';

export interface QueueJob<T> {
  id: string;
  userId: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/**
 * A concurrency-limited job queue with per-job cancellation. Pending jobs can
 * be cancelled before they start; active jobs are cancelled cooperatively via
 * the CancellationToken passed into the job body by the caller.
 */
export class DownloadQueue {
  private readonly pending: QueueJob<unknown>[] = [];
  private readonly active = new Set<string>();
  private shuttingDown = false;

  constructor(private readonly concurrency: number) {}

  async add<T>(id: string, userId: number, run: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) {
      throw new AppError('Queue is shutting down', 'CANCELLED');
    }
    return await new Promise<T>((resolve, reject) => {
      this.pending.push({ id, userId, run, resolve, reject } as QueueJob<unknown>);
      this.drain();
    });
  }

  /** Cancels a still-pending job. Returns true if it was removed from the queue. */
  cancelPending(id: string): boolean {
    const index = this.pending.findIndex((job) => job.id === id);
    if (index === -1) {
      return false;
    }
    const [job] = this.pending.splice(index, 1);
    job.reject(new AppError('Cancelled by user', 'CANCELLED'));
    return true;
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  stats(): { pending: number; active: number; concurrency: number; shuttingDown: boolean } {
    return {
      pending: this.pending.length,
      active: this.active.size,
      concurrency: this.concurrency,
      shuttingDown: this.shuttingDown,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (this.pending.length === 0 && this.active.size === 0) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
  }

  private drain(): void {
    while (!this.shuttingDown && this.active.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) {
        return;
      }

      this.active.add(job.id);
      logger.info({ jobId: job.id, active: this.active.size }, 'queue job started');

      void job
        .run()
        .then((result) => job.resolve(result))
        .catch((error) => job.reject(error))
        .finally(() => {
          this.active.delete(job.id);
          logger.info({ jobId: job.id, active: this.active.size }, 'queue job finished');
          this.drain();
        });
    }
  }
}
