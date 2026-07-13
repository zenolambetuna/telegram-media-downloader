import { DatabaseConnection } from './Database';
import { StoredMediaRecord } from '../types/media';

export interface MediaRepository {
  findByCacheKey(cacheKey: string): Promise<StoredMediaRecord | null>;
  findByCanonicalUrl(canonicalUrl: string): Promise<StoredMediaRecord | null>;
  findByOriginalUrl(originalUrl: string): Promise<StoredMediaRecord | null>;
  findByChecksum(checksum: string): Promise<StoredMediaRecord | null>;
  save(record: StoredMediaRecord): Promise<void>;
  count(): Promise<number>;
}

/** Builds the composite cache key used to dedupe per media + quality. */
export function buildCacheKey(canonicalUrl: string, quality: string): string {
  return `${canonicalUrl}::${quality}`;
}

export class SqliteMediaRepository implements MediaRepository {
  constructor(private readonly database: DatabaseConnection) {}

  async findByCacheKey(cacheKey: string): Promise<StoredMediaRecord | null> {
    return this.queryOne('cache_key', cacheKey);
  }

  async findByCanonicalUrl(canonicalUrl: string): Promise<StoredMediaRecord | null> {
    return this.queryOne('canonical_url', canonicalUrl);
  }

  async findByOriginalUrl(originalUrl: string): Promise<StoredMediaRecord | null> {
    return this.queryOne('original_url', originalUrl);
  }

  async findByChecksum(checksum: string): Promise<StoredMediaRecord | null> {
    return this.queryOne('checksum', checksum);
  }

  async save(record: StoredMediaRecord): Promise<void> {
    const cacheKey = buildCacheKey(record.canonicalUrl, record.quality);
    this.database.connection
      .prepare(`
        INSERT INTO media_records (
          cache_key, message_id, file_id, chat_id, provider, original_url, canonical_url, title,
          description, duration, thumbnail, mime_type, quality, resolution, fps,
          bitrate, codec, size, upload_date, checksum
        ) VALUES (
          @cacheKey, @messageId, @fileId, @chatId, @provider, @originalUrl, @canonicalUrl, @title,
          @description, @duration, @thumbnail, @mimeType, @quality, @resolution, @fps,
          @bitrate, @codec, @size, @uploadDate, @checksum
        )
        ON CONFLICT(cache_key) DO UPDATE SET
          message_id = excluded.message_id,
          file_id = excluded.file_id,
          chat_id = excluded.chat_id,
          provider = excluded.provider,
          original_url = excluded.original_url,
          canonical_url = excluded.canonical_url,
          title = excluded.title,
          description = excluded.description,
          duration = excluded.duration,
          thumbnail = excluded.thumbnail,
          mime_type = excluded.mime_type,
          quality = excluded.quality,
          resolution = excluded.resolution,
          fps = excluded.fps,
          bitrate = excluded.bitrate,
          codec = excluded.codec,
          size = excluded.size,
          upload_date = excluded.upload_date,
          checksum = excluded.checksum
      `)
      .run({
        cacheKey,
        messageId: record.messageId,
        fileId: record.fileId,
        chatId: record.chatId,
        provider: record.provider,
        originalUrl: record.originalUrl,
        canonicalUrl: record.canonicalUrl,
        title: record.title,
        description: record.description ?? null,
        duration: record.duration ?? null,
        thumbnail: record.thumbnail ?? null,
        mimeType: record.mimeType,
        quality: record.quality,
        resolution: record.resolution ?? null,
        fps: record.fps ?? null,
        bitrate: record.bitrate ?? null,
        codec: record.codec ?? null,
        size: record.size ?? null,
        uploadDate: record.uploadDate,
        checksum: record.checksum,
      });
  }

  async count(): Promise<number> {
    const row = this.database.connection.prepare('SELECT COUNT(*) AS count FROM media_records').get() as {
      count: number;
    };
    return row.count;
  }

  private queryOne(column: string, value: string): StoredMediaRecord | null {
    const row = this.database.connection
      .prepare(`SELECT * FROM media_records WHERE ${column} = ? LIMIT 1`)
      .get(value) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, unknown>): StoredMediaRecord {
    return {
      id: row.id as number,
      messageId: row.message_id as number,
      fileId: row.file_id as string,
      chatId: row.chat_id as string,
      provider: row.provider as string,
      originalUrl: row.original_url as string,
      canonicalUrl: row.canonical_url as string,
      title: row.title as string,
      description: (row.description as string | null) ?? undefined,
      duration: (row.duration as number | null) ?? undefined,
      thumbnail: (row.thumbnail as string | null) ?? undefined,
      mimeType: row.mime_type as string,
      quality: row.quality as string,
      resolution: (row.resolution as string | null) ?? undefined,
      fps: (row.fps as number | null) ?? undefined,
      bitrate: (row.bitrate as number | null) ?? undefined,
      codec: (row.codec as string | null) ?? undefined,
      size: (row.size as number | null) ?? undefined,
      uploadDate: row.upload_date as string,
      checksum: row.checksum as string,
    };
  }
}
