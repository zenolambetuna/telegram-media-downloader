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
});

export const config = envSchema.parse(process.env);
