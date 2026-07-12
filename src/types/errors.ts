export type ErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PROVIDER'
  | 'PRIVATE_MEDIA'
  | 'DELETED_MEDIA'
  | 'AGE_RESTRICTED'
  | 'DOWNLOAD_FAILED'
  | 'UPLOAD_FAILED'
  | 'NETWORK_FAILURE'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND';

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
