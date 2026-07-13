import { logger } from '../logger/logger';

export interface JobHandle {
  jobId: string;
  userId: number;
  chatId: number;
  cancelled: boolean;
  cancel: () => void;
}

/**
 * JobManager tracks in-flight and queued jobs per user and provides
 * cooperative cancellation. Cancellation flips a flag the pipeline checks at
 * safe checkpoints (before download, before upload, before delivery). Queued
 * jobs that have not started yet are cancelled before any work happens.
 *
 * Note on scope: this is cooperative cancellation at the bot/orchestration
 * layer. It does not force-kill an already-running yt-dlp process mid-stream,
 * which would require an engine-level abort hook. The job stops at the next
 * checkpoint and its workspace is cleaned by the engine.
 */
export class JobManager {
  private readonly jobs = new Map<string, JobHandle>();

  register(jobId: string, userId: number, chatId: number): JobHandle {
    const handle: JobHandle = {
      jobId,
      userId,
      chatId,
      cancelled: false,
      cancel: () => {
        handle.cancelled = true;
        logger.info({ jobId, userId }, 'job cancellation requested');
      },
    };
    this.jobs.set(jobId, handle);
    return handle;
  }

  get(jobId: string): JobHandle | undefined {
    return this.jobs.get(jobId);
  }

  cancel(jobId: string): boolean {
    const handle = this.jobs.get(jobId);
    if (!handle) {
      return false;
    }
    handle.cancel();
    return true;
  }

  release(jobId: string): void {
    this.jobs.delete(jobId);
  }

  activeForUser(userId: number): number {
    let count = 0;
    for (const handle of this.jobs.values()) {
      if (handle.userId === userId && !handle.cancelled) {
        count += 1;
      }
    }
    return count;
  }
}
