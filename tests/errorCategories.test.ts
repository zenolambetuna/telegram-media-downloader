import { describe, expect, it } from 'vitest';
import {
  AppError,
  categoryOf,
  categorize,
  isRetryableCode,
} from '../src/types/errors';

describe('categoryOf', () => {
  it('classifies validation codes', () => {
    expect(categoryOf('INVALID_URL')).toBe('validation');
    expect(categoryOf('UNSUPPORTED_FORMAT')).toBe('validation');
    expect(categoryOf('VALIDATION_ERROR')).toBe('validation');
    expect(categoryOf('TOO_LARGE')).toBe('validation');
  });

  it('classifies permanent media codes', () => {
    expect(categoryOf('PRIVATE_MEDIA')).toBe('permanent');
    expect(categoryOf('DELETED_MEDIA')).toBe('permanent');
    expect(categoryOf('UNAVAILABLE_MEDIA')).toBe('permanent');
    expect(categoryOf('AGE_RESTRICTED')).toBe('permanent');
    expect(categoryOf('GEO_RESTRICTED')).toBe('permanent');
    expect(categoryOf('LIVE_STREAM')).toBe('permanent');
    expect(categoryOf('NOT_FOUND')).toBe('permanent');
    expect(categoryOf('CANCELLED')).toBe('permanent');
  });

  it('classifies transient codes', () => {
    expect(categoryOf('NETWORK_FAILURE')).toBe('network');
    expect(categoryOf('TIMEOUT')).toBe('network');
    expect(categoryOf('UPLOAD_FAILED')).toBe('telegram');
    expect(categoryOf('RATE_LIMITED')).toBe('telegram');
    expect(categoryOf('DOWNLOAD_FAILED')).toBe('retryable');
    expect(categoryOf('MERGE_FAILED')).toBe('retryable');
    expect(categoryOf('DISK_FULL')).toBe('retryable');
  });
});

describe('isRetryableCode', () => {
  it('retries network and telegram failures', () => {
    expect(isRetryableCode('NETWORK_FAILURE')).toBe(true);
    expect(isRetryableCode('TIMEOUT')).toBe(true);
    expect(isRetryableCode('UPLOAD_FAILED')).toBe(true);
    expect(isRetryableCode('RATE_LIMITED')).toBe(true);
    expect(isRetryableCode('DOWNLOAD_FAILED')).toBe(true);
  });

  it('does not retry permanent or validation errors', () => {
    expect(isRetryableCode('INVALID_URL')).toBe(false);
    expect(isRetryableCode('UNSUPPORTED_FORMAT')).toBe(false);
    expect(isRetryableCode('PRIVATE_MEDIA')).toBe(false);
    expect(isRetryableCode('DELETED_MEDIA')).toBe(false);
    expect(isRetryableCode('CANCELLED')).toBe(false);
    expect(isRetryableCode('TOO_LARGE')).toBe(false);
  });
});

describe('categorize', () => {
  it('uses AppError.code when available', () => {
    const error = new AppError('boom', 'TIMEOUT');
    expect(categorize(error)).toBe('network');
  });

  it('detects flood errors from raw Error messages', () => {
    const error = new Error('Telegram returned 429: retry_after 5');
    expect(categorize(error)).toBe('telegram');
  });

  it('detects network errors from raw Error messages', () => {
    expect(categorize(new Error('ECONNRESET'))).toBe('network');
    expect(categorize(new Error('operation timed out'))).toBe('network');
    expect(categorize(new Error('ENOTFOUND example.com'))).toBe('network');
  });

  it('detects database errors from raw Error messages', () => {
    expect(categorize(new Error('SQLITE_CONSTRAINT: unique violation'))).toBe('database');
    expect(categorize(new Error('database is locked'))).toBe('database');
  });

  it('falls back to retryable for unknown errors', () => {
    expect(categorize(new Error('something weird'))).toBe('retryable');
    expect(categorize('not even an error')).toBe('retryable');
    expect(categorize(null)).toBe('retryable');
  });
});
