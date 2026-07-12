import { ProviderRegistry } from './ProviderRegistry';
import { DownloadEngine } from '../downloader/DownloadEngine';
import { EngineMetadata } from '../types/download';

/**
 * MediaInspector resolves the provider for a URL and delegates all metadata
 * work to the Universal Download Engine. It exists so the bot layer does not
 * touch the engine or registry directly.
 */
export class MediaInspector {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly downloadEngine: DownloadEngine,
  ) {}

  async inspect(url: string): Promise<EngineMetadata> {
    const platform = this.providerRegistry.platformFor(url);
    return await this.downloadEngine.inspect(url, platform);
  }
}
