import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectory } from '../utils/fs';

export interface RuntimeStats {
  users: number;
  uploads: number;
  errors: number;
}

export class StatsRepository {
  private readonly filePath = path.join(process.cwd(), 'data', 'stats.json');

  async get(): Promise<RuntimeStats> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      return JSON.parse(content) as RuntimeStats;
    } catch {
      return { users: 0, uploads: 0, errors: 0 };
    }
  }

  async update(mutator: (stats: RuntimeStats) => RuntimeStats): Promise<RuntimeStats> {
    const current = await this.get();
    const next = mutator(current);
    await ensureDirectory(path.dirname(this.filePath));
    await writeFile(this.filePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
}
