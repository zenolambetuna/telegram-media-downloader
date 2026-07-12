import { MediaRepository } from '../storage/MediaRepository';
import { StoredMediaRecord } from '../types/media';

export class CacheService {
  constructor(private readonly mediaRepository: MediaRepository) {}

  async get(canonicalUrl: string): Promise<StoredMediaRecord | null> {
    return await this.mediaRepository.findByCanonicalUrl(canonicalUrl);
  }

  async put(record: StoredMediaRecord): Promise<void> {
    await this.mediaRepository.save(record);
  }

  async count(): Promise<number> {
    return await this.mediaRepository.count();
  }
}
