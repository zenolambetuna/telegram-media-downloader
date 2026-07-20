import { DriveCallResult } from './DriveApiClient';
import { DriveStatus } from './DriveBridgeContract';

/**
 * DriveSyncPolicy classifies a Drive API call result as retryable or
 * permanent, following the Stage 4.0 contract:
 *
 * - 401 / 403 / 422 → permanent (config or schema issue; retrying will
 *   not help and could mask a misconfiguration).
 * - 429 / 5xx / network failure (status 0) / timeout (status -1) →
 *   retryable with exponential backoff.
 * - 404 on a write is permanent for the *caller's* logical operation but
 *   the sync service treats it as terminal-not-retryable.
 * - 409 is permanent (idempotency conflict or state conflict; the caller
 *   must resolve it, not retry blindly).
 *
 * The policy is intentionally separate from the generic `categorize()`
 * in `types/errors.ts` because Drive-specific status codes carry more
 * signal than a generic Error message.
 */
export type SyncDecision = 'retry' | 'permanent';

export function classifyDriveResult<T>(result: DriveCallResult<T>): SyncDecision {
  const status = result.status;
  if (status >= 200 && status < 300) {
    return 'permanent'; // success — no retry needed; caller handles this
  }
  if (status === DriveStatus.notAuthenticated || status === DriveStatus.forbidden || status === DriveStatus.unprocessable) {
    return 'permanent';
  }
  if (status === DriveStatus.notFound || status === DriveStatus.conflict) {
    return 'permanent';
  }
  if (status === DriveStatus.rateLimited) {
    return 'retry';
  }
  if (status >= 500) {
    return 'retry';
  }
  // status 0 (network failure) and status -1 (timeout) are retryable.
  if (status === 0 || status === -1) {
    return 'retry';
  }
  // Anything else (e.g. 3xx, unexpected 4xx) is permanent — we don't know
  // what it means and retrying could make things worse.
  return 'permanent';
}

/** Returns the backoff delay in ms for a given attempt (1-based). */
export function driveBackoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const exponential = baseMs * Math.pow(2, Math.min(attempt, 6));
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(exponential + jitter, capMs);
}
