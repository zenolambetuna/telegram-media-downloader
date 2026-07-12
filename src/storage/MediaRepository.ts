import { DatabaseConnection } from './Database';
import { StoredMediaRecord } from '../types/media';

export interface MediaRepository {
  findByCanonicalUrl(canonicalUrl: string): Promise<StoredMediaRecord | null>;
  save(record: StoredMediaRecord): Promise<void>;
  count(): Promise<number>;
}

export class SqliteMediaRepository implements MediaRepository {
  constructor(private readonly database: DatabaseConnection) {}

  async findByCanonicalUrl(canonicalUrl: string): Promise<StoredMediaRecord | null> {
    const row = this.database.connection
      .prepare('SELECT * FROM media_records WHERE canonical_url = ? LIMIT 1')
      .get(canonicalUrl) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return this.mapRow(row);
  }

  async save(record: StoredMediaRecord): Promise<void> {
    this.database.connection
      .prepare(`
        INSERT INTO media_records (
          message_id, file_id, provider, original_url, canonical_url, title,
          duration, thumbnail, quality, mime_type, upload_date, checksum
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canonical_url) DO UPDATE SET
          message_id = excluded.message_id,
          file_id = excluded.file_id,
          provider = excluded.provider,
          original_url = excluded.original_url,
          title = excluded.title,
          duration = excluded.duration,
          thumbnail = excluded.thumbnail,
          quality = excluded.quality,
          mime_type = excluded.mime_type,
          upload_date = excluded.upload_date,
          checksum = excluded.checksum
      `)
      .run(
        record.messageId,
        record.fileId,
        record.provider,
        record.originalUrl,
        record.canonicalUrl,
        record.title,
        record.duration ?? null,
        record.thumbnail ?? null,
        record.quality,
        record.mimeType,
        record.uploadDate,
        record.checksum,
      );
  }

  async count(): Promise<number> {
    const row = this.database.connection.prepare('SELECT COUNT(*) AS count FROM media_records').get() as {
      count: number;
    };
    return row.count;
  }

  private mapRow(row: Record<string, unknown>): StoredMediaRecord {
    return {
      id: row.id as number,
      messageId: row.message_id as number,
      fileId: row.file_id as string,
      provider: row.provider as StoredMediaRecord['provider'],
      originalUrl: row.original_url as string,
      canonicalUrl: row.canonical_url as string,
      title: row.title as string,
      duration: (row.duration as number | null) ?? undefined,
      thumbnail: (row.thumbnail as string | null) ?? undefined,
      quality: row.quality as string,
      mimeType: row.mime_type as string,
      uploadDate: row.upload_date as string,
      checksum: row.checksum as string,
    };
  }
}
