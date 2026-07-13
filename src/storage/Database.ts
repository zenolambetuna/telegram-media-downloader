import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from '../config/env';
import { ensureDirectory } from '../utils/fs';

/**
 * SQLite connection and schema management. The media cache is keyed by a
 * composite cache_key (canonical url + quality) so the same media can be
 * stored once per quality and deduplicated per format, satisfying the
 * "same media + format" reuse rule.
 */
export class DatabaseConnection {
  private readonly db: Database.Database;

  constructor() {
    const dbPath = path.resolve(config.DATABASE_PATH);
    void ensureDirectory(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  get connection(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key TEXT NOT NULL UNIQUE,
        message_id INTEGER NOT NULL,
        file_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        original_url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        duration INTEGER,
        thumbnail TEXT,
        mime_type TEXT NOT NULL,
        quality TEXT NOT NULL,
        resolution TEXT,
        fps REAL,
        bitrate INTEGER,
        codec TEXT,
        size INTEGER,
        upload_date TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_media_records_provider ON media_records(provider);
      CREATE INDEX IF NOT EXISTS idx_media_records_checksum ON media_records(checksum);
      CREATE INDEX IF NOT EXISTS idx_media_records_canonical ON media_records(canonical_url);

      CREATE TABLE IF NOT EXISTS thumbnails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL UNIQUE,
        file_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS runtime_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS runtime_counters (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);

    this.migrateToCompositeCacheKey();
  }

  /**
   * Older installs had UNIQUE(canonical_url), which prevented storing multiple
   * formats of the same media. This rebuilds the table to key on a composite
   * cache_key while preserving existing rows. Safe to run repeatedly.
   */
  private migrateToCompositeCacheKey(): void {
    const tableSql = (
      this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='media_records'")
        .get() as { sql?: string } | undefined
    )?.sql;

    const needsRebuild = Boolean(tableSql && /canonical_url\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(tableSql));
    if (!needsRebuild) {
      return;
    }

    const rebuild = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE media_records_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cache_key TEXT NOT NULL UNIQUE,
          message_id INTEGER NOT NULL,
          file_id TEXT NOT NULL,
          chat_id TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL,
          original_url TEXT NOT NULL,
          canonical_url TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          duration INTEGER,
          thumbnail TEXT,
          mime_type TEXT NOT NULL,
          quality TEXT NOT NULL,
          resolution TEXT,
          fps REAL,
          bitrate INTEGER,
          codec TEXT,
          size INTEGER,
          upload_date TEXT NOT NULL,
          checksum TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO media_records_new (
          message_id, file_id, chat_id, provider, original_url, canonical_url, title,
          description, duration, thumbnail, mime_type, quality, resolution, fps,
          bitrate, codec, size, upload_date, checksum, cache_key
        )
        SELECT
          message_id, file_id, COALESCE(chat_id, ''), provider, original_url, canonical_url, title,
          description, duration, thumbnail, mime_type, quality, resolution, fps,
          bitrate, codec, size, upload_date, checksum,
          canonical_url || '::' || quality
        FROM media_records;

        DROP TABLE media_records;
        ALTER TABLE media_records_new RENAME TO media_records;

        CREATE INDEX IF NOT EXISTS idx_media_records_provider ON media_records(provider);
        CREATE INDEX IF NOT EXISTS idx_media_records_checksum ON media_records(checksum);
        CREATE INDEX IF NOT EXISTS idx_media_records_canonical ON media_records(canonical_url);
      `);
    });

    rebuild();
  }
}
