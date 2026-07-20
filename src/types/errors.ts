export type ErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PROVIDER'
  | 'PRIVATE_MEDIA'
  | 'DELETED_MEDIA'
  | 'UNAVAILABLE_MEDIA'
  | 'AGE_RESTRICTED'
  | 'GEO_RESTRICTED'
  | 'DOWNLOAD_FAILED'
  | 'MERGE_FAILED'
  | 'UNSUPPORTED_FORMAT'
  | 'DISK_FULL'
  | 'UPLOAD_FAILED'
  | 'NETWORK_FAILURE'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'LIVE_STREAM'
  | 'TOO_LARGE'
  | 'CANCELLED';

/**
 * High-level error category used by the queue worker to decide retry vs.
 * dead-letter behaviour. The classification is intentionally coarse so the
 * worker does not need to know about every individual ErrorCode.
 *
 * - `validation`   — caller input is wrong; never retried.
 * - `permanent`    — the media itself cannot be served; never retried.
 * - `network`      — transient network failure; retried with backoff.
 * - `telegram`     — Telegram API failure (FloodWait, 5xx); retried.
 * - `database`     — local DB failure; retried once then dead-letter.
 * - `retryable`    — anything else that should be retried.
 */
export type ErrorCategory =
  | 'validation'
  | 'permanent'
  | 'network'
  | 'telegram'
  | 'database'
  | 'api'
  | 'retryable';

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Maps an ErrorCode to a coarse ErrorCategory for the queue worker. */
export function categoryOf(code: ErrorCode): ErrorCategory {
  switch (code) {
    case 'INVALID_URL':
    case 'UNSUPPORTED_PROVIDER':
    case 'UNSUPPORTED_FORMAT':
    case 'VALIDATION_ERROR':
    case 'TOO_LARGE':
      return 'validation';
    case 'PRIVATE_MEDIA':
    case 'DELETED_MEDIA':
    case 'UNAVAILABLE_MEDIA':
    case 'AGE_RESTRICTED':
    case 'GEO_RESTRICTED':
    case 'LIVE_STREAM':
    case 'NOT_FOUND':
      return 'permanent';
    case 'NETWORK_FAILURE':
    case 'TIMEOUT':
      return 'network';
    case 'UPLOAD_FAILED':
    case 'RATE_LIMITED':
      return 'telegram';
    case 'DOWNLOAD_FAILED':
    case 'MERGE_FAILED':
    case 'DISK_FULL':
      return 'retryable';
    case 'CANCELLED':
      return 'permanent';
  }
}

/** Whether a job with the given error code should be retried by the worker. */
export function isRetryableCode(code: ErrorCode): boolean {
  const category = categoryOf(code);
  return category === 'network' || category === 'telegram' || category === 'retryable' || category === 'database' || category === 'api';
}

/** Categorise an unknown thrown value into an ErrorCategory. */
export function categorize(error: unknown): ErrorCategory {
  if (error instanceof AppError) {
    return categoryOf(error.code);
  }
  if (error instanceof Error) {
    const text = error.message.toLowerCase();
    if (text.includes('flood') || text.includes('429') || text.includes('retry_after')) {
      return 'telegram';
    }
    if (text.includes('timeout') || text.includes('timed out')) {
      return 'network';
    }
    if (text.includes('econnreset') || text.includes('econnrefused') || text.includes('enotfound') || text.includes('network')) {
      return 'network';
    }
    if (text.includes('sqlite') || text.includes('database') || text.includes('constraint')) {
      return 'database';
    }
  }
  return 'retryable';
}

/**
 * Maps raw yt-dlp / ffmpeg stderr to a typed, user-safe AppError. Centralizing
 * this keeps error semantics consistent across every provider.
 */
export function classifyDownloadError(raw: string): AppError {
  const text = raw.toLowerCase();

  if (text.includes('private')) {
    return new AppError('This media is private', 'PRIVATE_MEDIA');
  }
  if (text.includes('age') && text.includes('restrict')) {
    return new AppError('This media is age restricted', 'AGE_RESTRICTED');
  }
  if (text.includes('geo') || text.includes('not available in your country') || text.includes('blocked it in your country')) {
    return new AppError('This media is geo restricted', 'GEO_RESTRICTED');
  }
  if (text.includes('removed') || text.includes('deleted') || text.includes('no longer available')) {
    return new AppError('This media was removed', 'DELETED_MEDIA');
  }
  if (text.includes('unavailable') || text.includes('not available')) {
    return new AppError('This media is unavailable', 'UNAVAILABLE_MEDIA');
  }
  if (text.includes('live event') || text.includes('is live')) {
    return new AppError('Live streams are not downloadable yet', 'LIVE_STREAM');
  }
  if (text.includes('requested format is not available') || text.includes('no video formats')) {
    return new AppError('Requested format is not available', 'UNSUPPORTED_FORMAT');
  }
  if (text.includes('no space left') || text.includes('disk full')) {
    return new AppError('Server storage is full', 'DISK_FULL');
  }
  if (text.includes('timed out') || text.includes('timeout')) {
    return new AppError('The operation timed out', 'TIMEOUT');
  }
  if (text.includes('network') || text.includes('connection') || text.includes('unable to download')) {
    return new AppError('Network failure while downloading', 'NETWORK_FAILURE');
  }

  return new AppError('Download failed', 'DOWNLOAD_FAILED', raw);
}
