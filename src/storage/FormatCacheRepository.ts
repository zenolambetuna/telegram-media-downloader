import { DatabaseConnection } from './Database';
import { MediaType } from '../types/media';

export interface FormatCacheRecord {
  canonicalUrl: string;
  formatId: string;
  messageId: number;
  fileId: string;
  chatId: string;
  provider: string;
  originalUrl: string;
  title: string;
  mediaType: MediaType;
  quality: string;
  duration?: number;
  size?: number;
  checksum: string;
  uploadDate: string;
}

/**
 * Repository for per-format cache entries. This is what makes requirement 13
 * correct: dedup is by media AND format, not by URL alone. Storage layer only;
 * the download engine and providers are untouched.
 */
export class FormatCacheRepository {
  constructor(private readonly database: DatabaseConnection) {}

  async find(canonicalUrl: string, formatId: string): Promise<FormatCacheRecord | null> {
    const row = this.database.connection
      .prepare('SELECT * FROM format_cache WHERE canonical_url = ? AND format_id = ? LIMIT 1')
      .get(canonicalUrl, formatId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findByChecksum(checksum: string): Promise<FormatCacheRecord | null> {
    const row = this.database.connection
      .prepare('SELECT * FROM format_cache WHERE checksum = ? LIMIT 1')
      .get(checksum) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async save(record: FormatCacheRecord): Promise<void> {
    this.database.connection
      .prepare(`
        INSERT INTO format_cache (
          canonical_url, format_id, message_id, file_id, chat_id, provider,
          original_url, title, media_type, quality, duration, size, checksum, upload_date
        ) VALUES (
          @canonicalUrl, @formatId, @messageId, @fileId, @chatId, @provider,
          @originalUrl, @title, @mediaType, @quality, @duration, @size, @checksum, @uploadDate
        )
        ON CONFLICT(canonical_url, format_id) DO UPDATE SET
          message_id = excluded.message_id,
          file_id = excluded.file_id,
          chat_id = excluded.chat_id,
          provider = excluded.provider,
          original_url = excluded.original_url,
          title = excluded.title,
          media_type = excluded.media_type,
          quality = excluded.quality,
          duration = excluded.duration,
          size = excluded.size,
          checksum = excluded.checksum,
          upload_date = excluded.upload_date
      `)
      .run({
        canonicalUrl: record.canonicalUrl,
        formatId: record.formatId,
        messageId: record.messageId,
        fileId: record.fileId,
        chatId: record.chatId,
        provider: record.provider,
        originalUrl: record.originalUrl,
        title: record.title,
        mediaType: record.mediaType,
        quality: record.quality,
        duration: record.duration ?? null,
        size: record.size ?? null,
        checksum: record.checksum,
        uploadDate: record.uploadDate,
      });
  }

  async count(): Promise<number> {
    const row = this.database.connection.prepare('SELECT COUNT(*) AS count FROM format_cache').get() as {
      count: number;
    };
    return row.count;
  }

  private mapRow(row: Record<string, unknown>): FormatCacheRecord {
    return {
      canonicalUrl: row.canonical_url as string,
      formatId: row.format_id as string,
      messageId: row.message_id as number,
      fileId: row.file_id as string,
      chatId: row.chat_id as string,
      provider: row.provider as string,
      originalUrl: row.original_url as string,
      title: row.title as string,
      mediaType: row.media_type as MediaType,
      quality: row.quality as string,
      duration: (row.duration as number | null) ?? undefined,
      size: (row.size as number | null) ?? undefined,
      checksum: row.checksum as string,
      uploadDate: row.upload_date as string,
    };
  }
}
