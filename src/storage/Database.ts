import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/env';
import { logger } from '../logger/logger';

/**
 * SQLite connection and schema management. The media cache is keyed by a
 * composite cache_key (canonical url + quality) so the same media can be
 * stored once per quality and deduplicated per format, satisfying the
 * "same media + format" reuse rule.
 */
export class DatabaseConnection {
  private readonly db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = dbPath ?? path.resolve(config.DATABASE_PATH);
    // Synchronous so the DB file can be opened immediately after. Using
    // mkdirSync(recursive: true) is a no-op when the directory exists.
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
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

      CREATE TABLE IF NOT EXISTS queue_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'download',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        url TEXT NOT NULL,
        format_id TEXT NOT NULL,
        quality TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        owner_id INTEGER NOT NULL,
        request_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        locked_until TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        last_error_category TEXT,
        next_attempt_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_queue_jobs_status ON queue_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_queue_jobs_next_attempt ON queue_jobs(status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS dead_letter (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'download',
        url TEXT NOT NULL,
        format_id TEXT NOT NULL,
        quality TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        owner_id INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        last_error_code TEXT,
        last_error_message TEXT,
        last_error_category TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_dead_letter_created ON dead_letter(created_at);
    `);

    this.migrateToCompositeCacheKey();
    this.migrateQueueProcessingStuck();
  }

  /**
   * On startup any job left in `processing` from a previous run is stale
   * (the process died mid-flight). Reset it to `pending` so the worker can
   * pick it back up. Safe to run repeatedly; only touches rows that need it.
   */
  private migrateQueueProcessingStuck(): void {
    const stale = this.db
      .prepare("UPDATE queue_jobs SET status='pending', locked_until=NULL, updated_at=CURRENT_TIMESTAMP WHERE status='processing'")
      .run();
    if (stale.changes > 0) {
      logger.info({ reset: stale.changes }, 'reset stuck processing jobs back to pending');
    }
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
