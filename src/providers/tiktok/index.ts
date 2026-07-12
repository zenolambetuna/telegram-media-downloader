import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class TikTokProvider extends BaseProvider {
  constructor() {
    super({
      id: 'tiktok',
      name: 'TikTok',
      version: '1.0.0',
      author: 'core',
      homepage: 'https://tiktok.com',
      priority: 80,
      domains: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com'],
      pattern: /tiktok\.com/i,
      engineCompatibility: '^1.0.0',
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
        supportsShorts: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  manifestVersion: 1,
  create: () => new TikTokProvider(),
};

export default manifest;
