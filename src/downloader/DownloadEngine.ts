import path from 'node:path';
import { config } from '../config/env';
import { ProviderRegistry } from '../core/ProviderRegistry';
import { DownloadArtifact, DownloadRequest } from '../types/media';
import { checksumFile, safeRemove } from '../utils/fs';
import { withRetry } from '../utils/retry';

export class DownloadEngine {
  constructor(private readonly providerRegistry: ProviderRegistry) {}

  async download(request: DownloadRequest): Promise<DownloadArtifact> {
    const provider = this.providerRegistry.resolve(request.url);
    const tempDir = path.join(config.TMP_DIR, String(request.userId), Date.now().toString());

    try {
      const artifact = await withRetry('download-media', config.DOWNLOAD_RETRY_ATTEMPTS, async () => {
        return await provider.download(request);
      });

      const checksum = await checksumFile(artifact.filePath);
      return {
        ...artifact,
        checksum,
      };
    } catch (error) {
      await safeRemove(tempDir);
      throw error;
    }
  }
}
