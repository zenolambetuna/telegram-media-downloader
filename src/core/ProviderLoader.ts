import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger/logger';
import { MediaProvider, ProviderManifest } from '../types/provider';
import { ProviderFactory } from './ProviderFactory';

const NON_PROVIDER_DIRS = new Set(['shared']);

/**
 * ProviderLoader auto-discovers provider plugins at runtime. It scans the
 * providers directory, dynamically imports each folder's default manifest, and
 * builds provider instances through the factory. Dropping a new provider
 * folder into src/providers (compiled to dist/providers) and restarting is the
 * entire installation process. No other file is ever touched.
 */
export class ProviderLoader {
  constructor(private readonly factory: ProviderFactory) {}

  async discover(): Promise<MediaProvider[]> {
    const providersDir = path.join(__dirname, '..', 'providers');
    const providers: MediaProvider[] = [];

    let entries: string[] = [];
    try {
      const dirents = await readdir(providersDir, { withFileTypes: true });
      entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      logger.error({ error, providersDir }, 'failed to read providers directory');
      return providers;
    }

    for (const entry of entries) {
      if (NON_PROVIDER_DIRS.has(entry)) {
        continue;
      }

      const modulePath = path.join(providersDir, entry);
      try {
        const imported = (await import(modulePath)) as { default?: ProviderManifest };
        const manifest = imported.default;
        if (!manifest) {
          logger.warn({ entry }, 'provider folder has no default manifest export');
          continue;
        }

        const provider = this.factory.create(manifest, entry);
        if (provider) {
          providers.push(provider);
          logger.info(
            { providerId: provider.metadata.id, version: provider.metadata.version, entry },
            'provider discovered',
          );
        }
      } catch (error) {
        logger.warn({ entry, error }, 'provider discovery failed for folder');
      }
    }

    return providers;
  }
}
