import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class TwitterProvider extends BaseProvider {
  constructor() {
    super({
      id: 'twitter',
      name: 'X (Twitter)',
      version: '1.0.0',
      author: 'core',
      homepage: 'https://x.com',
      priority: 80,
      domains: ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'],
      pattern: /(?:twitter\.com|x\.com)/i,
      engineCompatibility: '^1.0.0',
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  manifestVersion: 1,
  create: () => new TwitterProvider(),
};

export default manifest;
