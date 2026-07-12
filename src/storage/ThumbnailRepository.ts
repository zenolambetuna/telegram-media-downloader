import { DatabaseConnection } from './Database';

export interface StoredThumbnail {
  sourceKey: string;
  fileId: string;
  messageId: number;
}

export class ThumbnailRepository {
  constructor(private readonly database: DatabaseConnection) {}

  async find(sourceKey: string): Promise<StoredThumbnail | null> {
    const row = this.database.connection
      .prepare('SELECT source_key, file_id, message_id FROM thumbnails WHERE source_key = ? LIMIT 1')
      .get(sourceKey) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      sourceKey: row.source_key as string,
      fileId: row.file_id as string,
      messageId: row.message_id as number,
    };
  }

  async save(thumbnail: StoredThumbnail): Promise<void> {
    this.database.connection
      .prepare(`
        INSERT INTO thumbnails (source_key, file_id, message_id) VALUES (?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          file_id = excluded.file_id,
          message_id = excluded.message_id
      `)
      .run(thumbnail.sourceKey, thumbnail.fileId, thumbnail.messageId);
  }
}
