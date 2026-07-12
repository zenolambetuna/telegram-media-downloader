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
  | 'LIVE_STREAM';

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
