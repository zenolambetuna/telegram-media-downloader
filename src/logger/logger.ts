import pino from 'pino';
import { config } from '../config/env';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: {
    service: 'telegram-media-downloader-engine',
  },
  redact: {
    // Never log raw secrets. Paths cover both direct log calls and nested
    // error/context objects.
    paths: [
      '*.BOT_TOKEN',
      '*.bot_token',
      '*.token',
      '*.api_key',
      '*.apiKey',
      '*.DRIVE_API_KEY',
      '*.drive_api_key',
      '*.authorization',
      '*.Authorization',
      '*.headers.authorization',
      '*.headers.Authorization',
      '*.cookie',
      '*.cookies',
      '*.cookiesFile',
      '*.password',
      '*.secret',
      'bot.token',
      'ctx.bot.token',
    ],
    censor: '[REDACTED]',
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

/**
 * LogContext is the canonical structured-logging shape for Stage 2.8. Every
 * long-running operation (queue job, HTTP request, pipeline run) should
 * attach at least `requestId` (or `queueId`) and `ownerId`. `fileUniqueId`
 * is set after the upload step. `processingDurationMs` is set when the
 * operation completes.
 */
export interface LogContext {
  requestId?: string;
  queueId?: string;
  fileUniqueId?: string;
  ownerId?: number;
  processingDurationMs?: number;
  /** Stage 4.1: Drive service name (folder/share/trash/...). */
  service?: string;
}

/** Convenience child-logger builder for a single logical operation. */
export function loggerFor(context: LogContext): pino.Logger {
  return logger.child({
    requestId: context.requestId,
    queueId: context.queueId,
    fileUniqueId: context.fileUniqueId,
    ownerId: context.ownerId,
    service: context.service,
  });
}

/** Returns the time in ms between start and now, for processingDuration logs. */
export function durationSince(start: number): number {
  return Date.now() - start;
}

/**
 * Sanitise an arbitrary object before attaching it to a log record. Strips
 * keys that look like secrets (token, key, password, secret, cookie, auth).
 * Use this when logging unknown-typed payloads that may contain credentials.
 */
export function sanitizeForLog(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForLog);
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizeForLog(val);
    }
  }
  return result;
}

const SECRET_KEY_RE = /(token|apikey|api_key|secret|password|cookie|authorization|auth|bearer)/i;
