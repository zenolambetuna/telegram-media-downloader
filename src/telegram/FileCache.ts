import { logger } from '../logger/logger';
import { buildCacheKey, MediaRepository } from '../storage/MediaRepository';
import { CacheLookup, StoredMediaRecord } from '../types/media';
import { normalizeUrl } from '../utils/url';

/**
 * FileCache answers "do we already have this media at this quality?". Dedup is
 * format-aware: the primary key is (canonical url + quality). Checksum and
 * original-url lookups remain available as secondary signals.
 */
export class FileCache {
  constructor(private readonly mediaRepository: MediaRepository) {}

  async lookupByFormat(canonicalUrl: string, quality: string): Promise<StoredMediaRecord | null> {
    const record = await this.mediaRepository.findByCacheKey(buildCacheKey(canonicalUrl, quality));
    if (record) {
      logger.info({ canonicalUrl, quality }, 'cache hit by media + format');
    }
    return record;
  }

  async lookup(lookup: CacheLookup): Promise<StoredMediaRecord | null> {
    if (lookup.checksum) {
      const byChecksum = await this.mediaRepository.findByChecksum(lookup.checksum);
      if (byChecksum) {
        logger.info({ checksum: lookup.checksum }, 'cache hit by checksum');
        return byChecksum;
      }
    }

    if (lookup.originalUrl) {
      const byOriginal = await this.mediaRepository.findByOriginalUrl(lookup.originalUrl);
      if (byOriginal) {
        logger.info({ originalUrl: lookup.originalUrl }, 'cache hit by original url');
        return byOriginal;
      }
    }

    const canonical = lookup.canonicalUrl ?? (lookup.originalUrl ? normalizeUrl(lookup.originalUrl) : undefined);
    if (canonical) {
      const byCanonical = await this.mediaRepository.findByCanonicalUrl(canonical);
      if (byCanonical) {
        logger.info({ canonicalUrl: canonical }, 'cache hit by canonical url');
        return byCanonical;
      }
    }

    return null;
  }

  async save(record: StoredMediaRecord): Promise<void> {
    await this.mediaRepository.save(record);
  }

  async count(): Promise<number> {
    return await this.mediaRepository.count();
  }
}
