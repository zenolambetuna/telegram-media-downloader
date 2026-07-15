import { ProviderRegistry } from './ProviderRegistry';
import { DownloadEngine } from '../downloader/DownloadEngine';
import { ResolvedMediaInfo } from '../types/media';

export class MediaInspector {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly downloadEngine: DownloadEngine,
  ) {}

  async inspect(url: string): Promise<ResolvedMediaInfo> {
    const platform = this.providerRegistry.platformFor(url);
    return await this.downloadEngine.inspect(url, platform);
  }
}
