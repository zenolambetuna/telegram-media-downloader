/**
 * Cooperative cancellation token. The bot layer checks it at safe boundaries
 * (stage transitions, before upload). It does not forcibly kill a running
 * yt-dlp/ffmpeg process; that would require a change to the Download Engine
 * contract, which is intentionally frozen. Cancellation therefore takes effect
 * at the next checkpoint.
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
      const error = new Error('cancelled');
      error.name = 'CancellationError';
      throw error;
    }
  }
}

export function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'CancellationError';
}
