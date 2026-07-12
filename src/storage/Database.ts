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
        provider TEXT NOT NULL,
        original_url TEXT NOT NULL,
        canonical_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        duration INTEGER,
        thumbnail TEXT,
        quality TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        upload_date TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_media_records_provider ON media_records(provider);
      CREATE INDEX IF NOT EXISTS idx_media_records_checksum ON media_records(checksum);

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
  }
}
