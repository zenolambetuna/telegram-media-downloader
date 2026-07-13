import { logger } from '../logger/logger';
import { AppError } from '../types/errors';

export interface QueueJob<T> {
  id: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/**
 * DownloadQueue provides concurrency control and cancellation of still-queued
 * jobs. Jobs that have not started yet can be removed and rejected instantly.
 * Running jobs cooperate via their CancellationToken at safe boundaries.
 */
export class DownloadQueue {
  private readonly pending: QueueJob<unknown>[] = [];
  private activeCount = 0;
  private shuttingDown = false;

  constructor(private readonly concurrency: number) {}

  async add<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) {
      throw new AppError('Queue is shutting down', 'CANCELLED');
    }

    return await new Promise<T>((resolve, reject) => {
      this.pending.push({ id, run, resolve, reject } as QueueJob<unknown>);
      this.drain();
    });
  }

  /** Removes a still-queued job. Returns true if it was pending and removed. */
  cancelPending(id: string): boolean {
    const index = this.pending.findIndex((job) => job.id === id);
    if (index === -1) {
      return false;
    }
    const [job] = this.pending.splice(index, 1);
    job.reject(new AppError('Job cancelled', 'CANCELLED'));
    return true;
  }

  stats(): { pending: number; active: number; concurrency: number; shuttingDown: boolean } {
    return {
      pending: this.pending.length,
      active: this.activeCount,
      concurrency: this.concurrency,
      shuttingDown: this.shuttingDown,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (this.pending.length === 0 && this.activeCount === 0) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
  }

  private drain(): void {
    while (!this.shuttingDown && this.activeCount < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) {
        return;
      }

      this.activeCount += 1;
      logger.info({ jobId: job.id, activeCount: this.activeCount }, 'queue job started');

      void job
        .run()
        .then((result) => job.resolve(result))
        .catch((error) => job.reject(error))
        .finally(() => {
          this.activeCount -= 1;
          logger.info({ jobId: job.id, activeCount: this.activeCount }, 'queue job finished');
          this.drain();
        });
    }
  }
}
