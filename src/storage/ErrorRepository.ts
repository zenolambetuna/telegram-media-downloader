import { DatabaseConnection } from './Database';

export interface RuntimeErrorRecord {
  code: string;
  message: string;
  context?: string;
}

export class ErrorRepository {
  constructor(private readonly database: DatabaseConnection) {}

  async log(record: RuntimeErrorRecord): Promise<void> {
    this.database.connection
      .prepare('INSERT INTO runtime_errors (code, message, context) VALUES (?, ?, ?)')
      .run(record.code, record.message, record.context ?? null);
  }

  async latest(limit = 10): Promise<Array<RuntimeErrorRecord & { createdAt: string }>> {
    const rows = this.database.connection
      .prepare('SELECT code, message, context, created_at FROM runtime_errors ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      code: row.code as string,
      message: row.message as string,
      context: (row.context as string | null) ?? undefined,
      createdAt: row.created_at as string,
    }));
  }

  async count(): Promise<number> {
    const row = this.database.connection.prepare('SELECT COUNT(*) AS count FROM runtime_errors').get() as {
      count: number;
    };
    return row.count;
  }
}
