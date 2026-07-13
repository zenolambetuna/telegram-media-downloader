import { AppError } from '../types/errors';

type CancelListener = () => void;

/**
 * A cooperative cancellation token. The pipeline checks it at stage boundaries
 * and aborts cleanly. It does not force-kill an in-flight yt-dlp process (that
 * would require an engine hook, which this layer deliberately does not add);
 * it cancels queued work immediately and stops post-download work as soon as
 * the current stage yields.
 */
export class CancellationToken {
  private cancelled = false;
  private readonly listeners = new Set<CancelListener>();

  get isCancelled(): boolean {
    return this.cancelled;
  }

  cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // listeners must not break cancellation
      }
    }
  }

  onCancel(listener: CancelListener): void {
    this.listeners.add(listener);
  }

  throwIfCancelled(): void {
    if (this.cancelled) {
      throw new AppError('Cancelled by user', 'CANCELLED');
    }
  }
}

/**
 * Registry of active cancellation tokens keyed by job id, so a Telegram
 * callback (the Cancel button) can find and trip the right token.
 */
export class CancellationRegistry {
  private readonly tokens = new Map<string, CancellationToken>();

  create(jobId: string): CancellationToken {
    const token = new CancellationToken();
    this.tokens.set(jobId, token);
    return token;
  }

  cancel(jobId: string): boolean {
    const token = this.tokens.get(jobId);
    if (!token) {
      return false;
    }
    token.cancel();
    return true;
  }

  release(jobId: string): void {
    this.tokens.delete(jobId);
  }
}
