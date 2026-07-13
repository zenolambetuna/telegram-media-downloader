import { stat } from 'node:fs/promises';
import { AppError } from '../types/errors';

/**
 * Telegram Bot API upload ceiling. A standard bot can upload up to 50 MB per
 * file. A self-hosted Bot API server can raise this to 2 GB; when you deploy
 * one, raise this constant. The guard is centralized here so the upload path
 * has one authoritative limit.
 */
export const TELEGRAM_BOT_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

export async function assertUploadable(filePath: string, limitBytes = TELEGRAM_BOT_UPLOAD_LIMIT_BYTES): Promise<number> {
  const info = await stat(filePath);
  if (info.size > limitBytes) {
    const limitMb = Math.round(limitBytes / 1024 / 1024);
    const actualMb = Math.round(info.size / 1024 / 1024);
    throw new AppError(
      `File is ${actualMb} MB, over the ${limitMb} MB Telegram bot limit. A self-hosted Bot API server is needed for larger files.`,
      'UPLOAD_FAILED',
    );
  }
  return info.size;
}
