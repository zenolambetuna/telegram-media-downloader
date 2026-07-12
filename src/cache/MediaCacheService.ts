import { CachedMediaRecord } from '../types/media';
import { JsonMediaRepository } from '../storage/JsonMediaRepository';

export class MediaCacheService {
  constructor(private readonly repository: JsonMediaRepository) {}

  async get(canonicalUrl: string): Promise<CachedMediaRecord | null> {
    return await this.repository.findByCanonicalUrl(canonicalUrl);
  }

  async put(record: CachedMediaRecord): Promise<void> {
    await this.repository.save(record);
  }

  async count(): Promise<number> {
    return await this.repository.count();
  }
}
