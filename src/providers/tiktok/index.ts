import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class TikTokProvider extends BaseProvider {
  constructor() {
    super({
      id: 'tiktok',
      name: 'TikTok',
      priority: 80,
      domains: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com'],
      pattern: /tiktok\.com/i,
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
        supportsShorts: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  create: () => new TikTokProvider(),
};

export default manifest;
