import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class TwitterProvider extends BaseProvider {
  constructor() {
    super({
      id: 'twitter',
      name: 'X (Twitter)',
      priority: 80,
      domains: ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'],
      pattern: /(?:twitter\.com|x\.com)/i,
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  create: () => new TwitterProvider(),
};

export default manifest;
