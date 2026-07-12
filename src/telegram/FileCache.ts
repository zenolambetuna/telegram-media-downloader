import { logger } from '../logger/logger';
import { MediaRepository } from '../storage/MediaRepository';
import { CacheLookup, StoredMediaRecord } from '../types/media';
import { normalizeUrl } from '../utils/url';

/**
 * FileCache answers "do we already have this media?" using several signals:
 * checksum, original URL, and normalized canonical URL. This keeps the engine
 * from re-downloading anything already stored in the Telegram channel.
 */
export class FileCache {
  constructor(private readonly mediaRepository: MediaRepository) {}

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
