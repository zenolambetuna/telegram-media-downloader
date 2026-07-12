import { config } from '../config/env';
import { logger } from '../logger/logger';

export async function withRetry<T>(
  operationName: string,
  attempts: number,
  task: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      logger.warn({ operationName, attempt, error }, 'operation failed');
      if (attempt < attempts) {
        const delay = config.RETRY_BASE_DELAY_MS * attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
