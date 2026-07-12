import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseNumber(name: string, fallback?: number): number {
  const value = process.env[name];
  if (!value && fallback !== undefined) {
    return fallback;
  }
  if (!value) {
    throw new Error(`Missing required numeric environment variable: ${name}`);
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }
  return parsed;
}

export const config = {
  botToken: requireEnv('BOT_TOKEN'),
  channelId: requireEnv('CHANNEL_ID'),
  adminId: parseNumber('ADMIN_ID'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  tmpDir: process.env.TMP_DIR ?? '/tmp/media-downloader',
  maxConcurrentDownloads: parseNumber('MAX_CONCURRENT_DOWNLOADS', 2),
  rateLimitWindowMs: parseNumber('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMaxRequests: parseNumber('RATE_LIMIT_MAX_REQUESTS', 15),
  downloadTimeoutMs: parseNumber('DOWNLOAD_TIMEOUT_MS', 900_000),
  uploadTimeoutMs: parseNumber('UPLOAD_TIMEOUT_MS', 900_000),
  ytDlpPath: process.env.YT_DLP_PATH ?? 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
} as const;
