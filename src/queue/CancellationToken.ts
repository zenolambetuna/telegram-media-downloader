import { AppError } from '../types/errors';

/**
 * Cooperative cancellation. A token is checked at safe boundaries (before
 * upload) and when a job is still queued. This does not force-kill an
 * in-flight OS process; that would require an engine-level AbortSignal, which
 * is intentionally out of scope here so the Download Engine stays untouched.
 */
export class CancellationToken {
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  throwIfCancelled(): void {
    if (this.cancelled) {
      throw new AppError('Job cancelled', 'CANCELLED');
    }
  }
}

/**
 * Tracks active cancellation tokens keyed by a short job token string so the
 * bot can cancel a specific job from an inline button.
 */
export class CancellationRegistry {
  private readonly tokens = new Map<string, CancellationToken>();

  create(jobToken: string): CancellationToken {
    const token = new CancellationToken();
    this.tokens.set(jobToken, token);
    return token;
  }

  cancel(jobToken: string): boolean {
    const token = this.tokens.get(jobToken);
    if (!token) {
      return false;
    }
    token.cancel();
    return true;
  }

  release(jobToken: string): void {
    this.tokens.delete(jobToken);
  }
}
