import { config } from '../config/env';
import { AppError } from '../types/errors';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<number, Bucket>();

export async function rateLimit(userId: number): Promise<void> {
  const now = Date.now();
  const current = buckets.get(userId);

  if (!current || current.resetAt <= now) {
    buckets.set(userId, {
      count: 1,
      resetAt: now + config.RATE_LIMIT_WINDOW_MS,
    });
    return;
  }

  if (current.count >= config.RATE_LIMIT_MAX_REQUESTS) {
    throw new AppError('Too many requests, slow down', 'RATE_LIMITED');
  }

  current.count += 1;
}
