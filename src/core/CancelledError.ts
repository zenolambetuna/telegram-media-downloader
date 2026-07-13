import { AppError } from '../types/errors';

/**
 * Thrown when a job is cancelled cooperatively. Carries a NOT_FOUND-adjacent
 * semantic but is distinct so the bot can present a clean 'cancelled' message
 * rather than an error.
 */
export class CancelledError extends AppError {
  constructor() {
    super('Job cancelled', 'VALIDATION_ERROR');
    this.name = 'CancelledError';
  }
}
