import path from 'node:path';
import { config } from '../config/env';
import { ProviderRegistry } from './ProviderRegistry';
import { DownloadRequest, DownloadResult } from '../types/media';

export class DownloadManager {
  constructor(private readonly providerRegistry: ProviderRegistry) {}

  async download(request: DownloadRequest): Promise<DownloadResult> {
    const provider = this.providerRegistry.resolve(request.url);
    return await provider.download({
      ...request,
      url: request.url,
    });
  }

  buildTempDir(userId: number): string {
    return path.join(config.tmpDir, String(userId), Date.now().toString());
  }
}
