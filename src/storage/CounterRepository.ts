import { DatabaseConnection } from './Database';

export class CounterRepository {
  constructor(private readonly database: DatabaseConnection) {}

  async increment(key: string, amount = 1): Promise<void> {
    this.database.connection
      .prepare(
        `INSERT INTO runtime_counters (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
      )
      .run(key, amount);
  }

  async get(key: string): Promise<number> {
    const row = this.database.connection
      .prepare('SELECT value FROM runtime_counters WHERE key = ? LIMIT 1')
      .get(key) as { value: number } | undefined;
    return row?.value ?? 0;
  }
}
