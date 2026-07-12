import { ProviderRegistry } from './ProviderRegistry';
import { MediaMetadata } from '../types/media';
import { normalizeUrl } from '../utils/url';
import { withTimeout } from '../utils/time';
import { config } from '../config/env';

export class MediaInspector {
  constructor(private readonly providerRegistry: ProviderRegistry) {}

  async inspect(url: string): Promise<MediaMetadata> {
    const provider = this.providerRegistry.resolve(url);
    const metadata = await withTimeout(provider.getMetadata(url), config.PROVIDER_TIMEOUT_MS, 'provider timeout');
    return {
      ...metadata,
      canonicalUrl: normalizeUrl(metadata.canonicalUrl),
    };
  }
}
