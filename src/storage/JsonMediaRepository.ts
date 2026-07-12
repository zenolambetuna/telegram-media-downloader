import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CachedMediaRecord } from '../types/media';
import { ensureDirectory } from '../utils/fs';

export class JsonMediaRepository {
  private readonly filePath = path.join(process.cwd(), 'data', 'media-cache.json');

  async findByCanonicalUrl(canonicalUrl: string): Promise<CachedMediaRecord | null> {
    const records = await this.readAll();
    return records.find((record) => record.canonicalUrl === canonicalUrl) ?? null;
  }

  async save(record: CachedMediaRecord): Promise<void> {
    const records = await this.readAll();
    const nextRecords = records.filter((item) => item.canonicalUrl !== record.canonicalUrl);
    nextRecords.push(record);
    await this.writeAll(nextRecords);
  }

  async count(): Promise<number> {
    const records = await this.readAll();
    return records.length;
  }

  private async readAll(): Promise<CachedMediaRecord[]> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      return JSON.parse(content) as CachedMediaRecord[];
    } catch {
      return [];
    }
  }

  private async writeAll(records: CachedMediaRecord[]): Promise<void> {
    await ensureDirectory(path.dirname(this.filePath));
    await writeFile(this.filePath, JSON.stringify(records, null, 2), 'utf8');
  }
}
