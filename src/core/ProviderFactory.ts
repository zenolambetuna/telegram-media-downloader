import { MediaProvider, ProviderManifest } from '../types/provider';
import { logger } from '../logger/logger';

/**
 * ProviderFactory instantiates a provider from its manifest, isolating
 * construction failures so one broken plugin cannot crash discovery.
 */
export class ProviderFactory {
  create(manifest: ProviderManifest, source: string): MediaProvider | null {
    try {
      if (!manifest || typeof manifest.create !== 'function') {
        logger.warn({ source }, 'provider manifest missing create()');
        return null;
      }
      return manifest.create();
    } catch (error) {
      logger.warn({ source, error }, 'provider construction failed');
      return null;
    }
  }
}
