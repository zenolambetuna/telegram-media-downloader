import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from '../config/env';
import { ensureDirectory } from '../utils/fs';

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
        message_id INTEGER NOT NULL,
        file_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        original_url TEXT NOT NULL,
        canonical_url TEXT NOT NULL UNIQUE,
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
      CREATE INDEX IF NOT EXISTS idx_media_records_original_url ON media_records(original_url);

      -- Per-format cache: the same media at different qualities are distinct
      -- stored files. Keyed by (canonical_url, format_id) so we never collide
      -- 720p with 1080p and never re-download an already-stored format.
      CREATE TABLE IF NOT EXISTS format_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_url TEXT NOT NULL,
        format_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        file_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        original_url TEXT NOT NULL,
        title TEXT NOT NULL,
        media_type TEXT NOT NULL,
        quality TEXT NOT NULL,
        duration INTEGER,
        size INTEGER,
        checksum TEXT NOT NULL,
        upload_date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (canonical_url, format_id)
      );

      CREATE INDEX IF NOT EXISTS idx_format_cache_checksum ON format_cache(checksum);

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

    this.ensureColumns();
  }

  private ensureColumns(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(media_records)').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );

    const additions: Array<{ name: string; ddl: string }> = [
      { name: 'chat_id', ddl: "ALTER TABLE media_records ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''" },
      { name: 'description', ddl: 'ALTER TABLE media_records ADD COLUMN description TEXT' },
      { name: 'resolution', ddl: 'ALTER TABLE media_records ADD COLUMN resolution TEXT' },
      { name: 'fps', ddl: 'ALTER TABLE media_records ADD COLUMN fps REAL' },
      { name: 'bitrate', ddl: 'ALTER TABLE media_records ADD COLUMN bitrate INTEGER' },
      { name: 'codec', ddl: 'ALTER TABLE media_records ADD COLUMN codec TEXT' },
      { name: 'size', ddl: 'ALTER TABLE media_records ADD COLUMN size INTEGER' },
    ];

    for (const addition of additions) {
      if (!existing.has(addition.name)) {
        this.db.exec(addition.ddl);
      }
    }
  }
}
