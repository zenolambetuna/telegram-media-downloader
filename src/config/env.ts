import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  CHANNEL_ID: z.string().min(1),
  ADMIN_ID: z.coerce.number().int().positive(),
  LOG_LEVEL: z.string().default('info'),
  TMP_DIR: z.string().default('/tmp/media-downloader'),
  DATABASE_PATH: z.string().default('./data/media-engine.db'),
  MAX_CONCURRENT_DOWNLOADS: z.coerce.number().int().positive().default(2),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(15),
  DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  UPLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  DOWNLOAD_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
  UPLOAD_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(1000),
  YT_DLP_PATH: z.string().default('yt-dlp'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  // Telegram bot uploads are capped at 50MB unless a local Bot API server is
  // used, which raises the ceiling to ~2000MB. Set TELEGRAM_API_ROOT to your
  // local server and raise MAX_TELEGRAM_UPLOAD_MB accordingly.
  MAX_TELEGRAM_UPLOAD_MB: z.coerce.number().int().positive().default(50),
  TELEGRAM_API_ROOT: z.string().optional(),
  PROGRESS_EDIT_INTERVAL_MS: z.coerce.number().int().positive().default(2500),

  // Stage 2.8 — Production readiness & queue reliability.
  // All entries below have safe defaults so existing deployments keep working
  // without touching .env. DRIVE_API_* is optional; if absent, the Drive API
  // health check reports "skipped" instead of failing startup.
  DRIVE_API_BASE_URL: z.string().url().optional(),
  DRIVE_API_KEY: z.string().optional(),
  DRIVE_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Stage 4.0 — Drive sync retry budget for the DriveSyncService. This is
  // separate from the queue worker's retry budget because Drive sync is
  // best-effort and should not exhaust the download retry budget.
  DRIVE_SYNC_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  DRIVE_SYNC_FAVORITE_BY_DEFAULT: z.coerce.boolean().default(false),
  DRIVE_SYNC_FOLDER_NAME: z.string().default('Telegram Media Downloader'),

  QUEUE_RECOVERY_ENABLED: z.coerce.boolean().default(true),
  QUEUE_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  QUEUE_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(2000),
  QUEUE_DEAD_LETTER_ENABLED: z.coerce.boolean().default(true),
  QUEUE_PROCESSING_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),

  WORKER_ENABLED: z.coerce.boolean().default(true),
  WORKER_TICK_MS: z.coerce.number().int().positive().default(1000),
  WORKER_GRACEFUL_SHUTDOWN_MS: z.coerce.number().int().positive().default(15_000),

  HEALTH_CHECK_ENABLED: z.coerce.boolean().default(true),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  HEALTH_CHECK_FAIL_ON_DRIVE_ERROR: z.coerce.boolean().default(false),

  METRICS_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
});

export const config = envSchema.parse(process.env);
