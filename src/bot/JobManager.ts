import { DownloadQueue } from '../queue/DownloadQueue';
import { CancellationToken, isCancellation } from './CancellationToken';
import { logger } from '../logger/logger';

export interface JobHandle {
  jobId: string;
  userId: number;
  token: CancellationToken;
}

/**
 * JobManager sits on top of the existing DownloadQueue (which is not modified).
 * It adds per-user job tracking and cooperative cancellation. Concurrency and
 * scheduling remain owned by DownloadQueue.
 */
export class JobManager {
  private readonly jobs = new Map<string, JobHandle>();
  private readonly userJobs = new Map<number, Set<string>>();

  constructor(private readonly queue: DownloadQueue) {}

  async run<T>(userId: number, jobId: string, task: (token: CancellationToken) => Promise<T>): Promise<T> {
    const token = new CancellationToken();
    const handle: JobHandle = { jobId, userId, token };
    this.jobs.set(jobId, handle);
    this.trackUser(userId, jobId);

    try {
      return await this.queue.add(jobId, async () => {
        token.throwIfCancelled();
        return await task(token);
      });
    } finally {
      this.jobs.delete(jobId);
      this.userJobs.get(userId)?.delete(jobId);
    }
  }

  cancel(jobId: string): boolean {
    const handle = this.jobs.get(jobId);
    if (!handle) {
      return false;
    }
    handle.token.cancel();
    logger.info({ jobId }, 'cancellation requested');
    return true;
  }

  cancelAllForUser(userId: number): number {
    const ids = this.userJobs.get(userId);
    if (!ids || ids.size === 0) {
      return 0;
    }
    let count = 0;
    for (const jobId of ids) {
      if (this.cancel(jobId)) {
        count += 1;
      }
    }
    return count;
  }

  activeCountForUser(userId: number): number {
    return this.userJobs.get(userId)?.size ?? 0;
  }

  static isCancellation(error: unknown): boolean {
    return isCancellation(error);
  }

  private trackUser(userId: number, jobId: string): void {
    const set = this.userJobs.get(userId) ?? new Set<string>();
    set.add(jobId);
    this.userJobs.set(userId, set);
  }
}
